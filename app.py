"""WrongBook - a local, screenshot-first wrong-question notebook.

Run:  python app.py
Then open http://127.0.0.1:8765 (started automatically).
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import locale
import os
import queue

# Paddlex (pulled in transitively by paddleocr) imports matplotlib at load time.
# Redirect its cache into the app data dir so it never tries to write to the
# user profile (which can fail with PermissionError on Windows when running as a
# service). Must be set before paddleocr/matplotlib are imported below.
_MPL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", ".matplotlib")
os.makedirs(_MPL_DIR, exist_ok=True)
os.environ.setdefault("MPLCONFIGDIR", _MPL_DIR)

import re
import secrets
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import traceback
import urllib.request
import uuid
import webbrowser
from datetime import datetime
from pathlib import Path
from typing import Any

from flask import (
    Flask,
    Response,
    g,
    jsonify,
    redirect,
    render_template,
    request,
    send_file,
    send_from_directory,
    stream_with_context,
)
from PIL import Image, UnidentifiedImageError

import db
import keyword_extractor
import llm_client
import ocr_engine
import parser
from grading import grade_answer, normalize_user_answer
from codepaper import VERSION as APP_VERSION
from codepaper.routes import codepaper_bp

BASE_DIR = Path(__file__).resolve().parent
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "webp", "bmp"}
MAX_IMAGE_BYTES = 25 * 1024 * 1024

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 80 * 1024 * 1024
app.config["JSON_AS_ASCII"] = False
# 本地调试时改模板即时生效，不必重启服务
app.config["TEMPLATES_AUTO_RELOAD"] = True
# 代码填空整卷处理旁路：独立 Blueprint，不触碰现有 /api/ocr 等链路
app.register_blueprint(codepaper_bp)


@app.context_processor
def _inject_asset_version():
    """CSS / JS 任一文件改动就换版本号，手机端不会一直用旧缓存。

    整卷考试的 codepaper.css / codepaper.js 也要计入：v1.4.0 之前只盯主站
    两个文件，单独改动整卷视图时浏览器会一直拿旧缓存，改了像没改。
    """
    try:
        stamp = max(
            int((BASE_DIR / "static" / rel).stat().st_mtime)
            for rel in (
                "css/app.css", "js/app.js",
                "css/codepaper.css", "js/codepaper.js",
            )
        )
    except OSError:
        stamp = 0
    return {"asset_version": stamp}


def _load_lan_token() -> str:
    """固定访问令牌：重启后旧二维码与手机桌面图标不会失效。

    需要让所有旧链接失效时，删除 data/lan_token.txt 并重启，会自动生成新令牌。
    """
    path = db.DATA_DIR / "lan_token.txt"
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists():
            saved = path.read_text(encoding="utf-8").strip()
            if len(saved) >= 16 and re.fullmatch(r"[A-Za-z0-9_-]+", saved):
                return saved
    except OSError:
        pass
    token = secrets.token_urlsafe(18)
    try:
        path.write_text(token, encoding="utf-8")
    except OSError:
        pass
    return token


MOBILE_TOKEN = _load_lan_token()
BIND_HOST = os.environ.get("WRONGBOOK_HOST", "0.0.0.0")
MOBILE_MAX_FILES = 8

# 手机完整访问：扫码后写入一枚仅本机可校验的 Cookie，避免同网其他设备
# 在未授权的情况下直接读取题库。令牌已持久化，重启不会让已授权手机失效。
LAN_COOKIE = "wb_lan"
LAN_SESSION = hashlib.sha256(("wrongbook-lan:" + MOBILE_TOKEN).encode()).hexdigest()

_sessions: dict[str, dict[str, Any]] = {}
_sessions_lock = threading.Lock()
_log_stream = None


def _setup_file_logging() -> None:
    """pythonw has no console; keep startup/runtime errors in data/app.log."""
    global _log_stream
    is_pythonw = Path(sys.executable).name.lower().startswith("pythonw")
    if not is_pythonw and sys.stdout is not None and sys.stderr is not None:
        return
    db.DATA_DIR.mkdir(parents=True, exist_ok=True)
    log_path = db.DATA_DIR / "app.log"
    try:
        if log_path.exists() and log_path.stat().st_size > 2 * 1024 * 1024:
            log_path.replace(db.DATA_DIR / "app.log.old")
    except OSError:
        pass
    _log_stream = open(log_path, "a", encoding="utf-8", buffering=1)
    _log_stream.write(f"\n[{db.now()}] WrongBook starting\n")
    _log_stream.flush()
    if is_pythonw or sys.stdout is None:
        sys.stdout = _log_stream
    if is_pythonw or sys.stderr is None:
        sys.stderr = _log_stream


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------
def get_db() -> sqlite3.Connection:
    if "db" not in g:
        g.db = db.connect()
    return g.db


@app.teardown_appcontext
def close_db(_exc: BaseException | None) -> None:
    conn = g.pop("db", None)
    if conn is not None:
        conn.close()


# ---------------------------------------------------------------------------
# Small utilities
# ---------------------------------------------------------------------------
def clean_str(value: Any, limit: int = 4000) -> str:
    if value is None:
        return ""
    return str(value).replace("\x00", "").strip()[:limit]


def _local_ipv4_addresses() -> set[str]:
    """本机所有 IPv4：从本机网卡地址访问自己时也应视为本机请求。"""
    result = {"127.0.0.1", "::1", "localhost"}
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            result.add(sock.getsockname()[0])
    except OSError:
        pass
    try:
        for item in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            if item[4][0]:
                result.add(item[4][0])
    except OSError:
        pass
    return result


LOCAL_IPS = _local_ipv4_addresses()


def _is_loopback(value: str | None) -> bool:
    remote = (value or "").replace("::ffff:", "")
    return remote in LOCAL_IPS


def _lan_ip() -> str:
    """Best-effort LAN IPv4 used by the phone camera page."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as sock:
            sock.connect(("8.8.8.8", 80))
            ip = sock.getsockname()[0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if ip and not ip.startswith("127."):
                return ip
    except OSError:
        pass
    return ""


def _mobile_url(port: int | None = None) -> str:
    if BIND_HOST not in {"0.0.0.0", ""}:
        return ""
    ip = _lan_ip()
    if not ip:
        return ""
    port = port or int(os.environ.get("WRONGBOOK_PORT", "8765"))
    return f"http://{ip}:{port}/m/{MOBILE_TOKEN}"


def _lan_url(port: int | None = None, host: str | None = None) -> str:
    """Full-app entry for a phone on the same Wi-Fi (scan once, then use freely)."""
    if BIND_HOST not in {"0.0.0.0", ""}:
        return ""
    ip = host or _lan_ip()
    if not ip:
        return ""
    port = port or int(os.environ.get("WRONGBOOK_PORT", "8765"))
    return f"http://{ip}:{port}/p/{MOBILE_TOKEN}"


def _lan_ip_candidates() -> list[dict[str, Any]]:
    """列出手机可能可达的本机 IPv4（排除回环、169.254 与虚拟网卡）。"""
    primary = _lan_ip()
    snapshot = _network_snapshot()
    interfaces = snapshot.get("interfaces") or []
    alias_map = {item["ip"]: item.get("alias", "") for item in interfaces if item.get("ip")}
    raw: list[str] = []
    if snapshot.get("available") and interfaces:
        raw = [item["ip"] for item in interfaces]
        if primary and primary not in raw:
            raw.insert(0, primary)
    else:
        if primary:
            raw.append(primary)
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                raw.append(info[4][0])
        except OSError:
            pass
    items: list[dict[str, Any]] = []
    for ip in raw:
        if not ip or ip.startswith(("127.", "169.254.")):
            continue
        if any(item["ip"] == ip for item in items):
            continue
        alias = alias_map.get(ip) or "本机网卡"
        if _is_virtual_alias(alias):
            continue
        items.append({"ip": ip, "alias": alias, "primary": ip == primary})
    if primary and not any(item["primary"] for item in items):
        items.insert(0, {"ip": primary, "alias": alias_map.get(primary) or "默认出口", "primary": True})
    return items


def _valid_lan_host(host: str | None) -> bool:
    """二维码只允许指向本机已识别的地址，避免被塞入任意内容。"""
    if not host:
        return False
    return any(item["ip"] == host for item in _lan_ip_candidates())


def _windows_network_info() -> dict[str, Any]:
    """读取网卡名/网络类别/8765 放行规则，供手机连不上时自助排查。"""
    empty: dict[str, Any] = {
        "available": False,
        "interfaces": [],
        "firewall": {"exists": None, "enabled": False, "action": "", "profile": ""},
    }
    if os.name != "nt":
        return empty
    script = """
$ErrorActionPreference = 'SilentlyContinue'
$ifaces = @(Get-NetIPConfiguration | Where-Object { $_.IPv4Address } | ForEach-Object {
    $cat = (Get-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).NetworkCategory
    [PSCustomObject]@{ alias = [string]$_.InterfaceAlias; ip = [string]$_.IPv4Address.IPAddress; category = [string]$cat }
})
$rule = $null
$fwError = ''
try { $rule = Get-NetFirewallRule -DisplayName 'WrongBook LAN (TCP 8765)' -ErrorAction Stop } catch { $fwError = [string]$_.Exception.Message }
if ($fwError) {
    $fw = [PSCustomObject]@{ exists = $null; enabled = $false; action = ''; profile = ''; error = $fwError }
} elseif ($rule) {
    $fw = [PSCustomObject]@{ exists = $true; enabled = [bool]$rule.Enabled; action = [string]$rule.Action; profile = [string]$rule.Profile; error = '' }
} else {
    $fw = [PSCustomObject]@{ exists = $false; enabled = $false; action = ''; profile = ''; error = '' }
}
[PSCustomObject]@{ interfaces = $ifaces; firewall = $fw } | ConvertTo-Json -Compress -Depth 5
"""
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True,
            timeout=12,
        )
        # PowerShell 5.1 在中文 Windows 上输出 GBK，按 UTF-8 解码会抛异常
        output = proc.stdout or b""
        try:
            raw = output.decode("mbcs").strip()
        except (LookupError, UnicodeDecodeError):
            raw = output.decode("utf-8", errors="replace").strip()
        if proc.returncode != 0 or not raw:
            return empty
        data = json.loads(raw)
        interfaces = data.get("interfaces") or []
        if isinstance(interfaces, dict):
            interfaces = [interfaces]
        firewall_data = data.get("firewall") or empty["firewall"]
        return {
            "available": True,
            "firewall_available": firewall_data.get("exists") is not None,
            "interfaces": [
                {
                    "alias": str(item.get("alias", "")),
                    "ip": str(item.get("ip", "")),
                    "category": str(item.get("category", "")),
                }
                for item in interfaces
                if isinstance(item, dict)
            ],
            "firewall": firewall_data,
        }
    except Exception as exc:
        return {**empty, "error": str(exc)[:120]}


_net_cache: dict[str, Any] = {"at": 0.0, "data": None}
_net_lock = threading.Lock()


def _network_snapshot(force: bool = False) -> dict[str, Any]:
    """网卡/防火墙信息缓存 60 秒，避免每次打开设置页都启动 PowerShell。"""
    now = time.time()
    if not force and _net_cache["data"] and now - _net_cache["at"] < 60:
        return _net_cache["data"]
    data = _windows_network_info()
    with _net_lock:
        _net_cache.update(at=now, data=data)
    return data


def _is_virtual_alias(alias: str) -> bool:
    """VMware / Hyper-V / WSL / Docker 等虚拟网卡地址对手机没有意义。"""
    text = (alias or "").lower()
    return any(
        key in text
        for key in ("vmware", "vmnet", "virtual", "虚拟", "vethernet", "hyper-v", "wsl", "docker", "virtualbox", "tap-")
    )


_diag_cache: dict[str, Any] = {"at": 0.0, "data": None}
_diag_lock = threading.Lock()


def _collect_lan_diagnostics(port: int, force: bool = False) -> dict[str, Any]:
    info = _network_snapshot(force=force)
    interfaces = info.get("interfaces") or []
    primary = _lan_ip()
    category_map = {x["ip"]: x.get("category", "") for x in interfaces if x.get("ip")}
    candidates = [
        {**item, "category": category_map.get(item["ip"], "")}
        for item in _lan_ip_candidates()
    ]
    category = next(
        (x["category"] for x in candidates if x["ip"] == primary and x["category"]), ""
    )
    firewall = info.get("firewall") or {}
    profile = str(firewall.get("profile") or "")

    # 从局域网地址自检：确认服务确实能通过该 IP 访问（health 不触发诊断，避免递归）
    selfcheck = {"ok": False, "detail": "未执行"}
    if primary:
        try:
            with urllib.request.urlopen(f"http://{primary}:{port}/api/health", timeout=2) as resp:
                selfcheck = {"ok": resp.status == 200, "detail": f"HTTP {resp.status}"}
        except Exception as exc:
            selfcheck = {"ok": False, "detail": str(exc)[:120]}

    hints: list[dict[str, str]] = []
    if BIND_HOST not in {"0.0.0.0", ""}:
        hints.append(
            {
                "level": "error",
                "text": f"程序只监听 {BIND_HOST}，手机无法连接；启动时不要使用 --host 127.0.0.1。",
            }
        )
    if not selfcheck["ok"]:
        hints.append(
            {
                "level": "warn",
                "text": f"本机从局域网地址自检失败（{selfcheck['detail']}），请确认服务正在运行且监听 0.0.0.0。",
            }
        )
    if firewall.get("exists") is None:
        hints.append(
            {
                "level": "info",
                "text": "本机权限限制，无法自动读取防火墙状态（不代表规则不存在）。若手机打不开，请以管理员身份运行程序，或在管理员 PowerShell 执行：New-NetFirewallRule -DisplayName 'WrongBook LAN (TCP 8765)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8765 -Profile Private -RemoteAddress LocalSubnet",
            }
        )
    elif firewall.get("exists") is False:
        hints.append(
            {
                "level": "warn",
                "text": "没有找到 8765 端口的防火墙放行规则，手机连接会被 Windows 防火墙拦下；可在管理员 PowerShell 执行 New-NetFirewallRule 添加。",
            }
        )
    elif firewall.get("exists") and not firewall.get("enabled"):
        hints.append(
            {"level": "warn", "text": "8765 端口的放行规则处于禁用状态，请在 Windows 防火墙中启用。"}
        )
    elif profile and profile != "Any" and category and category not in profile:
        hints.append(
            {
                "level": "warn",
                "text": f"当前网络类别是 {category}，放行规则只覆盖 {profile}，规则不会生效；需把规则设为所有网络类别（Any）。",
            }
        )
    wireless_unplugged = any(
        item.get("ip", "").startswith("169.254.")
        and (
            "无线" in item.get("alias", "")
            or "WLAN" in item.get("alias", "").upper()
            or "WI-FI" in item.get("alias", "").upper()
        )
        for item in interfaces
    )
    if wireless_unplugged:
        hints.append(
            {
                "level": "warn",
                "text": "电脑无线网卡没拿到有效地址（169.254），目前主要靠网线联网。手机必须和这台电脑接在同一个路由器/网段；若手机 WiFi 属于另一个路由器或访客网络，请改接同一网络，或让电脑连上该 WiFi 后重新生成二维码。",
            }
        )
    if primary:
        prefix = ".".join(primary.split(".")[:3])
        hints.append(
            {
                "level": "info",
                "text": f"手机 WiFi 的 IP 前三段应与二维码地址一致（{prefix}.x）。请关闭手机 VPN、私人 DNS，并避开「访客网络 / AP 隔离」，用系统浏览器打开。",
            }
        )
    hints.append(
        {
            "level": "ok" if selfcheck["ok"] else "warn",
            "text": f"服务自检：{selfcheck['detail']}；监听 {BIND_HOST}:{port}；当前网络类别 {category or '未知'}；放行规则 {profile or '未能自动读取'}。",
        }
    )
    return {
        "bind_host": BIND_HOST,
        "port": port,
        "primary_ip": primary,
        "interfaces": interfaces,
        "candidates": candidates,
        "firewall": firewall,
        "selfcheck": selfcheck,
        "hints": hints,
    }


def _lan_diagnostics(port: int, force: bool = False) -> dict[str, Any]:
    now = time.time()
    if not force and _diag_cache["data"] and now - _diag_cache["at"] < 60:
        return _diag_cache["data"]
    data = _collect_lan_diagnostics(port, force=force)
    with _diag_lock:
        _diag_cache.update(at=now, data=data)
    return data


def _qr_png(text: str) -> Response:
    try:
        import qrcode
        from qrcode.constants import ERROR_CORRECT_M
    except Exception as exc:
        return Response(
            json.dumps({"error": f"二维码组件未安装：{exc}"}, ensure_ascii=False),
            status=503,
            mimetype="application/json",
        )
    qr = qrcode.QRCode(version=None, error_correction=ERROR_CORRECT_M, box_size=8, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    image = qr.make_image(fill_color="#152432", back_color="white")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    response = Response(buffer.getvalue(), mimetype="image/png")
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


def _mobile_invalid_page() -> str:
    return """<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fb;font-family:'Microsoft YaHei',sans-serif;color:#152432">
<div style="max-width:320px;padding:32px 24px;text-align:center">
<div style="width:58px;height:58px;margin:0 auto 18px;border-radius:16px;background:#e6eff9;color:#2b6cb0;display:grid;place-items:center;font-size:28px">!</div>
<h2 style="font-size:19px;margin:0 0 8px">链接已失效</h2>
<p style="font-size:12px;line-height:1.8;color:#52657e;margin:0">请回到电脑端「图片识题」重新扫描拍照二维码，或到「设置 → 手机访问」扫描完整系统二维码。</p>
</div></body>"""


def _lan_invalid_page() -> str:
    return """<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>错题簿 · 需要授权</title>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f7fb;font-family:'Microsoft YaHei',sans-serif;color:#152432">
<div style="max-width:340px;padding:36px 26px;text-align:center">
<div style="width:58px;height:58px;margin:0 auto 18px;border-radius:16px;background:#e6eff9;color:#2b6cb0;display:grid;place-items:center;font-size:28px">▣</div>
<h2 style="font-size:19px;margin:0 0 10px">请先扫码授权</h2>
<p style="font-size:12.5px;line-height:1.9;color:#52657e;margin:0">在电脑上打开「设置 → 手机访问」，用手机浏览器扫描二维码即可使用完整系统（概览、题库、练习、拍照识题等）。<br><br>电脑需保持开机，且手机与电脑连接同一个 Wi-Fi。</p>
</div></body></html>"""


@app.before_request
def guard_lan_access():
    """本机全部放行；局域网设备扫码授权后可使用完整系统。"""
    if _is_loopback(request.remote_addr):
        return None
    path = request.path
    if path.startswith("/static/") or path in {"/favicon.ico", "/manifest.webmanifest"}:
        return None
    # 两个扫码入口：/m/ 为仅拍照页，/p/ 为完整系统授权
    if path in {f"/m/{MOBILE_TOKEN}", f"/p/{MOBILE_TOKEN}"}:
        return None
    if path.startswith("/api/mobile/") and request.args.get("token") == MOBILE_TOKEN:
        return None
    # 已授权手机：所有页面与接口正常可用
    if request.cookies.get(LAN_COOKIE) == LAN_SESSION:
        return None
    if path.startswith("/m/") or path.startswith("/p/") or path == "/":
        return Response(_lan_invalid_page(), status=403, mimetype="text/html")
    return jsonify({"error": "请先在电脑端「设置 → 手机访问」扫码授权后再使用。"}), 403


def as_int(value: Any, default: int = 0, low: int | None = None, high: int | None = None) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    if low is not None:
        number = max(low, number)
    if high is not None:
        number = min(high, number)
    return number


def normalize_options(value: Any) -> dict[str, str]:
    if isinstance(value, dict):
        pairs = value.items()
    elif isinstance(value, list):
        pairs = zip("ABCDEFGH", value)
    else:
        pairs = []
    options: dict[str, str] = {}
    for key, text in pairs:
        letter = str(key).strip().upper()
        if letter not in "ABCDEFGH" or len(letter) != 1:
            continue
        content = clean_str(text, 2000)
        if content:
            options[letter] = content
    return {key: options[key] for key in sorted(options)}


def normalize_question(payload: dict[str, Any]) -> dict[str, Any]:
    stem = clean_str(payload.get("stem"), 8000)
    # 题干语义上是一句话：排版折行不该变成内容换行，统一合并成一行。
    stem = parser.merge_wrapped_lines(stem)
    qtype = clean_str(payload.get("qtype"), 20) or "single"
    if qtype not in {"single", "multiple", "truefalse", "fill"}:
        qtype = "single"
    options = normalize_options(payload.get("options"))
    answer = clean_str(payload.get("answer"), 1000)
    if qtype == "fill":
        options = {}
    elif qtype == "truefalse":
        # Judgment questions have no A/B/C/D options. The practice UI renders
        # the fixed pair 正确 / 错误 from the type itself.
        options = {}
        answer = parser.truefalse_value(answer) or answer
    elif qtype == "single":
        letters = parser.normalize_letters(answer)
        answer = letters[:1] if letters else answer
    elif qtype == "multiple":
        answer = parser.normalize_letters(answer) or answer

    tags = db.normalize_tags(payload.get("tags"), fallback=False)
    if not tags or tags == ["未分类"]:
        tags = [keyword_extractor.extract_tag(stem)] if stem else ["其他"]

    return {
        "qno": "",
        "stem": stem,
        "qtype": qtype,
        "options": options,
        "answer": answer,
        "explanation": clean_str(payload.get("explanation"), 12000),
        "tags": tags,
        "source_image": clean_source_image(payload.get("source_image")),
        "source_text": clean_str(payload.get("source_text"), 20000),
        "note": clean_str(payload.get("note"), 2000),
        "user_answer": clean_str(payload.get("user_answer"), 1000),
        "was_wrong": bool(payload.get("was_wrong")),
    }


def clean_source_image(value: Any) -> str:
    """Accept both the upload folder and the archived question-image folder."""
    text = clean_str(value, 500).replace("\\", "/").lstrip("/")
    if not db.is_image_ref(text):
        return ""
    return text if db.resolve_image(text) else ""


def question_fingerprint(stem: str) -> str:
    return db.fingerprint(stem)


def insert_question(conn: sqlite3.Connection, data: dict[str, Any], mark_wrong: bool = False) -> int:
    created = db.now()
    fingerprint = question_fingerprint(data["stem"])
    qno = db.next_qno(conn, data["qtype"])
    # 记录原图内容指纹，供“同一张图重复上传”判断使用
    image_digest = ""
    src_file = db.resolve_image(data.get("source_image") or "")
    if src_file:
        image_digest = _image_digest(src_file)
    cursor = conn.execute(
        """
        INSERT INTO questions
        (qno, stem, qtype, options, answer, explanation, tags, source_image,
         source_text, note, fingerprint, image_digest, wrong_count, correct_count, streak,
         mastery, last_practiced_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)
        """,
        (
            qno,
            data["stem"],
            data["qtype"],
            json.dumps(data["options"], ensure_ascii=False),
            data["answer"],
            data["explanation"],
            json.dumps(data["tags"], ensure_ascii=False),
            data["source_image"],
            data["source_text"],
            data["note"],
            fingerprint,
            image_digest,
            1 if mark_wrong else 0,
            1 if mark_wrong else 0,
            created if mark_wrong else None,
            created,
            created,
        ),
    )
    question_id = int(cursor.lastrowid)
    if mark_wrong:
        conn.execute(
            """
            INSERT INTO attempts(question_id, user_answer, correct_answer, is_correct,
                                 mode, duration_ms, created_at)
            VALUES (?, ?, ?, 0, 'import', 0, ?)
            """,
            (question_id, data["user_answer"], data["answer"], created),
        )
    return question_id


def tag_filter_sql(tags: list[str]) -> tuple[str, tuple[Any, ...]]:
    tags = [t for t in tags if t]
    if not tags:
        return "", ()
    clauses = " OR ".join("tags LIKE ?" for _ in tags)
    return f" AND ({clauses})", tuple(f'%"{t}"%' for t in tags)


# ---------------------------------------------------------------------------
# Pages / health
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    # 把练习模式的可用题量一起渲染进首屏：
    # 错题清零时直接默认选中「随机练习」，避免前端拿到数据前先闪一下错题重练
    return render_template("index.html", practice_counts=db.practice_mode_counts(get_db()), app_version=APP_VERSION)


@app.route("/api/health")
def health():
    return jsonify({"ok": True, "app": "wrongbook", "version": APP_VERSION})


def _archive_used_images(conn=None) -> dict[str, int]:
    """把已生成题目的原图同步到独立目录（幂等，可反复调用）。"""
    conn = conn or get_db()
    stats = db.sync_question_images(conn)
    conn.commit()
    return stats


@app.route("/uploads/<path:filename>")
def uploaded_file(filename: str):
    # 兼容旧链接：图片已归档到独立目录时，旧的 /uploads/ 地址仍然能打开
    path = db.resolve_image(f"uploads/{filename}")
    if path:
        return send_from_directory(path.parent, path.name, max_age=3600)
    return send_from_directory(db.UPLOAD_DIR, filename, max_age=3600)


@app.route("/question_images/<path:filename>")
def question_image_file(filename: str):
    path = db.resolve_image(f"question_images/{filename}")
    if path:
        return send_from_directory(path.parent, path.name, max_age=3600)
    return send_from_directory(db.QUESTION_IMAGE_DIR, filename, max_age=3600)


# ---------------------------------------------------------------------------
# Overview / stats
# ---------------------------------------------------------------------------
@app.route("/api/overview")
def api_overview():
    return jsonify(db.overview(get_db()))


@app.route("/api/stats")
def api_stats():
    return jsonify(db.stats(get_db()))


# ---- 标签自然排序（拼音 + 数字感知）-----------------------------------------
# 选标签下拉框按拼音 A–Z 排列更顺手；名字里含数字时按数值排（如「第2章」<「第10章」）。
# 用系统中文 locale 的 strxfrm 做拼音排序，完全离线；若环境没有中文 locale 就退回字符序。
try:
    locale.setlocale(locale.LC_COLLATE, "zh_CN.UTF-8")
    _PINYIN_SORT = True
except locale.Error:
    try:
        locale.setlocale(locale.LC_COLLATE, "Chinese_China.936")
        _PINYIN_SORT = True
    except locale.Error:
        _PINYIN_SORT = False


def _tag_sort_key(item: tuple[str, int]):
    name, count = item[0], item[1]
    # 拆成「数字段 / 非数字段」交替，数字段按数值比，文字段按拼音比
    parts = re.split(r"(\d+)", name)
    key = []
    for part in parts:
        if not part:
            continue
        if part.isdigit():
            key.append((0, int(part)))
        else:
            key.append((1, locale.strxfrm(part) if _PINYIN_SORT else part))
    return (key, -count)


def _tags_payload(conn: sqlite3.Connection) -> dict[str, Any]:
    """实时聚合标签，并给出内容指纹作为前端缓存的 revision。"""
    counts: dict[str, int] = {}
    for row in conn.execute("SELECT tags FROM questions WHERE archived=0"):
        try:
            tags = json.loads(row["tags"] or "[]")
        except json.JSONDecodeError:
            tags = []
        for tag in tags:
            counts[tag] = counts.get(tag, 0) + 1
    items = [
        {"name": name, "count": count}
        for name, count in sorted(counts.items(), key=_tag_sort_key)
    ]
    # 名称 + 计数一起参与哈希：新增标签、题目数变化、标签改名都会让 revision 改变
    fingerprint = "\n".join(f"{item['name']}\t{item['count']}" for item in items)
    return {
        "items": items,
        "revision": hashlib.sha1(fingerprint.encode("utf-8")).hexdigest()[:16],
    }


@app.route("/api/tags")
def api_tags():
    payload = _tags_payload(get_db())
    since = clean_str(request.args.get("since"), 32)
    # 标签没变时只回一个几十字节的确认，前端继续用缓存
    body = (
        {"revision": payload["revision"], "unchanged": True}
        if since and since == payload["revision"]
        else payload
    )
    response = jsonify(body)
    response.headers["Cache-Control"] = "no-store, max-age=0"
    return response


# ---------------------------------------------------------------------------
# Question CRUD
# ---------------------------------------------------------------------------
@app.route("/api/questions", methods=["GET"])
def api_questions():
    conn = get_db()
    keyword = clean_str(request.args.get("q"), 200)
    qtype = clean_str(request.args.get("type"), 20)
    tags = [clean_str(t, 50) for t in request.args.getlist("tag")]
    status = clean_str(request.args.get("status"), 20)
    sort = clean_str(request.args.get("sort"), 20) or "recent"
    scope = clean_str(request.args.get("scope"), 20)
    page = as_int(request.args.get("page"), 1, 1, 100000)
    per_page = as_int(request.args.get("per_page"), 12, 1, 100)

    where = ["archived=0"]
    params: list[Any] = []
    if keyword:
        # 默认只搜「题目本身」：题干、编号、标签。选项里常有干扰项、解析会
        # 复述题干、source_text 是整张卷子的 OCR 原文，把它们放进默认范围会
        # 混进「题干与关键词毫无关系」的结果（例如干扰项恰好含关键词）。
        # 需要深挖选项/解析时，由前端显式传 scope=all 打开。
        fields = ["stem", "qno", "tags"]
        if scope == "all":
            fields += ["options", "explanation", "source_text"]
        like = f"%{keyword}%"
        where.append("(" + " OR ".join(f"{field} LIKE ?" for field in fields) + ")")
        params.extend([like] * len(fields))
    if qtype in {"single", "multiple", "truefalse", "fill"}:
        where.append("qtype=?")
        params.append(qtype)
    if tags:
        clause, extra = tag_filter_sql(tags)
        where.append(clause.removeprefix(" AND "))
        params.extend(extra)
    if status == "wrong":
        where.append("wrong_count>0 AND mastery<3")
    elif status == "mastered":
        where.append("mastery>=3")
    elif status == "new":
        where.append("wrong_count=0 AND correct_count=0")
    elif status == "ready":
        where.append("answer<>''")

    order = {
        "recent": "id DESC",
        "oldest": "id ASC",
        "wrong": "wrong_count DESC, mastery ASC, id DESC",
        "mastery": "mastery ASC, wrong_count DESC, id DESC",
    }.get(sort, "id DESC")

    where_sql = " AND ".join(where)
    total = conn.execute(
        f"SELECT COUNT(*) AS n FROM questions WHERE {where_sql}", params
    ).fetchone()["n"]
    rows = conn.execute(
        f"""
        SELECT * FROM questions WHERE {where_sql}
        ORDER BY {order} LIMIT ? OFFSET ?
        """,
        [*params, per_page, (page - 1) * per_page],
    ).fetchall()

    return jsonify(
        {
            "items": [db.serialize_question(row) for row in rows],
            "total": total,
            "page": page,
            "per_page": per_page,
            "pages": max(1, (total + per_page - 1) // per_page),
        }
    )


@app.route("/api/questions", methods=["POST"])
def api_create_question():
    payload = request.get_json(silent=True) or {}
    data = normalize_question(payload)
    if not data["stem"]:
        return jsonify({"error": "题干不能为空"}), 400
    if data["qtype"] in {"single", "multiple"} and data["answer"]:
        letters = parser.normalize_letters(data["answer"])
        if letters and any(letter not in data["options"] for letter in letters):
            return jsonify({"error": "答案包含不存在的选项"}), 400

    conn = get_db()
    existing = db.find_duplicate_question(conn, data["stem"], threshold=0.9)
    if existing:
        return jsonify({"error": "题库中已有高度相似的题目", "id": existing["id"]}), 409
    try:
        mark_wrong = bool(payload.get("was_wrong")) and bool(data["user_answer"])
        question_id = insert_question(conn, data, mark_wrong=mark_wrong)
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()
        return jsonify({"error": "题库中已有相同题干的题目"}), 409
    # 题目一旦入库，它的原图就搬到独立目录，不再混在未使用的上传图片里
    _archive_used_images(conn)
    row = db.get_question(conn, question_id)
    return jsonify({"item": db.serialize_question(row)}), 201


@app.route("/api/questions/<int:question_id>", methods=["GET"])
def api_get_question(question_id: int):
    conn = get_db()
    row = db.get_question(conn, question_id)
    if not row:
        return jsonify({"error": "题目不存在"}), 404
    item = db.serialize_question(row)
    # 图片里选的答案与「是不是错题」存在 attempts 里，编辑 / 详情弹窗也要能看到
    imported = conn.execute(
        "SELECT user_answer FROM attempts "
        "WHERE question_id=? AND mode='import' ORDER BY id DESC LIMIT 1",
        (question_id,),
    ).fetchone()
    item["user_answer"] = (imported["user_answer"] if imported else "") or ""
    item["was_wrong"] = bool(row["wrong_count"])
    return jsonify({"item": item})


@app.route("/api/questions/<int:question_id>", methods=["PUT"])
def api_update_question(question_id: int):
    conn = get_db()
    row = db.get_question(conn, question_id)
    if not row:
        return jsonify({"error": "题目不存在"}), 404
    payload = request.get_json(silent=True) or {}
    data = normalize_question(payload)
    if not data["stem"]:
        return jsonify({"error": "题干不能为空"}), 400
    if data["qtype"] in {"single", "multiple"} and data["answer"]:
        letters = parser.normalize_letters(data["answer"])
        if letters and any(letter not in data["options"] for letter in letters):
            return jsonify({"error": "答案包含不存在的选项"}), 400
    fingerprint = question_fingerprint(data["stem"])
    conflict = db.find_duplicate_question(conn, data["stem"], threshold=0.9, exclude_id=question_id)
    if conflict:
        return jsonify({"error": "题库中已有高度相似的题目", "id": conflict["id"]}), 409
    new_qno = (
        row["qno"]
        if row["qtype"] == data["qtype"]
        else db.next_qno(conn, data["qtype"])
    )
    try:
        conn.execute(
            """
            UPDATE questions SET qno=?, stem=?, qtype=?, options=?, answer=?,
                explanation=?, tags=?, note=?, source_image=?, source_text=?,
                fingerprint=?, updated_at=?
            WHERE id=?
            """,
            (
                new_qno,
                data["stem"],
                data["qtype"],
                json.dumps(data["options"], ensure_ascii=False),
                data["answer"],
                data["explanation"],
                json.dumps(data["tags"], ensure_ascii=False),
                data["note"],
                data["source_image"] or row["source_image"],
                data["source_text"] or row["source_text"],
                fingerprint,
                db.now(),
                question_id,
            ),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.rollback()
        return jsonify({"error": "题库中已有相同题干的题目"}), 409
    _archive_used_images(conn)
    row = db.get_question(conn, question_id)
    return jsonify({"item": db.serialize_question(row)})


@app.route("/api/questions/<int:question_id>", methods=["DELETE"])
def api_delete_question(question_id: int):
    conn = get_db()
    row = db.get_question(conn, question_id)
    if not row:
        return jsonify({"error": "题目不存在"}), 404
    conn.execute("DELETE FROM questions WHERE id=?", (question_id,))
    conn.commit()
    # 题目删掉后，它的原图退回 uploads/，仍可在「已上传图片」里查看或删除
    _archive_used_images(conn)
    return jsonify({"ok": True})


@app.route("/api/questions/<int:question_id>/master", methods=["POST"])
def api_master_question(question_id: int):
    conn = get_db()
    row = db.get_question(conn, question_id)
    if not row:
        return jsonify({"error": "题目不存在"}), 404
    conn.execute(
        "UPDATE questions SET mastery=3, streak=3, updated_at=? WHERE id=?",
        (db.now(), question_id),
    )
    conn.commit()
    return jsonify({"ok": True})


@app.route("/api/questions/<int:question_id>/reset", methods=["POST"])
def api_reset_question(question_id: int):
    conn = get_db()
    row = db.get_question(conn, question_id)
    if not row:
        return jsonify({"error": "题目不存在"}), 404
    conn.execute(
        "UPDATE questions SET mastery=0, streak=0, wrong_count=0, correct_count=0, updated_at=? WHERE id=?",
        (db.now(), question_id),
    )
    conn.execute("DELETE FROM attempts WHERE question_id=?", (question_id,))
    conn.commit()
    return jsonify({"ok": True})


@app.route("/api/questions/<int:question_id>/mark-wrong", methods=["POST"])
def api_mark_question_wrong(question_id: int):
    """把题库中已存在的题目再次标记为「回答错误」。

    用于图片识题时上传了与题库中某题高度相似的截图：除标记重复外，
    可直接给该题记一次错误（错误次数 +1、连对清零、掌握度降为待攻克）。
    """
    conn = get_db()
    row = db.get_question(conn, question_id)
    if not row:
        return jsonify({"error": "题目不存在"}), 404
    now = db.now()
    conn.execute(
        """
        UPDATE questions SET wrong_count=wrong_count+1, streak=0, mastery=1,
            last_practiced_at=?, updated_at=? WHERE id=?
        """,
        (now, now, question_id),
    )
    conn.commit()
    updated = db.get_question(conn, question_id)
    return jsonify(
        {
            "ok": True,
            "question_id": question_id,
            "wrong_count": updated["wrong_count"],
            "mastery": updated["mastery"],
            "streak": updated["streak"],
        }
    )


# ---------------------------------------------------------------------------
# OCR import
# ---------------------------------------------------------------------------
def _save_image(file_storage) -> tuple[Path, str]:
    original = file_storage.filename or "pasted.png"
    suffix = Path(original).suffix.lower().lstrip(".")
    if suffix not in ALLOWED_EXTENSIONS:
        suffix = "png"
    filename = f"{datetime.now().strftime('%Y%m%d')}_{uuid.uuid4().hex[:12]}.{suffix}"
    target = db.UPLOAD_DIR / filename
    file_storage.save(target)
    if target.stat().st_size > MAX_IMAGE_BYTES:
        target.unlink(missing_ok=True)
        raise ValueError("单张图片不能超过 25MB")
    try:
        with Image.open(target) as image:
            image.verify()
    except (UnidentifiedImageError, OSError) as exc:
        target.unlink(missing_ok=True)
        raise ValueError("无法识别的图片格式") from exc
    return target, filename


def _image_digest(path: Path) -> str:
    """Content hash of an uploaded image, used to spot duplicate screenshots."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


@app.route("/api/ocr", methods=["POST"])
def api_ocr():
    files = request.files.getlist("images")
    if not files:
        single = request.files.get("image")
        files = [single] if single else []
    files = [item for item in files if item and item.filename]
    if not files:
        return jsonify({"error": "请选择或粘贴至少一张图片"}), 400

    conn = get_db()
    # 题库全部题目（用于近似重复判重，一次取出，后续复用）
    qrows = conn.execute("SELECT id, stem, fingerprint FROM questions").fetchall()
    # 已经导入过的图片哈希：用于识别「重复上传的同一张图」
    known_digests = db.known_image_digests(conn)
    # 真正被题库题目使用的图片内容指纹：只有这些图片重复时才算“真重复”并提示
    used_digest_paths = {
        row["image_digest"]: row["source_image"]
        for row in conn.execute(
            "SELECT image_digest, source_image FROM questions WHERE image_digest <> ''"
        ).fetchall()
    }
    # 本次上传批次内已经出现过的哈希：同一批里重复选同一张图也要能发现
    batch_digests: dict[str, str] = {}
    drafts: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    errors: list[dict[str, str]] = []
    duplicates: list[dict[str, Any]] = []

    for upload in files[:12]:
        try:
            path, filename = _save_image(upload)
            image_url = f"uploads/{filename}"
            digest = _image_digest(path)

            # 判定重复：
            #  - 本批次内重复选同一张图 → 直接算重复（与是否入库无关）
            #  - 历史上传过的图 → 仅当该图内容（digest）已被某个题库题目使用时才算
            #    “真重复”并提示；若只是上次上传过但并未保存题目，则视为重新上传，
            #    替换旧记录、不提示、默认加入题库。
            duplicate_of = ""
            if digest in batch_digests:
                duplicate_of = batch_digests[digest]
            elif digest in used_digest_paths:
                duplicate_of = used_digest_paths[digest]
            elif digest in known_digests:
                # 图片内容出现过，但没有对应已保存的题目 → 用本次上传替换旧记录
                db.replace_image_digest(conn, digest, image_url)
            if not duplicate_of:
                batch_digests[digest] = image_url

            ocr_result = ocr_engine.recognize(path)
            parsed = parser.parse_lines(ocr_result["lines"], image_url=image_url)
            for draft in parsed:
                draft["fingerprint"] = question_fingerprint(draft["stem"])
                dup = db.find_duplicate_question(conn, draft["stem"], threshold=0.9, rows=qrows)
                draft["duplicate"] = bool(dup)
                if dup:
                    draft["duplicate_question_id"] = dup["id"]
                draft["source_image"] = image_url
                draft["image_url"] = image_url
                draft["image_duplicate"] = bool(duplicate_of)
                if duplicate_of:
                    draft["duplicate_of"] = duplicate_of
                drafts.append(draft)
            conn.execute(
                "INSERT INTO imports(image_path, raw_text, line_json, created_at) VALUES (?, ?, ?, ?)",
                (
                    image_url,
                    ocr_result["raw_text"],
                    json.dumps(ocr_result["lines"], ensure_ascii=False),
                    db.now(),
                ),
            )
            db.record_image_digest(conn, digest, image_url)
            results.append(
                {
                    "filename": upload.filename,
                    "image_url": image_url,
                    "raw_text": ocr_result["raw_text"],
                    "line_count": ocr_result["line_count"],
                    "elapsed": ocr_result["elapsed"],
                    "questions": len(parsed),
                    "duplicate": bool(duplicate_of),
                    "duplicate_of": duplicate_of or "",
                }
            )
            if duplicate_of:
                duplicates.append(
                    {
                        "filename": upload.filename,
                        "image_url": image_url,
                        "duplicate_of": duplicate_of,
                        "questions": len(parsed),
                    }
                )
        except Exception as exc:  # Keep processing other images
            errors.append({"filename": upload.filename or "图片", "error": str(exc)})

    if not drafts and errors:
        conn.rollback()
        return jsonify({"error": errors[0]["error"], "errors": errors}), 400
    conn.commit()
    return jsonify(
        {
            "drafts": drafts,
            "results": results,
            "errors": errors,
            "duplicates": duplicates,
            "engine": ocr_engine.engine_status(),
        }
    )


@app.route("/api/ocr/corrections")
def api_ocr_corrections():
    return jsonify({"corrections": db.list_corrections()})


@app.route("/api/uploads/<name>", methods=["DELETE"])
def api_delete_upload(name: str):
    """Delete an uploaded image (and its import record) from the local disk."""
    if not name or "/" in name or ".." in name:
        return jsonify({"error": "无效的文件名"}), 400
    target = db.UPLOAD_DIR / name
    if not target.exists():
        return jsonify({"error": "文件不存在"}), 404
    conn = get_db()
    rel = f"uploads/{name}"
    archived_rel = f"question_images/{name}"
    # 图片若仍被题目引用，删除文件会让题目「有原图」变成「无原图」
    used = conn.execute(
        "SELECT COUNT(*) AS n FROM questions WHERE source_image IN (?, ?)",
        (rel, archived_rel),
    ).fetchone()["n"]
    if used:
        return jsonify({"error": "该图片仍被题库题目引用，请先删除对应题目"}), 400
    conn.execute("DELETE FROM imports WHERE image_path IN (?, ?)", (rel, archived_rel))
    conn.execute("DELETE FROM image_hashes WHERE image_path IN (?, ?)", (rel, archived_rel))
    conn.commit()
    target.unlink(missing_ok=True)
    return jsonify({"ok": True, "deleted": rel})


@app.route("/api/uploads")
def api_list_uploads():
    """List every image currently stored under uploads/ so the user can browse
    what has already been uploaded and see which ones are referenced by questions."""
    conn = get_db()
    items: list[dict[str, Any]] = []
    # 每张图当初识别时的 OCR 文本：没关联题目的图也能按内容搜索到
    ocr_texts = {
        row["image_path"]: (row["raw_text"] or "")
        for row in conn.execute(
            "SELECT image_path, raw_text FROM imports WHERE image_path LIKE 'uploads/%'"
        ).fetchall()
    }
    if db.UPLOAD_DIR.exists():
        exts = (".png", ".jpg", ".jpeg", ".webp", ".bmp")
        for f in sorted(db.UPLOAD_DIR.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if f.is_file() and f.name.lower().endswith(exts):
                rel = f"uploads/{f.name}"
                refs = conn.execute(
                    "SELECT id, qno, stem FROM questions WHERE source_image=? ORDER BY id",
                    (rel,),
                ).fetchall()
                items.append(
                    {
                        "name": f.name,
                        "url": f"/{rel}",
                        "size": f.stat().st_size,
                        "mtime": int(f.stat().st_mtime),
                        "used_by": len(refs),
                        # 关联的题目（题号 + 题干），方便用户认出这是哪张图
                        "questions": [
                            {"id": r["id"], "qno": r["qno"], "stem": r["stem"]}
                            for r in refs
                        ],
                        # 当初 OCR 识别出来的文字（截断），用于按内容搜索
                        "ocr_text": ocr_texts.get(rel, "")[:400],
                    }
                )
    return jsonify({"uploads": items})


# ---------------------------------------------------------------------------
# 题目原图：已生成题目的图片单独存放在 data/question_images/
# ---------------------------------------------------------------------------
@app.route("/api/question-images")
def api_list_question_images():
    """Browse the archived originals, with the question each one produced."""
    conn = get_db()
    by_name: dict[str, list[dict[str, Any]]] = {}
    for row in conn.execute(
        "SELECT id, qno, stem, source_image FROM questions WHERE source_image <> ''"
    ).fetchall():
        name = db.image_name(row["source_image"])
        if not name:
            continue
        by_name.setdefault(name, []).append(
            {"id": row["id"], "qno": row["qno"], "stem": row["stem"]}
        )
    items: list[dict[str, Any]] = []
    if db.QUESTION_IMAGE_DIR.exists():
        for file in sorted(
            db.QUESTION_IMAGE_DIR.iterdir(),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        ):
            if not file.is_file() or file.name.lower().endswith(".csv"):
                continue
            refs = by_name.get(file.name, [])
            items.append(
                {
                    "name": file.name,
                    "url": f"/question_images/{file.name}",
                    "size": file.stat().st_size,
                    "mtime": int(file.stat().st_mtime),
                    "used_by": len(refs),
                    "questions": refs,
                }
            )
    unused = (
        sum(1 for f in db.UPLOAD_DIR.glob("*") if f.is_file())
        if db.UPLOAD_DIR.exists()
        else 0
    )
    return jsonify(
        {
            "folder": str(db.QUESTION_IMAGE_DIR),
            "index_file": str(db.QUESTION_IMAGE_DIR / db.QUESTION_IMAGE_INDEX),
            "images": items,
            "total": len(items),
            "unused_uploads": unused,
        }
    )


@app.route("/api/question-images/sync", methods=["POST"])
def api_sync_question_images():
    """Re-run the one-folder-for-used-images rule (idempotent)."""
    stats = _archive_used_images()
    return jsonify({"ok": True, **stats})


def _upload_path(name: str) -> Path | None:
    """按文件名找图片（uploads/ 或已归档目录），挡住目录穿越。"""
    if not name or "/" in name or "\\" in name or ".." in name:
        return None
    for folder in (db.UPLOAD_DIR, db.QUESTION_IMAGE_DIR):
        path = folder / name
        if path.is_file():
            return path
    return None


@app.route("/api/uploads/<name>/recognize", methods=["POST"])
def api_recognize_upload(name: str):
    """识别一张「还没关联题目」的已上传图片，并拿去和题库比对。

    · 题干在题库里找到了同一道题 → 直接把当前图片关联到那道题；
    · 找到了同一道题、但那道题已经有原图 → 不覆盖，提示用户删除「当前这张图片」；
    · 题库里没有 → 把识别出的题目返回给前端，由用户决定是否入库。
    """
    path = _upload_path(name)
    if not path:
        return jsonify({"error": "文件不存在"}), 404
    payload = request.get_json(silent=True) or {}
    mode = (clean_str(payload.get("mode"), 10) or "ocr").lower()
    if mode not in {"ocr", "ai"}:
        mode = "ocr"
    # 用户可给大模型一句补充提示（如「答案应为 B」「选项顺序有误」），仅 AI 模式生效
    correction = clean_str(payload.get("correction"), 4000)
    conn = get_db()
    rel = f"uploads/{name}"
    used = conn.execute(
        "SELECT COUNT(*) AS n FROM questions WHERE source_image IN (?, ?)",
        (rel, f"question_images/{name}"),
    ).fetchone()["n"]
    if used:
        return jsonify({"error": "该图片已关联题目，无需重复识别"}), 409

    # 先跑本地 OCR：既能给大模型当参考，也能在大模型失败时兜底
    try:
        ocr_result = ocr_engine.recognize(path)
        parsed = parser.parse_lines(ocr_result["lines"], image_url=rel)
    except Exception as exc:
        return jsonify({"error": f"识别失败：{exc}"}), 500

    ai_draft: dict[str, Any] | None = None
    ai_error = ""
    ai_model = ""
    if mode == "ai":
        hint = (ocr_result.get("raw_text") or "")[:6000]
        raw, ai_error = llm_client.parse_question_image(path, hint, correction)
        if raw:
            ai_draft = _draft_from_ai(raw)
        cfg = llm_client.load_config()
        active = llm_client.get_active()
        ai_model = (active or {}).get("model", "") if cfg.get("enabled") else ""

    # 候选题目：AI 结果优先（更干净），OCR 结果兜底
    candidates: list[tuple[dict[str, Any], str]] = []
    if ai_draft and ai_draft["stem"]:
        candidates.append((ai_draft, "ai"))
    for draft in parsed:
        stem = (draft.get("stem") or "").strip()
        if not stem:
            continue
        if any(stem == c[0].get("stem") for c in candidates):
            continue
        candidates.append((draft, "ocr"))

    qrows = conn.execute(
        "SELECT id, qno, stem, fingerprint, source_image FROM questions"
    ).fetchall()
    digest = _image_digest(path)
    results: list[dict[str, Any]] = []
    linked = 0
    conflicts: list[dict[str, Any]] = []
    seen_matches: set[int] = set()
    for draft, source in candidates:
        stem = draft.get("stem", "")
        match = db.find_duplicate_question(conn, stem, threshold=0.9, rows=qrows)
        # AI 与 OCR 可能都认出同一道题，只保留先出现的那条（AI 优先）
        if match and match["id"] in seen_matches:
            continue
        if match:
            seen_matches.add(match["id"])
        stem = draft.get("stem", "")
        match = db.find_duplicate_question(conn, stem, threshold=0.9, rows=qrows)
        item: dict[str, Any] = {
            "stem": stem,
            "qtype": draft.get("qtype", "single"),
            "options": draft.get("options", {}),
            "answer": draft.get("answer", ""),
            "explanation": draft.get("explanation", ""),
            "tags": draft.get("tags", []),
            # 图片里选的答案 / 是否答错：加入题库时要一起带上，否则新题不带错题标记
            "user_answer": str(draft.get("user_answer") or "").strip(),
            "was_wrong": bool(draft.get("was_wrong")),
            "confidence": draft.get("confidence", 0),
            "source": source,
            "status": "new",
            "match": None,
        }
        if match:
            mrow = next((r for r in qrows if r["id"] == match["id"]), None)
            match_info = {
                "id": match["id"],
                "qno": mrow["qno"] if mrow else "",
                "stem": mrow["stem"] if mrow else "",
                "similarity": match["similarity"],
                "source_image": mrow["source_image"] if mrow else "",
            }
            item["match"] = match_info
            if match_info["source_image"]:
                # 这道题已经有原图 → 提示删除「当前这张图片」，不覆盖题库里的原图
                item["status"] = "conflict"
                conflicts.append(match_info)
            else:
                conn.execute(
                    "UPDATE questions SET source_image=?, image_digest=?, updated_at=? WHERE id=?",
                    (rel, digest, db.now(), match["id"]),
                )
                match_info["source_image"] = rel
                item["status"] = "linked"
                linked += 1
        results.append(item)
    conn.commit()
    # 关联成功的图片立刻归档；未匹配的图仍留在 uploads/ 等用户决定
    stats = _archive_used_images(conn)
    if stats.get("moved"):
        new_rel = f"question_images/{name}"
        for item in results:
            match_info = item.get("match")
            if match_info and match_info.get("source_image") == rel:
                match_info["source_image"] = new_rel
        rel = new_rel
    return jsonify(
        {
            "image": {"name": name, "url": f"/{rel}"},
            "mode": mode,
            "ai_model": ai_model,
            "ai_error": ai_error,
            "questions": results,
            "linked": linked,
            "conflicts": conflicts,
            "elapsed": ocr_result.get("elapsed"),
            "engine": ocr_engine.engine_status(),
        }
    )


def _draft_from_ai(data: dict[str, Any]) -> dict[str, Any]:
    """把大模型返回的 JSON 归一成与本地 draft 一样的结构。"""
    raw_options = data.get("options")
    options: dict[str, str] = {}
    if isinstance(raw_options, dict):
        for key, value in raw_options.items():
            letter = str(key).strip().upper()[:1]
            text = str(value).strip()
            if letter and text:
                options[letter] = text
    qtype = str(data.get("qtype") or "single").strip().lower()
    if qtype not in {"single", "multiple", "truefalse", "fill"}:
        qtype = "single"
    raw_tags = data.get("tags")
    tags: list[str] = []
    if isinstance(raw_tags, str):
        tags = [t.strip() for t in re.split(r"[,，、;；]", raw_tags)]
    elif isinstance(raw_tags, list):
        tags = [str(t).strip() for t in raw_tags]
    return {
        "stem": parser.merge_wrapped_lines(str(data.get("stem") or "").strip()),
        "qtype": qtype,
        "options": options,
        "answer": str(data.get("answer") or "").strip(),
        "explanation": str(data.get("explanation") or "").strip(),
        "tags": [t[:24] for t in tags if t][:6],
        "user_answer": str(data.get("user_answer") or "").strip(),
        "was_wrong": bool(data.get("was_wrong")),
        "confidence": 1.0,
    }


@app.route("/api/questions/<int:question_id>/rerecognize", methods=["POST"])
def api_rerecognize_question(question_id: int):
    """按原图重新识别一道题（本地 OCR 或大模型）。

    只返回识别结果，不直接改题库——由前端展示给用户确认后再保存。"""
    conn = get_db()
    row = db.get_question(conn, question_id)
    if not row:
        return jsonify({"error": "题目不存在"}), 404
    # 「图片中的作答 / 是否错题」不存在 questions 表里，而是在导入时的作答记录中。
    # 重新识别只覆盖识别字段，这里把原有信息带出去，让用户确认它不会被改掉。
    imported = conn.execute(
        "SELECT user_answer, correct_answer FROM attempts "
        "WHERE question_id=? AND mode='import' ORDER BY id DESC LIMIT 1",
        (question_id,),
    ).fetchone()
    keep = {
        "user_answer": (imported["user_answer"] if imported else "") or "",
        "correct_answer": (imported["correct_answer"] if imported else "") or "",
        "wrong_count": row["wrong_count"] or 0,
        "correct_count": row["correct_count"] or 0,
        "was_wrong": bool(row["wrong_count"]),
    }
    src = (row["source_image"] or "").strip()
    if not db.is_image_ref(src):
        return jsonify({"error": "这道题没有原图，无法重新识别"}), 400
    path = db.resolve_image(src) or _upload_path(src.split("/", 1)[1])
    if not path:
        return jsonify({"error": "原图文件不存在"}), 404
    payload = request.get_json(silent=True) or {}
    mode = (clean_str(payload.get("mode"), 10) or "ocr").lower()
    if mode not in {"ocr", "ai"}:
        mode = "ocr"
    # 与采集页「纠正说明」一致：所有编辑入口都能给大模型一句补充提示
    correction = clean_str(payload.get("correction"), 4000)
    try:
        ocr_result = ocr_engine.recognize(path)
        parsed = parser.parse_lines(ocr_result["lines"], image_url=src)
    except Exception as exc:
        return jsonify({"error": f"识别失败：{exc}"}), 500

    ai_draft: dict[str, Any] | None = None
    ai_error = ""
    if mode == "ai":
        raw, ai_error = llm_client.parse_question_image(
            path, (ocr_result.get("raw_text") or "")[:6000], correction
        )
        if raw:
            ai_draft = _draft_from_ai(raw)

    draft: dict[str, Any] | None = None
    source = "ocr"
    if ai_draft and ai_draft["stem"]:
        draft, source = ai_draft, "ai"
    elif parsed:
        # 一张图可能切出多段，取跟当前题干最接近的一段
        draft = _closest_draft(parsed, row["stem"] or "")
    if not draft or not draft.get("stem"):
        return jsonify({"error": "没有识别出题目内容", "ai_error": ai_error}), 400
    return jsonify(
        {
            "draft": {
                "stem": draft.get("stem", ""),
                "qtype": draft.get("qtype", "single"),
                "options": draft.get("options", {}),
                "answer": draft.get("answer", ""),
                "explanation": draft.get("explanation", ""),
                "tags": draft.get("tags", []),
            },
            "source": source,
            "mode": mode,
            "ai_error": ai_error,
            "keep": keep,
        }
    )


def _closest_draft(drafts: list[dict[str, Any]], stem: str) -> dict[str, Any] | None:
    """从多段识别结果里挑出与原题干最接近的一段。"""
    target = db.soft_normalize(stem or "")
    best: dict[str, Any] | None = None
    best_score = -1.0
    for draft in drafts:
        cand = db.soft_normalize(draft.get("stem") or "")
        if not cand:
            continue
        score = db.containment(target, cand) if target else 0.0
        if score > best_score:
            best, best_score = draft, score
    return best or (drafts[0] if drafts else None)


@app.route("/api/uploads/<name>/unlink", methods=["POST"])
def api_unlink_upload(name: str):
    """取消这张图片与题目的关联（自动关联错了时可撤销）。"""
    if not _upload_path(name):
        return jsonify({"error": "文件不存在"}), 404
    conn = get_db()
    rel = f"uploads/{name}"
    cursor = conn.execute(
        "UPDATE questions SET source_image='', image_digest='', updated_at=? "
        "WHERE source_image IN (?, ?)",
        (db.now(), rel, f"question_images/{name}"),
    )
    conn.commit()
    # 取消关联后把原图退回 uploads/，它又会出现在「已上传图片」里
    _archive_used_images(conn)
    return jsonify({"ok": True, "unlinked": cursor.rowcount})


@app.route("/api/ocr/corrections", methods=["POST"])
def api_ocr_correction_add():
    payload = request.get_json(silent=True) or {}
    wrong = clean_str(payload.get("wrong"), 200)
    right = clean_str(payload.get("right"), 200)
    try:
        cid = db.add_correction(wrong, right)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    ocr_engine.refresh_corrections()
    return (
        jsonify(
            {
                "correction": {
                    "id": cid,
                    "wrong": wrong,
                    "right": right,
                    "created_at": db.now(),
                }
            }
        ),
        201,
    )


@app.route("/api/ocr/corrections/<int:cid>", methods=["DELETE"])
def api_ocr_correction_delete(cid):
    db.delete_correction(cid)
    ocr_engine.refresh_corrections()
    return jsonify({"ok": True})


@app.route("/api/questions/bulk", methods=["POST"])
def api_bulk_create():
    payload = request.get_json(silent=True) or {}
    items = payload.get("questions")
    if not isinstance(items, list) or not items:
        return jsonify({"error": "没有可导入的题目"}), 400
    conn = get_db()
    created: list[int] = []
    skipped: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []

    for index, raw in enumerate(items):
        if not isinstance(raw, dict):
            continue
        data = normalize_question(raw)
        if not data["stem"]:
            errors.append({"index": index, "error": "题干为空"})
            continue
        fingerprint = question_fingerprint(data["stem"])
        exists = db.find_duplicate_question(conn, data["stem"], threshold=0.9)
        if exists:
            skipped.append({"index": index, "id": exists["id"], "reason": "已存在"})
            continue
        mark_wrong = bool(raw.get("was_wrong")) and bool(data["user_answer"])
        try:
            question_id = insert_question(conn, data, mark_wrong=mark_wrong)
            created.append(question_id)
        except sqlite3.IntegrityError:
            skipped.append({"index": index, "reason": "重复题目"})
        except Exception as exc:
            errors.append({"index": index, "error": str(exc)})
    conn.commit()
    _archive_used_images(conn)

    return jsonify(
        {
            "created": len(created),
            "created_ids": created,
            "skipped": skipped,
            "errors": errors,
        }
    )


@app.route("/api/questions/normalize-lines", methods=["POST"])
def api_normalize_lines():
    """One-off cleanup: merge OCR line breaks left in existing questions."""
    conn = get_db()
    rows = conn.execute(
        "SELECT id, stem, explanation, options, source_text FROM questions"
    ).fetchall()
    updated = 0
    touched_stem = 0
    touched_explanation = 0
    for row in rows:
        stem = parser.merge_wrapped_lines(row["stem"] or "")
        explanation = parser.merge_wrapped_lines(row["explanation"] or "")
        if stem != (row["stem"] or ""):
            touched_stem += 1
        if explanation != (row["explanation"] or ""):
            touched_explanation += 1
        if stem == (row["stem"] or "") and explanation == (row["explanation"] or ""):
            continue
        try:
            conn.execute(
                "UPDATE questions SET stem=?, explanation=?, fingerprint=? WHERE id=?",
                (
                    stem,
                    explanation,
                    question_fingerprint(stem),
                    row["id"],
                ),
            )
        except sqlite3.IntegrityError:
            # Another question already owns the merged fingerprint; keep the
            # original row instead of failing the whole cleanup.
            conn.execute(
                "UPDATE questions SET stem=?, explanation=? WHERE id=?",
                (stem, explanation, row["id"]),
            )
        updated += 1
    conn.commit()
    return jsonify(
        {
            "updated": updated,
            "stem_fixed": touched_stem,
            "explanation_fixed": touched_explanation,
            "scanned": len(rows),
        }
    )


# ---------------------------------------------------------------------------
# Phone camera capture
# ---------------------------------------------------------------------------
@app.route("/m/<token>")
def mobile_camera_page(token: str):
    if token != MOBILE_TOKEN:
        return Response(_mobile_invalid_page(), status=404, mimetype="text/html")
    return render_template("mobile.html", token=MOBILE_TOKEN)


@app.route("/api/mobile/info")
def api_mobile_info():
    port = as_int(request.environ.get("SERVER_PORT"), 8765, 1, 65535)
    url = _mobile_url(port)
    conn = get_db()
    pending = conn.execute("SELECT COUNT(*) AS n FROM mobile_inbox").fetchone()["n"]
    ip = _lan_ip()
    return jsonify(
        {
            "available": bool(url),
            "url": url,
            "qr_url": "/api/mobile/qr.png" if url else "",
            "lan_ip": ip,
            "port": port,
            "pending": pending,
            "max_files": MOBILE_MAX_FILES,
            "message": (
                "手机与电脑连接同一个 Wi-Fi，扫码即可拍照"
                if url
                else "未检测到局域网地址，或程序只监听了本机"
            ),
        }
    )


@app.route("/api/mobile/qr.png")
def api_mobile_qr():
    url = _mobile_url(as_int(request.environ.get("SERVER_PORT"), 8765, 1, 65535))
    if not url:
        return jsonify({"error": "未检测到可用的局域网地址"}), 404
    return _qr_png(url)


# ---------------------------------------------------------------------------
# Full app on phones (HarmonyOS / mobile browsers on the same Wi-Fi)
# ---------------------------------------------------------------------------
@app.route("/p/<token>")
def lan_pair_page(token: str):
    """扫码入口：校验一次性令牌并写入授权 Cookie，之后整站可用。"""
    if token != MOBILE_TOKEN:
        return Response(_lan_invalid_page(), status=404, mimetype="text/html")
    # 明确带上落地页：只写 "/" 时，手机浏览器/桌面图标可能恢复上次停留的
    # #settings 等 hash，看起来就变成「扫码后默认打开设置页」。
    # entry=qr 让前端忽略任何残留 hash，强制回到概览首页。
    response = redirect("/?entry=qr#dashboard")
    response.set_cookie(
        LAN_COOKIE,
        LAN_SESSION,
        max_age=60 * 60 * 24 * 30,
        httponly=True,
        samesite="Lax",
        secure=False,  # 局域网是 HTTP，Secure Cookie 不会被发送
    )
    response.headers["Cache-Control"] = "no-store"
    return response


def _lan_requested_host() -> str:
    """二维码/链接可指定候选网卡地址，但必须确实是本机地址。"""
    host = (request.args.get("host") or "").strip()
    return host if _valid_lan_host(host) else ""


@app.route("/api/lan/info")
def api_lan_info():
    port = as_int(request.environ.get("SERVER_PORT"), 8765, 1, 65535)
    host = _lan_requested_host()
    ip = host or _lan_ip()
    url = _lan_url(port, host or None)
    return jsonify(
        {
            "available": bool(url),
            "url": url,
            "qr_url": f"/api/lan/qr.png?host={ip}" if url else "",
            "lan_ip": ip,
            "primary_ip": _lan_ip(),
            "candidates": _lan_ip_candidates(),
            "port": port,
            "authorized": request.cookies.get(LAN_COOKIE) == LAN_SESSION,
            "token_fixed": True,
            "message": (
                "手机与电脑连接同一个 Wi-Fi，扫码即可使用完整系统"
                if url
                else "未检测到局域网地址，或程序只监听了本机（启动时使用 --host 0.0.0.0）"
            ),
        }
    )


@app.route("/api/lan/diag")
def api_lan_diag():
    """电脑端「连接自检」：网卡、网段、网络类别、防火墙与本机自检。"""
    if not _is_loopback(request.remote_addr):
        return jsonify({"error": "连接诊断只在电脑端显示"}), 403
    port = as_int(request.environ.get("SERVER_PORT"), 8765, 1, 65535)
    return jsonify(_lan_diagnostics(port, force=request.args.get("force") == "1"))


@app.route("/api/lan/qr.png")
def api_lan_qr():
    port = as_int(request.environ.get("SERVER_PORT"), 8765, 1, 65535)
    host = _lan_requested_host()
    url = _lan_url(port, host or None)
    if not url:
        return jsonify({"error": "未检测到可用的局域网地址"}), 404
    return _qr_png(url)


@app.route("/manifest.webmanifest")
def web_app_manifest():
    """让鸿蒙/Chromium 浏览器可把本系统添加到桌面，全屏打开。"""
    payload = {
        "id": "/",
        "name": "错题簿 · 把错题变成分数",
        "short_name": "错题簿",
        "description": "本地错题采集、OCR 识题与练习",
        "lang": "zh-CN",
        # 桌面图标也固定从概览首页启动，避免恢复成上次停留的设置页
        "start_url": "/#dashboard",
        "scope": "/",
        "display": "standalone",
        "orientation": "any",
        "background_color": "#f5efe2",
        "theme_color": "#2e251d",
        "icons": [
            {"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
            {"src": "/static/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
        ],
        "shortcuts": [
            {
                "name": "开始练习",
                "short_name": "练习",
                "description": "直接打开本地题库练习",
                "url": "/#practice",
                "icons": [{"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"}],
            },
            {
                "name": "错题本",
                "short_name": "错题",
                "description": "直接查看待攻克的错题",
                "url": "/#wrong",
                "icons": [{"src": "/static/icon-192.png", "sizes": "192x192", "type": "image/png"}],
            },
        ],
    }
    return Response(
        json.dumps(payload, ensure_ascii=False),
        mimetype="application/manifest+json",
        headers={"Cache-Control": "no-cache"},
    )


# ---------------------------------------------------------------------------
# Phone sync — desktop publishes a snapshot once; the phone keeps a local copy
# ---------------------------------------------------------------------------
SYNC_DIR = db.DATA_DIR / "sync"
SYNC_BUNDLE_PATH = SYNC_DIR / "bundle.json"
_sync_lock = threading.Lock()
_sync_listeners: list["queue.Queue[dict[str, Any]]"] = []


def _load_sync_state() -> dict[str, Any]:
    """Restore the last published snapshot info after a restart."""
    try:
        data = json.loads(SYNC_BUNDLE_PATH.read_text(encoding="utf-8"))
        return {
            "version": as_int(data.get("version"), 0, 0, 10**9),
            "generated_at": data.get("generated_at", ""),
            "counts": data.get("counts", {}),
        }
    except (OSError, ValueError, TypeError):
        return {"version": 0, "generated_at": "", "counts": {}}


_sync_state = _load_sync_state()


def _sync_version(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        "SELECT value FROM settings WHERE key='sync_version'"
    ).fetchone()
    return as_int(row["value"], 0, 0, 10**9) if row else 0


def _sync_tags(conn: sqlite3.Connection) -> dict[str, Any]:
    """手机快照里的标签段：与 /api/tags 使用同一份实时聚合结果。"""
    return {"items": _tags_payload(conn)["items"]}


def _build_sync_bundle(conn: sqlite3.Connection) -> dict[str, Any]:
    """One self-contained snapshot of everything the phone needs offline."""
    rows = conn.execute(
        "SELECT * FROM questions WHERE archived=0 ORDER BY id DESC"
    ).fetchall()
    questions = [db.serialize_question(row) for row in rows]
    overview = db.overview(conn)
    return {
        "version": _sync_version(conn),
        "generated_at": db.now(),
        "counts": {
            "questions": len(questions),
            "papers": int(conn.execute("SELECT COUNT(*) FROM code_papers").fetchone()[0]),
            "wrong": overview.get("wrong", 0),
            "mastered": overview.get("mastered", 0),
        },
        "overview": overview,
        "stats": db.stats(conn),
        "tags": _sync_tags(conn),
        "questions": questions,
    }


def _notify_sync(info: dict[str, Any]) -> None:
    with _sync_lock:
        _sync_state.update(info)
        listeners = list(_sync_listeners)
    for listener in listeners:
        listener.put(info)


@app.route("/api/sync/publish", methods=["POST"])
def api_sync_publish():
    """电脑端「一键同步到手机」：生成快照、递增版本、推送给在线手机。"""
    if not _is_loopback(request.remote_addr):
        return jsonify({"error": "请在电脑端点击「一键同步到手机」"}), 403
    conn = get_db()
    version = _sync_version(conn) + 1
    conn.execute(
        "INSERT OR REPLACE INTO settings(key, value) VALUES('sync_version', ?)",
        (str(version),),
    )
    conn.commit()
    bundle = _build_sync_bundle(conn)
    SYNC_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SYNC_BUNDLE_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
    tmp.replace(SYNC_BUNDLE_PATH)
    info = {
        "version": version,
        "generated_at": bundle["generated_at"],
        "counts": bundle["counts"],
    }
    _notify_sync(info)
    return jsonify({"ok": True, **info})


@app.route("/api/sync/manifest")
def api_sync_manifest():
    with _sync_lock:
        info = dict(_sync_state)
    info["has_bundle"] = SYNC_BUNDLE_PATH.exists()
    return jsonify(info)


@app.route("/api/sync/bundle")
def api_sync_bundle():
    # 手机端写操作后会强制刷新，此时要读实时数据而不是上次发布的快照文件
    if request.args.get("live") == "1":
        bundle = _build_sync_bundle(get_db())
        with _sync_lock:
            published = _sync_state.get("generated_at")
        if published:
            bundle["generated_at"] = published
        return jsonify(bundle)
    if SYNC_BUNDLE_PATH.exists():
        return Response(
            SYNC_BUNDLE_PATH.read_text(encoding="utf-8"),
            mimetype="application/json",
            headers={"Cache-Control": "no-store, max-age=0"},
        )
    # 还没点过同步也给一份当前快照，手机第一次打开就能用
    return jsonify(_build_sync_bundle(get_db()))


@app.route("/api/sync/stream")
def api_sync_stream():
    """SSE：电脑点同步后立刻通知手机，无需手机轮询等待。"""
    listener: queue.Queue = queue.Queue()
    with _sync_lock:
        _sync_listeners.append(listener)

    def events():
        try:
            yield "retry: 3000\n\n"
            with _sync_lock:
                version = _sync_state["version"]
            yield f"data: {json.dumps({'type': 'hello', 'version': version})}\n\n"
            while True:
                try:
                    info = listener.get(timeout=15)
                except queue.Empty:
                    yield ": ping\n\n"
                    continue
                yield f"event: sync\ndata: {json.dumps(info, ensure_ascii=False)}\n\n"
        finally:
            with _sync_lock:
                if listener in _sync_listeners:
                    _sync_listeners.remove(listener)

    return Response(
        stream_with_context(events()),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.route("/api/sync/attempts", methods=["POST"])
def api_sync_attempts():
    """手机离线练习记录回传，按 client_key 去重，避免重复计分。"""
    payload = request.get_json(silent=True) or {}
    items = payload.get("attempts") or []
    if not isinstance(items, list):
        return jsonify({"error": "提交格式不正确"}), 400
    conn = get_db()
    accepted = 0
    for item in items[:500]:
        if not isinstance(item, dict):
            continue
        key = clean_str(item.get("client_key"), 80)
        if not key:
            continue
        if conn.execute(
            "SELECT 1 FROM sync_attempt_keys WHERE client_key=?", (key,)
        ).fetchone():
            continue
        qid = as_int(item.get("question_id"), 0, 1)
        row = db.get_question(conn, qid)
        if not row:
            continue
        correct = 1 if item.get("is_correct") else 0
        stamp = clean_str(item.get("created_at"), 40) or db.now()
        conn.execute(
            "INSERT OR IGNORE INTO sync_attempt_keys(client_key, created_at) VALUES(?, ?)",
            (key, db.now()),
        )
        if correct:
            streak = row["streak"] + 1
            mastery = 3 if streak >= 3 else max(2, row["mastery"])
            conn.execute(
                """UPDATE questions SET correct_count=correct_count+1, streak=?,
                   mastery=?, last_practiced_at=?, updated_at=? WHERE id=?""",
                (streak, mastery, stamp, db.now(), qid),
            )
        else:
            conn.execute(
                """UPDATE questions SET wrong_count=wrong_count+1, streak=0,
                   mastery=1, last_practiced_at=?, updated_at=? WHERE id=?""",
                (stamp, db.now(), qid),
            )
        conn.execute(
            """INSERT INTO attempts(question_id, user_answer, correct_answer,
               is_correct, mode, duration_ms, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)""",
            (
                qid,
                clean_str(item.get("user_answer"), 1000),
                clean_str(item.get("correct_answer"), 1000),
                correct,
                clean_str(item.get("mode"), 20) or "practice",
                as_int(item.get("duration_ms"), 0, 0, 3_600_000),
                stamp,
            ),
        )
        accepted += 1
    conn.commit()
    return jsonify({"ok": True, "accepted": accepted, "version": _sync_version(conn)})


@app.route("/api/mobile/upload", methods=["POST"])
def api_mobile_upload():
    if request.args.get("token") != MOBILE_TOKEN:
        return jsonify({"error": "手机链接已失效，请重新扫码"}), 403
    files = request.files.getlist("images")
    files = [item for item in files if item and item.filename]
    if not files:
        return jsonify({"error": "没有收到照片"}), 400
    if len(files) > MOBILE_MAX_FILES:
        return jsonify({"error": f"一次最多上传 {MOBILE_MAX_FILES} 张照片"}), 400

    conn = get_db()
    saved: list[Path] = []
    try:
        for upload in files:
            path, filename = _save_image(upload)
            saved.append(path)
            conn.execute(
                "INSERT INTO mobile_inbox(image_path, created_at) VALUES (?, ?)",
                (f"uploads/{filename}", db.now()),
            )
        conn.commit()
    except Exception as exc:
        conn.rollback()
        for path in saved:
            path.unlink(missing_ok=True)
        return jsonify({"error": str(exc)}), 400

    return jsonify(
        {
            "ok": True,
            "received": len(saved),
            "message": f"已收到 {len(saved)} 张照片，请回到电脑端继续",
        }
    )


@app.route("/api/mobile/inbox/take", methods=["POST"])
def api_mobile_inbox_take():
    conn = get_db()
    rows = conn.execute(
        "SELECT id, image_path, created_at FROM mobile_inbox ORDER BY id"
    ).fetchall()
    if rows:
        conn.execute("DELETE FROM mobile_inbox")
        conn.commit()
    items = [
        {
            "id": row["id"],
            "image_url": row["image_path"],
            "filename": Path(row["image_path"]).name,
            "created_at": row["created_at"],
        }
        for row in rows
    ]
    return jsonify({"items": items, "count": len(items)})


# ---------------------------------------------------------------------------
# Practice
# ---------------------------------------------------------------------------
def _cleanup_sessions() -> None:
    cutoff = time.time() - 12 * 3600
    with _sessions_lock:
        for key in [key for key, value in _sessions.items() if value["created"] < cutoff]:
            _sessions.pop(key, None)


def _public_question(row: sqlite3.Row) -> dict[str, Any]:
    item = db.serialize_question(row, include_answer=False)
    item.pop("source_text", None)
    item.pop("note", None)
    return item


@app.route("/api/practice/start", methods=["POST"])
def api_practice_start():
    _cleanup_sessions()
    payload = request.get_json(silent=True) or {}
    mode = clean_str(payload.get("mode"), 20) or "random"
    count = as_int(payload.get("count"), 10, 1, 100)
    tag = clean_str(payload.get("tag"), 50)
    conn = get_db()

    where = ["archived=0", "answer<>''"]
    params: list[Any] = []
    if mode == "wrong":
        where.append("wrong_count>0 AND mastery<3")
    elif mode == "unseen":
        where.append("wrong_count=0 AND correct_count=0")
    elif mode == "tag":
        if not tag:
            return jsonify({"error": "请选择标签"}), 400
        where.append("tags LIKE ?")
        params.append(f'%"{tag}"%')
    elif mode == "custom":
        ids = payload.get("question_ids") or []
        ids = [as_int(item, 0, 1) for item in ids if as_int(item, 0, 1)]
        if not ids:
            return jsonify({"error": "没有指定题目"}), 400
        placeholders = ",".join("?" for _ in ids)
        where.append(f"id IN ({placeholders})")
        params.extend(ids)
    elif mode not in {"random", "wrong", "unseen", "tag", "custom"}:
        mode = "random"

    where_sql = " AND ".join(where)
    rows = conn.execute(
        f"SELECT * FROM questions WHERE {where_sql} ORDER BY RANDOM() LIMIT ?",
        [*params, count],
    ).fetchall()
    if mode == "custom":
        raw_ids = [as_int(item, 0, 1) for item in (payload.get("question_ids") or [])]
        order = {qid: index for index, qid in enumerate(raw_ids)}
        rows = sorted(rows, key=lambda row: order.get(row["id"], 9999))
    if not rows:
        return jsonify({"error": "当前条件下没有可练习的题目，请先采集或调整筛选"}), 400

    session_id = secrets.token_urlsafe(12)
    ids = [row["id"] for row in rows]
    with _sessions_lock:
        _sessions[session_id] = {
            "ids": ids,
            "mode": mode,
            "created": time.time(),
            "started": time.time(),
            "results": {},
        }
    return jsonify(
        {
            "session_id": session_id,
            "mode": mode,
            "total": len(ids),
            "questions": [_public_question(row) for row in rows],
        }
    )


@app.route("/api/practice/answer", methods=["POST"])
def api_practice_answer():
    payload = request.get_json(silent=True) or {}
    session_id = clean_str(payload.get("session_id"), 80)
    question_id = as_int(payload.get("question_id"), 0, 1)
    duration_ms = as_int(payload.get("duration_ms"), 0, 0, 3_600_000)
    with _sessions_lock:
        session = _sessions.get(session_id)
        if not session:
            return jsonify({"error": "练习会话已失效，请重新开始"}), 404
        if question_id not in session["ids"]:
            return jsonify({"error": "题目不在本次练习中"}), 400
        previous = session["results"].get(question_id)
    if previous:
        return jsonify({**previous, "duplicate": True})

    conn = get_db()
    row = db.get_question(conn, question_id)
    if not row:
        return jsonify({"error": "题目不存在"}), 404
    options = json.loads(row["options"] or "{}")
    user_raw = payload.get("answer")
    user_answer = normalize_user_answer(row["qtype"], options, user_raw)
    correct, normalized_correct = grade_answer(
        row["qtype"], options, row["answer"], user_answer
    )

    if correct:
        streak = row["streak"] + 1
        mastery = 3 if streak >= 3 else max(2, row["mastery"])
        conn.execute(
            """
            UPDATE questions SET correct_count=correct_count+1, streak=?,
                mastery=?, last_practiced_at=?, updated_at=? WHERE id=?
            """,
            (streak, mastery, db.now(), db.now(), question_id),
        )
    else:
        streak = 0
        mastery = 1
        conn.execute(
            """
            UPDATE questions SET wrong_count=wrong_count+1, streak=0,
                mastery=1, last_practiced_at=?, updated_at=? WHERE id=?
            """,
            (db.now(), db.now(), question_id),
        )
    conn.execute(
        """
        INSERT INTO attempts(question_id, user_answer, correct_answer, is_correct,
                             mode, duration_ms, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            question_id,
            user_answer,
            normalized_correct,
            1 if correct else 0,
            session["mode"],
            duration_ms,
            db.now(),
        ),
    )
    conn.commit()

    updated = db.get_question(conn, question_id)
    result = {
        "question_id": question_id,
        "is_correct": correct,
        "user_answer": user_answer,
        "correct_answer": normalized_correct,
        "explanation": row["explanation"],
        "mastery": updated["mastery"],
        "streak": updated["streak"],
        "wrong_count": updated["wrong_count"],
        "correct_count": updated["correct_count"],
        "duplicate": False,
    }
    with _sessions_lock:
        if session_id in _sessions:
            _sessions[session_id]["results"][question_id] = result
    return jsonify(result)


@app.route("/api/practice/finish", methods=["POST"])
def api_practice_finish():
    payload = request.get_json(silent=True) or {}
    session_id = clean_str(payload.get("session_id"), 80)
    with _sessions_lock:
        session = _sessions.get(session_id)
        if not session:
            return jsonify({"error": "练习会话已失效"}), 404
        results = list(session["results"].values())
        total = len(session["ids"])
        elapsed = int(time.time() - session["started"])
    conn = get_db()
    details = []
    for result in results:
        row = db.get_question(conn, result["question_id"])
        if not row:
            continue
        details.append(
            {
                **result,
                "stem": row["stem"],
                "qno": row["qno"],
                "qtype": row["qtype"],
                "options": json.loads(row["options"] or "{}"),
                "tags": json.loads(row["tags"] or "[]"),
            }
        )
    correct = sum(1 for item in results if item["is_correct"])
    answered = len(results)
    return jsonify(
        {
            "total": total,
            "answered": answered,
            "correct": correct,
            "accuracy": round(correct / answered * 100) if answered else 0,
            "elapsed": elapsed,
            "details": details,
            "wrong_ids": [item["question_id"] for item in results if not item["is_correct"]],
        }
    )


# ---------------------------------------------------------------------------
# Export / backup / settings
# ---------------------------------------------------------------------------
@app.route("/api/export/json")
def api_export_json():
    conn = get_db()
    questions = [
        db.serialize_question(row)
        for row in conn.execute("SELECT * FROM questions ORDER BY id").fetchall()
    ]
    attempts = [
        dict(row)
        for row in conn.execute("SELECT * FROM attempts ORDER BY id").fetchall()
    ]
    payload = {
        "app": "wrongbook",
        "version": APP_VERSION,
        "exported_at": db.now(),
        "questions": questions,
        "attempts": attempts,
    }
    data = json.dumps(payload, ensure_ascii=False, indent=2)
    return Response(
        data,
        mimetype="application/json",
        headers={
            "Content-Disposition": f"attachment; filename=wrongbook_{datetime.now():%Y%m%d_%H%M}.json"
        },
    )


@app.route("/api/export/csv")
def api_export_csv():
    conn = get_db()
    rows = conn.execute("SELECT * FROM questions ORDER BY id").fetchall()
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(
        ["题号", "题型", "题干", "选项", "正确答案", "解析", "标签", "错误次数", "正确次数", "掌握度", "创建时间"]
    )
    type_labels = {"single": "单选", "multiple": "多选", "truefalse": "判断", "fill": "填空"}
    for row in rows:
        options = json.loads(row["options"] or "{}")
        tags = json.loads(row["tags"] or "[]")
        writer.writerow(
            [
                row["qno"],
                type_labels.get(row["qtype"], row["qtype"]),
                row["stem"],
                " | ".join(f"{key}. {value}" for key, value in options.items()),
                row["answer"],
                row["explanation"],
                "、".join(tags),
                row["wrong_count"],
                row["correct_count"],
                row["mastery"],
                row["created_at"],
            ]
        )
    data = "\ufeff" + buffer.getvalue()
    return Response(
        data,
        mimetype="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f"attachment; filename=wrongbook_{datetime.now():%Y%m%d_%H%M}.csv"
        },
    )


@app.route("/api/backup")
def api_backup():
    conn = get_db()
    conn.execute("PRAGMA wal_checkpoint(FULL)")
    backup_path = db.DATA_DIR / "wrongbook_backup.db"
    target = sqlite3.connect(backup_path)
    with target:
        conn.backup(target)
    target.close()
    return send_file(
        backup_path,
        as_attachment=True,
        download_name=f"wrongbook_backup_{datetime.now():%Y%m%d_%H%M}.db",
    )


@app.route("/api/settings")
def api_settings():
    conn = get_db()
    db_size = db.DB_PATH.stat().st_size if db.DB_PATH.exists() else 0
    # 两个目录都算上：未使用的上传图 + 已生成题目的归档原图
    image_count = sum(
        1
        for folder in (db.UPLOAD_DIR, db.QUESTION_IMAGE_DIR)
        for item in folder.glob("*")
        if item.is_file() and item.name != db.QUESTION_IMAGE_INDEX
    )
    return jsonify(
        {
            "version": APP_VERSION,
            "data_dir": str(db.DATA_DIR),
            "db_size": db_size,
            "image_count": image_count,
            "ocr": ocr_engine.engine_status(),
            "llm": llm_client.configs_for_frontend(),
            "counts": {
                "questions": conn.execute("SELECT COUNT(*) AS n FROM questions").fetchone()["n"],
                "imports": conn.execute("SELECT COUNT(*) AS n FROM imports").fetchone()["n"],
                "attempts": conn.execute("SELECT COUNT(*) AS n FROM attempts").fetchone()["n"],
            },
        }
    )


@app.route("/api/shutdown", methods=["POST"])
def api_shutdown():
    def stop():
        time.sleep(0.4)
        os._exit(0)

    threading.Thread(target=stop, daemon=True).start()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# External LLM (cloud, OpenAI-compatible) — multiple profiles, one active
# ---------------------------------------------------------------------------
@app.route("/api/llm/presets")
def api_llm_presets():
    return jsonify({"presets": llm_client.presets_for_frontend()})


@app.route("/api/llm/config")
def api_llm_config():
    scope = request.args.get("scope", "ocr")
    return jsonify(llm_client.config_for_frontend(scope))


@app.route("/api/llm/configs")
def api_llm_configs():
    return jsonify(llm_client.configs_for_frontend())


@app.route("/api/llm/config", methods=["POST"])
def api_llm_config_save():
    scope = request.args.get("scope", "ocr")
    payload = request.get_json(silent=True) or {}
    try:
        llm_client.save_full(payload, scope)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(llm_client.config_for_frontend(scope))


@app.route("/api/llm/profiles", methods=["POST"])
def api_llm_profile_add():
    scope = request.args.get("scope", "ocr")
    payload = request.get_json(silent=True) or {}
    try:
        profile = llm_client.add_profile(payload, scope)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"profile": llm_client._mask_profile(profile)}), 201


@app.route("/api/llm/profiles/<pid>", methods=["PUT"])
def api_llm_profile_update(pid):
    scope = request.args.get("scope", "ocr")
    payload = request.get_json(silent=True) or {}
    try:
        profile = llm_client.update_profile(pid, payload, scope)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"profile": llm_client._mask_profile(profile)})


@app.route("/api/llm/profiles/<pid>", methods=["DELETE"])
def api_llm_profile_delete(pid):
    scope = request.args.get("scope", "ocr")
    try:
        llm_client.delete_profile(pid, scope)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(llm_client.config_for_frontend(scope))


@app.route("/api/llm/activate/<pid>", methods=["POST"])
def api_llm_activate(pid):
    scope = request.args.get("scope", "ocr")
    try:
        llm_client.activate(pid, scope)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(llm_client.config_for_frontend(scope))


@app.route("/api/llm/enabled", methods=["POST"])
def api_llm_enabled():
    scope = request.args.get("scope", "ocr")
    payload = request.get_json(silent=True) or {}
    enabled = bool(payload.get("enabled", False))
    try:
        llm_client.set_enabled(enabled, scope)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(llm_client.config_for_frontend(scope))


@app.route("/api/llm/test", methods=["POST"])
def api_llm_test():
    scope = request.args.get("scope", "ocr")
    payload = request.get_json(silent=True) or {}
    config = payload.get("config")
    profile_id = payload.get("profile_id")
    if isinstance(config, dict):
        ok, reply, error = llm_client.test_config(config)
    else:
        ok, reply, error = llm_client.test_active(profile_id=profile_id, scope=scope)
    if not ok:
        return jsonify({"ok": False, "error": error})
    return jsonify({"ok": True, "reply": (reply or "").strip()[:200]})


@app.route("/api/llm/parse", methods=["POST"])
def api_llm_parse():
    payload = request.get_json(silent=True) or {}
    image_url = clean_str(payload.get("image_url"), 500)
    ocr_hint = clean_str(payload.get("ocr_hint"), 20000)
    correction = clean_str(payload.get("correction"), 4000)
    if not db.is_image_ref(image_url):
        return jsonify({"error": "缺少有效的图片路径"}), 400
    name = image_url.split("/", 1)[1]
    path = db.resolve_image(image_url)
    if not path:
        return jsonify({"error": "图片不存在，请先上传或识别"}), 404
    data, error = llm_client.parse_question_image(path, ocr_hint, correction)
    if error:
        return jsonify({"error": error}), 400
    return jsonify({"draft": data})


# ---------------------------------------------------------------------------
# Errors / startup
# ---------------------------------------------------------------------------
@app.errorhandler(413)
def too_large(_error):
    return jsonify({"error": "图片总大小超过限制，请减少数量后重试"}), 413


@app.errorhandler(500)
def server_error(error):
    app.logger.exception("Unhandled error: %s", error)
    return jsonify({"error": "服务器处理失败，请查看日志"}), 500


def _port_is_ours(port: int) -> bool:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}/api/health", timeout=0.5
        ) as response:
            data = json.loads(response.read().decode("utf-8"))
            return data.get("app") == "wrongbook"
    except Exception:
        return False


def _port_open(port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.08)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def _running_port(start: int) -> int | None:
    for port in range(start, start + 30):
        # Avoid an HTTP timeout on every unused port. Only open ports are probed.
        if _port_open(port) and _port_is_ours(port):
            return port
    return None


def _free_port(start: int, host: str = "0.0.0.0") -> int:
    bind_host = "0.0.0.0" if host in {"0.0.0.0", ""} else "127.0.0.1"
    for port in range(start, start + 30):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind((bind_host, port))
                return port
            except OSError:
                continue
    return start


def _backfill_default_tags() -> None:
    """Replace legacy '未分类' tags with one keyword extracted from the stem."""
    conn = db.connect()
    try:
        rows = conn.execute(
            "SELECT id, stem, tags FROM questions WHERE tags LIKE ? OR tags IN ('', '[]')",
            ('%"未分类"%',),
        ).fetchall()
        changed = 0
        for row in rows:
            try:
                tags = json.loads(row["tags"] or "[]")
            except json.JSONDecodeError:
                tags = []
            if tags != ["未分类"] and tags:
                continue
            new_tag = keyword_extractor.extract_tag(row["stem"])
            conn.execute(
                "UPDATE questions SET tags=?, updated_at=? WHERE id=?",
                (json.dumps([new_tag], ensure_ascii=False), db.now(), row["id"]),
            )
            changed += 1
        conn.commit()
        if changed:
            print(f"已为 {changed} 道旧题自动提取标签")
    finally:
        conn.close()


def _startup_archive_images() -> None:
    """首次启动（或升级后）把旧 uploads/ 里已被题目使用的原图迁到独立目录。"""
    conn = db.connect()
    try:
        stats = db.sync_question_images(conn)
        conn.commit()
        if stats["moved"] or stats["restored"]:
            print(
                f"题目原图归档：移入 {stats['moved']} 张，退回 {stats['restored']} 张，"
                f"索引 {stats['indexed']} 条 → {db.QUESTION_IMAGE_DIR}"
            )
    finally:
        conn.close()


def main() -> None:
    import argparse

    global BIND_HOST

    _setup_file_logging()
    arg_parser = argparse.ArgumentParser(description="WrongBook local server")
    arg_parser.add_argument("--port", type=int, default=int(os.environ.get("WRONGBOOK_PORT", "8765")))
    arg_parser.add_argument(
        "--host",
        default=os.environ.get("WRONGBOOK_HOST", "0.0.0.0"),
        help="0.0.0.0 enables the phone camera page on the local network; 127.0.0.1 is local-only.",
    )
    arg_parser.add_argument("--no-browser", action="store_true")
    args = arg_parser.parse_args()
    BIND_HOST = args.host

    db.init_db()
    _backfill_default_tags()

    running = _running_port(args.port)
    if running:
        url = f"http://127.0.0.1:{running}"
        print(f"错题簿已经在运行：{url}")
        mobile_url = _mobile_url(running)
        if mobile_url:
            print(f"手机拍照：{mobile_url}")
        lan_url = _lan_url(running)
        if lan_url:
            print(f"手机完整访问（设置页有二维码）：{lan_url}")
        if not args.no_browser:
            webbrowser.open(url)
        return

    _startup_archive_images()
    port = _free_port(args.port, args.host)
    url = f"http://127.0.0.1:{port}"
    mobile_url = _mobile_url(port)
    print("=" * 60)
    print("  错题簿 · 本地错题采集与练习")
    print(f"  电脑访问：{url}")
    lan_url = _lan_url(port)
    if mobile_url:
        print(f"  手机拍照：{mobile_url}")
    else:
        print("  手机拍照：未检测到局域网地址（仅本机可用）")
    if lan_url:
        print(f"  手机完整访问（设置页有二维码）：{lan_url}")
    else:
        print("  手机完整访问：未检测到局域网地址（仅本机可用）")
    print("  数据只保存在本机，关闭窗口不会丢失。")
    print("  按 Ctrl+C 可停止服务。")
    print("=" * 60)

    if not args.no_browser:
        threading.Timer(0.9, lambda: webbrowser.open(url)).start()
    app.run(host=args.host, port=port, debug=False, threaded=True, use_reloader=False)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        _setup_file_logging()
        traceback.print_exc()
        raise
