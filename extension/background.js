// ============================================================
// ETSY PRODUCT SHORTLISTER v6.0 — Simple & Reliable
//
// Architecture: ONE alarm tick per action. Single reused tab.
//
// Phases:
//   warmup    → visit Etsy homepage
//   search    → load search page N, score listings, queue top 20
//   listing   → visit ONE listing, extract demand signals
//   (repeat listing until queue empty, then next search page)
//
// Timing:
//   20 listings/page × 3s = 60s active work per page
//   Chrome bumps alarm to ~30s min (unpacked) or ~60s (packed)
//   Worst case: 20 pages × (60s work + 60s alarm) = ~40 min
//   Best case (unpacked): 20 pages × (60s + 5s) = ~22 min  ✓
//
// Key insight: the service worker stays alive during continuous
// Chrome API calls (tabs.update, scripting.executeScript). It
// only dies during setTimeout. So we process ALL listings for
// a page in one tick using activeWait (chrome.storage.get loop)
// between each listing visit.
// ============================================================

const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";
const ALARM_NAME = "searchTick";
const TOTAL_SEARCH_PAGES = 20;
const LISTINGS_PER_PAGE = 20; // top 20 most promising per page

// ============================================================
// UTILITY
// ============================================================

function gaussRand(mean, sd, min, max) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  let z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  let val = mean + z * sd;
  if (min !== undefined) val = Math.max(min, val);
  if (max !== undefined) val = Math.min(max, val);
  return Math.round(val);
}

// Active wait — loops chrome.storage.local.get to keep worker alive
// ~1-3ms per iteration, so 1000 iterations ≈ 1-3 seconds
async function activeWait(iterations) {
  for (let i = 0; i < iterations; i++) {
    await chrome.storage.local.get(["_kl"]);
  }
}

// ============================================================
// TAB — single reused tab
// ============================================================

async function getTab() {
  const data = await chrome.storage.local.get(["tabId"]);
  if (data.tabId) {
    try {
      await chrome.tabs.get(data.tabId);
      return data.tabId;
    } catch (e) {}
  }
  console.log("[tab] creating new tab");
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  await chrome.storage.local.set({ tabId: tab.id });
  return tab.id;
}

function navTab(tabId, url) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; chrome.tabs.onUpdated.removeListener(fn); resolve(false); }
    }, 30000);
    function fn(id, info) {
      if (id === tabId && info.status === "complete" && !done) {
        done = true;
        chrome.tabs.onUpdated.removeListener(fn);
        clearTimeout(timer);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
    chrome.tabs.update(tabId, { url }).catch(() => {
      if (!done) { done = true; chrome.tabs.onUpdated.removeListener(fn); clearTimeout(timer); resolve(false); }
    });
  });
}

// ============================================================
// CAPTCHA
// ============================================================

async function isCaptcha(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const b = document.body?.innerText || "";
        const d = document.querySelectorAll("div");
        const f = document.querySelectorAll("iframe");
        if (d.length < 5 && f.length > 0 && (document.title || "").length < 20) return true;
        if (b.toLowerCase().includes("captcha")) return true;
        if (b.includes("Access is temporarily restricted")) return true;
        return false;
      },
    });
    return r[0]?.result || false;
  } catch (e) { return false; }
}

// ============================================================
// COLLECT + SCORE listings from search page
// Returns top LISTINGS_PER_PAGE sorted by signal strength
// ============================================================

async function collectAndScoreListings(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const out = [];
        const seen = new Set();
        const links = document.querySelectorAll('a[href*="/listing/"]');

        for (const link of links) {
          const m = link.href.match(/\/listing\/(\d+)/);
          if (!m || seen.has(m[1])) continue;
          seen.add(m[1]);

          let card = link.closest('[data-listing-id]') ||
                     link.closest('.v2-listing-card') ||
                     link.closest('.wt-grid__item-xs-6') ||
                     link.closest('[class*="listing"]');
          if (!card) {
            let el = link;
            for (let i = 0; i < 8; i++) {
              if (el.parentElement) el = el.parentElement;
              if (el.offsetHeight > 150 && el.offsetWidth > 100) { card = el; break; }
            }
          }
          if (!card) card = link.parentElement?.parentElement || link.parentElement;

          const ct = (card?.innerText || "").toLowerCase();
          const titleEl = card?.querySelector('h3, h2, [class*="title"]') || link;
          const img = card?.querySelector("img");

          // Score the listing based on card-level signals
          let score = 1; // base score — every listing gets visited eventually
          if (/bought|sold/i.test(ct)) score += 50;
          if (/in\s+demand/i.test(ct)) score += 40;
          if (/bestseller/i.test(ct)) score += 30;
          if (/popular\s*now/i.test(ct)) score += 25;
          if (/only\s+\d+\s+left/i.test(ct)) score += 20;
          // High ratings with many reviews
          const rm = ct.match(/(4\.[5-9]|5\.0)\s*\((\d[\d,.k]*)\)/);
          if (rm) {
            let rc = rm[2].toLowerCase().replace(/,/g, "");
            let n = rc.includes("k") ? parseFloat(rc) * 1000 : parseInt(rc, 10);
            if (n >= 1000) score += 15;
            else if (n >= 500) score += 10;
            else if (n >= 100) score += 5;
          }
          // Skip ads
          if (/^ad\b/i.test(ct) || card?.querySelector('[class*="ad-"]')) score -= 100;

          out.push({
            listingId: m[1],
            url: `https://www.etsy.com/listing/${m[1]}`,
            cardTitle: titleEl?.textContent?.trim()?.substring(0, 120) || "",
            cardImage: img?.src || "",
            score,
          });
        }

        return { total: seen.size, listings: out };
      },
    });
    return r[0]?.result || { total: 0, listings: [] };
  } catch (e) {
    console.log("[collect] error:", e.message);
    return { total: 0, listings: [] };
  }
}

// ============================================================
// EXTRACT demand signals from one listing page
// ============================================================

async function extractListing(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const t = document.body?.innerText || "";
        const out = { title: "", price: "", sold_count: null, demand_signal: null, image_url: "", shop_name: "" };

        out.title = document.querySelector('meta[property="og:title"]')?.content ||
                    document.querySelector('h1')?.textContent?.trim() || "";
        out.image_url = document.querySelector('meta[property="og:image"]')?.content || "";

        const p = document.querySelector('[data-buy-box-listing-price]') ||
                  document.querySelector('[class*="price"]');
        if (p) out.price = p.textContent?.trim() || "";

        const sl = document.querySelector('a[href*="/shop/"]');
        if (sl) { const m = sl.href.match(/\/shop\/([^/?]+)/); out.shop_name = m ? m[1] : ""; }

        // Demand signals — ordered by strength
        let bm = t.match(/(\d+\+?)\s+(?:people\s+)?(?:bought|sold)\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s*hours/i);
        if (bm) { out.demand_signal = bm[0].trim(); out.sold_count = bm[1]; return out; }

        if (/in\s+demand/i.test(t)) {
          out.demand_signal = "In demand";
          let n = t.match(/in\s+demand[.\s]*(\d+)\+?\s+(?:people\s+)?bought/i);
          if (n) out.sold_count = n[1];
          return out;
        }

        bm = t.match(/(\d+\+?)\s+people\s+have\s+this\s+in\s+their\s+(?:basket|cart)/i);
        if (bm) { out.demand_signal = bm[0].trim(); out.sold_count = bm[1]; return out; }

        bm = t.match(/in\s+(\d+\+?)\s+(?:basket|cart)s?/i);
        if (bm) { out.demand_signal = bm[0].trim(); out.sold_count = bm[1]; return out; }

        if (/bestseller/i.test(t)) { out.demand_signal = "Bestseller"; return out; }
        if (/popular\s+now/i.test(t)) { out.demand_signal = "Popular now"; return out; }

        bm = t.match(/only\s+(\d+)\s+left/i);
        if (bm) { out.demand_signal = bm[0].trim(); out.sold_count = bm[1]; return out; }

        bm = t.match(/([\d,]+)\s+sales?/i);
        if (bm) {
          const n = parseInt(bm[1].replace(/,/g, ""), 10);
          if (n >= 100) { out.sold_count = bm[1]; out.demand_signal = `${bm[1]} sales`; }
        }

        return out;
      },
    });
    return r[0]?.result || null;
  } catch (e) {
    console.log("[extract] error:", e.message);
    return null;
  }
}

// ============================================================
// SCROLL search page (sync — no setTimeout)
// ============================================================

async function scrollPage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const h = document.body.scrollHeight;
        for (let i = 1; i <= 6; i++) window.scrollTo(0, (h * i) / 6);
        window.scrollTo(0, 0);
      },
    });
  } catch (e) {}
}

// ============================================================
// PROGRESS
// ============================================================

function tsLog(ts, msg) {
  ts.log.push(msg);
  console.log("[s]", msg);
}

async function updateProgress(ts) {
  if (!ts.searchId) return;
  try {
    await fetch(`${ts.backendUrl || DEFAULT_BACKEND}/api/queue/${ts.searchId}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        status: ts.status,
        progress: {
          currentPage: ts.currentPage,
          totalPages: ts.totalPages,
          listingsChecked: ts.listingsChecked,
          productsFound: ts.productsFound,
          log: ts.log.slice(-80),
        },
      }),
    });
  } catch (e) {}
}

async function flushProducts(ts) {
  if (ts.matchingProducts.length === 0) return;
  const batch = ts.matchingProducts.splice(0);
  console.log(`[flush] ${batch.length} products`);
  try {
    await fetch(`${ts.backendUrl || DEFAULT_BACKEND}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: ts.keyword, products: batch }),
    });
  } catch (e) {
    console.log("[flush] FAIL:", e.message);
    ts.matchingProducts.push(...batch);
  }
}

// ============================================================
// PROCESS ONE FULL SEARCH PAGE + ITS TOP 20 LISTINGS
//
// All in one tick. Between listing visits, activeWait() keeps
// the service worker alive via chrome.storage.local.get loops.
// ============================================================

async function processFullPage(ts) {
  const tabId = await getTab();
  const pageNum = ts.currentPage;
  const backendUrl = ts.backendUrl || DEFAULT_BACKEND;

  // ---- 1. Navigate to search page ----
  const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(ts.keyword)}&ref=search_bar&page=${pageNum}`;
  console.log(`[page ${pageNum}] loading search page, tab=${tabId}`);
  tsLog(ts, `Page ${pageNum}/${ts.totalPages}: loading...`);

  const ok = await navTab(tabId, searchUrl);
  console.log(`[page ${pageNum}] loaded: ${ok}`);

  if (!ok) {
    tsLog(ts, `Page ${pageNum}: load failed, skipping.`);
    return true; // skip, don't error
  }

  // Brief active wait for DOM
  await activeWait(500);

  // Captcha?
  if (await isCaptcha(tabId)) {
    console.log(`[page ${pageNum}] CAPTCHA!`);
    tsLog(ts, `Page ${pageNum}: CAPTCHA detected. Stopping.`);
    ts.status = "error";
    return false;
  }

  // ---- 2. Scroll to trigger lazy loading ----
  await scrollPage(tabId);
  await activeWait(300);

  // ---- 3. Collect + score listings ----
  const { total, listings } = await collectAndScoreListings(tabId);
  console.log(`[page ${pageNum}] ${total} total listings, ${listings.length} scored`);

  if (listings.length === 0) {
    tsLog(ts, `Page ${pageNum}: no listings found.`);
    return true;
  }

  // Sort by score descending, take top N
  listings.sort((a, b) => b.score - a.score);
  const top = listings.slice(0, LISTINGS_PER_PAGE);
  console.log(`[page ${pageNum}] visiting top ${top.length} listings (scores: ${top.map(l => l.score).join(",")})`);
  tsLog(ts, `Page ${pageNum}: ${total} listings, visiting top ${top.length}.`);

  // ---- 4. Visit each listing one at a time ----
  for (let i = 0; i < top.length; i++) {
    const listing = top[i];
    ts.listingsChecked++;

    console.log(`[page ${pageNum}] listing ${i + 1}/${top.length}: ${listing.listingId} (score=${listing.score})`);

    // Navigate same tab to listing (preserves referrer from search page)
    const navOk = await navTab(tabId, listing.url);
    if (!navOk) {
      console.log(`[page ${pageNum}] listing ${listing.listingId} load failed`);
      continue;
    }

    // Brief wait for DOM
    await activeWait(300);

    // Captcha?
    if (await isCaptcha(tabId)) {
      console.log(`[page ${pageNum}] CAPTCHA on listing!`);
      tsLog(ts, "CAPTCHA on listing page. Stopping.");
      ts.status = "error";
      return false;
    }

    // Extract
    const data = await extractListing(tabId);

    if (data && data.demand_signal) {
      ts.productsFound++;
      ts.matchingProducts.push({
        title: data.title || listing.cardTitle || "",
        url: listing.url,
        image_url: data.image_url || listing.cardImage || "",
        sold_count: data.demand_signal,
        price: data.price || "",
        shop_name: data.shop_name || "",
      });
      console.log(`[page ${pageNum}] ✓ ${data.demand_signal} — ${(data.title || "").substring(0, 50)}`);
      tsLog(ts, `✓ ${data.demand_signal} — ${(data.title || listing.cardTitle || "").substring(0, 50)}`);
    }

    // Flush every 10
    if (ts.matchingProducts.length >= 10) {
      await flushProducts(ts);
    }

    // Active wait ~3s between listings (keeps worker alive)
    if (i < top.length - 1) {
      const waitIters = gaussRand(1500, 400, 800, 2500);
      await activeWait(waitIters);
    }
  }

  // ---- 5. Flush remaining ----
  await flushProducts(ts);

  // ---- 6. Navigate back to search page (for referrer chain) ----
  // This also prepares the tab for the next page
  console.log(`[page ${pageNum}] navigating back to search`);
  await navTab(tabId, searchUrl);
  await activeWait(200);

  tsLog(ts, `Page ${pageNum} done. ${ts.listingsChecked} checked, ${ts.productsFound} found.`);
  console.log(`[page ${pageNum}] COMPLETE`);

  return true;
}

// ============================================================
// MAIN TICK — one alarm = warmup OR one full search page
// ============================================================

async function processTick() {
  console.log("[tick] ===== START =====");

  let ts;
  try {
    const data = await chrome.storage.local.get(["tickState", "backendUrl"]);
    ts = data.tickState;
    if (!ts) { console.log("[tick] no state"); return; }
    if (ts.status !== "running") { console.log("[tick] status:", ts.status); return; }
    if (data.backendUrl) ts.backendUrl = data.backendUrl;
  } catch (e) {
    console.error("[tick] storage read error:", e);
    return;
  }

  try {
    console.log(`[tick] phase=${ts.phase} page=${ts.currentPage}/${ts.totalPages} checked=${ts.listingsChecked} found=${ts.productsFound}`);

    // ---- WARMUP ----
    if (ts.phase === "warmup") {
      console.log("[tick] WARMUP");
      tsLog(ts, "Warming up — visiting Etsy homepage...");

      const tabId = await getTab();
      console.log("[tick] tab:", tabId);

      const ok = await navTab(tabId, "https://www.etsy.com");
      console.log("[tick] homepage loaded:", ok);

      await activeWait(500);

      ts.phase = "search";
      ts.currentPage = 0;
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);

      console.log("[tick] warmup done, scheduling first search page");
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
      return;
    }

    // ---- SEARCH — process one full page ----
    if (ts.phase === "search") {
      ts.currentPage++;

      if (ts.currentPage > ts.totalPages) {
        console.log("[tick] ALL DONE");
        ts.status = "completed";
        tsLog(ts, `Done! ${ts.listingsChecked} listings checked, ${ts.productsFound} with demand signals.`);
        await flushProducts(ts);
        await chrome.storage.local.set({ tickState: ts });
        await updateProgress(ts);
        // Clean up tab
        const data = await chrome.storage.local.get(["tabId"]);
        if (data.tabId) { try { await chrome.tabs.remove(data.tabId); } catch (e) {} }
        await chrome.storage.local.remove("tabId");
        return;
      }

      // Process the entire page (search + all top listings)
      const ok = await processFullPage(ts);

      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);

      if (!ok) {
        // Error (captcha) — stop
        console.log("[tick] page returned error, stopping");
        return;
      }

      // Schedule next page
      const delayMin = gaussRand(60, 15, 40, 90) / 60;
      const extra = (ts.currentPage % 5 === 0) ? gaussRand(30, 10, 15, 45) / 60 : 0;
      const totalMin = Math.max(0.5, delayMin + extra); // at least 30s

      console.log(`[tick] next page in ~${Math.round(totalMin * 60)}s`);
      tsLog(ts, `Next page in ~${Math.round(totalMin * 60)}s...`);
      await chrome.storage.local.set({ tickState: ts });

      chrome.alarms.create(ALARM_NAME, { delayInMinutes: totalMin });
      return;
    }

    // Unknown phase
    console.log("[tick] unknown phase:", ts.phase, "resetting");
    ts.phase = "search";
    await chrome.storage.local.set({ tickState: ts });
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });

  } catch (e) {
    console.error("[tick] CRASH:", e.message);
    console.error("[tick] stack:", e.stack);
    if (ts) {
      tsLog(ts, `Crash: ${e.message}`);
      ts.status = "error";
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);
    }
  }
}

// ============================================================
// START SEARCH
// ============================================================

async function startAlarmSearch(keyword, searchId, backendUrl) {
  console.log(`[start] "${keyword}" id=${searchId}`);

  // Clean up any stale tabs from previous searches
  const old = await chrome.storage.local.get(["tabId"]);
  if (old.tabId) {
    try { await chrome.tabs.remove(old.tabId); } catch (e) {}
    await chrome.storage.local.remove("tabId");
  }

  const tickState = {
    keyword, searchId, backendUrl,
    currentPage: 0,
    totalPages: TOTAL_SEARCH_PAGES,
    matchingProducts: [],
    listingsChecked: 0,
    productsFound: 0,
    log: [],
    status: "running",
    phase: "warmup",
  };
  await chrome.storage.local.set({ tickState });
  await updateProgress(tickState);

  // Run first tick inline immediately
  console.log("[start] running first tick inline");
  try {
    await processTick();
  } catch (e) {
    console.error("[start] inline tick error:", e);
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5 });
  }
}

// ============================================================
// MESSAGES
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[msg]", msg.type);
  if (msg.type === "startSearch") {
    startAlarmSearch(msg.keyword, null, msg.backendUrl || DEFAULT_BACKEND);
    sendResponse({ ok: true });
  } else if (msg.type === "cancelSearch") {
    (async () => {
      const d = await chrome.storage.local.get(["tickState"]);
      if (d.tickState) { d.tickState.status = "cancelled"; await chrome.storage.local.set({ tickState: d.tickState }); await updateProgress(d.tickState); }
      chrome.alarms.clear(ALARM_NAME);
      const t = await chrome.storage.local.get(["tabId"]);
      if (t.tabId) { try { await chrome.tabs.remove(t.tabId); } catch (e) {} }
      await chrome.storage.local.remove("tabId");
    })();
    sendResponse({ ok: true });
  } else if (msg.type === "getState") {
    chrome.storage.local.get(["tickState"]).then(d => sendResponse({ state: d.tickState || null }));
    return true;
  }
  return true;
});

// ============================================================
// QUEUE POLLING
// ============================================================

async function pollForQueuedSearches() {
  console.log("[poll] checking...");
  let backendUrl = DEFAULT_BACKEND;
  try {
    const d = await chrome.storage.local.get(["backendUrl", "tickState"]);
    if (d.backendUrl) backendUrl = d.backendUrl;
    if (d.tickState && d.tickState.status === "running") {
      console.log("[poll] active:", d.tickState.phase, "page:", d.tickState.currentPage);
      return;
    }
    if (d.tickState) {
      console.log("[poll] clearing:", d.tickState.status);
      await chrome.storage.local.remove("tickState");
    }
  } catch (e) {}

  try {
    const resp = await fetch(`${backendUrl}/api/queue/pending`);
    const pending = await resp.json();
    console.log("[poll] pending:", pending.length);
    if (pending.length > 0) {
      const s = pending[0];
      console.log("[poll] claiming:", s.search_id, s.keyword);
      await fetch(`${backendUrl}/api/queue/${s.search_id}/claim`, { method: "POST" });
      await startAlarmSearch(s.keyword, s.search_id, backendUrl);
    }
  } catch (e) { console.log("[poll] error:", e.message); }
}

// ============================================================
// ALARMS
// ============================================================

chrome.alarms.create("pollQueue", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  console.log("[alarm]", alarm.name);
  if (alarm.name === "pollQueue") pollForQueuedSearches();
  else if (alarm.name === ALARM_NAME) processTick();
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[init] installed");
  chrome.alarms.create("pollQueue", { periodInMinutes: 1 });
  pollForQueuedSearches();
});

chrome.runtime.onStartup.addListener(() => { pollForQueuedSearches(); });

console.log("[init] v6.0 loaded");
pollForQueuedSearches();
