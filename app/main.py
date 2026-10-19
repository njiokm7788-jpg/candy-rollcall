"""应用入口：WebView2 检测、启动与退出编排（§3.2 应用生命周期、§9.1）。

初始化业务服务 → 检测 WebView2 → 创建唯一主窗（可隐藏）→ 启动 GUI 循环
及球线程 → 圆球可见。点击球显示主窗并切到点名视图，右键切到管理视图；
点名页与管理页在同一个 WebView 内切换（不创建第二个窗口）；退出统一结束。
"""
from __future__ import annotations

import ctypes
import sys
from pathlib import Path

# ---- 打包资源路径（PyInstaller _MEIPASS 兼容）----
def resource_path(relative: str) -> str:
    base = getattr(sys, "_MEIPASS", None)
    if base:
        return str(Path(base) / relative)
    return str(Path(__file__).resolve().parent.parent / relative)


def report_error(context: str, exc: BaseException) -> None:
    """把窗口/悬浮球回调里的异常写入数据目录日志。

    打包后 console=False；若再静默吞掉异常，“点了没反应”这类接线故障就
    完全没有出口（离线工具也没有远端日志）。
    """
    try:
        from datetime import datetime
        from .storage import user_paths
        logs = user_paths.logs_dir()
        logs.mkdir(parents=True, exist_ok=True)
        with open(logs / "error.log", "a", encoding="utf-8") as f:
            f.write(f"{datetime.now().isoformat(timespec='seconds')} "
                    f"[{context}] {type(exc).__name__}: {exc}\n")
    except Exception:
        pass  # 记日志本身失败不得影响主流程


def check_webview2_runtime() -> bool:
    """检测 WebView2 Runtime（§9.1）：核对注册表版本字段。

    不静默回退 MSHTML；缺失时由 caller 提示安装官方运行环境。
    """
    if sys.platform != "win32":
        return True  # 非 Windows 开发环境视为可用（实机验证在 Windows 上做）
    try:
        import winreg
        for root, path in (
            (winreg.HKEY_LOCAL_MACHINE,
             r"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
            (winreg.HKEY_CURRENT_USER,
             r"Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
        ):
            try:
                with winreg.OpenKey(root, path) as k:
                    pv, _ = winreg.QueryValueEx(k, "pv")
                    if pv and pv not in ("0.0.0.0", ""):
                        return True
            except OSError:
                continue
    except Exception:
        pass
    return False


def show_webview2_missing_dialog() -> None:
    """缺失 WebView2 时的明确提示（AT-04），不自动下载、不提权。"""
    message = (
        "当前电脑缺少 Microsoft Edge WebView2 Runtime。\n\n"
        "本工具需要 WebView2 才能显示界面。\n"
        "请从微软官网下载并安装 WebView2 Runtime（Evergreen 安装程序）：\n"
        "https://developer.microsoft.com/microsoft-edge/webview2/\n\n"
        "安装完成后重新打开本工具。"
    )
    if sys.platform == "win32":
        MB_OK = 0x0
        MB_ICONERROR = 0x10
        ctypes.windll.user32.MessageBoxW(None, message, "缺少运行环境", MB_OK | MB_ICONERROR)
    else:
        print(message, file=sys.stderr)


def get_frontend_url() -> str:
    """本地静态资源 URL；pywebview 内置静态服务器加载，避免 file:// 限制（§3.3）。"""
    html = resource_path("frontend/index.html")
    return str(Path(html).resolve())


# 悬浮球等非 WebView 入口借此驱动前端切视图（App 由前端定义，未就绪时静默跳过）
_JS_SHOW_ROLL = "if (typeof App !== 'undefined' && App.showView) App.showView('roll');"
_JS_SHOW_MANAGE = "if (typeof App !== 'undefined' && App.showView) App.showView('manage');"


def main() -> int:
    import webview

    # 0. WebView2 检测（在创建任何窗口之前）
    if not check_webview2_runtime():
        show_webview2_missing_dialog()
        return 2

    # 1. 单实例（AT-31）
    from .windows.startup import SingleInstanceGuard, StartupManager
    guard = SingleInstanceGuard()
    if not guard.acquire():
        # 重复双击：激活现有实例即可（此处简单退出；实机验证阶段可扩展窗口激活）
        return 0

    # 2. 业务服务初始化（崩溃后重启重置本轮，加载名单设置，AT-29）
    from .core.application_state import ApplicationState
    from .core.models import (
        DEFAULT_WINDOW_HEIGHT,
        DEFAULT_WINDOW_WIDTH,
        MIN_WINDOW_HEIGHT,
        MIN_WINDOW_WIDTH,
    )
    state = ApplicationState()
    state.startup()

    # 退出标记：区分“点名窗 X（收起）”与“应用退出（真正关闭窗口）”
    quitting = False

    # 3. 窗口编排
    from .windows.window_manager import WindowManager
    wm = WindowManager(on_error=lambda e: report_error("window_manager.eval_js", e))

    # 4. 悬浮球（独立 GUI 线程；跨线程 PostMessage）
    from .windows.orb_win32 import create_orb_thread
    from .windows.dpi_and_snap import Win32MonitorMixin, clamp_to_workarea

    settings = state.get_settings()
    snap_enabled = bool(settings.get("edgeSnap", True))
    saved = settings.get("lastOrbPosition") or {"x": 0, "y": 0}
    saved_window = settings.get("lastWindowSize") or {}
    win_width = int(saved_window.get("width", DEFAULT_WINDOW_WIDTH))
    win_height = int(saved_window.get("height", DEFAULT_WINDOW_HEIGHT))

    def save_window_size() -> None:
        """收起/退出前记住主窗尺寸；只读 GUI 线程维护的缓存，避免跨线程取控件。"""
        try:
            size = wm.get_size()
            if size:
                state.set_preference("lastWindowSize", {"width": size[0], "height": size[1]})
        except Exception as e:
            report_error("save_window_size", e)

    def on_window_resized(width: int, height: int) -> None:
        try:
            wm.note_size(width, height)
        except Exception as e:
            report_error("on_window_resized", e)

    def on_position_saved(x: int, y: int) -> None:
        state.set_preference("lastOrbPosition", {"x": x, "y": y})

    def on_orb_click() -> None:
        # 单击球：显示主窗并切到点名视图（§4.2）。跨线程 → 走 wm 投递。
        try:
            wm.show()
            wm.eval_js(_JS_SHOW_ROLL)
        except Exception as e:
            report_error("on_orb_click", e)

    def on_orb_manage() -> None:
        # 右键→管理名单：显示主窗并切到管理视图；悬浮球保持可见（§4.2）
        try:
            wm.show()
            wm.eval_js(_JS_SHOW_MANAGE)
        except Exception as e:
            report_error("on_orb_manage", e)

    def on_orb_quit() -> None:
        quit_app()

    def collapse_roll_window() -> None:
        """收起：主窗隐藏变回悬浮球；轮次保留（§2）。"""
        save_window_size()
        wm.hide()

    def quit_app() -> None:
        """统一退出：停止球线程、关闭所有窗口、结束进程（无残留，AT-09）。"""
        nonlocal quitting
        quitting = True  # 允许点名窗真正关闭（否则被 closing 事件取消）
        save_window_size()
        try:
            orb.close()
        except Exception:
            pass
        try:
            wm.shutdown()
        except Exception:
            pass
        import os
        os._exit(0)  # 确保无孤儿线程/进程残留

    # 初始位置：主屏右边缘中部附近（实施建议，§4.2），夹紧到工作区
    if sys.platform == "win32":
        work = Win32MonitorMixin.get_primary_workarea()
        from .windows.orb_win32 import ORB_SIZE
        init_x = work.right - ORB_SIZE - 16 if not saved.get("x") else int(saved["x"])
        init_y = (work.top + work.bottom) // 2 - ORB_SIZE // 2 if not saved.get("y") else int(saved["y"])
        init_x, init_y = clamp_to_workarea(init_x, init_y, ORB_SIZE, work)
    else:
        init_x, init_y = int(saved.get("x", 100)), int(saved.get("y", 100))

    def on_roll_window_closing() -> bool:
        """点名窗 X 按钮 → 收起为悬浮球，而不是结束整个工具（球须常驻，§4.2）。

        返回 False 取消关闭；pywebview 的 closing 事件同步生效（should_lock=True）。
        handler 抛出的异常会被 pywebview 吞掉并视作"不取消"，因此这里必须自行兜底。
        """
        if quitting:
            return True
        try:
            save_window_size()
            wm.hide()
        except Exception as e:
            report_error("on_roll_window_closing", e)
        return False

    def create_main_window() -> webview.Window:
        """唯一主窗：点名页与管理页在同一 WebView 内切换视图。

        统一尺寸取管理页所需大小（点名页是流式布局，只会更空旷）。
        先隐藏创建，球线程就绪后由 wm.show() 显示。
        """
        win = webview.create_window(
            "圈圈点名",
            get_frontend_url(),
            js_api=bridge,
            width=win_width,
            height=win_height,
            min_size=(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT),
            hidden=True,  # 初始隐藏；点击球显示（实机验证项 §3.2）
        )
        win.events.closing += on_roll_window_closing
        win.events.resized += on_window_resized
        return win

    # 5. 桥接（窗口编排回调注入）
    from .bridge import Bridge
    bridge = Bridge(state, window_ctrl={
        "collapse": collapse_roll_window,
        "fullscreen": lambda: wm.toggle_fullscreen(),
        "quit": quit_app,
    })

    # 6. 启动球线程（在 pywebview GUI 循环启动前创建窗口对象不可行——
    #    pywebview 需主线程循环。这里先起球线程，再 webview.start 阻塞主线程。）
    orb = create_orb_thread(
        on_click=on_orb_click,
        on_manage=on_orb_manage,
        on_quit=quit_app,
        initial_pos=(init_x, init_y),
        snap_enabled=snap_enabled,
        on_position_saved=on_position_saved,
    )

    # 7. 开机启动路径变更检查（AT-30）
    sm = StartupManager()
    sm.cleanup_legacy()  # 清理旧版 CandyRollCall 自启项（改名后不再维护）
    if sm.is_enabled() and sm.check_stale_path():
        # 下次手动启动时识别当前路径；此处静默修正为当前 EXE（用户已在用新版路径）
        sm.enable()

    # 8. 创建主窗并启动 GUI 循环（主线程阻塞）
    wm.register_window(create_main_window())
    wm.note_size(win_width, win_height)
    try:
        webview.start(gui="edgechromium", debug=False)
    except Exception:
        # WebView2 环境异常等；明确失败而非伪装成功
        raise
    finally:
        try:
            orb.close()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
