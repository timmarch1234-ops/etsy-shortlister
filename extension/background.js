// ============================================================
// ETSY PRODUCT SHORTLISTER v5.1 — Parallel Stealth Edition
//
// FIXED: v5.0 ran long processSearchPage loops within a single
// alarm tick. MV3 service workers die during setTimeout-based
// sleep() calls because setTimeout ≠ active Chrome API work.
//
// v5.1 fix: EVERY operation is its own short alarm tick.
//   - warmup tick: visit homepage (~3s)
//   - searchPage tick: load page, collect URLs into queue (~5s)
//   - batch tick: open 4 listings in parallel, extract (~5s)
//   - repeat batch ticks until queue empty
//   - then next searchPage tick
//
// Each tick: do work → save state → schedule next alarm → return.
// No sleep() calls. No long-running loops. Service worker safe.
//
// Math: 20 pages × ~70 listings = 1400 ÷ 4 = 350 batches
//       350 × ~5s + 20 × ~5s = ~31 min. ✓
// ============================================================

const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";
const ALARM_NAME = "searchTick";

const TOTAL_SEARCH_PAGES = 20;
const PARALLEL_TABS = 4;
const MAX_PAGES_PER_24H = 2000;
const KEYWORD_COOLDOWN_MS = 30 * 60 * 1000;

// ============================================================
// UTILITY
// ============================================================

// Gaussian random (Box-Muller), clamped
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

// Schedule next alarm tick with gaussian delay (in ms)
function scheduleNext(delayMs) {
  const mins = Math.max(0.017, delayMs / 60000); // floor ~1 second
  console.log(`[alarm] scheduling next tick in ${Math.round(delayMs / 1000)}s (${mins.toFixed(3)} min)`);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: mins });
}

// ============================================================
// 24-HOUR RATE LIMITER
// ============================================================

async function recordPageLoads(count = 1) {
  const data = await chrome.storage.local.get(["pageLoads24h"]);
  const loads = data.pageLoads24h || [];
  const now = Date.now();
  const recent = loads.filter(t => (now - t) < 86400000);
  for (let i = 0; i < count; i++) recent.push(now);
  await chrome.storage.local.set({ pageLoads24h: recent });
  return recent.length;
}

async function isOver24hLimit() {
  const data = await chrome.storage.local.get(["pageLoads24h"]);
  const loads = data.pageLoads24h || [];
  const now = Date.now();
  return loads.filter(t => (now - t) < 86400000).length >= MAX_PAGES_PER_24H;
}

// ============================================================
// KEYWORD COOLDOWN
// ============================================================

async function isKeywordCooldownActive() {
  const data = await chrome.storage.local.get(["lastKeywordFinished"]);
  return (Date.now() - (data.lastKeywordFinished || 0)) < KEYWORD_COOLDOWN_MS;
}

// ============================================================
// TAB MANAGEMENT — reuse browse tab + listing tabs
// ============================================================

async function getOrCreateTab(storageKey) {
  const data = await chrome.storage.local.get([storageKey]);
  const savedId = data[storageKey];
  if (savedId) {
    try {
      await chrome.tabs.get(savedId);
      return savedId;
    } catch (e) {}
  }
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  await chrome.storage.local.set({ [storageKey]: tab.id });
  console.log(`[tabs] created ${storageKey} = ${tab.id}`);
  return tab.id;
}

async function ensureListingTabs() {
  const ids = [];
  for (let i = 0; i < PARALLEL_TABS; i++) {
    const id = await getOrCreateTab(`listingTab_${i}`);
    ids.push(id);
  }
  return ids;
}

async function cleanupAllTabs() {
  // Browse tab
  const data = await chrome.storage.local.get(["browseTabId"]);
  if (data.browseTabId) {
    try { await chrome.tabs.remove(data.browseTabId); } catch (e) {}
  }
  // Listing tabs
  for (let i = 0; i < PARALLEL_TABS; i++) {
    const d = await chrome.storage.local.get([`listingTab_${i}`]);
    if (d[`listingTab_${i}`]) {
      try { await chrome.tabs.remove(d[`listingTab_${i}`]); } catch (e) {}
    }
    await chrome.storage.local.remove(`listingTab_${i}`);
  }
  await chrome.storage.local.remove("browseTabId");
}

// Navigate a tab and wait for complete (with timeout)
function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      console.log(`[nav] tab ${tabId} timed out loading ${url.substring(0, 60)}`);
      resolve(false);
    }, 30000);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve(true);
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url }).catch(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timeout);
      console.log(`[nav] tab ${tabId} update failed`);
      resolve(false);
    });
  });
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
    console.log(`[captcha] check failed on tab ${tabId}:`, e.message);
    return false;
  }
}

// ============================================================
// SCROLL SEARCH PAGE (fast, triggers lazy loading)
// ============================================================

async function scrollSearchPage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const totalH = document.body.scrollHeight;
        const chunks = 6;
        const chunkSize = totalH / chunks;
        let promise = Promise.resolve();
        for (let i = 0; i < chunks; i++) {
          promise = promise.then(() => {
            window.scrollBy(0, chunkSize);
            return new Promise(r => setTimeout(r, 200 + Math.random() * 200));
          });
        }
        return promise.then(() => window.scrollTo(0, 0));
      },
    });
  } catch (e) {
    console.log(`[scroll] failed on tab ${tabId}:`, e.message);
  }
}

// ============================================================
// COLLECT ALL LISTING URLS FROM SEARCH PAGE
// ============================================================

async function collectAllListings(tabId) {
  try {
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
  } catch (e) {
    console.log(`[collect] failed on tab ${tabId}:`, e.message);
    return [];
  }
}

// ============================================================
// EXTRACT DEMAND SIGNALS FROM ONE LISTING PAGE
// ============================================================

async function extractFromListingPage(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const text = document.body?.innerText || "";
        const r = {
          title: "",
          price: "",
          sold_count: null,
          demand_signal: null,
          image_url: "",
          shop_name: "",
        };

        const ogT = document.querySelector('meta[property="og:title"]');
        r.title = ogT?.content || document.querySelector('h1')?.textContent?.trim() || "";

        const ogI = document.querySelector('meta[property="og:image"]');
        r.image_url = ogI?.content || "";

        const priceEl = document.querySelector('[data-buy-box-listing-price]') ||
                        document.querySelector('[class*="price"]') ||
                        document.querySelector('p[class*="Price"]');
        if (priceEl) r.price = priceEl.textContent?.trim() || "";

        const shopLink = document.querySelector('a[href*="/shop/"]');
        if (shopLink) {
          const m = shopLink.href.match(/\/shop\/([^/?]+)/);
          r.shop_name = m ? m[1] : "";
        }

        // Demand signals
        const bought = text.match(/(\d+\+?)\s+(?:people\s+)?(?:bought|sold)\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s*hours/i);
        if (bought) { r.demand_signal = bought[0].trim(); r.sold_count = bought[1]; }

        if (!r.demand_signal && /in\s+demand/i.test(text)) {
          r.demand_signal = "In demand";
          const n = text.match(/in\s+demand[.\s]*(\d+)\+?\s+(?:people\s+)?bought/i);
          if (n) r.sold_count = n[1];
        }

        if (!r.demand_signal) {
          const bm = text.match(/(\d+\+?)\s+people\s+have\s+this\s+in\s+their\s+(?:basket|cart)/i);
          if (bm) { r.demand_signal = bm[0].trim(); r.sold_count = bm[1]; }
        }

        if (!r.demand_signal) {
          const ib = text.match(/in\s+(\d+\+?)\s+(?:basket|cart)s?/i);
          if (ib) { r.demand_signal = ib[0].trim(); r.sold_count = ib[1]; }
        }

        if (!r.demand_signal && /bestseller/i.test(text)) r.demand_signal = "Bestseller";
        if (!r.demand_signal && /popular\s+now/i.test(text)) r.demand_signal = "Popular now";

        if (!r.demand_signal) {
          const ls = text.match(/only\s+(\d+)\s+left/i);
          if (ls) { r.demand_signal = ls[0].trim(); r.sold_count = ls[1]; }
        }

        if (!r.sold_count) {
          const sm = text.match(/([\d,]+)\s+sales?/i);
          if (sm) {
            const n = parseInt(sm[1].replace(/,/g, ""), 10);
            if (n >= 100) {
              r.sold_count = sm[1];
              if (!r.demand_signal) r.demand_signal = `${sm[1]} sales`;
            }
          }
        }

        return r;
      },
    });
    return results[0]?.result || null;
  } catch (e) {
    console.log(`[extract] failed on tab ${tabId}:`, e.message);
    return null;
  }
}

// ============================================================
// PROGRESS + LOGGING
// ============================================================

function tsLog(ts, msg) {
  ts.log.push(msg);
  console.log("[shortlister]", msg);
}

async function updateProgress(ts) {
  if (!ts.searchId) return;
  const backendUrl = ts.backendUrl || DEFAULT_BACKEND;
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

async function flushProducts(ts) {
  if (ts.matchingProducts.length === 0) return;
  const backendUrl = ts.backendUrl || DEFAULT_BACKEND;
  const toSend = ts.matchingProducts.splice(0);
  console.log(`[flush] sending ${toSend.length} products to backend...`);
  try {
    const resp = await fetch(`${backendUrl}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: ts.keyword, products: toSend }),
    });
    const data = await resp.json();
    console.log(`[flush] sent ${data.count} products OK`);
  } catch (e) {
    console.log("[flush] FAILED:", e.message);
    // Put them back so they aren't lost
    ts.matchingProducts.push(...toSend);
  }
}

async function saveState(ts) {
  await chrome.storage.local.set({ tickState: ts });
}

// ============================================================
// START SEARCH
// ============================================================

async function startAlarmSearch(keyword, searchId, backendUrl) {
  console.log(`[start] Starting search: "${keyword}" id=${searchId}`);
  const tickState = {
    keyword,
    searchId,
    backendUrl,
    currentPage: 0,
    totalPages: TOTAL_SEARCH_PAGES,
    // Listing queue: filled when a search page is loaded
    listingQueue: [],
    matchingProducts: [],
    listingsChecked: 0,
    productsFound: 0,
    log: [],
    status: "running",
    phase: "warmup", // warmup → searchPage → batch → (repeat batch) → searchPage → ... → done
  };
  await saveState(tickState);
  await updateProgress(tickState);
  scheduleNext(500);
}

// ============================================================
// PROCESS ONE TICK — short, no sleep(), service-worker safe
//
// Phase flow:
//   warmup → searchPage → batch → batch → ... → searchPage → ... → done
// ============================================================

async function processTick() {
  console.log("[tick] ===== processTick START =====");

  const data = await chrome.storage.local.get(["tickState", "backendUrl"]);
  const ts = data.tickState;

  if (!ts) {
    console.log("[tick] no tickState, returning");
    return;
  }
  if (ts.status !== "running") {
    console.log("[tick] status is", ts.status, "— not running, returning");
    return;
  }
  if (data.backendUrl) ts.backendUrl = data.backendUrl;

  const backendUrl = ts.backendUrl || DEFAULT_BACKEND;

  try {
    // Rate limit
    if (await isOver24hLimit()) {
      tsLog(ts, "24h rate limit reached. Pausing 2 hours.");
      ts.status = "rate_limited";
      await saveState(ts);
      await updateProgress(ts);
      scheduleNext(2 * 60 * 60 * 1000);
      return;
    }

    console.log(`[tick] phase=${ts.phase} page=${ts.currentPage}/${ts.totalPages} queue=${ts.listingQueue.length} checked=${ts.listingsChecked} found=${ts.productsFound}`);

    // ============================================
    // PHASE: WARMUP — visit Etsy homepage
    // ============================================
    if (ts.phase === "warmup") {
      console.log("[tick] WARMUP: visiting Etsy homepage");
      tsLog(ts, "Warming up — visiting Etsy homepage...");

      const tabId = await getOrCreateTab("browseTabId");
      console.log(`[tick] browse tab = ${tabId}`);

      const ok = await navigateTab(tabId, "https://www.etsy.com");
      console.log(`[tick] homepage loaded: ${ok}`);
      await recordPageLoads(1);

      // Move to searchPage phase
      ts.phase = "searchPage";
      ts.currentPage = 0;
      await saveState(ts);
      await updateProgress(ts);

      // Gaussian delay before first search page
      const delay = gaussRand(3000, 800, 2000, 5000);
      console.log(`[tick] warmup done, next tick in ${delay}ms`);
      scheduleNext(delay);
      return;
    }

    // ============================================
    // PHASE: BATCH — process next 4 listings
    // ============================================
    if (ts.phase === "batch") {
      if (!ts.listingQueue || ts.listingQueue.length === 0) {
        console.log("[tick] BATCH: queue empty, switching to searchPage");
        ts.phase = "searchPage";
        await saveState(ts);
        // Small delay before next search page
        scheduleNext(gaussRand(4000, 1000, 3000, 6000));
        return;
      }

      // Take next batch of up to PARALLEL_TABS listings
      const batch = ts.listingQueue.splice(0, PARALLEL_TABS);
      console.log(`[tick] BATCH: processing ${batch.length} listings (${ts.listingQueue.length} remaining)`);

      // Get listing tabs
      const tabIds = await ensureListingTabs();
      console.log(`[tick] listing tabs: [${tabIds.join(", ")}]`);

      // Navigate all tabs in parallel
      const navPromises = batch.map((listing, i) => {
        const tid = tabIds[i];
        console.log(`[tick] navigating tab ${tid} → listing ${listing.listingId}`);
        return navigateTab(tid, listing.url);
      });
      const navResults = await Promise.all(navPromises);
      console.log(`[tick] all ${batch.length} tabs loaded: [${navResults.join(", ")}]`);

      await recordPageLoads(batch.length);

      // Check first tab for captcha
      if (await hasCaptcha(tabIds[0])) {
        console.log("[tick] CAPTCHA detected!");
        tsLog(ts, "Access restricted! Pausing search.");
        // Put batch back
        ts.listingQueue.unshift(...batch);
        ts.status = "error";
        await saveState(ts);
        await updateProgress(ts);
        return;
      }

      // Extract from all tabs in parallel
      const extractPromises = batch.map((listing, i) => {
        return extractFromListingPage(tabIds[i]).then(data => ({ listing, data }));
      });
      const extractions = await Promise.all(extractPromises);
      console.log(`[tick] extracted from ${extractions.length} listings`);

      // Process results
      for (const { listing, data } of extractions) {
        ts.listingsChecked++;
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
          console.log(`[tick] ✓ MATCH: ${data.demand_signal} — ${(data.title || "").substring(0, 50)}`);
          tsLog(ts, `✓ ${data.demand_signal} — ${(data.title || listing.cardTitle || "").substring(0, 50)}`);
        }
      }

      // Flush to backend every 10 matches
      if (ts.matchingProducts.length >= 10) {
        await flushProducts(ts);
      }

      await saveState(ts);
      // Update progress every 5 batches to avoid spamming
      if (ts.listingsChecked % 20 === 0 || ts.listingQueue.length === 0) {
        await updateProgress(ts);
      }

      // Schedule next batch with gaussian delay
      if (ts.listingQueue.length > 0) {
        // 8% chance of a longer "reading pause"
        let delay;
        if (Math.random() < 0.08) {
          delay = gaussRand(12000, 3000, 8000, 18000);
          tsLog(ts, `(reading pause ${Math.round(delay / 1000)}s...)`);
          await saveState(ts);
        } else {
          delay = gaussRand(4000, 800, 2500, 6000);
        }
        console.log(`[tick] next batch in ${delay}ms (${ts.listingQueue.length} remaining)`);
        scheduleNext(delay);
      } else {
        // Queue exhausted — move to next search page
        tsLog(ts, `Finished all listings for page ${ts.currentPage}. Checked ${ts.listingsChecked} total, ${ts.productsFound} matches.`);
        ts.phase = "searchPage";
        await saveState(ts);
        await updateProgress(ts);

        // Delay before next search page
        const pageDelay = gaussRand(5000, 1500, 3000, 8000);
        const extraDelay = (ts.currentPage % 5 === 0) ? gaussRand(8000, 3000, 5000, 12000) : 0;
        console.log(`[tick] next search page in ${pageDelay + extraDelay}ms`);
        scheduleNext(pageDelay + extraDelay);
      }
      return;
    }

    // ============================================
    // PHASE: SEARCH PAGE — load page + collect URLs
    // ============================================
    if (ts.phase === "searchPage") {
      ts.currentPage++;
      console.log(`[tick] SEARCH PAGE: loading page ${ts.currentPage}/${ts.totalPages}`);

      if (ts.currentPage > ts.totalPages) {
        // ALL DONE
        console.log("[tick] ALL PAGES DONE — completing search");
        ts.status = "completed";
        tsLog(ts, `Search complete! ${ts.listingsChecked} listings checked, ${ts.productsFound} with demand signals.`);
        await flushProducts(ts);
        await chrome.storage.local.set({ lastKeywordFinished: Date.now() });
        await saveState(ts);
        await updateProgress(ts);
        await cleanupAllTabs();
        return;
      }

      tsLog(ts, `Loading search page ${ts.currentPage}/${ts.totalPages}...`);
      await updateProgress(ts);

      const tabId = await getOrCreateTab("browseTabId");
      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(ts.keyword)}&ref=search_bar&page=${ts.currentPage}`;
      console.log(`[tick] navigating browse tab ${tabId} → ${searchUrl.substring(0, 80)}`);

      const loaded = await navigateTab(tabId, searchUrl);
      console.log(`[tick] search page loaded: ${loaded}`);
      await recordPageLoads(1);

      // Captcha check
      if (await hasCaptcha(tabId)) {
        console.log("[tick] CAPTCHA on search page!");
        tsLog(ts, "Access restricted! Pausing search.");
        ts.currentPage--; // retry this page later
        ts.status = "error";
        await saveState(ts);
        await updateProgress(ts);
        return;
      }

      // Scroll to trigger lazy loading
      await scrollSearchPage(tabId);
      console.log("[tick] scrolled search page");

      // Collect all listing URLs
      const allListings = await collectAllListings(tabId);
      console.log(`[tick] collected ${allListings.length} listings from page ${ts.currentPage}`);

      if (allListings.length === 0) {
        tsLog(ts, `Page ${ts.currentPage}: no listings found (may be end of results).`);
        // Check if this is really the end
        if (ts.currentPage >= 3) {
          // Probably end of results — finish early
          ts.totalPages = ts.currentPage;
          console.log("[tick] adjusting totalPages to", ts.currentPage);
        }
        await saveState(ts);
        scheduleNext(gaussRand(3000, 800, 2000, 5000));
        return;
      }

      // Shuffle listings (look more natural than sequential)
      for (let i = allListings.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [allListings[i], allListings[j]] = [allListings[j], allListings[i]];
      }

      ts.listingQueue = allListings;
      ts.phase = "batch";
      tsLog(ts, `Page ${ts.currentPage}: ${allListings.length} listings queued. Starting batches...`);

      await saveState(ts);
      await updateProgress(ts);

      // Short delay before first batch
      scheduleNext(gaussRand(2000, 500, 1500, 3000));
      return;
    }

    // Unknown phase — reset
    console.log("[tick] unknown phase:", ts.phase, "— resetting to searchPage");
    ts.phase = "searchPage";
    await saveState(ts);
    scheduleNext(2000);

  } catch (e) {
    console.error("[tick] UNCAUGHT ERROR:", e);
    console.error("[tick] stack:", e.stack);
    if (ts) {
      tsLog(ts, `Error: ${e.message}`);
      await saveState(ts);
    }
    // Retry in 30s
    scheduleNext(30000);
  }
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[msg] received:", msg.type);
  if (msg.type === "startSearch") {
    const backendUrl = msg.backendUrl || DEFAULT_BACKEND;
    startAlarmSearch(msg.keyword, null, backendUrl);
    sendResponse({ ok: true });
  } else if (msg.type === "cancelSearch") {
    (async () => {
      const data = await chrome.storage.local.get(["tickState"]);
      if (data.tickState) {
        data.tickState.status = "cancelled";
        await saveState(data.tickState);
        await updateProgress(data.tickState);
      }
      chrome.alarms.clear(ALARM_NAME);
      await cleanupAllTabs();
    })();
    sendResponse({ ok: true });
  } else if (msg.type === "getState") {
    chrome.storage.local.get(["tickState"]).then(data => {
      sendResponse({ state: data.tickState || null });
    });
    return true; // async sendResponse
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

    if (data.tickState && ["running", "rate_limited"].includes(data.tickState.status)) {
      console.log("[poll] search active:", data.tickState.status, "phase:", data.tickState.phase);
      return;
    }

    if (data.tickState) {
      console.log("[poll] clearing old tickState:", data.tickState.status);
      await chrome.storage.local.remove("tickState");
    }
  } catch (e) {
    console.log("[poll] storage error:", e);
  }

  if (await isKeywordCooldownActive()) {
    console.log("[poll] keyword cooldown active");
    return;
  }

  if (await isOver24hLimit()) {
    console.log("[poll] 24h rate limit");
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
    console.log("[poll] error:", e.message);
  }
}

// ============================================================
// ALARM LISTENERS
// ============================================================

chrome.alarms.create("pollQueue", { periodInMinutes: 1 });

chrome.alarms.onAlarm.addListener((alarm) => {
  console.log("[alarm] fired:", alarm.name);
  if (alarm.name === "pollQueue") {
    pollForQueuedSearches();
  } else if (alarm.name === ALARM_NAME) {
    processTick();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[init] onInstalled");
  chrome.alarms.create("pollQueue", { periodInMinutes: 1 });
  pollForQueuedSearches();
});

chrome.runtime.onStartup.addListener(() => {
  console.log("[init] onStartup");
  pollForQueuedSearches();
});

console.log("[init] background.js loaded, polling...");
pollForQueuedSearches();
