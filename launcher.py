#!/usr/bin/env python3
"""WrongBook 启动器（打包后的程序入口）。

设计目标：普通用户双击 exe 后立刻有可见反馈，并能可靠地打开应用。

关键约束（来自用户真实环境）：
- 该环境会拦截“由 exe 拉起的外部浏览器窗口”（Chrome/Edge 进程能起，但窗口不显示）。
- 因此“自动弹浏览器”这条路在此环境下不可靠；最稳的方式是：启动本地 Flask 服务，
  把访问地址清晰地展示出来并自动复制到剪贴板，用户在自己已打开的浏览器里粘贴即可。
- 启动器窗口本身用 Tkinter（用户已确认此类窗口可正常显示），并做成简洁现代的样式。

数据初始化（针对打包后的数据归属）：
- 打包时完整数据放在 ``_internal/data``（PyInstaller 管理目录）。
- 首次运行（或运行库被污染时）自动把 ``_internal/data`` 复制到 ``exe 同级/data``，
  保证 Full=192 题（含大模型配置）、Lite=1 题示例（无大模型），且用户后续改动持久保存。
"""
from __future__ import annotations

import argparse
import os
import re
import sys
import time
import shutil
import sqlite3
import tempfile
import threading
import webbrowser
import subprocess
import urllib.request
import tkinter as tk
from tkinter import messagebox
from pathlib import Path

# Windows 创建无窗口子进程的标志（仅用于 cmd/explorer 等辅助调用）
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)

ACCENT = "#3b5bdb"
ACCENT_SOFT = "#edf0fe"
TEXT_DARK = "#222222"
TEXT_MUTE = "#666666"
BG = "#f5f6fa"
WHITE = "#ffffff"


def _log_line(msg: str) -> None:
    """把诊断信息追加写入 exe 同级目录的日志文件（失败静默忽略）。"""
    try:
        base = Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(".")
        log_path = base / "WrongBook_launcher.log"
        ts = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(f"[{ts}] {msg}\n")
    except Exception:
        pass


def _default_browser_exe() -> str | None:
    """通过注册表定位系统默认浏览器的可执行文件路径。失败返回 None。"""
    try:
        import winreg
    except Exception:
        return None

    def extract_exe(cmd: str) -> str | None:
        if not cmd:
            return None
        m = re.search(r'"([^"]+\.exe)"', cmd)
        if m:
            return m.group(1)
        m = re.search(r'(\S+\.exe)', cmd)
        return m.group(1) if m else None

    prog_id = None
    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice",
        ) as k:
            prog_id = winreg.QueryValueEx(k, "ProgId")[0]
    except Exception:
        pass

    candidates = []
    if prog_id:
        candidates.append(prog_id)
    candidates.append(r"http\shell\open\command")

    for key in candidates:
        for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_CLASSES_ROOT):
            try:
                with winreg.OpenKey(hive, f"{key}\\shell\\open\\command") as k:
                    cmd = winreg.QueryValueEx(k, "")[0]
                    exe = extract_exe(cmd)
                    if exe and os.path.exists(exe):
                        return exe
            except Exception:
                continue
    return None


def _common_browser_exes() -> list[str]:
    """常见浏览器可执行文件的候选路径（用于兜底直接启动）。"""
    return [
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Mozilla Firefox\firefox.exe",
        r"C:\Program Files (x86)\Mozilla Firefox\firefox.exe",
    ]


def _launch_browser_exe(exe_path: str, url: str, tmp: Path) -> None:
    """用浏览器 exe 直接拉起 url，强制一个独立、可见的新窗口（绕过单例锁）。"""
    name = os.path.basename(exe_path).lower()
    show = subprocess.STARTUPINFO()  # type: ignore[attr-defined]
    show.dwFlags = subprocess.STARTF_USESHOWWINDOW  # type: ignore[attr-defined]
    show.wShowWindow = 1  # SW_SHOWNORMAL

    if "firefox" in name:
        profile = tmp / "wb_ff_profile"
        subprocess.Popen(
            [exe_path, "-new-window", "-no-remote", "-profile", str(profile), url],
            shell=False, startupinfo=show,
        )
    else:
        ud = tmp / "wb_chrome_profile"
        subprocess.Popen(
            [
                exe_path,
                f"--user-data-dir={ud}",
                "--no-first-run",
                "--no-default-browser-check",
                "--new-window",
                url,
            ],
            shell=False, startupinfo=show,
        )


def _create_desktop_shortcut(url: str) -> str | None:
    """创建 .url 快捷方式作为兜底入口。依次尝试多个可写目录，避免 OneDrive 桌面被拒。"""
    candidates: list[str] = []
    try:
        import ctypes
        buf = ctypes.create_unicode_buffer(1024)
        ctypes.windll.shell32.SHGetFolderPathW(None, 0x0000, None, 0, buf)  # CSIDL_DESKTOP=0
        if buf.value:
            candidates.append(buf.value)
    except Exception:
        pass
    candidates.append(os.path.join(os.environ.get("USERPROFILE", ""), "Desktop"))
    candidates.append(tempfile.gettempdir())
    if getattr(sys, "frozen", False):
        candidates.append(str(Path(sys.executable).resolve().parent))

    for d in candidates:
        if not d or not os.path.isdir(d):
            continue
        try:
            path = os.path.join(d, "错题簿本地服务.url")
            with open(path, "w", encoding="utf-8") as f:
                f.write("[InternetShortcut]\n")
                f.write(f"URL={url}\n")
            _log_line(f"已创建快捷方式: {path}")
            return path
        except Exception as exc:
            _log_line(f"快捷方式写 {d} 失败: {exc}")
    return None


def _open_browser_robust(url: str) -> tuple[bool, str]:
    """尽力用系统默认浏览器打开 url，逐级回退。返回 (是否触发, 诊断信息)。

    注意：在受限环境下外部浏览器常常“进程启动了但窗口不弹”，因此这仅作尽力而为，
    主入口是界面上清晰展示 + 自动复制的访问地址。
    """
    details: list[str] = []

    tmp = Path(tempfile.gettempdir()) / "WrongBook_browser"
    try:
        tmp.mkdir(parents=True, exist_ok=True)
    except Exception:
        tmp = Path(".")

    try:
        exe_path = _default_browser_exe()
        if exe_path and os.path.exists(exe_path):
            _launch_browser_exe(exe_path, url, tmp)
            _log_line(f"浏览器打开成功(默认浏览器exe={exe_path}, 强制新窗口): {url}")
            return True, f"exe:{exe_path}"
        details.append(f"注册表默认浏览器无效: {exe_path}")
    except Exception as exc:
        details.append(f"默认浏览器exe启动失败: {exc}")

    for cand in _common_browser_exes():
        try:
            if os.path.exists(cand):
                _launch_browser_exe(cand, url, tmp)
                _log_line(f"浏览器打开成功(常见浏览器={cand}, 强制新窗口): {url}")
                return True, f"exe:{cand}"
        except Exception as exc:
            details.append(f"浏览器 {cand} 启动失败: {exc}")

    try:
        os.startfile(url)  # type: ignore[attr-defined]
        _log_line(f"浏览器打开成功(os.startfile): {url}")
        return True, "os.startfile"
    except Exception as exc:
        details.append(f"os.startfile 失败: {exc}")

    try:
        from ctypes import windll
        windll.shell32.ShellExecuteW(None, "open", url, None, None, 1)
        _log_line(f"已通过 ShellExecute 尝试打开(结果无法确认是否可见): {url}")
        return True, "ShellExecuteW"
    except Exception as exc:
        details.append(f"ShellExecuteW 异常: {exc}")

    try:
        subprocess.run(["cmd", "/c", "start", "", url], check=False, creationflags=CREATE_NO_WINDOW)
        _log_line(f"浏览器打开成功(cmd start): {url}")
        return True, "cmd start"
    except Exception as exc:
        details.append(f"cmd start 失败: {exc}")

    try:
        subprocess.run(["explorer", url], check=False, creationflags=CREATE_NO_WINDOW)
        _log_line(f"浏览器打开成功(explorer): {url}")
        return True, "explorer"
    except Exception as exc:
        details.append(f"explorer 失败: {exc}")

    diag = "; ".join(details)
    _log_line(f"所有方式均失败: {url} | {diag}")
    return False, diag


def _copy_runtime_data() -> None:
    """冻结模式下，把打包进来的种子数据初始化到运行目录（exe 同级/data）。

    - 首次运行（运行目录无 wrongbook.db）：直接复制 ``_internal/data``。
    - 运行库被污染（题数 ≤ 1，明显是空库自动塞的示例）：用内置种子覆盖，自动修复。
    - 已是正常使用中的库（题数较多）：保留，不覆盖用户数据。

    保证 Full=192 题（含大模型配置）、Lite=1 题示例（无大模型），且改动持久保存。
    """
    if not getattr(sys, "frozen", False):
        return
    try:
        exe_dir = Path(sys.executable).resolve().parent
        runtime_data = exe_dir / "data"

        # 定位打包进来的种子数据：onedir 在 _internal/data，onefile 在 _MEIPASS/data
        meipass = getattr(sys, "_MEIPASS", None)
        bundled_candidates = []
        if meipass:
            bundled_candidates.append(Path(meipass) / "data")
        bundled_candidates.append(exe_dir / "_internal" / "data")
        bundled = next(
            (c for c in bundled_candidates if (c / "wrongbook.db").exists()), None
        )
        if bundled is None:
            _log_line("未找到内置种子数据，跳过数据初始化")
            return

        def qcount(db_path: Path) -> int:
            try:
                c = sqlite3.connect(str(db_path))
                n = c.execute("SELECT COUNT(*) FROM questions").fetchone()[0]
                c.close()
                return n
            except Exception:
                return -1

        marker = runtime_data / ".wb_bundle_seed"
        rt_db = runtime_data / "wrongbook.db"
        need_seed = False
        if not rt_db.exists():
            need_seed = True
        elif not marker.exists() and qcount(rt_db) <= 1:
            # 运行库只有自动塞的 1 条示例，视为被污染，用内置种子修复
            need_seed = True

        if not need_seed:
            return

        runtime_data.mkdir(parents=True, exist_ok=True)
        for item in bundled.iterdir():
            dst = runtime_data / item.name
            try:
                if item.is_dir():
                    shutil.copytree(item, dst, dirs_exist_ok=True)
                else:
                    shutil.copy2(item, dst)
            except Exception as exc:
                _log_line(f"复制 {item.name} 失败: {exc}")
        marker.write_text(f"seeded_from={bundled}\n", encoding="utf-8")
        _log_line(f"已从内置种子初始化数据: {bundled} -> {runtime_data} (题数={qcount(rt_db)})")
    except Exception as exc:  # noqa: BLE001
        _log_line(f"数据初始化异常: {exc}")


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="WrongBook launcher")
    p.add_argument("--port", type=int, default=int(os.environ.get("WRONGBOOK_PORT", "8765")))
    p.add_argument("--host", default=os.environ.get("WRONGBOOK_HOST", "0.0.0.0"))
    p.add_argument("--no-browser", action="store_true", help="不打开界面（仅起服务）")
    return p.parse_args()


def _bootstrap_server(port_start: int, host: str):
    """导入 app、初始化并选择端口。返回 (port, url, already_running, host)。"""
    _copy_runtime_data()  # 在导入 app 之前，确保运行目录已有正确数据
    import app  # 触发重型依赖加载（PaddlePaddle 等）
    app.db.init_db()
    app._backfill_default_tags()

    running = app._running_port(port_start)
    if running:
        return running, f"http://127.0.0.1:{running}", True, host

    app._startup_archive_images()
    port = app._free_port(port_start, host)
    return port, f"http://127.0.0.1:{port}", False, host


def _serve_forever(port: int, host: str) -> None:
    """在后台线程常驻运行 Flask 服务。"""
    import app as app_module
    app_module.app.run(host=host, port=port, debug=False, threaded=True, use_reloader=False)


def _run_tk_gui(args: argparse.Namespace) -> None:
    """主路径：简洁现代的 Tkinter 窗口，展示访问地址并自动复制。"""
    root = tk.Tk()
    root.title("错题簿 · 本地错题采集与练习")
    root.geometry("580x470")
    root.resizable(False, False)
    root.configure(bg=BG)

    try:
        from ctypes import windll
        windll.shcore.SetProcessDpiAwareness(1)
    except Exception:
        pass

    # ---------- 顶部标题栏 ----------
    header = tk.Frame(root, bg=ACCENT, height=96)
    header.pack(fill="x")
    header.pack_propagate(False)
    tk.Label(
        header, text="错题簿", font=("Microsoft YaHei", 24, "bold"),
        bg=ACCENT, fg=WHITE,
    ).place(x=28, y=14)
    tk.Label(
        header, text="本地错题采集与练习", font=("Microsoft YaHei", 11),
        bg=ACCENT, fg="#dbe4ff",
    ).place(x=30, y=54)

    # ---------- 主体 ----------
    body = tk.Frame(root, bg=BG)
    body.pack(fill="both", expand=True, padx=30, pady=18)

    state: dict = {"port": None, "url": None, "already": False, "error": None, "shortcut": None}

    tk.Label(
        body, text="本地服务已启动", font=("Microsoft YaHei", 14, "bold"),
        bg=BG, fg=TEXT_DARK,
    ).pack(anchor="w")
    tk.Label(
        body,
        text="把下方地址粘贴到任意浏览器（Chrome / Edge 等）即可打开错题簿。"
              "地址已自动复制到剪贴板，双击桌面「错题簿本地服务」图标也可打开。",
        font=("Microsoft YaHei", 10), bg=BG, fg=TEXT_MUTE,
        wraplength=500, justify="left",
    ).pack(anchor="w", pady=(2, 12))

    # 地址框（带边框）
    url_frame = tk.Frame(body, bg=ACCENT, bd=0)
    url_frame.pack(fill="x", pady=(0, 14))
    url_var = tk.StringVar(value="（正在准备服务…）")
    url_box = tk.Entry(
        url_frame, textvariable=url_var, font=("Consolas", 13),
        bd=0, relief="flat", bg=WHITE, fg="#1b3a8c", state="readonly",
        readonlybackground=WHITE,
    )
    url_box.pack(fill="x", ipady=11, padx=2, pady=2)

    def do_copy() -> None:
        u = state.get("url")
        if not u:
            messagebox.showinfo("提示", "服务尚未就绪，请稍候片刻再试。")
            return
        try:
            root.clipboard_clear()
            root.clipboard_append(u)
        except Exception:
            pass
        messagebox.showinfo("已复制", f"地址已复制到剪贴板：\n{u}\n\n请粘贴到浏览器地址栏打开。")

    def do_open() -> None:
        u = state.get("url")
        if not u:
            return
        try:
            root.clipboard_clear()
            root.clipboard_append(u)
        except Exception:
            pass
        ok, diag = _open_browser_robust(u)
        if ok:
            messagebox.showinfo(
                "已尝试打开",
                f"已尝试用系统浏览器打开：\n{u}\n\n若窗口未出现（本机常拦截程序拉起的浏览器），"
                f"地址已复制，请直接粘贴到浏览器地址栏打开。",
            )
        else:
            messagebox.showwarning(
                "无法自动打开浏览器",
                f"已尝试多种方式仍未能自动打开浏览器。\n\n地址已复制，请粘贴到浏览器：\n{u}",
            )

    btn_row = tk.Frame(body, bg=BG)
    btn_row.pack(pady=(0, 12))
    copy_btn = tk.Button(
        btn_row, text="复制地址", width=14, height=1, command=do_copy,
        bg=ACCENT, fg=WHITE, font=("Microsoft YaHei", 11), bd=0, cursor="hand2",
        activebackground="#2f4bc0",
    )
    open_btn = tk.Button(
        btn_row, text="尝试打开浏览器", width=16, height=1, command=do_open,
        bg=WHITE, fg=ACCENT, font=("Microsoft YaHei", 11), bd=1, relief="solid",
        cursor="hand2",
    )
    exit_btn = tk.Button(
        btn_row, text="退出", width=10, height=1, command=lambda: sys.exit(0),
        bg=WHITE, fg=TEXT_MUTE, font=("Microsoft YaHei", 11), bd=1, relief="solid",
        cursor="hand2",
    )
    copy_btn.pack(side="left", padx=6)
    open_btn.pack(side="left", padx=6)
    exit_btn.pack(side="left", padx=6)

    status_var = tk.StringVar(value="正在启动本地服务，首次加载识别模型可能稍慢，请稍候…")
    status = tk.Label(
        body, textvariable=status_var, font=("Microsoft YaHei", 10),
        bg=BG, fg=TEXT_MUTE, wraplength=500, justify="left",
    )
    status.pack(anchor="w", pady=(4, 0))

    # 题量提示
    info_var = tk.StringVar(value="")
    info = tk.Label(
        body, textvariable=info_var, font=("Microsoft YaHei", 9),
        bg=BG, fg="#9aa0a6", wraplength=500, justify="left",
    )
    info.pack(anchor="w", pady=(8, 0))

    def on_close() -> None:
        sys.exit(0)

    root.protocol("WM_DELETE_WINDOW", on_close)

    def boot() -> None:
        try:
            import app as app_module
            port, url, already, host = _bootstrap_server(args.port, args.host)
            state["port"] = port
            state["url"] = url
            state["already"] = already
            url_var.set(url)
            # 自动复制到剪贴板，降低使用门槛
            try:
                root.clipboard_clear()
                root.clipboard_append(url)
            except Exception:
                pass
            state["shortcut"] = _create_desktop_shortcut(url)

            def update_ui() -> None:
                mob = app_module._mobile_url(port)
                lan = app_module._lan_url(port)
                lines = []
                try:
                    from db import connect
                    with connect() as conn:
                        total = conn.execute(
                            "SELECT COUNT(*) FROM questions WHERE archived=0"
                        ).fetchone()[0]
                        has_llm = conn.execute(
                            "SELECT COUNT(*) FROM settings WHERE key='llm_config'"
                        ).fetchone()[0]
                    lines.append(f"当前题库：{total} 题　|　大模型：{'已配置' if has_llm else '未配置（精简版）'}")
                except Exception:
                    pass
                if mob:
                    lines.append(f"手机拍照上传：{mob}")
                if lan:
                    lines.append(f"手机访问（设置页有二维码）：{lan}")
                if state.get("shortcut"):
                    lines.append("桌面已生成「错题簿本地服务」快捷方式，可随时双击打开。")
                info_var.set("\n".join(lines))
                status_var.set(
                    "✅ 服务已就绪，地址已复制到剪贴板，请粘贴到浏览器打开。"
                    if not already else "✅ 错题簿已在运行中，可直接访问（地址已复制）。"
                )

            root.after(0, update_ui)

            if not already:
                threading.Thread(
                    target=lambda: _serve_forever(port, host), daemon=True
                ).start()
        except Exception as exc:  # noqa: BLE001
            state["error"] = str(exc)
            _log_line(f"启动失败: {exc}")
            root.after(
                0,
                lambda: messagebox.showerror(
                    "启动失败",
                    f"错题簿启动出错：\n\n{exc}\n\n请检查端口是否被占用，或程序文件是否完整。",
                ),
            )

    threading.Thread(target=boot, daemon=True).start()

    # 就绪后把窗口提到前台，避免被遮挡
    root.after(1200, lambda: root.lift())
    root.mainloop()


def _run_headless(args: argparse.Namespace) -> None:
    """无界面兜底：直接起服务并尽力打开系统浏览器。"""
    sys.stderr.write("[launcher] 图形界面不可用，降级为无界面模式。\n")
    try:
        port, url, already, host = _bootstrap_server(args.port, args.host)
    except Exception as exc:  # noqa: BLE001
        sys.stderr.write(f"[launcher] 启动失败：{exc}\n")
        return

    sys.stderr.write(f"[launcher] 错题簿已启动：{url}\n")
    if not args.no_browser:
        _open_browser_robust(url)

    if not already:
        threading.Thread(target=lambda: _serve_forever(port, host), daemon=True).start()
    while True:
        time.sleep(3600)


def _run_gui(args: argparse.Namespace) -> None:
    if args.no_browser:
        _run_headless(args)
        return
    try:
        _run_tk_gui(args)
    except Exception as exc:  # noqa: BLE001
        _log_line(f"Tkinter GUI 不可用，降级无界面: {exc}")
        _run_headless(args)


def main() -> None:
    args = _parse_args()
    try:
        _run_gui(args)
    except Exception as exc:  # noqa: BLE001
        _log_line(f"GUI 失败，降级无界面: {exc}")
        _run_headless(args)


if __name__ == "__main__":
    main()
