"""External LLM client for WrongBook (cloud / OpenAI-compatible only).

Design goals:
- No local model deployment. Connects to any OpenAI-compatible ``/chat/completions``
  endpoint (OpenAI, DeepSeek, 通义/DashScope, 智谱/GLM, Kimi, 自定义 ...).
- Pure standard library HTTP (urllib) so we add zero runtime dependencies.
- Config lives in the ``settings`` table as a single JSON blob shaped like::

      {"enabled": bool, "active_id": str|null, "profiles": [ {profile}, ... ]}

  where each profile is one fully-specified model connection. The API never
  returns the raw api_key to the browser; it returns a mask + has_key flag.
- Used for the optional "AI 增强识别" feature: send a question image + OCR hint
  to a vision model and get back structured question JSON. The *active* profile
  (selected in the UI) is the one that takes effect.
"""
from __future__ import annotations

import base64
import concurrent.futures
import json
import re
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

# 系统对「单次大模型调用」的硬上限（秒）：超过即判定为卡死并主动终止。
# 这是 urllib 按次读取超时之外的第二道保险——即使对端以极慢速度涓流返回
# （按次超时永远不触发），本看门狗也会在到达硬上限时终止等待并返回明确错误。
LLM_HARD_CAP = 120

# 复用的线程池：把阻塞的 HTTP 调用放进工作线程，主线程用 future.result(timeout)
# 等待；一旦超过硬上限就放弃等待、主动终止本次调用（工作线程随后由 urllib 自身
# 的读取超时回收，不会常驻）。
_LLM_EXECUTOR = concurrent.futures.ThreadPoolExecutor(
    max_workers=4, thread_name_prefix="llm-client"
)

import db

# 两个完全独立的大模型通道：
#   ocr   —— 图片识别（AI 增强识别）：把题目截图补全为结构化题干 / 选项 / 答案 / 解析
#   parse —— 整卷入库二次核对：对抽取出的填空答案做语义级复核与纠错
# 二者各自维护 enabled / active_id / profiles，互不共享同一个模型。
SCOPES = {
    "ocr": "llm_config",
    "parse": "llm_config_parse",
}


def _scope_key(scope: str) -> str:
    if scope not in SCOPES:
        raise ValueError(f"未知的大模型通道：{scope!r}（应为 ocr / parse）")
    return SCOPES[scope]

# Provider presets. base_url is editable in the UI; these are just starting points.
PRESETS: dict[str, dict[str, str]] = {
    "openai": {
        "label": "OpenAI",
        "base_url": "https://api.openai.com/v1",
        "default_model": "gpt-4o-mini",
        "vision": True,
    },
    "deepseek": {
        "label": "DeepSeek",
        "base_url": "https://api.deepseek.com/v1",
        "default_model": "deepseek-chat",
        "vision": False,
    },
    "qwen": {
        "label": "阿里通义 (DashScope)",
        "base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "default_model": "qwen-vl-max",
        "vision": True,
    },
    "zhipu": {
        "label": "智谱 GLM",
        "base_url": "https://open.bigmodel.cn/api/paas/v4",
        "default_model": "glm-4v-plus",
        "vision": True,
    },
    "moonshot": {
        "label": "Kimi (Moonshot)",
        "base_url": "https://api.moonshot.cn/v1",
        "default_model": "moonshot-v1-8k",
        "vision": False,
    },
    "custom": {
        "label": "自定义 (OpenAI 兼容)",
        "base_url": "",
        "default_model": "",
        "vision": True,
    },
}

_PROFILE_FIELDS = ("temperature", "max_tokens", "timeout", "vision_hint")
_DEFAULTS: dict[str, Any] = {
    "temperature": 0.2,
    "max_tokens": 2048,
    "timeout": 60,
    "vision_hint": "请使用支持图片输入的视觉模型（Vision）。",
}


def _new_id() -> str:
    return uuid.uuid4().hex[:12]


def _clean(value: Any, limit: int) -> str:
    return str(value or "")[:limit].strip()


def _provider_label(pid: str) -> str:
    return PRESETS.get(pid, {}).get("label", pid or "--")


def default_config() -> dict[str, Any]:
    return {"enabled": False, "active_id": None, "profiles": []}


def _profile_defaults(
    name: str = "",
    provider: str = "openai",
    base_url: str = "",
    api_key: str = "",
    model: str = "",
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    extra = extra or {}
    d = {
        "id": _new_id(),
        "name": name or _provider_label(provider),
        "provider": provider,
        "base_url": base_url,
        "api_key": api_key,
        "model": model,
    }
    # Treat an explicit None (e.g. a field the caller omitted) as "use default",
    # not as an intentional override, so we never persist null tuning params.
    for key in _PROFILE_FIELDS:
        value = extra.get(key)
        d[key] = value if value is not None else _DEFAULTS[key]
    return d


def _normalize_profile(p: dict[str, Any]) -> dict[str, Any]:
    extra = {k: p.get(k) for k in _PROFILE_FIELDS}
    prof = _profile_defaults(
        name=p.get("name", ""),
        provider=p.get("provider", "openai"),
        base_url=p.get("base_url", ""),
        api_key=p.get("api_key", ""),
        model=p.get("model", ""),
        extra=extra,
    )
    prof["id"] = p.get("id") or prof["id"]
    return prof


def _migrate_legacy(old: dict[str, Any]) -> dict[str, Any]:
    """Convert the old single-config shape into the new profiles shape."""
    prov = old.get("provider", "openai")
    prof = _profile_defaults(
        name=_provider_label(prov),
        provider=prov,
        base_url=old.get("base_url", ""),
        api_key=old.get("api_key", ""),
        model=old.get("model", ""),
        extra={k: old.get(k) for k in _PROFILE_FIELDS},
    )
    return {
        "enabled": bool(old.get("enabled", False)),
        "active_id": prof["id"],
        "profiles": [prof],
    }


def load_config(scope: str = "ocr") -> dict[str, Any]:
    key = _scope_key(scope)
    conn = db.connect()
    try:
        row = conn.execute(
            "SELECT value FROM settings WHERE key=?", (key,)
        ).fetchone()
    finally:
        conn.close()
    if not row or not row["value"]:
        return default_config()
    try:
        data = json.loads(row["value"])
    except json.JSONDecodeError:
        return default_config()

    # 仅 ocr（历史单配置）需要迁移；parse 是新通道，不会有 legacy 形状
    if scope == "ocr" and "profiles" not in data:
        data = _migrate_legacy(data)

    cfg = default_config()
    cfg["enabled"] = bool(data.get("enabled", False))
    cfg["active_id"] = data.get("active_id")
    cfg["profiles"] = [_normalize_profile(p) for p in data.get("profiles", [])]
    if cfg["active_id"] and not any(p["id"] == cfg["active_id"] for p in cfg["profiles"]):
        cfg["active_id"] = cfg["profiles"][0]["id"] if cfg["profiles"] else None
    return cfg


def _persist(cfg: dict[str, Any], scope: str = "ocr") -> None:
    key = _scope_key(scope)
    conn = db.connect()
    try:
        conn.execute(
            "INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)",
            (key, json.dumps(cfg, ensure_ascii=False)),
        )
        conn.commit()
    finally:
        conn.close()


def get_active(scope: str = "ocr") -> dict[str, Any] | None:
    cfg = load_config(scope)
    if cfg["active_id"]:
        for p in cfg["profiles"]:
            if p["id"] == cfg["active_id"]:
                return p
    return cfg["profiles"][0] if cfg["profiles"] else None


def _mask_profile(p: dict[str, Any]) -> dict[str, Any]:
    key = p.get("api_key", "")
    return {
        "id": p["id"],
        "name": p.get("name", ""),
        "provider": p.get("provider", "openai"),
        "base_url": p.get("base_url", ""),
        "model": p.get("model", ""),
        "temperature": p.get("temperature"),
        "max_tokens": p.get("max_tokens"),
        "timeout": p.get("timeout"),
        "vision_hint": p.get("vision_hint", ""),
        "has_key": bool(key),
        "api_key_mask": ("****" + key[-4:]) if key else "",
    }


def config_for_frontend(scope: str = "ocr") -> dict[str, Any]:
    """Config safe to send to the browser (no raw api_key)."""
    cfg = load_config(scope)
    active = get_active(scope)
    return {
        "enabled": cfg["enabled"],
        "active_id": cfg["active_id"],
        "active_label": (
            f"{active['name']} · {active['model']}" if active else "--"
        ),
        "profiles": [_mask_profile(p) for p in cfg["profiles"]],
    }


def configs_for_frontend() -> dict[str, Any]:
    """Both channels at once, for the settings page and /status."""
    return {"ocr": config_for_frontend("ocr"), "parse": config_for_frontend("parse")}


def presets_for_frontend() -> list[dict[str, str]]:
    return [
        {
            "id": pid,
            "label": meta["label"],
            "base_url": meta["base_url"],
            "default_model": meta["default_model"],
            "vision": meta["vision"],
        }
        for pid, meta in PRESETS.items()
    ]


# ---------------------------------------------------------------------------
# Mutations
# ---------------------------------------------------------------------------
def save_full(payload: dict[str, Any], scope: str = "ocr") -> dict[str, Any]:
    """Replace the whole config (enabled + active_id + full profile list)."""
    current = load_config(scope)
    enabled = bool(payload.get("enabled", current["enabled"]))
    active_id = payload.get("active_id", current["active_id"])
    profiles_in = payload.get("profiles", current["profiles"])

    profiles = [_normalize_profile(p) for p in profiles_in]
    old_by_id = {p["id"]: p for p in current["profiles"]}
    for p in profiles:
        if not p.get("api_key"):
            old = old_by_id.get(p["id"])
            if old:
                p["api_key"] = old["api_key"]

    if active_id and not any(p["id"] == active_id for p in profiles):
        active_id = profiles[0]["id"] if profiles else None

    if enabled:
        active = next((p for p in profiles if p["id"] == active_id), None)
        _require_complete(active)

    cfg = {"enabled": enabled, "active_id": active_id, "profiles": profiles}
    _persist(cfg, scope)
    return cfg


def add_profile(payload: dict[str, Any], scope: str = "ocr") -> dict[str, Any]:
    cfg = load_config(scope)
    name = _clean(payload.get("name"), 60)
    provider = str(payload.get("provider", "openai") or "openai")
    base_url = _clean(payload.get("base_url"), 500)
    api_key = str(payload.get("api_key", "") or "")
    model = _clean(payload.get("model"), 200)
    extra = {k: payload.get(k) for k in _PROFILE_FIELDS}
    prof = _profile_defaults(
        name=name or _provider_label(provider),
        provider=provider,
        base_url=base_url,
        api_key=api_key,
        model=model,
        extra=extra,
    )
    if not prof["base_url"] or not prof["model"]:
        raise ValueError("请填写 API 地址和模型名称")
    cfg["profiles"].append(prof)
    if cfg["active_id"] is None:
        cfg["active_id"] = prof["id"]
    _persist(cfg, scope)
    return prof


def update_profile(pid: str, payload: dict[str, Any], scope: str = "ocr") -> dict[str, Any]:
    cfg = load_config(scope)
    prof = next((p for p in cfg["profiles"] if p["id"] == pid), None)
    if not prof:
        raise ValueError("模型不存在")
    if "name" in payload:
        prof["name"] = _clean(payload.get("name"), 60) or prof["name"]
    if "provider" in payload:
        prof["provider"] = str(payload.get("provider") or prof["provider"])
    if "base_url" in payload:
        prof["base_url"] = _clean(payload.get("base_url"), 500)
    if "model" in payload:
        prof["model"] = _clean(payload.get("model"), 200)
    if "api_key" in payload:
        key = str(payload.get("api_key") or "")
        if key:
            prof["api_key"] = key
    for k in _PROFILE_FIELDS:
        if k in payload and payload.get(k) is not None:
            prof[k] = payload[k]
    if not prof["base_url"] or not prof["model"]:
        raise ValueError("请填写 API 地址和模型名称")
    _persist(cfg, scope)
    return prof


def delete_profile(pid: str, scope: str = "ocr") -> None:
    cfg = load_config(scope)
    if not any(p["id"] == pid for p in cfg["profiles"]):
        raise ValueError("模型不存在")
    cfg["profiles"] = [p for p in cfg["profiles"] if p["id"] != pid]
    if cfg["active_id"] == pid:
        cfg["active_id"] = cfg["profiles"][0]["id"] if cfg["profiles"] else None
    _persist(cfg, scope)


def activate(pid: str, scope: str = "ocr") -> None:
    cfg = load_config(scope)
    if not any(p["id"] == pid for p in cfg["profiles"]):
        raise ValueError("模型不存在")
    cfg["active_id"] = pid
    _persist(cfg, scope)


def set_enabled(enabled: bool, scope: str = "ocr") -> None:
    cfg = load_config(scope)
    if enabled:
        active = next((p for p in cfg["profiles"] if p["id"] == cfg["active_id"]), None)
        _require_complete(active)
    cfg["enabled"] = bool(enabled)
    _persist(cfg, scope)


def _require_complete(profile: dict[str, Any] | None) -> None:
    if not profile or not profile.get("base_url") or not profile.get("api_key") or not profile.get("model"):
        raise ValueError("启用前请先添加一个完整配置（地址、密钥、模型）的模型，并设为生效")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
# Common HTTP failures translated into actionable hints for the settings page.
_HTTP_HINTS: dict[int, str] = {
    400: "请求被服务方拒绝（400），常见原因：模型名称写错、不支持该参数",
    401: "密钥无效或未授权（401），请检查 API Key 是否复制完整、是否正确",
    403: "无权限访问（403），可能是账号未开通该模型或地区受限",
    404: "地址不存在（404），请检查 Base URL，OpenAI 兼容地址通常要以 /v1 结尾",
    429: "请求过于频繁或额度不足（429），请稍后重试或检查账户余额",
    500: "服务方内部错误（500），稍后重试",
    502: "服务方网关错误（502），稍后重试",
    503: "服务暂不可用（503），稍后重试",
    504: "服务方网关超时（504），可尝试调大超时时间",
}


def _http_post_blocking(url: str, headers: dict[str, str], body: bytes, timeout: int) -> tuple[Any, str | None]:
    """真正的阻塞请求。看门狗负责包裹它，本函数不直接对外使用。"""
    request = urllib.request.Request(url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:1000]
        except Exception:
            pass
        hint = _HTTP_HINTS.get(exc.code, f"HTTP {exc.code}")
        return None, f"{hint}\n服务方原始返回：{detail or '(无内容)'}"
    except urllib.error.URLError as exc:
        reason = str(exc.reason)
        if "timed out" in reason.lower() or "timeout" in reason.lower():
            return None, "连接超时：系统已主动终止本次调用。请调大超时时间，或检查网络 / 代理设置"
        return None, f"网络错误：无法连接到 API 地址（{reason}）\n常见原因：地址拼写错误、本机网络不通、公司网络拦截、需要代理"
    except TimeoutError:
        return None, "请求超时：系统已主动终止本次调用。请调大超时时间或检查网络"
    except Exception as exc:  # noqa: BLE001
        return None, f"请求失败：{exc}"
    try:
        return json.loads(raw), None
    except json.JSONDecodeError:
        head = raw[:300]
        return None, (
            "返回内容不是 JSON，可能是地址指向了网页而不是 API 接口\n"
            f"返回开头：{head}"
        )


def _http_post(url: str, headers: dict[str, str], body: bytes, timeout: int) -> tuple[Any, str | None]:
    """带「系统判定 + 主动终止」的 POST。

    1) 把按次读取超时收束到合理区间（5~120s），防止配置过大导致无限等待；
    2) 用线程池 + 硬上限看门狗保证：无论对端是「完全无响应」还是「极慢涓流」，
       单次调用都不会超过 ``LLM_HARD_CAP`` 秒；超时即返回明确的「系统已主动终止」错误。
    """
    eff = max(5, min(int(timeout or 60), 120))
    hard = min(max(eff + 30, 60), LLM_HARD_CAP)
    try:
        fut = _LLM_EXECUTOR.submit(_http_post_blocking, url, headers, body, eff)
        return fut.result(timeout=hard)
    except concurrent.futures.TimeoutError:
        return None, (
            f"大模型调用超时，系统已主动终止（已等待约 {hard} 秒）。\n"
            "这说明远端模型迟迟未返回，可能已卡死或网络不通。可稍后重试，或在"
            "「设置 → 大模型 → ② 整卷解析大模型」调大超时时间，或关闭"
            "「启用大模型辅助」开关后重新封卷（仍可使用纯规则解析）。"
        )


def _auth_headers(cfg: dict[str, Any]) -> dict[str, str]:
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        # Some providers (e.g. Z.ai / 智谱 GLM free Flash tier) return 1305
        # "temporarily overloaded" far more often when no User-Agent is sent.
        "User-Agent": "WrongBook/1.4.3 (llm-client)",
    }
    key = cfg.get("api_key", "")
    if key:
        # Most OpenAI-compatible services use "Bearer <key>". A few (e.g. some
        # gateways) want the raw key; we keep Bearer as the default and let the
        # user put a full header value into api_key if they need a custom scheme.
        headers["Authorization"] = f"Bearer {key}"
    return headers


def _chat_completion(cfg: dict[str, Any], messages: list[dict[str, Any]], max_tokens: int | None = None) -> tuple[dict[str, Any] | None, str | None]:
    """POST a chat/completions request.

    Robustness notes:
    - A User-Agent is now always sent (see ``_auth_headers``); some providers
      (e.g. Z.ai / 智谱 GLM free Flash tier) return 1305 "overloaded" far more
      often when the client sends none.
    - Thinking models (e.g. glm-4.5-flash) spend part of ``max_tokens`` on
      internal reasoning, so the visible answer in ``content`` can come back
      empty with ``finish_reason == "length"``. When that happens we *escalate*
      the budget (2048 -> 4096 -> 8192) and retry, instead of descending to a
      smaller value, which would only make the truncation worse.
    Returns (json_data, error).
    """
    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    if max_tokens is None:
        max_tokens = int(cfg.get("max_tokens", 2048))

    # 强制思考模型（GLM-5.3-Flash / FlashX / GLM-4.7 等）不允许关闭 thinking，
    # 默认 reasoning_effort=max 会把 2048 的输出预算几乎全耗在内部推理上，
    # 再叠加 60s 超时就会「配置填对了却解析失败」。这里按模型名自动兜底：
    # 提高输出预算与超时、把推理强度降到 low，免费/旧模型保持原行为不变。
    model_name = str(cfg.get("model") or "").lower()
    forced_thinking = "glm-5.3" in model_name or "glm-4.7" in model_name
    if forced_thinking:
        max_tokens = max(int(max_tokens), 4096)
        effort = str(cfg.get("reasoning_effort") or "low")
        eff_timeout = min(120, max(int(cfg.get("timeout", 60) or 60), 100))
    else:
        effort = ""
        eff_timeout = int(cfg.get("timeout", 60) or 60)
    # Escalating budget: start at the user's value, then *grow* on truncation.
    candidates: list[int] = []
    v = max_tokens
    while len(candidates) < 4 and v <= 8192:
        if v not in candidates:
            candidates.append(v)
        nxt = min(v * 2, 8192)
        if nxt == v:
            # v 已顶到 8192 且该值已入列：再循环就是死循环。
            # 旧代码在这里空转，max_tokens=2048 时只会生成 3 个候选，
            # 于是「整卷解析大模型」一启用就 CPU 100% 且永不发请求。
            break
        v = nxt
    if not candidates:
        candidates = [max_tokens]
    last_error = None
    for attempt, mt in enumerate(candidates):
        payload = {
            "model": cfg["model"],
            "messages": messages,
            "temperature": cfg.get("temperature", 0.2),
            "max_tokens": mt,
        }
        if forced_thinking:
            # 官方仅接受 max / high / low；low 最省额度，用于「补几个空」足够
            payload["reasoning_effort"] = effort if effort in ("max", "high", "low") else "low"
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        data, error = _http_post(url, _auth_headers(cfg), body, eff_timeout)
        if error:
            last_error = error
            # Only retry when the failure is about max_tokens; other errors stop.
            if "max_tokens" not in (error or "").lower():
                break
            continue
        # HTTP 200. If the answer is empty yet the model hit the length limit,
        # escalate the budget and retry rather than handing back nothing.
        try:
            choice = data["choices"][0]
            content = (choice.get("message", {}).get("content") or "").strip()
            finish = choice.get("finish_reason")
        except (KeyError, IndexError, TypeError):
            return data, None  # malformed -> let caller surface it
        if not content and finish == "length" and attempt < len(candidates) - 1:
            last_error = (
                f"输出被 max_tokens({mt}) 截断且内容为空，已自动提高上限至 "
                f"{candidates[attempt + 1]} 重试"
            )
            continue
        return data, None
    return None, last_error


def chat(messages: list[dict[str, Any]], cfg: dict[str, Any] | None = None) -> tuple[str, str | None]:
    """Plain text chat completion. Returns (text, error)."""
    cfg = cfg or get_active()
    if not cfg or not cfg.get("base_url") or not cfg.get("api_key") or not cfg.get("model"):
        return "", "大模型未配置：请先在设置中填写 Base URL、API Key 与模型名称"
    data, error = _chat_completion(cfg, messages)
    if error:
        return "", error
    try:
        return data["choices"][0]["message"]["content"], None
    except (KeyError, IndexError, TypeError):
        return "", f"响应格式异常：{json.dumps(data, ensure_ascii=False)[:200]}"


def test_config(config: dict[str, Any]) -> tuple[bool, str | None, str | None]:
    """Test an arbitrary (possibly unsaved) config dict."""
    cfg = {
        "base_url": _clean(config.get("base_url", ""), 500),
        "api_key": str(config.get("api_key", "") or ""),
        "model": _clean(config.get("model", ""), 200),
        "temperature": config.get("temperature", 0.2),
        "max_tokens": config.get("max_tokens", 256),
        "timeout": config.get("timeout", 30),
    }
    if not cfg["base_url"] or not cfg["api_key"] or not cfg["model"]:
        return False, None, "请填写 API 地址、密钥与模型名称"
    text, error = chat(
        [{"role": "user", "content": "请只回复两个字：成功"}], cfg=cfg
    )
    if error:
        return False, None, error
    return True, text, None


def test_active(profile_id: str | None = None, scope: str = "ocr") -> tuple[bool, str | None, str | None]:
    cfg = None
    if profile_id:
        loaded = load_config(scope)
        cfg = next((p for p in loaded["profiles"] if p["id"] == profile_id), None)
    else:
        cfg = get_active(scope)
    if not cfg:
        return False, None, "没有可用的模型配置"
    if not cfg.get("base_url") or not cfg.get("api_key") or not cfg.get("model"):
        return False, None, "当前模型配置不完整（缺少地址/密钥/模型）"
    text, error = chat(
        [{"role": "user", "content": "请只回复两个字：成功"}], cfg=cfg
    )
    if error:
        return False, None, error
    return True, text, None


def _encode_image(path: str | Path) -> str:
    with open(path, "rb") as handle:
        return base64.b64encode(handle.read()).decode("ascii")


def parse_question_image(image_path: str | Path, ocr_hint: str = "", correction: str = "") -> tuple[dict[str, Any] | None, str | None]:
    """Send a question image to a vision model and get structured question JSON.

    Returns (parsed_dict, error). On success the dict contains the keys emitted
    by the model (stem / qtype / options / answer / explanation / tags ...).
    Uses the currently *active* profile.
    """
    full = load_config()
    if not full["enabled"]:
        return None, "大模型未启用，请先在设置中开启并选择生效模型"
    cfg = get_active()
    if not cfg:
        return None, "尚未配置任何大模型，请先在设置中添加模型"
    if not cfg.get("base_url") or not cfg.get("api_key") or not cfg.get("model"):
        return None, "生效模型配置不完整：请填写地址、密钥与模型"

    b64 = _encode_image(image_path)
    mime = "image/png" if str(image_path).lower().endswith((".png",)) else "image/jpeg"

    prompt = (
        "你是一个错题识别助手。请阅读这张题目图片，提取结构化信息并以 JSON 返回，"
        "不要包含任何解释或 Markdown 代码块标记，只返回纯 JSON 对象，字段如下：\n"
        "{\n"
        '  "stem": "题干全文",\n'
        '  "qtype": "single|multiple|truefalse|fill",\n'
        '  "options": {"A":"选项A","B":"选项B"},\n'
        '  "answer": "正确答案，填空可用 || 分隔多个，判断题用 正确/错误",\n'
        '  "explanation": "解析，没有则空字符串",\n'
        '  "tags": ["标签1"],\n'
        '  "was_wrong": false,\n'
        '  "user_answer": ""\n'
        "}\n"
        "规则：\n"
        "1. 只输出 JSON 对象本身，不要写注释，也不要加代码块标记；\n"
        "2. 题干不要带题号；判断题 options 为空对象且 answer 用 正确/错误；"
        "多选题 answer 用字母集合如 ACD；\n"
        "3. explanation 写成一行、不超过 100 字；所有字段的值内部不要出现英文双引号"
        "（需要强调时用「」或单引号），也不要换行；\n"
        "4. 置信度不足时用空字符串；\n"
        "5. user_answer 只填图片里作答者勾选、圈出、填写或被标红的那个答案"
        "（如 B、ACD、正确），不要把正确答案抄到这里；图中没有作答痕迹就留空；"
        "was_wrong 表示图片里这道题被判错（打叉、红字、标为错题等），无法判断时填 false。"
    )
    if ocr_hint:
        prompt += f"\n参考（OCR 已识别的文字，可能不精确）：\n{ocr_hint}"
    if correction:
        prompt += (
            "\n用户补充说明（请按此修正识别结果，例如纠正某题答案、补全填空、"
            "调整选项顺序等）：\n"
            f"{correction}"
        )

    user_content: list[dict[str, Any]] = [
        {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
        {"type": "text", "text": prompt},
    ]
    messages = [{"role": "user", "content": user_content}]

    url = cfg["base_url"].rstrip("/") + "/chat/completions"
    data, error = _chat_completion(cfg, messages)
    if error:
        return None, error
    try:
        text = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError):
        return None, f"响应格式异常：{json.dumps(data, ensure_ascii=False)[:200]}"

    parsed = _extract_json(text)
    if parsed is None:
        return None, f"模型未返回可解析的 JSON：{text[:200]}"
    return parsed, None


def _extract_json(text: str) -> dict[str, Any] | None:
    text = (text or "").strip()
    if not text:
        return None
    # Strip Markdown code fences if present.
    fence = re.match(r"^```(?:json)?\s*(.*?)\s*```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fall back to the first balanced {...} block.
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except json.JSONDecodeError:
            pass
    # 最后用宽容解析器兜底：能吃下裸换行、未转义的引号和被截断的输出。
    return lenient_json(text)


# ---------------------------------------------------------------------------
# 宽容 JSON 解析
#
# 大模型输出的 JSON 经常有两类毛病，直接 json.loads 会整段报废：
#   1) 字段值里带裸换行 / 制表符（JSON 字符串不允许裸控制字符）；
#   2) 字段值里有没转义的英文双引号，例如解析里写 必须是"真正例数"。
# 下面的解析器按「引号后面（跳过空白）跟着 , } ] : 才算字符串结束」判断边界，
# 并把裸换行当空格收下；输出被 max_tokens 截断时，把已读到的部分交出去。
# ---------------------------------------------------------------------------

_STR_END_CHARS = ",}]:"


def _skip_ws(text: str, i: int) -> int:
    while i < len(text) and text[i] in " \t\r\n":
        i += 1
    return i


def _parse_json_string(text: str, i: int) -> tuple[str, int, bool]:
    """解析一个 JSON 字符串，返回 (值, 下一个位置, 是否正常闭合)。"""
    i += 1  # 跳过起始引号
    buf: list[str] = []
    escapes = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\", "/": "/"}
    while i < len(text):
        c = text[i]
        if c == "\\" and i + 1 < len(text):
            buf.append(escapes.get(text[i + 1], text[i + 1]))
            i += 2
            continue
        if c == '"':
            j = _skip_ws(text, i + 1)
            if j >= len(text) or text[j] in _STR_END_CHARS:
                return "".join(buf), j, True
            buf.append(c)  # 没转义的引号，当普通字符收下
            i += 1
            continue
        if c in "\r\n\t":
            buf.append(" ")
            i += 1
            continue
        buf.append(c)
        i += 1
    # 走到文本末尾还没有收尾引号 → 被截断了，把已有的部分交出去
    return "".join(buf), i, False


def _parse_json_value(text: str, i: int, depth: int = 0) -> tuple[Any, int, bool]:
    i = _skip_ws(text, i)
    if i >= len(text):
        return None, i, False
    c = text[i]
    if c == '"':
        return _parse_json_string(text, i)
    if c == "{":
        return _parse_json_object(text, i, depth)
    if c == "[":
        return _parse_json_array(text, i, depth)
    j = i
    while j < len(text) and text[j] not in ",}]":
        j += 1
    raw = text[i:j].strip()
    low = raw.lower()
    if low == "true":
        return True, j, True
    if low == "false":
        return False, j, True
    if low in ("null", "none"):
        return None, j, True
    try:
        return (float(raw) if ("." in raw or "e" in low) else int(raw)), j, True
    except ValueError:
        return raw, j, True


def _parse_json_object(text: str, i: int, depth: int = 0) -> tuple[dict, int, bool]:
    obj: dict[str, Any] = {}
    i += 1  # 跳过 {
    while True:
        i = _skip_ws(text, i)
        if i >= len(text):
            return obj, i, False  # 被截断：交出已读到的部分
        if text[i] == "}":
            return obj, i + 1, True
        if text[i] == ",":
            i += 1
            continue
        if text[i] != '"':
            i += 1
            continue
        key, i, _ = _parse_json_string(text, i)
        i = _skip_ws(text, i)
        if i < len(text) and text[i] == ":":
            i += 1
            value, i, _ = _parse_json_value(text, i, depth + 1)
            obj[str(key)] = value
        else:
            obj[str(key)] = None


def _parse_json_array(text: str, i: int, depth: int = 0) -> tuple[list, int, bool]:
    arr: list[Any] = []
    i += 1  # 跳过 [
    while True:
        i = _skip_ws(text, i)
        if i >= len(text):
            return arr, i, False
        if text[i] == "]":
            return arr, i + 1, True
        if text[i] == ",":
            i += 1
            continue
        value, i, _ = _parse_json_value(text, i, depth + 1)
        arr.append(value)


def lenient_json(text: str) -> dict[str, Any] | None:
    """从模型输出里尽力解析出一个 JSON 对象（宽容版）。"""
    start = (text or "").find("{")
    if start < 0:
        return None
    value, _end, _ok = _parse_json_object(text, start)
    if isinstance(value, dict) and value:
        return value
    return None
