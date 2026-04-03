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
import requests as http_requests

app = Flask(__name__)
CORS(app)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "etsy.db")

# Track active searches so we can cancel them
active_searches = {}


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

ETSY_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}


def scrape_etsy(keyword, search_id, max_pages=20):
    """Generator that yields SSE events as it scrapes Etsy."""
    session = http_requests.Session()
    session.headers.update(ETSY_HEADERS)

    matching_products = []
    listings_checked = 0
    products_found = 0

    def event(data):
        return f"data: {json.dumps(data)}\n\n"

    yield event({"type": "status", "message": "Starting search...", "page": 0, "totalPages": max_pages, "checked": 0, "found": 0})

    for page in range(1, max_pages + 1):
        if active_searches.get(search_id) == "cancelled":
            yield event({"type": "log", "message": "Search cancelled."})
            yield event({"type": "done", "found": products_found, "cancelled": True})
            return

        yield event({"type": "status", "message": f"Searching page {page} of {max_pages}...", "page": page, "totalPages": max_pages, "checked": listings_checked, "found": products_found})

        search_url = f"https://www.etsy.com/search?q={keyword}&ref=search_bar&page={page}"
        try:
            resp = session.get(search_url, timeout=15)
            search_html = resp.text
        except Exception as e:
            yield event({"type": "log", "message": f"Page {page}: Failed to load - {e}"})
            continue

        # Extract unique listing IDs
        seen = set()
        listing_urls = []
        for m in re.finditer(r"/listing/(\d+)", search_html):
            lid = m.group(1)
            if lid not in seen:
                seen.add(lid)
                listing_urls.append(f"https://www.etsy.com/listing/{lid}")

        yield event({"type": "log", "message": f"Page {page}: Found {len(listing_urls)} listings to check."})

        if not listing_urls and page > 1:
            yield event({"type": "log", "message": f"Page {page}: No listings found, stopping."})
            break

        for listing_url in listing_urls:
            if active_searches.get(search_id) == "cancelled":
                break

            listings_checked += 1
            time.sleep(1.0 + random.random() * 1.5)

            try:
                resp = session.get(listing_url, timeout=15)
                html = resp.text

                bought_match = re.search(
                    r"(\d+\+?)\s+(?:people\s+)?bought\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s+hours",
                    html, re.IGNORECASE
                )
                basket_match = re.search(r"In\s+(\d+\+?)\s+baskets?", html)
                in_demand_match = re.search(r"In demand", html)
                match = bought_match or basket_match

                if match:
                    sold_count = match.group(0).strip()

                    title_match = re.search(r"<title>([^<]*)</title>", html)
                    title = title_match.group(1).split(" - Etsy")[0].strip() if title_match else ""

                    og_img_match = re.search(r'<meta\s+property="og:image"\s+content="([^"]+)"', html)
                    image_url = og_img_match.group(1) if og_img_match else ""

                    product = {
                        "title": title,
                        "url": listing_url,
                        "image_url": image_url,
                        "sold_count": sold_count,
                    }
                    matching_products.append(product)
                    products_found += 1

                    yield event({"type": "match", "message": f"MATCH: {sold_count} - {title[:60]}", "product": product})

                    # Save batch every 5
                    if len(matching_products) >= 5:
                        _save_products(search_id, keyword, matching_products[:])
                        matching_products.clear()

            except Exception as e:
                yield event({"type": "log", "message": f"Error checking listing: {e}"})

            yield event({"type": "status", "message": f"Page {page}/{max_pages}", "page": page, "totalPages": max_pages, "checked": listings_checked, "found": products_found})

        time.sleep(2.0 + random.random() * 2.0)

    # Save remaining
    if matching_products:
        _save_products(search_id, keyword, matching_products[:])
        matching_products.clear()

    yield event({"type": "done", "found": products_found, "cancelled": False})


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


@app.route("/api/search")
def search_etsy():
    keyword = request.args.get("keyword", "").strip()
    max_pages = min(int(request.args.get("pages", 20)), 50)

    if not keyword:
        return jsonify({"error": "keyword is required"}), 400

    search_id = uuid.uuid4().hex
    active_searches[search_id] = "running"

    def generate():
        yield f"data: {json.dumps({'type': 'init', 'search_id': search_id})}\n\n"
        try:
            yield from scrape_etsy(keyword, search_id, max_pages)
        finally:
            active_searches.pop(search_id, None)

    return Response(generate(), mimetype="text/event-stream", headers={
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
    })


@app.route("/api/search/<search_id>/cancel", methods=["POST"])
def cancel_search(search_id):
    if search_id in active_searches:
        active_searches[search_id] = "cancelled"
        return jsonify({"ok": True})
    return jsonify({"error": "search not found"}), 404


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


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"Server starting on port {port}")
    app.run(debug=False, host="0.0.0.0", port=port)
