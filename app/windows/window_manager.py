"""WebView 窗口生命周期编排（§3.2、§4.3）。

单窗口设计：点名页与管理页在**同一个 WebView 内切换视图**（前端负责切换），
后端只负责这一个窗口的显示/隐藏/全屏与退出，不再创建第二个窗口。
"""
from __future__ import annotations

import threading
from typing import Callable, Optional

import webview


class WindowManager:
    """管理唯一主窗。pywebview API 须在 GUI 线程外以
    webview.windows 上的方法调用；这里封装线程安全的窗口操作入口。

    on_error: 可选异常回调（通常是 main.report_error）。仅 eval_js 使用——
    它在线程中执行，异常无法回抛给调用方。
    """

    def __init__(self, on_error: Optional[Callable[[BaseException], None]] = None):
        self._lock = threading.RLock()
        self.window: Optional[webview.Window] = None
        self._on_error = on_error
        self._last_size: Optional[tuple[int, int]] = None

    def register_window(self, window: webview.Window) -> None:
        with self._lock:
            self.window = window

    # ---------- 尺寸 ----------
    def note_size(self, width: int, height: int) -> None:
        """缓存 pywebview 的 resized 事件尺寸（逻辑像素）。

        真正关闭前可能已经隐藏窗口，此时再同步读取 WinForms 控件尺寸容易
        跨线程失败；缓存由 GUI 线程的 resized 事件持续更新，退出时只读缓存。
        """
        try:
            width = int(width)
            height = int(height)
        except (TypeError, ValueError):
            return
        if width <= 0 or height <= 0:
            return
        with self._lock:
            self._last_size = (width, height)

    def get_size(self) -> Optional[tuple[int, int]]:
        """返回最近一次窗口尺寸；尚无事件时尝试从 GUI 读取一次。"""
        with self._lock:
            cached = self._last_size
            win = self.window
        if cached:
            return cached
        if not win or getattr(win, "gui", None) is None:
            return None
        try:
            width, height = win.gui.get_size(win.uid)
            self.note_size(width, height)
        except Exception:
            return None
        with self._lock:
            return self._last_size

    def show(self) -> None:
        with self._lock:
            win = self.window
        if not win:
            return
        try:
            win.show()
            win.restore()
        except Exception:
            pass

    def hide(self) -> None:
        """收起为悬浮球；轮次与视图状态都保留。"""
        with self._lock:
            win = self.window
        if not win:
            return
        try:
            win.hide()
        except Exception:
            pass

    def toggle_fullscreen(self) -> None:
        with self._lock:
            win = self.window
        if not win:
            return
        try:
            win.toggle_fullscreen()
        except Exception:
            pass

    def eval_js(self, script: str) -> None:
        """在主窗内执行 JS：悬浮球等非 WebView 入口借此驱动前端切视图。

        pywebview 的 evaluate_js 会先等窗口 loaded 事件（最长 20 s）再抛
        WebViewException，而调用方是悬浮球的 WndProc 线程——同步执行会让球
        假死。故投递到短生命周期线程；失败经 on_error 记录（前端另有
        App.pendingView 兜底，就绪前的切换意图不会丢）。
        """
        with self._lock:
            win = self.window
        if not win:
            return

        def run() -> None:
            try:
                win.evaluate_js(script)
            except Exception as e:
                if self._on_error:
                    self._on_error(e)

        threading.Thread(target=run, daemon=True, name="candy-eval-js").start()

    # ---------- 退出 ----------
    def shutdown(self) -> None:
        """统一退出：销毁主窗；pywebview 主循环随之结束。"""
        with self._lock:
            win = self.window
        if win is not None:
            try:
                win.destroy()
            except Exception:
                pass
