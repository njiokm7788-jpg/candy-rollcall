"""数据目录定位（§5.3）。

Windows: %LOCALAPPDATA%\\QuanQuanRollCall\\
其他平台（开发/测试）: ~/.quanquan_rollcall/ 或环境变量 QUANQUAN_ROLLCALL_HOME。
不写在 PyInstaller _MEIPASS 解包目录，也不默认 EXE 所在目录。

改名兼容：旧版（CandyRollCall）数据目录若存在、而新目录还没有 data.json，
首次定位数据目录时把 data.json / data.json.bak 复制过来，老用户名单不丢。
只复制不删除旧目录；迁移失败不阻断启动。
"""
from __future__ import annotations

import os
import shutil
import sys
import threading
from pathlib import Path
from typing import Optional

APP_DIR_NAME = "QuanQuanRollCall"
LEGACY_APP_DIR_NAME = "CandyRollCall"
ENV_VAR = "QUANQUAN_ROLLCALL_HOME"
LEGACY_ENV_VAR = "CANDY_ROLLCALL_HOME"

_migrate_lock = threading.Lock()
_migrated = False


def migrate_legacy_data(target: Path, legacy: Path) -> bool:
    """把旧目录的数据文件复制到新目录（仅当新目录还没有 data.json）。

    返回是否发生了复制；任何 IO 失败都静默跳过，不影响启动。
    """
    try:
        if (target / "data.json").exists() or not (legacy / "data.json").exists():
            return False
        target.mkdir(parents=True, exist_ok=True)
        copied = False
        for name in ("data.json", "data.json.bak"):
            src = legacy / name
            dst = target / name
            if src.exists() and not dst.exists():
                shutil.copy2(src, dst)
                copied = True
        return copied
    except OSError:
        return False


def _paths() -> tuple[Path, Path]:
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or str(Path.home() / "AppData" / "Local")
        return Path(base) / APP_DIR_NAME, Path(base) / LEGACY_APP_DIR_NAME
    return Path.home() / ".quanquan_rollcall", Path.home() / ".candy_rollcall"


def data_dir() -> Path:
    global _migrated
    # 显式指定目录（开发/测试）时不做自动迁移，避免污染沙箱
    env = os.environ.get(ENV_VAR) or os.environ.get(LEGACY_ENV_VAR)
    if env:
        return Path(env)
    target, legacy = _paths()
    if not _migrated:
        with _migrate_lock:
            if not _migrated:
                migrate_legacy_data(target, legacy)
                _migrated = True
    return target


def data_file() -> Path:
    return data_dir() / "data.json"


def logs_dir() -> Path:
    return data_dir() / "logs"
