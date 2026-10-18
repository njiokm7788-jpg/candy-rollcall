"""CandyRollCall 打包/运行入口。

PyInstaller 冻结时以本文件为顶层脚本（``__main__``），再由它以绝对导入
加载 ``app`` 包；这样 ``app`` 下的相对导入才能拿到正确的包上下文。

若直接冻结 ``app/main.py``，其内部的相对导入（``from .windows...``）会因
缺少父包而以 ``ImportError: attempted relative import with no known parent
package`` 失败——本入口即用于规避该问题。

本地开发仍可用 ``python -m app.main``。
"""
from __future__ import annotations

import sys

from app.main import main

if __name__ == "__main__":
    sys.exit(main())
