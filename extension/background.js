// ============================================================
// ETSY PRODUCT SHORTLISTER v5.2
//
// One alarm tick = one ENTIRE search page (all listings).
// Service worker stays alive via continuous Chrome API calls.
// NO setTimeout/sleep — uses chrome.storage.local.get loops
// for micro-delays between batches (keeps worker alive).
//
// 20 pages × ~1 min between-page alarm delay = ~20 min idle
// Each page: ~70 listings in ~30s of active Chrome API work
// Total: ~30 min.  ✓
// ============================================================

const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";
const ALARM_NAME = "searchTick";

const TOTAL_SEARCH_PAGES = 20;
const PARALLEL_TABS = 4;
const MAX_PAGES_PER_24H = 2000;
const KEYWORD_COOLDOWN_MS = 30 * 60 * 1000;

// ============================================================
// UTILITY — no setTimeout anywhere
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

// Active wait using chrome.storage.local.get — keeps service worker alive
// Each iteration is ~1-3ms of real Chrome API work
async function activeWait(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await chrome.storage.local.get(["_keepalive"]);
  }
}

// Slightly less aggressive: do N chrome API calls with small gaps
// Roughly 50-100ms per call cycle, so 10 calls ≈ 500ms-1s
async function activeWaitLight(targetMs) {
  const iterations = Math.max(1, Math.round(targetMs / 100));
  for (let i = 0; i < iterations; i++) {
    await chrome.storage.local.get(["_keepalive"]);
  }
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
  return (data.pageLoads24h || []).filter(t => (Date.now() - t) < 86400000).length >= MAX_PAGES_PER_24H;
}

// ============================================================
// KEYWORD COOLDOWN
// ============================================================

async function isKeywordCooldownActive() {
  const data = await chrome.storage.local.get(["lastKeywordFinished"]);
  return (Date.now() - (data.lastKeywordFinished || 0)) < KEYWORD_COOLDOWN_MS;
}

// ============================================================
// TAB MANAGEMENT
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
    ids.push(await getOrCreateTab(`listingTab_${i}`));
  }
  return ids;
}

async function cleanupAllTabs() {
  const keys = ["browseTabId"];
  for (let i = 0; i < PARALLEL_TABS; i++) keys.push(`listingTab_${i}`);
  const data = await chrome.storage.local.get(keys);
  for (const key of keys) {
    if (data[key]) {
      try { await chrome.tabs.remove(data[key]); } catch (e) {}
    }
  }
  await chrome.storage.local.remove(keys);
}

function navigateTab(tabId, url) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      console.log(`[nav] timeout tab ${tabId}`);
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
        const body = document.body?.innerText || "";
        const iframes = document.querySelectorAll("iframe");
        const divs = document.querySelectorAll("div");
        if (divs.length < 5 && iframes.length > 0 && (document.title || "").length < 20) return true;
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
// SCROLL SEARCH PAGE (triggers lazy loading)
// Uses chrome.scripting.executeScript — active Chrome API call
// ============================================================

async function scrollSearchPage(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const totalH = document.body.scrollHeight;
        const chunks = 6;
        const chunkSize = totalH / chunks;
        // Synchronous scroll — no setTimeout needed inside
        for (let i = 0; i < chunks; i++) {
          window.scrollBy(0, chunkSize);
        }
        window.scrollTo(0, 0);
      },
    });
  } catch (e) {}
}

// ============================================================
// COLLECT ALL LISTING URLS
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
    console.log("[collect] error:", e.message);
    return [];
  }
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
        const r = { title: "", price: "", sold_count: null, demand_signal: null, image_url: "", shop_name: "" };

        const ogT = document.querySelector('meta[property="og:title"]');
        r.title = ogT?.content || document.querySelector('h1')?.textContent?.trim() || "";
        const ogI = document.querySelector('meta[property="og:image"]');
        r.image_url = ogI?.content || "";
        const priceEl = document.querySelector('[data-buy-box-listing-price]') ||
                        document.querySelector('[class*="price"]') ||
                        document.querySelector('p[class*="Price"]');
        if (priceEl) r.price = priceEl.textContent?.trim() || "";
        const shopLink = document.querySelector('a[href*="/shop/"]');
        if (shopLink) { const m = shopLink.href.match(/\/shop\/([^/?]+)/); r.shop_name = m ? m[1] : ""; }

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
            if (n >= 100) { r.sold_count = sm[1]; if (!r.demand_signal) r.demand_signal = `${sm[1]} sales`; }
          }
        }
        return r;
      },
    });
    return results[0]?.result || null;
  } catch (e) { return null; }
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
  try {
    await fetch(`${(ts.backendUrl || DEFAULT_BACKEND)}/api/queue/${ts.searchId}/progress`, {
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
  const toSend = ts.matchingProducts.splice(0);
  console.log(`[flush] sending ${toSend.length} products`);
  try {
    const resp = await fetch(`${(ts.backendUrl || DEFAULT_BACKEND)}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: ts.keyword, products: toSend }),
    });
    const data = await resp.json();
    console.log(`[flush] OK: ${data.count}`);
  } catch (e) {
    console.log("[flush] FAILED:", e.message);
    ts.matchingProducts.push(...toSend);
  }
}

// ============================================================
// PROCESS ONE ENTIRE SEARCH PAGE (all listings) in one tick
//
// This is the core function. It runs ~30-60s of CONTINUOUS
// Chrome API calls (no setTimeout) so the service worker
// stays alive the entire time.
//
// Flow:
//   1. Navigate browse tab to search URL
//   2. Scroll + collect all listing URLs
//   3. Loop: navigate 4 listing tabs in parallel → extract
//   4. Between batches: activeWaitLight() keeps worker alive
//   5. Flush products to backend
// ============================================================

async function processOneSearchPage(ts, pageNum) {
  const backendUrl = ts.backendUrl || DEFAULT_BACKEND;
  console.log(`[page] ====== PROCESSING PAGE ${pageNum}/${ts.totalPages} ======`);

  // --- 1. Load search page ---
  const browseTab = await getOrCreateTab("browseTabId");
  const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(ts.keyword)}&ref=search_bar&page=${pageNum}`;
  console.log(`[page] navigating browse tab ${browseTab} to search page`);

  const loaded = await navigateTab(browseTab, searchUrl);
  console.log(`[page] search page loaded: ${loaded}`);
  await recordPageLoads(1);

  // Active wait ~1.5s for page to settle (DOM rendering)
  await activeWaitLight(15);

  // Captcha check
  if (await hasCaptcha(browseTab)) {
    console.log("[page] CAPTCHA detected on search page!");
    tsLog(ts, `Page ${pageNum}: Access restricted! Pausing.`);
    ts.currentPage--; // retry later
    ts.status = "error";
    return false;
  }

  // --- 2. Scroll + collect listings ---
  await scrollSearchPage(browseTab);
  // Another brief active wait for lazy-loaded content
  await activeWaitLight(10);

  const allListings = await collectAllListings(browseTab);
  console.log(`[page] collected ${allListings.length} listings`);
  tsLog(ts, `Page ${pageNum}: ${allListings.length} listings found.`);

  if (allListings.length === 0) {
    tsLog(ts, `Page ${pageNum}: no listings (may be end of results).`);
    return true;
  }

  // Shuffle for natural browsing pattern
  for (let i = allListings.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [allListings[i], allListings[j]] = [allListings[j], allListings[i]];
  }

  // --- 3. Get listing tabs ---
  const listingTabs = await ensureListingTabs();
  console.log(`[page] listing tabs: [${listingTabs.join(", ")}]`);

  // --- 4. Process all listings in batches of PARALLEL_TABS ---
  let batchNum = 0;
  for (let i = 0; i < allListings.length; i += PARALLEL_TABS) {
    batchNum++;
    const batch = allListings.slice(i, i + PARALLEL_TABS);
    const tabs = listingTabs.slice(0, batch.length);

    console.log(`[page] batch ${batchNum}: ${batch.length} listings (${i + batch.length}/${allListings.length})`);

    // Navigate all tabs in parallel — active Chrome API calls
    const navResults = await Promise.all(
      batch.map((listing, idx) => navigateTab(tabs[idx], listing.url))
    );
    await recordPageLoads(batch.length);
    console.log(`[page] batch ${batchNum} loaded: [${navResults.join(", ")}]`);

    // Brief active wait for DOM rendering (~1s of Chrome API calls)
    await activeWaitLight(10);

    // Captcha check on first tab
    if (await hasCaptcha(tabs[0])) {
      console.log("[page] CAPTCHA on listing page!");
      tsLog(ts, "Access restricted on listing! Pausing.");
      ts.status = "error";
      return false;
    }

    // Extract from all tabs in parallel
    const extractions = await Promise.all(
      batch.map((listing, idx) =>
        extractFromListingPage(tabs[idx]).then(data => ({ listing, data }))
      )
    );

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
        console.log(`[page] ✓ ${data.demand_signal} — ${(data.title || "").substring(0, 50)}`);
        tsLog(ts, `✓ ${data.demand_signal} — ${(data.title || listing.cardTitle || "").substring(0, 50)}`);
      }
    }

    // Flush every 10 matches
    if (ts.matchingProducts.length >= 10) {
      await flushProducts(ts);
    }

    // Save state periodically
    if (batchNum % 5 === 0) {
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);
    }

    // Active wait between batches (~2-4s of Chrome API calls)
    // This replaces gaussSleep — keeps worker alive
    if (i + PARALLEL_TABS < allListings.length) {
      const waitCycles = gaussRand(25, 8, 15, 40);
      // 8% chance of a longer "reading" pause
      const extraCycles = (Math.random() < 0.08) ? gaussRand(80, 20, 50, 120) : 0;
      if (extraCycles > 0) {
        console.log(`[page] reading pause (~${Math.round((waitCycles + extraCycles) * 0.1)}s)`);
      }
      await activeWaitLight(waitCycles + extraCycles);
    }
  }

  // --- 5. Flush remaining products ---
  await flushProducts(ts);

  console.log(`[page] page ${pageNum} DONE: ${ts.listingsChecked} total checked, ${ts.productsFound} matches`);
  tsLog(ts, `Page ${pageNum} done. ${ts.listingsChecked} total checked, ${ts.productsFound} matches.`);

  return true;
}

// ============================================================
// MAIN TICK — one alarm = one search page fully processed
// ============================================================

async function processTick() {
  console.log("[tick] ===== processTick START =====");

  const data = await chrome.storage.local.get(["tickState", "backendUrl"]);
  const ts = data.tickState;

  if (!ts) { console.log("[tick] no tickState"); return; }
  if (ts.status !== "running") { console.log("[tick] status:", ts.status); return; }
  if (data.backendUrl) ts.backendUrl = data.backendUrl;

  try {
    if (await isOver24hLimit()) {
      tsLog(ts, "24h rate limit. Pausing 2 hours.");
      ts.status = "rate_limited";
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: 120 });
      return;
    }

    console.log(`[tick] phase=${ts.phase} page=${ts.currentPage}/${ts.totalPages}`);

    // ---- WARMUP ----
    if (ts.phase === "warmup") {
      console.log("[tick] WARMUP");
      tsLog(ts, "Warming up — visiting Etsy homepage...");

      const tabId = await getOrCreateTab("browseTabId");
      await navigateTab(tabId, "https://www.etsy.com");
      await recordPageLoads(1);

      // Active wait ~2s
      await activeWaitLight(20);

      ts.phase = "searchPage";
      ts.currentPage = 0;
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);

      console.log("[tick] warmup done, scheduling first search page");
      // Chrome will bump this to ~1 min minimum — that's fine
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.05 });
      return;
    }

    // ---- SEARCH PAGE (processes entire page including all listings) ----
    if (ts.phase === "searchPage") {
      ts.currentPage++;

      if (ts.currentPage > ts.totalPages) {
        // ALL DONE
        console.log("[tick] ALL DONE");
        ts.status = "completed";
        tsLog(ts, `Search complete! ${ts.listingsChecked} listings checked, ${ts.productsFound} with demand signals.`);
        await flushProducts(ts);
        await chrome.storage.local.set({ lastKeywordFinished: Date.now(), tickState: ts });
        await updateProgress(ts);
        await cleanupAllTabs();
        return;
      }

      // Process the entire page (search + all listings)
      const ok = await processOneSearchPage(ts, ts.currentPage);

      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);

      if (!ok) {
        // Error/captcha — status already set
        return;
      }

      // Schedule next search page
      // gaussRand for delay — Chrome bumps to ~1 min minimum, that's fine
      const delayMin = gaussRand(60, 15, 45, 90) / 60; // ~45-90 seconds
      // Every 5 pages, add extra delay
      const extraMin = (ts.currentPage % 5 === 0) ? gaussRand(30, 10, 15, 60) / 60 : 0;
      const totalMin = delayMin + extraMin;

      console.log(`[tick] page ${ts.currentPage} complete. Next page in ~${Math.round(totalMin * 60)}s`);
      tsLog(ts, `Next page in ~${Math.round(totalMin * 60)}s...`);
      await chrome.storage.local.set({ tickState: ts });

      chrome.alarms.create(ALARM_NAME, { delayInMinutes: totalMin });
      return;
    }

    // Unknown phase
    console.log("[tick] unknown phase:", ts.phase);
    ts.phase = "searchPage";
    await chrome.storage.local.set({ tickState: ts });
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.05 });

  } catch (e) {
    console.error("[tick] UNCAUGHT ERROR:", e.message);
    console.error("[tick] stack:", e.stack);
    if (ts) {
      tsLog(ts, `Error: ${e.message}`);
      await chrome.storage.local.set({ tickState: ts });
    }
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5 });
  }
}

// ============================================================
// START SEARCH
// ============================================================

async function startAlarmSearch(keyword, searchId, backendUrl) {
  console.log(`[start] keyword="${keyword}" id=${searchId}`);
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
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.017 });
}

// ============================================================
// MESSAGE HANDLERS
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  console.log("[msg]", msg.type);
  if (msg.type === "startSearch") {
    startAlarmSearch(msg.keyword, null, msg.backendUrl || DEFAULT_BACKEND);
    sendResponse({ ok: true });
  } else if (msg.type === "cancelSearch") {
    (async () => {
      const d = await chrome.storage.local.get(["tickState"]);
      if (d.tickState) {
        d.tickState.status = "cancelled";
        await chrome.storage.local.set({ tickState: d.tickState });
        await updateProgress(d.tickState);
      }
      chrome.alarms.clear(ALARM_NAME);
      await cleanupAllTabs();
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
    if (d.tickState && ["running", "rate_limited"].includes(d.tickState.status)) {
      console.log("[poll] active:", d.tickState.status, "phase:", d.tickState.phase, "page:", d.tickState.currentPage);
      return;
    }
    if (d.tickState) {
      console.log("[poll] clearing old:", d.tickState.status);
      await chrome.storage.local.remove("tickState");
    }
  } catch (e) {}

  if (await isKeywordCooldownActive()) { console.log("[poll] keyword cooldown"); return; }
  if (await isOver24hLimit()) { console.log("[poll] 24h limit"); return; }

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

chrome.runtime.onStartup.addListener(() => {
  console.log("[init] startup");
  pollForQueuedSearches();
});

console.log("[init] loaded");
pollForQueuedSearches();
