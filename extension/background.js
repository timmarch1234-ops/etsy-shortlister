// ============================================================
// ETSY PRODUCT SHORTLISTER v5.0 — Parallel Stealth Edition
//
// Completes 20 search pages + ALL listings in ≤30 minutes.
// Opens 4 listing tabs in parallel per batch.
//
// Anti-detection retained from v4:
//   1. Gaussian-distributed delays (Box-Muller) on everything
//   2. Natural scrolling with variable speed + scroll-back
//   3. Tab reuse: 1 search tab + 4 listing tabs, all reused
//   4. Referrer chain: homepage → search (same tab navigation)
//   5. 24h rate limit (max pages in rolling 24h window)
//   6. Keyword cooldown between different keyword searches
//   7. Random "reading pauses" on ~8% of batches
//
// Architecture:
//   Each alarm tick processes ONE FULL search page:
//     - Load search page in browse tab
//     - Collect all listing URLs
//     - Process listings in batches of 4 (parallel tabs)
//     - 3-5s gaussian delay between batches
//     - ~70 listings ÷ 4 = ~18 batches × 4.5s = ~80s per page
//   Then alarm schedules next search page (short delay).
//   Total: 20 pages × ~90s = ~30 minutes.
// ============================================================

const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";
const ALARM_NAME = "searchTick";

// Tuning
const TOTAL_SEARCH_PAGES = 20;
const PARALLEL_TABS = 4;
const MAX_PAGES_PER_24H = 2000; // 20 search + ~1400 listings per run
const KEYWORD_COOLDOWN_MS = 30 * 60 * 1000; // 30 min between keywords

// ============================================================
// UTILITY
// ============================================================

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Gaussian random (Box-Muller), clamped to [min, max]
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

function gaussSleep(meanMs, sdMs, minMs, maxMs) {
  return sleep(gaussRand(meanMs, sdMs, minMs, maxMs));
}

// ============================================================
// 24-HOUR RATE LIMITER
// ============================================================

async function recordPageLoads(count = 1) {
  const data = await chrome.storage.local.get(["pageLoads24h"]);
  const loads = data.pageLoads24h || [];
  const now = Date.now();
  const recent = loads.filter(t => (now - t) < 24 * 60 * 60 * 1000);
  for (let i = 0; i < count; i++) recent.push(now);
  await chrome.storage.local.set({ pageLoads24h: recent });
  return recent.length;
}

async function getPageLoadCount24h() {
  const data = await chrome.storage.local.get(["pageLoads24h"]);
  const loads = data.pageLoads24h || [];
  const now = Date.now();
  return loads.filter(t => (now - t) < 24 * 60 * 60 * 1000).length;
}

async function isOver24hLimit() {
  return (await getPageLoadCount24h()) >= MAX_PAGES_PER_24H;
}

// ============================================================
// KEYWORD COOLDOWN
// ============================================================

async function getLastKeywordFinishTime() {
  const data = await chrome.storage.local.get(["lastKeywordFinished"]);
  return data.lastKeywordFinished || 0;
}

async function setLastKeywordFinishTime() {
  await chrome.storage.local.set({ lastKeywordFinished: Date.now() });
}

async function isKeywordCooldownActive() {
  const last = await getLastKeywordFinishTime();
  return (Date.now() - last) < KEYWORD_COOLDOWN_MS;
}

// ============================================================
// TAB MANAGEMENT
// ============================================================

// The browse tab is used for search pages (reused, preserves referrer)
let browseTabId = null;
// Listing tabs are reused across batches
let listingTabIds = [];

async function getOrCreateBrowseTab() {
  if (browseTabId) {
    try {
      await chrome.tabs.get(browseTabId);
      return browseTabId;
    } catch (e) { browseTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  browseTabId = tab.id;
  await chrome.storage.local.set({ browseTabId: tab.id });
  return tab.id;
}

async function ensureListingTabs(count) {
  // Verify existing tabs still exist
  const alive = [];
  for (const id of listingTabIds) {
    try {
      await chrome.tabs.get(id);
      alive.push(id);
    } catch (e) {}
  }
  listingTabIds = alive;

  // Create any missing tabs
  while (listingTabIds.length < count) {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    listingTabIds.push(tab.id);
  }

  await chrome.storage.local.set({ listingTabIds });
  return listingTabIds.slice(0, count);
}

async function restoreTabs() {
  const data = await chrome.storage.local.get(["browseTabId", "listingTabIds"]);
  if (data.browseTabId) {
    try {
      await chrome.tabs.get(data.browseTabId);
      browseTabId = data.browseTabId;
    } catch (e) {
      browseTabId = null;
    }
  }
  if (data.listingTabIds) {
    listingTabIds = [];
    for (const id of data.listingTabIds) {
      try {
        await chrome.tabs.get(id);
        listingTabIds.push(id);
      } catch (e) {}
    }
  }
}

async function cleanupAllTabs() {
  for (const id of listingTabIds) {
    try { await chrome.tabs.remove(id); } catch (e) {}
  }
  listingTabIds = [];
  if (browseTabId) {
    try { await chrome.tabs.remove(browseTabId); } catch (e) {}
    browseTabId = null;
  }
  await chrome.storage.local.remove(["browseTabId", "listingTabIds"]);
}

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // Resolve instead of reject — don't crash on slow pages
    }, 30000);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

// Navigate multiple tabs in parallel, wait for all to complete
function navigateTabsParallel(tabUrls) {
  // tabUrls = [{tabId, url}, ...]
  return Promise.all(tabUrls.map(({ tabId, url }) => navigateTab(tabId, url)));
}

// ============================================================
// NATURAL SCROLLING
// ============================================================

// Fast but natural scroll for search pages (~2-3 seconds)
async function scrollSearchPageFast(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: async () => {
        function gr(mean, sd, min, max) {
          let u = 0, v = 0;
          while (u === 0) u = Math.random();
          while (v === 0) v = Math.random();
          let z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
          let val = mean + z * sd;
          return Math.round(Math.max(min, Math.min(max, val)));
        }

        const totalH = document.body.scrollHeight;
        let y = 0;
        // Fast scroll in 5-7 chunks to trigger lazy loading
        const chunks = gr(6, 1, 5, 8);
        const chunkSize = totalH / chunks;

        for (let i = 0; i < chunks; i++) {
          window.scrollBy(0, chunkSize + gr(0, 50, -100, 100));
          y += chunkSize;
          // Brief pause — enough for lazy images but fast
          await new Promise(r => setTimeout(r, gr(250, 80, 120, 450)));
        }

        // Scroll back to top
        window.scrollTo({ top: 0, behavior: "auto" });
      },
    });
  } catch (e) {}
}

// ============================================================
// CAPTCHA DETECTION
// ============================================================

async function hasCaptcha(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const title = document.title || "";
        const body = document.body?.innerText || "";
        const iframes = document.querySelectorAll("iframe");
        const divs = document.querySelectorAll("div");
        if (divs.length < 5 && iframes.length > 0 && title.length < 20) return true;
        if (body.toLowerCase().includes("captcha")) return true;
        if (body.includes("Access is temporarily restricted")) return true;
        return false;
      },
    });
    return results[0]?.result || false;
  } catch (e) {
    return false;
  }
}

// ============================================================
// COLLECT ALL LISTING URLS FROM SEARCH PAGE
// ============================================================

async function collectAllListings(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const listings = [];
      const seen = new Set();
      const links = document.querySelectorAll('a[href*="/listing/"]');

      for (const link of links) {
        const m = link.href.match(/\/listing\/(\d+)/);
        if (!m || seen.has(m[1])) continue;
        seen.add(m[1]);

        // Walk up to find card
        let card = link.closest('[data-listing-id]') ||
                   link.closest('.v2-listing-card') ||
                   link.closest('.wt-grid__item-xs-6') ||
                   link.closest('[class*="listing"]');
        if (!card) {
          let el = link;
          for (let i = 0; i < 8; i++) {
            if (el.parentElement) el = el.parentElement;
            if (el.offsetHeight > 150 && el.offsetWidth > 100) {
              card = el; break;
            }
          }
        }
        if (!card) card = link.parentElement?.parentElement || link.parentElement;

        const titleEl = card?.querySelector('h3, h2, [class*="title"]') || link;
        const img = card?.querySelector("img");

        listings.push({
          listingId: m[1],
          url: `https://www.etsy.com/listing/${m[1]}`,
          cardTitle: titleEl?.textContent?.trim()?.substring(0, 120) || "",
          cardImage: img?.src || "",
        });
      }
      return listings;
    },
  });
  return results[0]?.result || [];
}

// ============================================================
// EXTRACT DEMAND SIGNALS FROM LISTING PAGE
// ============================================================

async function extractFromListingPage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = document.body?.innerText || "";
        const result = {
          title: "",
          price: "",
          sold_count: null,
          demand_signal: null,
          image_url: "",
          shop_name: "",
        };

        // Title
        const ogTitle = document.querySelector('meta[property="og:title"]');
        result.title = ogTitle?.content ||
                       document.querySelector('h1')?.textContent?.trim() || "";

        // Image
        const ogImage = document.querySelector('meta[property="og:image"]');
        result.image_url = ogImage?.content || "";

        // Price
        const priceEl = document.querySelector('[data-buy-box-listing-price]') ||
                         document.querySelector('[class*="price"]') ||
                         document.querySelector('p[class*="Price"]');
        if (priceEl) result.price = priceEl.textContent?.trim() || "";

        // Shop name
        const shopLink = document.querySelector('a[href*="/shop/"]');
        if (shopLink) {
          const m = shopLink.href.match(/\/shop\/([^/?]+)/);
          result.shop_name = m ? m[1] : "";
        }

        // --- Demand signals ---

        const boughtMatch = text.match(
          /(\d+\+?)\s+(?:people\s+)?(?:bought|sold)\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s*hours/i
        );
        if (boughtMatch) {
          result.demand_signal = boughtMatch[0].trim();
          result.sold_count = boughtMatch[1];
        }

        if (!result.demand_signal && /in\s+demand/i.test(text)) {
          result.demand_signal = "In demand";
          const near = text.match(/in\s+demand[.\s]*(\d+)\+?\s+(?:people\s+)?bought/i);
          if (near) result.sold_count = near[1];
        }

        if (!result.demand_signal) {
          const bm = text.match(/(\d+\+?)\s+people\s+have\s+this\s+in\s+their\s+(?:basket|cart)/i);
          if (bm) { result.demand_signal = bm[0].trim(); result.sold_count = bm[1]; }
        }

        if (!result.demand_signal) {
          const ibm = text.match(/in\s+(\d+\+?)\s+(?:basket|cart)s?/i);
          if (ibm) { result.demand_signal = ibm[0].trim(); result.sold_count = ibm[1]; }
        }

        if (!result.demand_signal && /bestseller/i.test(text)) {
          result.demand_signal = "Bestseller";
        }

        if (!result.demand_signal && /popular\s+now/i.test(text)) {
          result.demand_signal = "Popular now";
        }

        if (!result.demand_signal) {
          const ls = text.match(/only\s+(\d+)\s+left/i);
          if (ls) { result.demand_signal = ls[0].trim(); result.sold_count = ls[1]; }
        }

        if (!result.sold_count) {
          const sm = text.match(/([\d,]+)\s+sales?/i);
          if (sm) {
            const n = parseInt(sm[1].replace(/,/g, ""), 10);
            if (n >= 100) {
              result.sold_count = sm[1];
              if (!result.demand_signal) result.demand_signal = `${sm[1]} sales`;
            }
          }
        }

        return result;
      },
    });
    return results[0]?.result || null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// PROGRESS + LOGGING
// ============================================================

async function updateProgress(ts) {
  const backendUrl = ts.backendUrl || DEFAULT_BACKEND;
  if (!ts.searchId) return;
  try {
    await fetch(`${backendUrl}/api/queue/${ts.searchId}/progress`, {
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

function tsLog(ts, msg) {
  ts.log.push(msg);
  console.log("[shortlister]", msg);
}

async function flushProducts(ts, backendUrl) {
  if (ts.matchingProducts.length === 0) return;
  try {
    const resp = await fetch(`${backendUrl}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: ts.keyword, products: ts.matchingProducts.splice(0) }),
    });
    const data = await resp.json();
    console.log(`[shortlister] Sent ${data.count} products to backend.`);
  } catch (e) {
    console.log("[shortlister] Failed to send:", e.message);
  }
}

// ============================================================
// PROCESS ONE BATCH OF LISTINGS (parallel tabs)
//
// Opens `urls.length` listings simultaneously in reused tabs,
// waits for all to load, extracts demand signals from each,
// returns results.
// ============================================================

async function processBatch(tabIds, listings, ts) {
  const pairs = listings.map((l, i) => ({ tabId: tabIds[i], listing: l }));

  // Navigate all tabs in parallel
  await navigateTabsParallel(
    pairs.map(p => ({ tabId: p.tabId, url: p.listing.url }))
  );

  // Brief pause for pages to settle (DOM rendering)
  await gaussSleep(1200, 300, 800, 1800);

  // Check first tab for captcha (if one is blocked, likely all are)
  if (await hasCaptcha(pairs[0].tabId)) {
    return { captcha: true, results: [] };
  }

  // Extract from all tabs in parallel
  const extractions = await Promise.all(
    pairs.map(async (p) => {
      const data = await extractFromListingPage(p.tabId);
      return { listing: p.listing, data };
    })
  );

  return { captcha: false, results: extractions };
}

// ============================================================
// PROCESS ONE FULL SEARCH PAGE (called from alarm tick)
//
// This runs as a single long tick (~60-90s):
//   1. Load search page
//   2. Collect all listing URLs
//   3. Process in batches of 4 with gaussian delays
// ============================================================

async function processSearchPage(ts, pageNum) {
  const backendUrl = ts.backendUrl || DEFAULT_BACKEND;
  const tabId = await getOrCreateBrowseTab();

  // Navigate to search page (referrer = previous page in same tab)
  const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(ts.keyword)}&ref=search_bar&page=${pageNum}`;
  tsLog(ts, `Loading search page ${pageNum}/${ts.totalPages}...`);

  await navigateTab(tabId, searchUrl);
  await recordPageLoads(1);
  await gaussSleep(1500, 400, 1000, 2500);

  // Captcha check
  if (await hasCaptcha(tabId)) {
    tsLog(ts, "Access restricted! Pausing.");
    ts.status = "error";
    return false;
  }

  // Quick natural scroll to trigger lazy loading
  await scrollSearchPageFast(tabId);
  await gaussSleep(800, 200, 500, 1200);

  // Collect ALL listing URLs
  const allListings = await collectAllListings(tabId);
  tsLog(ts, `Page ${pageNum}: found ${allListings.length} listings. Processing in batches of ${PARALLEL_TABS}...`);

  if (allListings.length === 0) {
    tsLog(ts, `Page ${pageNum}: no listings found (may be end of results).`);
    return true;
  }

  // Ensure we have listing tabs ready
  const ltabs = await ensureListingTabs(PARALLEL_TABS);

  // Process in batches
  let batchNum = 0;
  for (let i = 0; i < allListings.length; i += PARALLEL_TABS) {
    batchNum++;
    const batch = allListings.slice(i, i + PARALLEL_TABS);
    const tabsForBatch = ltabs.slice(0, batch.length);

    const result = await processBatch(tabsForBatch, batch, ts);
    await recordPageLoads(batch.length);
    ts.listingsChecked += batch.length;

    if (result.captcha) {
      tsLog(ts, "Captcha detected on listing page! Pausing.");
      ts.status = "error";
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);
      return false;
    }

    // Process extraction results
    for (const { listing, data } of result.results) {
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
        tsLog(ts, `  ✓ ${data.demand_signal} — ${(data.title || listing.cardTitle || "").substring(0, 50)}`);
      }
    }

    // Flush to backend every 10 matches
    if (ts.matchingProducts.length >= 10) {
      await flushProducts(ts, backendUrl);
    }

    // Save state periodically (every 5 batches)
    if (batchNum % 5 === 0) {
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);
    }

    // Gaussian delay between batches (3-5s center, occasional longer pause)
    if (i + PARALLEL_TABS < allListings.length) {
      if (Math.random() < 0.08) {
        // ~8% chance: "reading pause" — user is studying a result
        const longPause = gaussRand(12000, 4000, 8000, 20000);
        tsLog(ts, `  (pausing ${Math.round(longPause / 1000)}s...)`);
        await sleep(longPause);
      } else {
        await gaussSleep(4000, 800, 2500, 6000);
      }
    }
  }

  tsLog(ts, `Page ${pageNum}: done. ${ts.listingsChecked} total checked, ${ts.productsFound} matches.`);

  // Flush remaining
  await flushProducts(ts, backendUrl);
  await chrome.storage.local.set({ tickState: ts });
  await updateProgress(ts);

  return true;
}

// ============================================================
// MAIN TICK PROCESSOR
// ============================================================

async function processTick() {
  const data = await chrome.storage.local.get(["tickState", "backendUrl"]);
  let ts = data.tickState;
  if (!ts || ts.status !== "running") return;
  if (data.backendUrl) ts.backendUrl = data.backendUrl;

  const backendUrl = ts.backendUrl || DEFAULT_BACKEND;

  try {
    // Rate limit check
    if (await isOver24hLimit()) {
      tsLog(ts, `24h rate limit hit. Waiting 2 hours.`);
      ts.status = "rate_limited";
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: 120 });
      return;
    }

    await restoreTabs();

    // ==== WARMUP ====
    if (ts.phase === "warmup") {
      tsLog(ts, "Warming up — visiting Etsy homepage...");
      const tabId = await getOrCreateBrowseTab();
      await navigateTab(tabId, "https://www.etsy.com");
      await recordPageLoads(1);
      await gaussSleep(2500, 700, 1500, 4000);

      ts.phase = "searchPage";
      ts.currentPage = 0;
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);

      // Brief delay before first search page
      const delay = gaussRand(3000, 1000, 2000, 5000);
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay / 60000 });
      return;
    }

    // ==== SEARCH PAGE (processes all listings within this tick) ====
    if (ts.phase === "searchPage") {
      ts.currentPage++;

      if (ts.currentPage > ts.totalPages) {
        // All pages done!
        ts.status = "completed";
        tsLog(ts, `Search complete! ${ts.listingsChecked} listings checked, ${ts.productsFound} with demand signals.`);
        await flushProducts(ts, backendUrl);
        await setLastKeywordFinishTime();
        await chrome.storage.local.set({ tickState: ts });
        await updateProgress(ts);
        await cleanupAllTabs();
        return;
      }

      // Process this search page (loads page + all listing batches)
      const ok = await processSearchPage(ts, ts.currentPage);

      if (!ok) {
        // Error (captcha etc) — state already saved
        await chrome.storage.local.set({ tickState: ts });
        await updateProgress(ts);
        return;
      }

      // Schedule next search page
      // Short delay — most time is spent in listing batches already
      const delay = gaussRand(5000, 1500, 3000, 8000);
      // Every 5 pages, slightly longer break
      const extra = (ts.currentPage % 5 === 0) ? gaussRand(8000, 3000, 5000, 15000) : 0;
      const totalMs = delay + extra;

      chrome.alarms.create(ALARM_NAME, { delayInMinutes: totalMs / 60000 });
      tsLog(ts, `Next search page in ${Math.round(totalMs / 1000)}s...`);
      await chrome.storage.local.set({ tickState: ts });
      return;
    }

  } catch (e) {
    console.error("[shortlister] tick error:", e);
    if (ts) {
      tsLog(ts, `Tick error: ${e.message}`);
      await chrome.storage.local.set({ tickState: ts });
    }
    // Retry after 30s
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5 });
  }
}

// ============================================================
// START SEARCH
// ============================================================

async function startAlarmSearch(keyword, searchId, backendUrl) {
  const tickState = {
    keyword,
    searchId,
    backendUrl,
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
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.01 });
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "startSearch") {
    const backendUrl = msg.backendUrl || DEFAULT_BACKEND;
    startAlarmSearch(msg.keyword, null, backendUrl);
    sendResponse({ ok: true });
  } else if (msg.type === "cancelSearch") {
    (async () => {
      const data = await chrome.storage.local.get(["tickState"]);
      if (data.tickState) {
        data.tickState.status = "cancelled";
        await chrome.storage.local.set({ tickState: data.tickState });
        await updateProgress(data.tickState);
      }
      chrome.alarms.clear(ALARM_NAME);
      await cleanupAllTabs();
    })();
    sendResponse({ ok: true });
  } else if (msg.type === "getState") {
    (async () => {
      const data = await chrome.storage.local.get(["tickState"]);
      sendResponse({ state: data.tickState || null });
    })();
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
    const data = await chrome.storage.local.get(["backendUrl", "tickState"]);
    if (data.backendUrl) backendUrl = data.backendUrl;

    if (data.tickState && ["running", "cooldown", "rate_limited"].includes(data.tickState.status)) {
      console.log("[poll] search active:", data.tickState.status);
      return;
    }

    if (data.tickState) {
      console.log("[poll] clearing old tickState:", data.tickState.status);
      await chrome.storage.local.remove("tickState");
    }
  } catch (e) {}

  if (await isKeywordCooldownActive()) {
    const last = await getLastKeywordFinishTime();
    const rem = Math.round((KEYWORD_COOLDOWN_MS - (Date.now() - last)) / 60000);
    console.log(`[poll] keyword cooldown: ${rem} min left`);
    return;
  }

  if (await isOver24hLimit()) {
    console.log("[poll] 24h rate limit reached");
    return;
  }

  try {
    const resp = await fetch(`${backendUrl}/api/queue/pending`);
    const pending = await resp.json();
    console.log("[poll] pending:", pending.length);
    if (pending.length > 0) {
      const search = pending[0];
      console.log("[poll] claiming:", search.search_id, search.keyword);
      await fetch(`${backendUrl}/api/queue/${search.search_id}/claim`, { method: "POST" });
      await startAlarmSearch(search.keyword, search.search_id, backendUrl);
    }
  } catch (e) {
    console.log("[poll] error:", e);
  }
}

// ============================================================
// ALARM LISTENERS
// ============================================================

chrome.alarms.create("pollQueue", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pollQueue") {
    pollForQueuedSearches();
  } else if (alarm.name === ALARM_NAME) {
    processTick();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("pollQueue", { periodInMinutes: 1 });
  pollForQueuedSearches();
});

chrome.runtime.onStartup.addListener(() => {
  pollForQueuedSearches();
});

pollForQueuedSearches();
