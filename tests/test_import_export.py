"""导入导出测试（M3 门槛、§8、AT-14/26/34）。"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.models import Student, ValidationError
from app.storage import import_export as ie


def mk(n, prefix="学生"):
    return [Student.create(f"{prefix}{i:02d}") for i in range(1, n + 1)]


class TestDeriveMapping(unittest.TestCase):
    """列映射推导（§8.2）：本工具自己的导出必须能重新导入（AT-14）。"""

    def test_tool_export_header_maps_name_and_no(self):
        """“序号/姓名/学号”三列：序号不得被当作姓名或学号。"""
        rows = [["序号", "姓名", "学号"], ["1", "张小明", "08"]]
        mapping, has_header = ie.derive_mapping(rows)
        self.assertTrue(has_header)
        self.assertEqual(mapping, {"name": 1, "studentNo": 2})
        self.assertEqual(ie.rows_to_drafts(rows, mapping, has_header),
                         [{"name": "张小明", "studentNo": "08"}])

    def test_common_two_column_header(self):
        rows = [["姓名", "学号"], ["张小明", "08"]]
        self.assertEqual(ie.derive_mapping(rows), ({"name": 0, "studentNo": 1}, True))

    def test_reversed_header_order(self):
        rows = [["学号", "姓名"], ["08", "张小明"]]
        self.assertEqual(ie.derive_mapping(rows), ({"name": 1, "studentNo": 0}, True))

    def test_header_without_student_no_column(self):
        rows = [["姓名"], ["张小明"]]
        self.assertEqual(ie.derive_mapping(rows), ({"name": 0, "studentNo": -1}, True))

    def test_no_header_falls_back_to_first_two_columns(self):
        rows = [["张小明", "08"]]
        self.assertEqual(ie.derive_mapping(rows), ({"name": 0, "studentNo": 1}, False))

    def test_single_column_without_header(self):
        rows = [["张小明"]]
        mapping, has_header = ie.derive_mapping(rows)
        self.assertEqual((mapping, has_header), ({"name": 0, "studentNo": 1}, False))
        self.assertEqual(ie.rows_to_drafts(rows, mapping, has_header),
                         [{"name": "张小明", "studentNo": None}])

    def test_empty_rows(self):
        self.assertEqual(ie.derive_mapping([]), ({"name": 0, "studentNo": -1}, False))


class TestCsv(unittest.TestCase):
    def test_csv_roundtrip_preserves_leading_zero(self):
        """AT-14：学号 08 导出再导入仍为 08（字符串），列映射由表头推导。"""
        students = [Student.create("张小明", "08"), Student.create("李小红", "")]
        data = ie.export_csv(students)
        rows = ie.read_csv_rows(data, "utf-8-sig")
        self.assertEqual(rows[0], ["序号", "姓名", "学号"])
        self.assertEqual(rows[1][2], "08")  # 前导零保留
        # 走真实导入路径（表头推导），不再手工硬编码列号
        mapping, has_header = ie.derive_mapping(rows)
        drafts = ie.rows_to_drafts(rows, mapping, has_header)
        self.assertEqual(len(drafts), 2)
        self.assertEqual(drafts[0]["name"], "张小明")
        self.assertEqual(drafts[0]["studentNo"], "08")

    def test_csv_gb18030(self):
        """GB18030 编码可读，不把乱码写入库（§8.2）。"""
        students = mk(2)
        text = "姓名,学号\n王小虎,01\n"
        data = text.encode("gb18030")
        rows = ie.read_csv_rows(data, "gb18030")
        drafts = ie.rows_to_drafts(rows[1:], {"name": 0, "studentNo": 1})
        self.assertEqual(drafts[0]["name"], "王小虎")

    def test_csv_bad_encoding_raises(self):
        with self.assertRaises(ValidationError):
            ie.read_csv_rows(b"\xff\xfe\x00\x00bad", "utf-8-sig")


class TestXlsx(unittest.TestCase):
    def test_xlsx_roundtrip(self):
        """XLSX 学号列文本格式（@），数值学号 8 读回为 "8"。"""
        students = [Student.create("张小明", "08"), Student.create("李小红", "9")]
        data = ie.export_xlsx(students)
        # 写临时文件再读
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
            f.write(data)
            path = f.name
        try:
            rows = ie.read_xlsx_rows(path)
            self.assertEqual(rows[0], ["序号", "姓名", "学号"])
            self.assertEqual(rows[1][2], "08")
            self.assertEqual(rows[2][2], "9")
            # 走真实导入路径（表头推导）：姓名列不得被“序号”列顶替（AT-14）
            mapping, has_header = ie.derive_mapping(rows)
            drafts = ie.rows_to_drafts(rows, mapping, has_header)
            self.assertEqual([d["name"] for d in drafts], ["张小明", "李小红"])
            self.assertEqual(drafts[0]["studentNo"], "08")
        finally:
            os.unlink(path)


class TestPaste(unittest.TestCase):
    def test_paste_single_column(self):
        drafts = ie.parse_paste_text("张小明\n李小红\n")
        self.assertEqual(drafts, [{"name": "张小明", "studentNo": None},
                                  {"name": "李小红", "studentNo": None}])

    def test_paste_two_columns(self):
        drafts = ie.parse_paste_text("08\t张小明\n09,李小红\n10 王小虎\n")
        self.assertEqual(drafts[0], {"name": "张小明", "studentNo": "08"})
        self.assertEqual(drafts[1], {"name": "李小红", "studentNo": "09"})
        self.assertEqual(drafts[2], {"name": "王小虎", "studentNo": "10"})

    def test_paste_skips_empty_lines(self):
        drafts = ie.parse_paste_text("\n张小明\n\n\n")
        self.assertEqual(len(drafts), 1)


class TestPreview(unittest.TestCase):
    def test_duplicates_kinds(self):
        """§8.3 重复判定矩阵。"""
        existing = [Student.create("张小明", "08"), Student.create("李小红", "")]
        drafts = [
            {"name": "张小明", "studentNo": "08"},   # 同名同号 → 高度疑似
            {"name": "张小明", "studentNo": "09"},   # 同名不同号 → 同名提示
            {"name": "李小红", "studentNo": None},   # 同名双无号 → 人工确认
            {"name": "王小虎", "studentNo": "08"},   # 同学号不同名 → 冲突
            {"name": "赵新", "studentNo": "10"},     # 无问题
        ]
        p = ie.preview_import(drafts, existing)
        kinds = {i["key"]: i["kind"] for i in p["issues"]}
        self.assertEqual(kinds["new:0"], "duplicate_exact")
        self.assertEqual(kinds["new:1"], "same_name_diff_no")
        self.assertEqual(kinds["new:2"], "same_name_no_no")
        self.assertEqual(kinds["new:3"], "no_conflict")
        self.assertNotIn("new:4", kinds)
        self.assertEqual(p["validCount"], 5)

    def test_over_limit(self):
        """AT-12 后端部分：超过 100 人标记超额。"""
        drafts = [{"name": f"学生{i}", "studentNo": None} for i in range(101)]
        p = ie.preview_import(drafts, [])
        self.assertTrue(p["overLimit"])
        self.assertEqual(p["maxStudents"], 100)

    def test_empty_names_flagged(self):
        drafts = [{"name": "", "studentNo": None}, {"name": "张小明", "studentNo": None}]
        p = ie.preview_import(drafts, [])
        self.assertEqual(p["emptyNameRows"], [0])
        self.assertEqual(p["validCount"], 1)

    def test_internal_duplicates_within_new_list(self):
        """追加时新名单内部重复也要检查（§8.3）。"""
        drafts = [{"name": "张小明", "studentNo": "08"},
                  {"name": "张小明", "studentNo": "08"}]
        p = ie.preview_import(drafts, [])
        exact = [i for i in p["issues"] if i["kind"] == "duplicate_exact"]
        self.assertEqual(len(exact), 1)  # 第二条被报告


if __name__ == "__main__":
    unittest.main()
