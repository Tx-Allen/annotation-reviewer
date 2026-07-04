import csv
import io
import os
import sqlite3
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import db


def insert_annotation(conn, annotation_id=1, **payload):
    data = {"annotation_id": str(annotation_id), "image": f"{annotation_id}.jpg"}
    data.update(payload)
    conn.execute(
        "INSERT INTO annotation(annotation_id, image_filename, payload_json, imported_at) "
        "VALUES (?, ?, ?, ?)",
        (
            annotation_id,
            data["image"],
            __import__("json").dumps(data),
            "2026-01-01T00:00:00",
        ),
    )
    conn.commit()


class BackendTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.conn = db.connect(os.path.join(self.tmp.name, "reviewer.db"))

    def tearDown(self):
        self.conn.close()
        self.tmp.cleanup()

    def test_foreign_keys_are_enabled_and_orphan_reviews_are_rejected(self):
        self.assertEqual(self.conn.execute("PRAGMA foreign_keys").fetchone()[0], 1)
        with self.assertRaisesRegex(ValueError, "annotation_id not found"):
            db.save_review(self.conn, 404, "auditor", "pass", "", {})

        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(
                "INSERT INTO review(annotation_id, reviewer, status, reviewed_at) "
                "VALUES (404, 'auditor', 'pass', '2026-01-01T00:00:00')"
            )

    def test_reset_deletes_reviews_before_annotations(self):
        insert_annotation(self.conn, 1)
        db.save_review(self.conn, 1, "auditor", "pass", "", {})

        csv_path = os.path.join(self.tmp.name, "data.csv")
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            f.write("annotation_id,image,label\n2,2.jpg,new\n")

        self.assertEqual(db.import_csv(self.conn, csv_path, reset=True), 1)
        self.assertEqual(
            self.conn.execute("SELECT COUNT(*) FROM review").fetchone()[0],
            0,
        )
        self.assertEqual(
            self.conn.execute("SELECT annotation_id FROM annotation").fetchone()[0],
            2,
        )

    def test_latest_review_uses_same_id_order_in_list_detail_and_export(self):
        insert_annotation(self.conn, 1)
        self.conn.execute(
            "INSERT INTO review(annotation_id, reviewer, status, reviewed_at) "
            "VALUES (1, 'r', 'pass', '2026-01-02T00:00:00')"
        )
        self.conn.execute(
            "INSERT INTO review(annotation_id, reviewer, status, reviewed_at) "
            "VALUES (1, 'r', 'fail', '2026-01-01T00:00:00')"
        )
        self.conn.commit()

        self.assertEqual(db.list_items(self.conn)[0]["status"], "fail")
        self.assertEqual(db.get_item(self.conn, 1)["latest_review"]["status"], "fail")
        self.assertEqual(db.export_rows(self.conn)[0]["__review_status"], "fail")


class CsvExportSafetyTest(unittest.TestCase):
    def test_csv_safe_cell_prefixes_formula_like_values(self):
        self.assertEqual(db.csv_safe_cell("=1+1"), "'=1+1")
        self.assertEqual(db.csv_safe_cell("+1"), "'+1")
        self.assertEqual(db.csv_safe_cell("-1"), "'-1")
        self.assertEqual(db.csv_safe_cell("@cmd"), "'@cmd")
        self.assertEqual(db.csv_safe_cell("\tindent"), "'\tindent")
        self.assertEqual(db.csv_safe_cell("\rcell"), "'\rcell")
        self.assertEqual(db.csv_safe_cell("plain"), "plain")
        self.assertEqual(db.csv_safe_cell(None), "")

    def test_dict_writer_output_keeps_formula_cells_as_text(self):
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=["id", "note"])
        writer.writerow({k: db.csv_safe_cell(k) for k in ["id", "note"]})
        writer.writerow({"id": db.csv_safe_cell("1"), "note": db.csv_safe_cell("=1+1")})
        self.assertIn("1,'=1+1", buf.getvalue())


class ImagePathResolutionTest(unittest.TestCase):
    def test_resolve_image_filename_accepts_recovered_pack_prefix(self):
        with tempfile.TemporaryDirectory() as tmp:
            prefixed = os.path.join(tmp, "0001_europeana_foo.jpg")
            with open(prefixed, "wb") as f:
                f.write(b"x")

            self.assertEqual(
                db.resolve_image_filename(tmp, "europeana_foo.jpg"),
                "0001_europeana_foo.jpg",
            )

    def test_resolve_image_filename_prefers_exact_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            for name in ("europeana_foo.jpg", "0001_europeana_foo.jpg"):
                with open(os.path.join(tmp, name), "wb") as f:
                    f.write(b"x")

            self.assertEqual(
                db.resolve_image_filename(tmp, "europeana_foo.jpg"),
                "europeana_foo.jpg",
            )


if __name__ == "__main__":
    unittest.main()
