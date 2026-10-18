"""js_api 白名单桥接（§10）。

pywebview 在独立线程调用这些方法（非线程安全），全部写操作经
ApplicationState 的锁保护。仅暴露白名单方法，前端不能任意注入路径。

确认类动作（change_mode / reset_round / commit_students）
返回 needsConfirm 供前端展示确认框；真正提交须带 confirmed=True。
"""
from __future__ import annotations

from typing import Any, Optional

from .core.application_state import ApplicationState
from .core.models import ValidationError
from .storage import import_export


class Bridge:
    """window.pywebview.api 的后端对象。每个公开方法对应 §10 API 表。"""

    def __init__(self, state: ApplicationState, window_ctrl: Optional[dict] = None):
        """
        window_ctrl: 可选 {"collapse": fn, "fullscreen": fn, "quit": fn}
        由 main.py 注入窗口编排回调（跨线程 UI 指令经此投递）。
        视图切换（点名↔管理）由前端在同一 document 内自行完成，不经后端。
        """
        self._state = state
        self._ctrl = window_ctrl or {}

    # ================ 状态 ================
    def get_snapshot(self) -> dict:
        """全班名单、设置、当前状态摘要（管理页初始化用）。"""
        return {"ok": True, **self._state.full_snapshot()}

    # ================ 抽取 ================
    def draw(self, count: Optional[int] = None) -> dict:
        """原子生成结果；忙时返回 BUSY（不重复计数，AT-18）。"""
        result = self._state.draw(count)
        if not result.get("ok"):
            return result
        # 供动画层使用
        snap = result.get("state", {})
        result["baseAnimationSeconds"] = self._state.get_settings()["baseAnimationSeconds"]
        result["remaining"] = snap.get("remaining")
        return result

    def mark_reveal_complete(self, draw_id: str) -> dict:
        """常规完成/立即揭晓共用；同 drawId 幂等，过期忽略（AT-38）。"""
        return self._state.mark_reveal_complete(draw_id)

    def set_draw_count(self, count: int) -> dict:
        """仅点名主页调用；保存设置不重置轮次（§10）。"""
        result = self._state.set_preference("drawCount", count)
        return result

    def change_mode(self, mode: str, confirmed: bool = False) -> dict:
        return self._state.change_mode(mode, confirmed=confirmed)

    def reset_round(self, confirmed: bool = False) -> dict:
        return self._state.reset_round(confirmed=confirmed)

    # ================ 名单 ================
    def commit_students(self, draft: list, strategy: str,
                        decisions: Optional[dict] = None,
                        confirmed: bool = False) -> dict:
        """校验 → 保存 → 重置本轮。"""
        return self._state.commit_students(draft, strategy, decisions, confirmed)

    # ================ 导入 ================
    def import_file_dialog(self) -> dict:
        """打开文件选择对话框（pywebview 原生），直接返回导入预览（不写库）。"""
        import webview
        windows = webview.windows
        if not windows:
            return {"ok": False, "error": "NoWindow"}
        result = windows[0].create_file_dialog(
            webview.OPEN_DIALOG,
            allow_multiple=False,
            file_types=("Excel/CSV (*.xlsx;*.csv)", "所有文件 (*.*)",),
        )
        if not result:
            return {"ok": False, "error": "Cancelled"}
        path = result[0] if isinstance(result, (list, tuple)) else result
        return self._load_import_file(path)

    def _load_import_file(self, path: str) -> dict:
        """读取文件 → 推导列映射 → 返回预览（一次调用完成，无需二次握手）。"""
        encoding = None
        try:
            lower = str(path).lower()
            if lower.endswith(".xlsx"):
                rows = import_export.read_xlsx_rows(path)
            elif lower.endswith(".csv"):
                with open(path, "rb") as f:
                    content = f.read()
                rows, encoding = self._decode_csv_with_fallback(content)
            else:
                return {"ok": False, "error": "UnsupportedFormat",
                        "message": "仅支持 .xlsx 与 .csv 文件"}
        except ValidationError as e:
            return {"ok": False, "error": "ValidationError", "message": str(e)}
        except OSError as e:
            return {"ok": False, "error": "IOError", "message": str(e)}

        mapping, has_header = import_export.derive_mapping(rows)
        try:
            drafts = import_export.rows_to_drafts(rows, mapping, has_header)
            preview = import_export.preview_import(drafts, self._state.get_students())
        except ValidationError as e:
            return {"ok": False, "error": "ValidationError", "message": str(e)}
        return {"ok": True, "csvEncoding": encoding, **preview}

    @staticmethod
    def _decode_csv_with_fallback(content: bytes):
        """优先 utf-8-sig，失败回退 GB18030，仍失败给出乱码警告（§8.2）。"""
        for enc in ("utf-8-sig", "gb18030"):
            try:
                return import_export.read_csv_rows(content, enc), enc
            except ValidationError:
                continue
        raise ValidationError("无法识别文件编码，请用 UTF-8 或 GB18030 重新保存")

    def import_from_paste(self, text: str) -> dict:
        """批量粘贴预览。"""
        drafts = import_export.parse_paste_text(text)
        preview = import_export.preview_import(drafts, self._state.get_students())
        return {"ok": True, **preview}

    # ================ 导出 ================
    def export_students(self, fmt: str) -> dict:
        """xlsx/csv 导出：打开保存对话框并写入本地文件（AT-34）。"""
        import webview
        if fmt not in ("xlsx", "csv"):
            return {"ok": False, "error": "ValidationError", "message": "格式须为 xlsx 或 csv"}
        windows = webview.windows
        if not windows:
            return {"ok": False, "error": "NoWindow"}
        ext = "xlsx" if fmt == "xlsx" else "csv"
        result = windows[0].create_file_dialog(
            webview.SAVE_DIALOG,
            save_filename=f"学生名单.{ext}",
            file_types=(f"{ext.upper()} (*.{ext})",),
        )
        if not result:
            return {"ok": False, "error": "Cancelled"}
        path = result[0] if isinstance(result, (list, tuple)) else result
        students = self._state.get_students()
        try:
            if fmt == "xlsx":
                data = import_export.export_xlsx(students)
            else:
                data = import_export.export_csv(students)
            with open(path, "wb") as f:
                f.write(data)
        except OSError as e:
            return {"ok": False, "error": "IOError", "message": str(e)}
        return {"ok": True, "path": str(path), "count": len(students)}

    # ================ 设置 ================
    def set_preference(self, key: str, value: Any) -> dict:
        """写设置；startWithWindows 必须同时落到 HKCU Run 才算生效（§9.2）。"""
        previous = self._state.get_settings().get(key) if key == "startWithWindows" else None
        result = self._state.set_preference(key, value)
        if result.get("ok") and key == "startWithWindows":
            from .windows.startup import StartupManager
            sm = StartupManager()
            applied = sm.enable() if value else sm.disable()
            if not applied:
                self._state.set_preference(key, previous)  # 回滚，避免"看起来开了"
                return {"ok": False, "error": "StartupWriteFailed",
                        "message": "写入开机启动项失败（注册表不可写），已保持原状态"}
        return result

    # ================ 窗口编排 ================
    def collapse(self) -> dict:
        """收起点名窗变回悬浮球；不重置轮次（AT-10）。"""
        fn = self._ctrl.get("collapse")
        if fn:
            fn()
        return {"ok": True}

    def show_fullscreen(self) -> dict:
        """全屏切换；Esc 由前端监听退出（§4.3）。"""
        fn = self._ctrl.get("fullscreen")
        if fn:
            fn()
        return {"ok": True}

    def quit_app(self) -> dict:
        """统一退出：停止球线程、关闭所有窗口、结束进程（AT-09）。"""
        fn = self._ctrl.get("quit")
        if fn:
            fn()
        return {"ok": True}
