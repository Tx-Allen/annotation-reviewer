import argparse
import csv
import io
import os
import sys

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass

from flask import (
    Flask,
    Response,
    abort,
    jsonify,
    render_template,
    request,
    send_from_directory,
)

import db

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "data", "reviewer.db")

app = Flask(__name__, template_folder="templates", static_folder="static")

CONFIG = {
    "csv": None,
    "img_root": None,
    "reviewer": "anonymous",
}


_CONN = None


def get_conn():
    # L5:复用单连接,避免每请求新开 SQLite 连接(句柄泄漏)+ 每次重跑建表 DDL。
    # 单用户本地工具 + check_same_thread=False,共享一个连接是安全的。
    global _CONN
    if _CONN is None:
        _CONN = db.connect(DB_PATH)
    return _CONN


def _same_origin(req):
    """仅允许同源写入(防 CSRF)。无 Origin/Referer 时退而要求 JSON 内容类型。"""
    from urllib.parse import urlparse

    host = req.host  # 例如 127.0.0.1:5050
    for hdr in ("Origin", "Referer"):
        val = req.headers.get(hdr)
        if val:
            return urlparse(val).netloc == host
    return bool(req.content_type and "application/json" in req.content_type)


@app.route("/")
def index():
    return render_template("review.html", reviewer=CONFIG["reviewer"])


@app.route("/api/list")
def api_list():
    conn = get_conn()
    items = db.list_items(conn)
    return jsonify({"items": items, "reviewer": CONFIG["reviewer"]})


@app.route("/api/item/<int:anno_id>")
def api_item(anno_id):
    conn = get_conn()
    item = db.get_item(conn, anno_id)
    if not item:
        abort(404)
    return jsonify(item)


@app.route("/api/review", methods=["POST"])
def api_review():
    # CSRF/内容类型加固:只接受同源的 application/json(跨站简单请求带不了该类型,也无预检)
    if not _same_origin(request):
        return jsonify({"error": "forbidden"}), 403
    if not request.is_json:
        return jsonify({"error": "expected application/json"}), 415
    data = request.get_json(silent=True) or {}
    try:
        anno_id = int(data.get("annotation_id"))
    except (TypeError, ValueError):
        return jsonify({"error": "annotation_id required"}), 400
    status = data.get("status", "")
    note = data.get("note", "") or ""
    edits = data.get("edits") or {}
    if not isinstance(edits, dict):  # 防止 edits 非对象导致整库导出 500(export_rows .items())
        return jsonify({"error": "edits must be an object"}), 400
    reviewer = data.get("reviewer") or CONFIG["reviewer"]
    conn = get_conn()
    try:
        rid = db.save_review(conn, anno_id, reviewer, status, note, edits)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"ok": True, "review_id": rid})


@app.route("/img/<path:filename>")
def img(filename):
    root = CONFIG.get("img_root")
    if not root or not os.path.isdir(root):
        abort(404)
    safe_name = os.path.basename(filename)
    return send_from_directory(root, safe_name)


@app.route("/api/export")
def api_export():
    conn = get_conn()
    rows = db.export_rows(conn)
    if not rows:
        return Response("no data", status=404)
    buf = io.StringIO()
    fieldnames = list(rows[0].keys())
    for r in rows:
        for k in r.keys():
            if k not in fieldnames:
                fieldnames.append(k)
    writer = csv.DictWriter(buf, fieldnames=fieldnames)
    writer.writeheader()
    for r in rows:
        writer.writerow(r)
    return Response(
        buf.getvalue().encode("utf-8-sig"),
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="review.csv"'},
    )


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--csv", help="Label Studio 导出的 CSV 路径")
    p.add_argument("--img-root", help="图片所在目录(例如 bi/)")
    p.add_argument("--reviewer", default="anonymous", help="检察员名字")
    p.add_argument("--port", type=int, default=5050)
    p.add_argument("--reset", action="store_true", help="清空已有数据并重新导入 CSV")
    return p.parse_args()


def main():
    args = parse_args()
    CONFIG["reviewer"] = args.reviewer
    if args.img_root:
        CONFIG["img_root"] = os.path.abspath(args.img_root)
        if not os.path.isdir(CONFIG["img_root"]):
            print(f"[warn] img-root 不存在: {CONFIG['img_root']}", file=sys.stderr)

    if args.csv:
        CONFIG["csv"] = os.path.abspath(args.csv)
        if not os.path.isfile(CONFIG["csv"]):
            print(f"[error] CSV 不存在: {CONFIG['csv']}", file=sys.stderr)
            sys.exit(1)
        conn = get_conn()
        n = db.import_csv(conn, CONFIG["csv"], reset=args.reset)
        if n:
            print(f"[ok] 已导入 {n} 条标注")
        else:
            print("[ok] 数据库已有数据,跳过导入(传 --reset 强制重导)")
    else:
        conn = get_conn()
        cnt = conn.execute("SELECT COUNT(*) AS n FROM annotation").fetchone()["n"]
        if cnt == 0:
            print(
                "[warn] 数据库为空,且未提供 --csv。请用 --csv <路径> 启动以导入数据。",
                file=sys.stderr,
            )

    print(f"[info] reviewer = {CONFIG['reviewer']}")
    print(f"[info] img_root = {CONFIG['img_root']}")
    print(f"[info] 打开 http://127.0.0.1:{args.port}")
    app.run(host="127.0.0.1", port=args.port, debug=False)


if __name__ == "__main__":
    main()
