import csv
import json
import os
import sqlite3
import urllib.parse
from datetime import datetime
from typing import Optional

SCHEMA = """
CREATE TABLE IF NOT EXISTS annotation (
  annotation_id   INTEGER PRIMARY KEY,
  image_filename  TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  imported_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS review (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  annotation_id   INTEGER NOT NULL,
  reviewer        TEXT NOT NULL,
  status          TEXT NOT NULL,
  note            TEXT,
  edits_json      TEXT,
  reviewed_at     TEXT NOT NULL,
  FOREIGN KEY (annotation_id) REFERENCES annotation(annotation_id)
);

CREATE INDEX IF NOT EXISTS idx_review_anno ON review(annotation_id, reviewed_at DESC);
"""


def connect(db_path: str) -> sqlite3.Connection:
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def extract_filename(image_url: str) -> str:
    """Label Studio path → 文件名。

    e.g. '/data/local-files/?d=bi%5C2_4742.jfif' → '2_4742.jfif'
    """
    decoded = urllib.parse.unquote(image_url or "")
    if "?d=" in decoded:
        decoded = decoded.split("?d=", 1)[1]
    decoded = decoded.replace("\\", "/")
    return decoded.rsplit("/", 1)[-1]


def import_csv(conn: sqlite3.Connection, csv_path: str, reset: bool = False) -> int:
    cur = conn.cursor()
    if reset:
        cur.execute("DELETE FROM annotation")
        cur.execute("DELETE FROM review")

    cur.execute("SELECT COUNT(*) AS n FROM annotation")
    if cur.fetchone()["n"] > 0 and not reset:
        return 0

    now = datetime.utcnow().isoformat()
    inserted = 0
    with open(csv_path, "r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            anno_id_raw = (row.get("annotation_id") or "").strip()
            if not anno_id_raw:
                continue
            try:
                anno_id = int(anno_id_raw)
            except ValueError:
                continue
            filename = extract_filename(row.get("image", ""))
            cur.execute(
                "INSERT OR REPLACE INTO annotation (annotation_id, image_filename, payload_json, imported_at) VALUES (?, ?, ?, ?)",
                (anno_id, filename, json.dumps(row, ensure_ascii=False), now),
            )
            inserted += 1
    conn.commit()
    return inserted


def list_items(conn: sqlite3.Connection):
    rows = conn.execute(
        """
        SELECT
          a.annotation_id,
          a.image_filename,
          a.payload_json,
          r.status,
          r.reviewer,
          r.reviewed_at
        FROM annotation a
        LEFT JOIN (
          SELECT r1.*
          FROM review r1
          JOIN (
            SELECT annotation_id, MAX(reviewed_at) AS latest
            FROM review GROUP BY annotation_id
          ) r2 ON r1.annotation_id = r2.annotation_id AND r1.reviewed_at = r2.latest
        ) r ON r.annotation_id = a.annotation_id
        ORDER BY a.annotation_id ASC
        """
    ).fetchall()
    return [
        {
            "annotation_id": r["annotation_id"],
            "image_filename": r["image_filename"],
            "payload": json.loads(r["payload_json"]),
            "status": r["status"],
            "reviewer": r["reviewer"],
            "reviewed_at": r["reviewed_at"],
        }
        for r in rows
    ]


def get_item(conn: sqlite3.Connection, anno_id: int) -> Optional[dict]:
    a = conn.execute(
        "SELECT * FROM annotation WHERE annotation_id = ?", (anno_id,)
    ).fetchone()
    if not a:
        return None
    r = conn.execute(
        "SELECT * FROM review WHERE annotation_id = ? ORDER BY reviewed_at DESC LIMIT 1",
        (anno_id,),
    ).fetchone()
    latest = None
    if r:
        latest = {
            "status": r["status"],
            "reviewer": r["reviewer"],
            "note": r["note"],
            "edits": json.loads(r["edits_json"]) if r["edits_json"] else {},
            "reviewed_at": r["reviewed_at"],
        }
    return {
        "annotation_id": a["annotation_id"],
        "image_filename": a["image_filename"],
        "payload": json.loads(a["payload_json"]),
        "latest_review": latest,
    }


def save_review(
    conn: sqlite3.Connection,
    annotation_id: int,
    reviewer: str,
    status: str,
    note: str,
    edits: dict,
) -> int:
    if status not in ("pass", "fail", "doubt"):
        raise ValueError(f"invalid status: {status}")
    now = datetime.utcnow().isoformat()
    edits_json = json.dumps(edits, ensure_ascii=False) if edits else None
    cur = conn.execute(
        "INSERT INTO review (annotation_id, reviewer, status, note, edits_json, reviewed_at) VALUES (?, ?, ?, ?, ?, ?)",
        (annotation_id, reviewer, status, note or None, edits_json, now),
    )
    conn.commit()
    return cur.lastrowid


def export_rows(conn: sqlite3.Connection):
    """每条 annotation 最新 review 的合并视图,用于导出 CSV。"""
    items = list_items(conn)
    out = []
    for it in items:
        payload = it["payload"]
        latest = None
        r = conn.execute(
            "SELECT * FROM review WHERE annotation_id = ? ORDER BY reviewed_at DESC LIMIT 1",
            (it["annotation_id"],),
        ).fetchone()
        if r:
            latest = {
                "status": r["status"],
                "reviewer": r["reviewer"],
                "note": r["note"] or "",
                "edits": json.loads(r["edits_json"]) if r["edits_json"] else {},
                "reviewed_at": r["reviewed_at"],
            }
        merged = dict(payload)
        if latest and latest["edits"]:
            for k, v in latest["edits"].items():
                merged[k] = v
        merged["__review_status"] = latest["status"] if latest else ""
        merged["__review_reviewer"] = latest["reviewer"] if latest else ""
        merged["__review_note"] = latest["note"] if latest else ""
        merged["__review_at"] = latest["reviewed_at"] if latest else ""
        out.append(merged)
    return out
