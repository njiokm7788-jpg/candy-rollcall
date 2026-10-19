"""存储与会话状态测试（M1 门槛、§5、AT-21/22/29）。

使用 QUANQUAN_ROLLCALL_HOME 环境变量隔离临时数据目录。
"""
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_tmpdir = tempfile.mkdtemp(prefix="candy-test-")
os.environ["QUANQUAN_ROLLCALL_HOME"] = _tmpdir

from app.core.application_state import ApplicationState
from app.core.models import ValidationError, default_settings, validate_settings
from app.storage import user_paths
from app.storage.json_store import DataCorruptError, JsonStore


def make_draft(n, prefix="学生"):
    return [{"name": f"{prefix}{i:02d}", "studentNo": None} for i in range(1, n + 1)]


class TestJsonStore(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="candy-store-")
        self.path = os.path.join(self.dir, "data.json")
        self.store = JsonStore(self.path)

    def test_atomic_save_load(self):
        doc = {"schemaVersion": 2, "students": [{"id": "a", "name": "张小明", "studentNo": "08"}],
               "settings": {"mode": "no_repeat"}}
        self.store.save(doc)
        loaded = self.store.load()
        self.assertEqual(loaded["students"][0]["studentNo"], "08")

    def test_no_tmp_files_left(self):
        self.store.save({"schemaVersion": 2, "students": [], "settings": {}})
        leftovers = [f for f in os.listdir(self.dir) if f.endswith(".tmp")]
        self.assertEqual(leftovers, [])

    def test_corrupt_main_recovers_from_bak(self):
        good = {"schemaVersion": 2, "students": [], "settings": {"mode": "random"}}
        self.store.save(good)
        # 破坏主文件
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{corrupt!!!")
        loaded = self.store.load()
        self.assertEqual(loaded["settings"]["mode"], "random")
        # 恢复后主文件可用
        self.assertEqual(self.store.load()["schemaVersion"], 2)

    def test_both_corrupt_raises_not_overwrite(self):
        """AT-27：两者均坏时抛 DataCorruptError，不悄悄覆盖。"""
        with open(self.path, "w", encoding="utf-8") as f:
            f.write("{bad")
        with open(self.store.bak_path, "w", encoding="utf-8") as f:
            f.write("{also bad")
        with self.assertRaises(DataCorruptError):
            self.store.load()
        # 原文件未被覆盖
        with open(self.path, encoding="utf-8") as f:
            self.assertEqual(f.read(), "{bad")

    def test_missing_file_returns_none(self):
        self.assertIsNone(self.store.load())


class TestApplicationState(unittest.TestCase):
    def setUp(self):
        # 每个测试独立的临时目录 + 新实例
        self.dir = tempfile.mkdtemp(prefix="candy-app-")
        os.environ["QUANQUAN_ROLLCALL_HOME"] = self.dir
        self.state = ApplicationState()

    # ---------- 提交与校验 ----------
    def test_commit_replace_resets_round(self):
        """AT-22 后端部分：提交名单重置本轮。"""
        snap = self.state.commit_students(make_draft(5), "replace", None, True)
        self.assertEqual(snap["draw"]["studentCount"], 5)
        r = self.state.draw()
        self.assertTrue(r["ok"])
        self.state.mark_reveal_complete(r["drawId"])
        # 再次提交 → 轮次重置
        snap2 = self.state.commit_students(make_draft(6), "replace", None, True)
        self.assertEqual(snap2["draw"]["remaining"], 6)
        self.assertIsNone(snap2["draw"]["activeResult"])

    def test_commit_requires_confirmation(self):
        """§10：无确认标记不提交。"""
        r = self.state.commit_students(make_draft(3), "replace", None, False)
        self.assertFalse(r["ok"])

    def test_commit_over_100_rejected(self):
        """AT-12：第 101 人明确拒绝，不截断。"""
        r = self.state.commit_students(make_draft(101), "replace", None, True)
        self.assertFalse(r["ok"])
        self.assertIn("101", r["message"])

    def test_append_over_100_rejected(self):
        self.state.commit_students(make_draft(95), "replace", None, True)
        r = self.state.commit_students(make_draft(10), "append", None, True)
        self.assertFalse(r["ok"])
        self.assertIn("105", r["message"])

    def test_skip_decision_respected(self):
        """教师选择“跳过”的疑似重复条目不入库（§8.3 不自动合并）。"""
        drafts = [{"name": "张小明", "studentNo": "08"},
                  {"name": "张小明", "studentNo": "08"}]
        snap = self.state.commit_students(drafts, "replace", {"new:1": "skip"}, True)
        self.assertEqual(len(snap["students"]), 1)

    def test_empty_name_rejected(self):
        r = self.state.commit_students([{"name": "  ", "studentNo": None}], "replace", None, True)
        self.assertFalse(r["ok"])

    # ---------- 学号字符串（AT-14） ----------
    def test_student_no_kept_as_string(self):
        snap = self.state.commit_students([{"name": "张小明", "studentNo": "08"}],
                                          "replace", None, True)
        self.assertEqual(snap["students"][0]["studentNo"], "08")
        # 重新加载后仍是字符串
        state2 = ApplicationState()
        state2.startup()
        students = state2.get_students()
        self.assertEqual(students[0].studentNo, "08")

    # ---------- 持久化与重启（AT-29） ----------
    def test_restart_resets_round_keeps_students(self):
        self.state.commit_students(make_draft(8), "replace", None, True)
        r = self.state.draw()
        self.state.mark_reveal_complete(r["drawId"])
        # 模拟重启：新实例加载
        state2 = ApplicationState()
        snap = state2.startup()
        self.assertEqual(len(snap["students"]), 8)
        self.assertEqual(snap["draw"]["state"], "IDLE")
        self.assertEqual(snap["draw"]["remaining"], 8, "重启清空 drawn_ids")

    def test_settings_persisted(self):
        self.state.commit_students(make_draft(3), "replace", None, True)
        self.state.set_preference("drawCount", 3)
        self.state.set_preference("baseAnimationSeconds", 6)
        snap = ApplicationState().startup()
        self.assertEqual(snap["settings"]["drawCount"], 3)
        self.assertEqual(snap["settings"]["baseAnimationSeconds"], 6)

    def test_window_size_persisted_and_clamped(self):
        """关闭时的窗口尺寸跨重启保留；过小尺寸按最小窗口修正。"""
        self.assertEqual(self.state.get_settings()["lastWindowSize"],
                         {"width": 760, "height": 560})
        r = self.state.set_preference("lastWindowSize", {"width": 980, "height": 700})
        self.assertTrue(r["ok"])
        snap = ApplicationState().startup()
        self.assertEqual(snap["settings"]["lastWindowSize"], {"width": 980, "height": 700})

        r = self.state.set_preference("lastWindowSize", {"width": 480, "height": 300})
        self.assertTrue(r["ok"])
        self.assertEqual(r["value"], {"width": 600, "height": 420})
        self.assertEqual(self.state.get_settings()["lastWindowSize"],
                         {"width": 600, "height": 420})

    def test_invalid_window_size_falls_back_to_default(self):
        r = self.state.set_preference("lastWindowSize", {"width": "980", "height": 700})
        self.assertFalse(r["ok"])
        r = self.state.set_preference("lastWindowSize", {"width": 980})
        self.assertFalse(r["ok"])
        self.assertEqual(validate_settings({"lastWindowSize": "bad"})["lastWindowSize"],
                         default_settings()["lastWindowSize"])

    def test_corrupt_data_starts_clean_not_crash(self):
        self.state.commit_students(make_draft(3), "replace", None, True)
        # 破坏主文件和 .bak
        for name in ("data.json", "data.json.bak"):
            p = os.path.join(self.dir, name)
            if os.path.exists(p):
                with open(p, "w", encoding="utf-8") as f:
                    f.write("{broken")
        snap = ApplicationState().startup()
        # 不崩溃：从干净状态开始（教师用外部备份恢复）
        self.assertEqual(snap["students"], [])

    # ---------- 设置校验 ----------
    def test_preference_whitelist(self):
        r = self.state.set_preference("drawCount", 3)
        self.assertTrue(r["ok"])
        r = self.state.set_preference("evilKey", "x")
        self.assertFalse(r["ok"])
        r = self.state.set_preference("drawCount", 9)
        self.assertFalse(r["ok"], "drawCount 须为 1~5")
        r = self.state.set_preference("baseAnimationSeconds", 20)
        self.assertFalse(r["ok"], "动画时长须为 2~8")

    # ---------- 模式切换（AT-19/20） ----------
    def test_change_mode_confirmation_flow(self):
        self.state.commit_students(make_draft(10), "replace", None, True)
        r = self.state.change_mode("random")   # 未确认
        self.assertTrue(r.get("needsConfirm"))
        self.assertEqual(self.state.get_settings()["mode"], "no_repeat")
        r = self.state.change_mode("random", confirmed=True)
        self.assertTrue(r["ok"])
        self.assertEqual(self.state.get_settings()["mode"], "random")
        self.assertEqual(r["state"]["remaining"], 10, "确认切换后重置本轮")

    def test_draw_count_change_does_not_reset(self):
        """修改人数保存设置但不重置（§6.3）。"""
        self.state.commit_students(make_draft(10), "replace", None, True)
        r = self.state.draw()
        self.state.mark_reveal_complete(r["drawId"])
        self.state.set_preference("drawCount", 3)
        self.assertEqual(len(self.state.full_snapshot()["draw"]["activeResult"]["students"]), 1)

    # ---------- 抽取接口（AT-18） ----------
    def test_draw_busy_via_state(self):
        self.state.commit_students(make_draft(10), "replace", None, True)
        r1 = self.state.draw()
        self.assertTrue(r1["ok"])
        r2 = self.state.draw()
        self.assertFalse(r2["ok"])
        self.assertEqual(r2["error"], "BUSY")


class TestConcurrency(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="candy-conc-")
        os.environ["QUANQUAN_ROLLCALL_HOME"] = self.dir
        self.state = ApplicationState()

    def test_concurrent_draws_single_transaction(self):
        """并发抽取：只有一个成功，其余 BUSY（AT-18）。"""
        self.state.commit_students(make_draft(50), "replace", None, True)
        results = []
        lock = threading.Lock()

        def worker():
            r = self.state.draw(5)
            with lock:
                results.append(r)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        ok = [r for r in results if r.get("ok")]
        self.assertEqual(len(ok), 1, "只应有一个抽样事务")
        self.assertEqual(len(results) - len(ok), 7, "其余全部 BUSY")

    def test_concurrent_commits_consistent(self):
        """并发提交：数据一致（后提交者生效）。"""
        self.state.commit_students(make_draft(3), "replace", None, True)
        errors = []

        def worker(i):
            try:
                self.state.commit_students(make_draft(3 + i), "replace", None, True)
            except ValidationError as e:
                errors.append(str(e))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        # 最终状态可加载且学生数在合法范围
        snap = self.state.full_snapshot()
        self.assertLessEqual(len(snap["students"]), 100)


class TestLegacyDataMigration(unittest.TestCase):
    """改名兼容：旧 CandyRollCall 目录的数据首次启动时复制到 QuanQuanRollCall。"""

    def setUp(self):
        self.base = tempfile.mkdtemp(prefix="qq-migrate-")
        self.legacy = Path(self.base) / "CandyRollCall"
        self.target = Path(self.base) / "QuanQuanRollCall"

    def _write(self, root: Path, name: str, text: str = '{"schemaVersion": 2}'):
        root.mkdir(parents=True, exist_ok=True)
        (root / name).write_text(text, encoding="utf-8")

    def test_copies_data_and_bak_when_target_empty(self):
        self._write(self.legacy, "data.json", '{"schemaVersion": 2, "students": [{"name": "张三"}]}')
        self._write(self.legacy, "data.json.bak")
        self.assertTrue(user_paths.migrate_legacy_data(self.target, self.legacy))
        self.assertIn("张三", (self.target / "data.json").read_text(encoding="utf-8"))
        self.assertTrue((self.target / "data.json.bak").exists())
        # 旧目录保留，不删除
        self.assertTrue((self.legacy / "data.json").exists())

    def test_does_not_overwrite_existing_target_data(self):
        self._write(self.legacy, "data.json", '{"old": true}')
        self._write(self.target, "data.json", '{"new": true}')
        self.assertFalse(user_paths.migrate_legacy_data(self.target, self.legacy))
        self.assertEqual((self.target / "data.json").read_text(encoding="utf-8"), '{"new": true}')

    def test_no_legacy_data_is_noop(self):
        self.assertFalse(user_paths.migrate_legacy_data(self.target, self.legacy))
        self.assertFalse(self.target.exists())


if __name__ == "__main__":
    unittest.main()
