"""开机自启（HKCU）与单实例互斥（§9.2、§9.3）。

- 自启只写当前用户 HKCU\\...\\Run，路径加引号；不写 HKLM、不要求管理员。
- 单实例用命名互斥体；重复启动返回已有实例信号。
"""
from __future__ import annotations

import sys
from typing import Optional

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_NAME = "QuanQuanRollCall"
LEGACY_APP_NAMES = ("CandyRollCall",)  # 旧版自启项名，升级时清理
MUTEX_NAME = "QuanQuanRollCall_SingleInstance_Mutex"


def get_exe_path() -> str:
    """当前 EXE 绝对路径（冻结时取 sys.executable）。"""
    if getattr(sys, "frozen", False):
        return sys.executable
    return f'"{sys.executable}" "{__import__("os").path.abspath(sys.argv[0])}"'


class StartupManager:
    """HKCU 自启项管理。非 Windows 平台所有操作为空操作。"""

    def __init__(self):
        self._win = sys.platform == "win32"

    def _open_key(self):
        import winreg
        return winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY)

    def is_enabled(self) -> bool:
        if not self._win:
            return False
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_READ) as k:
                val, _ = winreg.QueryValueEx(k, APP_NAME)
                return bool(val)
        except (FileNotFoundError, OSError):
            return False

    def get_registered_path(self) -> Optional[str]:
        if not self._win:
            return None
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_READ) as k:
                val, _ = winreg.QueryValueEx(k, APP_NAME)
                return val
        except (FileNotFoundError, OSError):
            return None

    def enable(self, exe_path: Optional[str] = None) -> bool:
        """写入自启项，路径加引号（AT-30）。"""
        if not self._win:
            return False
        exe = exe_path or get_exe_path()
        if not exe.startswith('"'):
            exe = f'"{exe}"'
        try:
            with self._open_key() as k:
                import winreg
                winreg.SetValueEx(k, APP_NAME, 0, winreg.REG_SZ, exe)
            return True
        except OSError:
            return False

    def disable(self) -> bool:
        """删除本应用自启项；关闭开关应及时删除（§9.2）。"""
        if not self._win:
            return False
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, APP_NAME)
            return True
        except FileNotFoundError:
            return True  # 本就没有自启项：幂等视为成功
        except OSError:
            return False

    def cleanup_legacy(self) -> bool:
        """删除旧版本（CandyRollCall）留下的自启项，避免升级后残留失效条目。

        使用旧名注册的自启项指向旧 EXE；改名后它既不会随关闭开关删除，
        也不会再被新版本维护，因此启动时主动清理。幂等，无此值即视为成功。
        """
        if not self._win:
            return True
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
                for name in LEGACY_APP_NAMES:
                    try:
                        winreg.DeleteValue(k, name)
                    except FileNotFoundError:
                        pass
            return True
        except (FileNotFoundError, OSError):
            return False

    def check_stale_path(self) -> bool:
        """检测注册的自启路径与当前 EXE 是否一致（AT-30：移动 EXE 后由 main 静默修正）。"""
        reg = self.get_registered_path()
        if not reg:
            return False
        current = get_exe_path().strip('"')
        return reg.strip('"').lower() != current.lower()


class SingleInstanceGuard:
    """命名互斥体单实例（AT-31）。非 Windows 空实现。"""

    def __init__(self):
        self._handle = None
        self._win = sys.platform == "win32"

    def acquire(self) -> bool:
        """尝试获取；已存在实例时返回 False。"""
        if not self._win:
            return True
        import ctypes
        ERROR_ALREADY_EXISTS = 183
        ctypes.windll.kernel32.CreateMutexW(None, False, MUTEX_NAME)
        if ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS:
            return False
        self._handle = True
        return True

    def release(self):
        self._handle = None
