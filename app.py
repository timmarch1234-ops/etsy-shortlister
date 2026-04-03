import os
import re
import json
import time
import sqlite3
import uuid
import random
import threading
from flask import Flask, render_template, request, jsonify, Response
from flask_cors import CORS

app = Flask(__name__)
app.config["TEMPLATES_AUTO_RELOAD"] = True
CORS(app)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "etsy.db")

# Search queue: search_id -> {keyword, status, progress}
search_queue = {}


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    conn = get_db()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            search_id TEXT NOT NULL,
            keyword TEXT NOT NULL,
            title TEXT,
            url TEXT NOT NULL,
            image_url TEXT,
            sold_count TEXT,
            screenshot_path TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()
    conn.close()


init_db()


def _save_products(search_id, keyword, products):
    conn = get_db()
    for p in products:
        conn.execute(
            """INSERT INTO products (search_id, keyword, title, url, image_url, sold_count)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (search_id, keyword, p["title"], p["url"], p.get("image_url", ""), p.get("sold_count", "")),
        )
    conn.commit()
    conn.close()



# --- Routes ---


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/shortlisted")
def shortlisted():
    return render_template("shortlisted.html")


@app.route("/api/products", methods=["POST"])
def add_products():
    data = request.get_json()
    keyword = data.get("keyword", "").strip()
    products = data.get("products", [])

    if not keyword or not products:
        return jsonify({"error": "keyword and products are required"}), 400

    search_id = uuid.uuid4().hex
    conn = get_db()
    count = 0
    for p in products:
        url = p.get("url", "").strip()
        if not url:
            continue
        conn.execute(
            """INSERT INTO products (search_id, keyword, title, url, image_url, sold_count)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (
                search_id,
                keyword,
                p.get("title", ""),
                url,
                p.get("image_url", ""),
                p.get("sold_count", ""),
            ),
        )
        count += 1
    conn.commit()
    conn.close()

    return jsonify({"ok": True, "count": count, "search_id": search_id})


@app.route("/api/products")
def get_products():
    keyword = request.args.get("keyword", "")
    conn = get_db()
    if keyword:
        rows = conn.execute(
            "SELECT * FROM products WHERE keyword LIKE ? ORDER BY created_at DESC",
            (f"%{keyword}%",),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM products ORDER BY created_at DESC"
        ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route("/api/products/<int:product_id>", methods=["DELETE"])
def delete_product(product_id):
    conn = get_db()
    conn.execute("DELETE FROM products WHERE id = ?", (product_id,))
    conn.commit()
    conn.close()
    return jsonify({"ok": True})


# --- Search Queue ---


@app.route("/api/queue", methods=["POST"])
def queue_search():
    """Website posts a keyword to start a search."""
    data = request.get_json()
    keyword = data.get("keyword", "").strip()
    max_pages = min(int(data.get("pages", 5)), 20)
    if not keyword:
        return jsonify({"error": "keyword is required"}), 400

    search_id = uuid.uuid4().hex
    search_queue[search_id] = {
        "keyword": keyword,
        "status": "pending",
        "progress": {
            "currentPage": 0,
            "totalPages": max_pages,
            "listingsChecked": 0,
            "productsFound": 0,
            "log": [],
        },
    }

    return jsonify({"ok": True, "search_id": search_id})


@app.route("/api/queue/pending")
def get_pending_searches():
    """Extension polls for pending searches to pick up."""
    pending = []
    for sid, s in search_queue.items():
        if s["status"] == "pending":
            pending.append({
                "search_id": sid,
                "keyword": s["keyword"],
                "pages": s["progress"]["totalPages"],
            })
    return jsonify(pending)


@app.route("/api/queue/<search_id>/claim", methods=["POST"])
def claim_search(search_id):
    """Extension claims a pending search so it starts running."""
    if search_id not in search_queue:
        return jsonify({"error": "not found"}), 404
    search_queue[search_id]["status"] = "running"
    return jsonify({"ok": True})


@app.route("/api/queue/<search_id>/progress", methods=["GET", "POST"])
def get_or_update_progress(search_id):
    """GET: Website polls for progress. POST: Extension reports progress."""
    if search_id not in search_queue:
        return jsonify({"error": "not found"}), 404
    if request.method == "POST":
        data = request.get_json()
        if data.get("status"):
            search_queue[search_id]["status"] = data["status"]
        if data.get("progress"):
            search_queue[search_id]["progress"] = data["progress"]
        return jsonify({"ok": True})
    s = search_queue[search_id]
    return jsonify({"status": s["status"], "progress": s["progress"]})


@app.route("/api/queue/<search_id>/cancel", methods=["POST"])
def cancel_queued_search(search_id):
    """Cancel a running search."""
    if search_id not in search_queue:
        return jsonify({"error": "not found"}), 404
    search_queue[search_id]["status"] = "cancelled"
    return jsonify({"ok": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"Server starting on port {port}")
    app.run(debug=False, host="0.0.0.0", port=port)
