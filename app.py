import os
import re
import random
import sqlite3
import threading
import time
import uuid
from urllib.parse import quote_plus
from flask import Flask, render_template, request, jsonify, send_from_directory
from playwright.sync_api import sync_playwright

app = Flask(__name__)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(BASE_DIR, "etsy.db")
SCREENSHOT_DIR = os.path.join(BASE_DIR, "screenshots")

os.makedirs(SCREENSHOT_DIR, exist_ok=True)

# Track running searches
searches = {}


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


def launch_browser(playwright):
    """Launch Playwright's bundled Chromium in headless mode."""
    return playwright.chromium.launch(
        headless=True,
        args=[
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-blink-features=AutomationControlled",
        ],
    )


def human_delay(short=False):
    if short:
        time.sleep(random.uniform(1.0, 2.5))
    else:
        time.sleep(random.uniform(2.5, 5.0))


def dismiss_popups(page):
    selectors = [
        'button[data-gdpr-single-choice-accept]',
        'button:has-text("Accept")',
        'button:has-text("Accept All")',
        'button:has-text("Got it")',
        'button:has-text("OK")',
    ]
    for sel in selectors:
        try:
            btn = page.locator(sel).first
            if btn.is_visible(timeout=1000):
                btn.click()
                time.sleep(0.5)
                return
        except Exception:
            pass


def solve_slider_captcha(page):
    """Detect and solve DataDome slider captcha if present."""
    captcha_frame = None
    for f in page.frames:
        if 'captcha-delivery' in f.url:
            captcha_frame = f
            break

    if not captcha_frame:
        return False

    try:
        slider = captcha_frame.locator('.slider')
        target = captcha_frame.locator('.sliderTarget')

        slider_box = slider.bounding_box()
        target_box = target.bounding_box()

        if not slider_box or not target_box:
            return False

        start_x = slider_box['x'] + slider_box['width'] / 2
        start_y = slider_box['y'] + slider_box['height'] / 2
        end_x = target_box['x'] + target_box['width'] / 2
        distance = end_x - start_x

        page.mouse.move(start_x, start_y)
        time.sleep(0.3)
        page.mouse.down()
        time.sleep(0.1)

        steps = random.randint(20, 35)
        for i in range(steps):
            progress = (i + 1) / steps
            x = start_x + distance * progress
            y = start_y + random.uniform(-2, 2)
            page.mouse.move(x, y)
            time.sleep(random.uniform(0.01, 0.04))

        time.sleep(0.1)
        page.mouse.up()

        # Wait for page to reload after captcha
        time.sleep(5)
        return True
    except Exception:
        return False


def is_captcha_page(page):
    """Check if current page is a captcha/blocked page."""
    try:
        html = page.content()
        return len(html) < 5000 and ('captcha-delivery' in html or 'captcha' in html.lower())
    except Exception:
        return False


def run_search(search_id, keyword):
    """Run the Etsy search using Chrome on the macOS host."""
    searches[search_id] = {
        "status": "running",
        "keyword": keyword,
        "current_page": 0,
        "total_pages": 20,
        "products_found": 0,
        "listings_checked": 0,
        "log": [],
    }

    def log(msg):
        searches[search_id]["log"].append(msg)

    try:
        log("Launching browser...")

        with sync_playwright() as p:
            try:
                browser = launch_browser(p)
            except Exception as e:
                log(f"Could not launch browser: {e}")
                searches[search_id]["status"] = "error"
                return

            context = browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 1920, "height": 1080},
            )
            log("Browser ready! Establishing Etsy session...")

            page = context.new_page()

            # Visit homepage first to establish cookies and solve any captcha
            page.goto("https://www.etsy.com", timeout=30000, wait_until="domcontentloaded")
            time.sleep(5)

            if is_captcha_page(page):
                log("Captcha detected, solving...")
                solved = solve_slider_captcha(page)
                if solved:
                    log("Captcha solved!")
                    time.sleep(3)
                else:
                    log("Warning: Could not solve captcha automatically. Retrying...")
                    page.reload(wait_until="domcontentloaded")
                    time.sleep(5)
                    if is_captcha_page(page):
                        solve_slider_captcha(page)
                        time.sleep(3)

            dismiss_popups(page)

            for page_num in range(1, 21):
                if searches[search_id].get("cancelled"):
                    log("Search cancelled.")
                    break

                searches[search_id]["current_page"] = page_num
                log(f"Searching page {page_num} of 20...")

                search_url = f"https://www.etsy.com/search?q={quote_plus(keyword)}&ref=search_bar&page={page_num}"
                try:
                    page.goto(search_url, timeout=30000, wait_until="domcontentloaded")
                    human_delay()
                    dismiss_popups(page)
                except Exception as e:
                    log(f"Page {page_num}: Failed to load - {e}")
                    continue

                # Handle captcha on search page
                if is_captcha_page(page):
                    log(f"Page {page_num}: Captcha detected, solving...")
                    solve_slider_captcha(page)
                    time.sleep(3)
                    # Retry the search page
                    page.goto(search_url, timeout=30000, wait_until="domcontentloaded")
                    human_delay()

                # Scroll to load lazy content
                for _ in range(4):
                    page.evaluate("window.scrollBy(0, 800)")
                    time.sleep(random.uniform(0.5, 1.0))

                # Collect listing links using evaluate (more reliable than selector)
                listing_links = page.evaluate("""() => {
                    const seen = new Set();
                    return Array.from(document.querySelectorAll('a'))
                        .map(el => el.href)
                        .filter(href => {
                            const match = href.match(/\\/listing\\/(\\d+)/);
                            if (match && !seen.has(match[1])) {
                                seen.add(match[1]);
                                return true;
                            }
                            return false;
                        });
                }""")

                log(f"Page {page_num}: Found {len(listing_links)} listings to check.")

                if len(listing_links) == 0:
                    time.sleep(3)
                    listing_links = page.evaluate("""() => {
                        const seen = new Set();
                        return Array.from(document.querySelectorAll('a'))
                            .map(el => el.href)
                            .filter(href => {
                                const match = href.match(/\\/listing\\/(\\d+)/);
                                if (match && !seen.has(match[1])) {
                                    seen.add(match[1]);
                                    return true;
                                }
                                return false;
                            });
                    }""")
                    if listing_links:
                        log(f"Page {page_num}: Found {len(listing_links)} after retry.")
                    else:
                        log(f"Page {page_num}: No listings found, may be end of results.")
                        if page_num > 1:
                            continue

                for listing_url in listing_links:
                    if searches[search_id].get("cancelled"):
                        break

                    searches[search_id]["listings_checked"] += 1
                    human_delay(short=True)

                    try:
                        page.goto(listing_url, timeout=30000, wait_until="domcontentloaded")
                        human_delay(short=True)

                        # Handle captcha on listing page
                        if is_captcha_page(page):
                            log("Captcha on listing page, solving...")
                            solve_slider_captcha(page)
                            time.sleep(3)
                            page.goto(listing_url, timeout=30000, wait_until="domcontentloaded")
                            human_delay(short=True)

                        page.evaluate("window.scrollBy(0, 400)")
                        time.sleep(0.5)

                        body_text = page.inner_text("body")

                        match = re.search(
                            r"(\d+[\+]?)\s+(?:people\s+)?bought\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s+hours",
                            body_text,
                            re.IGNORECASE,
                        )
                        if not match:
                            # AU/UK variant: "In X+ baskets"
                            match = re.search(
                                r"In\s+(\d+[\+]?)\s+baskets?",
                                body_text,
                            )

                        if match:
                            sold_count = match.group(0).strip()
                            log(f"MATCH: {sold_count} - {listing_url}")

                            title = ""
                            try:
                                title = page.title()
                                title = title.split(" - Etsy")[0].strip()
                            except Exception:
                                pass

                            image_url = ""
                            try:
                                image_url = page.eval_on_selector(
                                    'img[data-listing-card-listing-image], img.wt-max-width-full, ul[data-carousel] img, div[data-component="listing-page-image"] img',
                                    "el => el.src",
                                )
                            except Exception:
                                try:
                                    image_url = page.eval_on_selector("img", "el => el.src")
                                except Exception:
                                    pass

                            screenshot_name = f"{uuid.uuid4().hex}.png"
                            screenshot_path = os.path.join(SCREENSHOT_DIR, screenshot_name)
                            try:
                                page.screenshot(path=screenshot_path, full_page=True)
                            except Exception:
                                screenshot_name = ""

                            conn = get_db()
                            conn.execute(
                                """INSERT INTO products (search_id, keyword, title, url, image_url, sold_count, screenshot_path)
                                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
                                (search_id, keyword, title, listing_url, image_url, sold_count, screenshot_name),
                            )
                            conn.commit()
                            conn.close()

                            searches[search_id]["products_found"] += 1

                    except Exception as e:
                        log(f"Error checking listing: {e}")

            page.close()

        searches[search_id]["status"] = "completed"
        log("Search completed!")

    except Exception as e:
        searches[search_id]["status"] = "error"
        log(f"Search failed: {e}")


# --- Routes ---


@app.route("/")
def index():
    return render_template("search.html")


@app.route("/shortlisted")
def shortlisted():
    return render_template("shortlisted.html")


@app.route("/api/search", methods=["POST"])
def start_search():
    data = request.get_json()
    keyword = data.get("keyword", "").strip()
    if not keyword:
        return jsonify({"error": "Keyword is required"}), 400

    search_id = uuid.uuid4().hex
    thread = threading.Thread(target=run_search, args=(search_id, keyword))
    thread.daemon = True
    thread.start()

    return jsonify({"search_id": search_id})


@app.route("/api/search/<search_id>/status")
def search_status(search_id):
    info = searches.get(search_id)
    if not info:
        return jsonify({"error": "Search not found"}), 404
    return jsonify(info)


@app.route("/api/search/<search_id>/cancel", methods=["POST"])
def cancel_search(search_id):
    if search_id in searches:
        searches[search_id]["cancelled"] = True
        return jsonify({"ok": True})
    return jsonify({"error": "Search not found"}), 404


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


@app.route("/screenshots/<path:filename>")
def serve_screenshot(filename):
    return send_from_directory(SCREENSHOT_DIR, filename)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    print(f"Server starting on port {port}")
    app.run(debug=False, host="0.0.0.0", port=port)
