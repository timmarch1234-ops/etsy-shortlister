// ============================================================
// ETSY PRODUCT SHORTLISTER v7.0
//
// Proven architecture: ONE tab, alarm-per-tick, sequential.
// v3.0 ran 4 hours overnight without captcha — this is that
// architecture optimized for speed.
//
// Each alarm tick processes 5 listings sequentially in the
// SAME tab: nav→extract→nav→extract→nav→extract→nav→extract→nav→extract
// All Chrome API calls (tabs.update + scripting.executeScript),
// no setTimeout. Service worker stays alive.
//
// Timing:
//   Each tick: 5 listings × ~2s = ~10s active work
//   Alarm gap: ~30s (Chrome minimum for unpacked)
//   Per search page: ~70 listings ÷ 5 = 14 ticks × 30s = ~7 min
//   Total: warmup + 20 pages × 7 min = ~23 min  ✓
//
// Phases (stored in tickState.phase):
//   warmup  → visit homepage, schedule next tick
//   search  → load search page, collect URLs into queue
//   batch   → visit next 5 listings from queue, extract
//             (repeats until queue empty, then → search)
// ============================================================

const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";
const ALARM_NAME = "searchTick";
const TOTAL_SEARCH_PAGES = 20;
const BATCH_SIZE = 5; // listings per tick

// ============================================================
// TAB — single reused tab, stored in chrome.storage
// ============================================================

async function getTab() {
  const data = await chrome.storage.local.get(["tabId"]);
  if (data.tabId) {
    try {
      const tab = await chrome.tabs.get(data.tabId);
      if (tab) return data.tabId;
    } catch (e) {}
  }
  // Create fresh tab
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  await chrome.storage.local.set({ tabId: tab.id });
  console.log("[tab] created:", tab.id);
  return tab.id;
}

// Navigate and wait for complete. Returns true/false.
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
// CAPTCHA CHECK
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
// SCROLL (sync, no setTimeout)
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
// COLLECT ALL LISTING URLS from search page
// ============================================================

async function collectListings(tabId) {
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

          const titleEl = card?.querySelector('h3, h2, [class*="title"]') || link;
          const img = card?.querySelector("img");

          out.push({
            id: m[1],
            url: `https://www.etsy.com/listing/${m[1]}`,
            title: titleEl?.textContent?.trim()?.substring(0, 120) || "",
            img: img?.src || "",
          });
        }
        return out;
      },
    });
    return r[0]?.result || [];
  } catch (e) {
    console.log("[collect] err:", e.message);
    return [];
  }
}

// ============================================================
// EXTRACT DEMAND SIGNALS from one listing page
// ============================================================

async function extractListing(tabId) {
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const t = document.body?.innerText || "";
        const o = { title: "", price: "", sold_count: null, demand_signal: null, image_url: "", shop_name: "" };

        o.title = document.querySelector('meta[property="og:title"]')?.content ||
                  document.querySelector('h1')?.textContent?.trim() || "";
        o.image_url = document.querySelector('meta[property="og:image"]')?.content || "";

        const p = document.querySelector('[data-buy-box-listing-price]') ||
                  document.querySelector('[class*="price"]');
        if (p) o.price = p.textContent?.trim() || "";

        const sl = document.querySelector('a[href*="/shop/"]');
        if (sl) { const m = sl.href.match(/\/shop\/([^/?]+)/); o.shop_name = m ? m[1] : ""; }

        // Demand signals
        let m;
        m = t.match(/(\d+\+?)\s+(?:people\s+)?(?:bought|sold)\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s*hours/i);
        if (m) { o.demand_signal = m[0].trim(); o.sold_count = m[1]; return o; }

        if (/in\s+demand/i.test(t)) {
          o.demand_signal = "In demand";
          m = t.match(/in\s+demand[.\s]*(\d+)\+?\s+(?:people\s+)?bought/i);
          if (m) o.sold_count = m[1];
          return o;
        }

        m = t.match(/(\d+\+?)\s+people\s+have\s+this\s+in\s+their\s+(?:basket|cart)/i);
        if (m) { o.demand_signal = m[0].trim(); o.sold_count = m[1]; return o; }

        m = t.match(/in\s+(\d+\+?)\s+(?:basket|cart)s?/i);
        if (m) { o.demand_signal = m[0].trim(); o.sold_count = m[1]; return o; }

        if (/bestseller/i.test(t)) { o.demand_signal = "Bestseller"; return o; }
        if (/popular\s+now/i.test(t)) { o.demand_signal = "Popular now"; return o; }

        m = t.match(/only\s+(\d+)\s+left/i);
        if (m) { o.demand_signal = m[0].trim(); o.sold_count = m[1]; return o; }

        m = t.match(/([\d,]+)\s+sales?/i);
        if (m) {
          const n = parseInt(m[1].replace(/,/g, ""), 10);
          if (n >= 100) { o.sold_count = m[1]; o.demand_signal = `${m[1]} sales`; }
        }
        return o;
      },
    });
    return r[0]?.result || null;
  } catch (e) { return null; }
}

// ============================================================
// LOGGING + PROGRESS
// ============================================================

function tsLog(ts, msg) {
  ts.log.push(msg);
  console.log("[s]", msg);
}

async function reportProgress(ts) {
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

async function sendProducts(ts) {
  if (ts.matchingProducts.length === 0) return;
  const batch = ts.matchingProducts.splice(0);
  try {
    await fetch(`${ts.backendUrl || DEFAULT_BACKEND}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword: ts.keyword, products: batch }),
    });
    console.log("[send] sent", batch.length);
  } catch (e) {
    console.log("[send] FAIL:", e.message);
    ts.matchingProducts.push(...batch);
  }
}

async function save(ts) {
  await chrome.storage.local.set({ tickState: ts });
}

// ============================================================
// PROCESS TICK
//
// warmup: visit homepage → schedule next
// search: load search page, collect URLs → schedule next
// batch:  visit next 5 listings sequentially in same tab → schedule next
// ============================================================

async function processTick() {
  console.log("[tick] =====");

  let ts;
  try {
    const data = await chrome.storage.local.get(["tickState"]);
    ts = data.tickState;
    if (!ts) { console.log("[tick] no state"); return; }
    if (ts.status !== "running") { console.log("[tick] status:", ts.status); return; }
  } catch (e) { console.error("[tick] storage err:", e); return; }

  try {
    const tabId = await getTab();
    console.log(`[tick] phase=${ts.phase} page=${ts.currentPage}/${ts.totalPages} q=${(ts.queue || []).length} tab=${tabId}`);

    // ==== WARMUP ====
    if (ts.phase === "warmup") {
      console.log("[tick] WARMUP");
      tsLog(ts, "Visiting Etsy homepage...");
      await navTab(tabId, "https://www.etsy.com");
      // A few chrome API calls as brief pause
      for (let i = 0; i < 200; i++) await chrome.storage.local.get(["_kl"]);

      ts.phase = "search";
      ts.currentPage = 0;
      await save(ts);
      await reportProgress(ts);
      console.log("[tick] warmup done");
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
      return;
    }

    // ==== BATCH — visit next 5 listings from queue ====
    if (ts.phase === "batch" && ts.queue && ts.queue.length > 0) {
      const batch = ts.queue.splice(0, BATCH_SIZE);
      console.log(`[tick] BATCH: ${batch.length} listings (${ts.queue.length} left)`);

      for (const listing of batch) {
        // Navigate same tab to listing
        const ok = await navTab(tabId, listing.url);
        if (!ok) { console.log("[tick] nav failed:", listing.id); ts.listingsChecked++; continue; }

        // Captcha?
        if (await isCaptcha(tabId)) {
          console.log("[tick] CAPTCHA!");
          tsLog(ts, "CAPTCHA detected. Stopping.");
          ts.queue.unshift(listing); // put it back
          ts.status = "error";
          await save(ts);
          await reportProgress(ts);
          return;
        }

        // Extract immediately — no scrolling needed
        const data = await extractListing(tabId);
        ts.listingsChecked++;

        if (data && data.demand_signal) {
          ts.productsFound++;
          ts.matchingProducts.push({
            title: data.title || listing.title || "",
            url: listing.url,
            image_url: data.image_url || listing.img || "",
            sold_count: data.demand_signal,
            price: data.price || "",
            shop_name: data.shop_name || "",
          });
          console.log(`[tick] ✓ ${data.demand_signal} — ${(data.title || "").substring(0, 50)}`);
          tsLog(ts, `✓ ${data.demand_signal} — ${(data.title || listing.title || "").substring(0, 50)}`);
        }
      }

      // Send products to backend
      if (ts.matchingProducts.length >= 5) {
        await sendProducts(ts);
      }

      await save(ts);

      // More in queue?
      if (ts.queue.length > 0) {
        console.log(`[tick] ${ts.queue.length} left in queue`);
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
      } else {
        // Queue exhausted — done with this search page
        tsLog(ts, `Page ${ts.currentPage} done. ${ts.listingsChecked} checked, ${ts.productsFound} found.`);
        await reportProgress(ts);
        ts.phase = "search";
        await save(ts);
        console.log("[tick] queue empty, next search page");
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
      }
      return;
    }

    // ==== SEARCH — load next search page, collect listings ====
    if (ts.phase === "search") {
      ts.currentPage++;

      // All done?
      if (ts.currentPage > ts.totalPages) {
        console.log("[tick] ALL DONE");
        ts.status = "completed";
        tsLog(ts, `Done! ${ts.listingsChecked} checked, ${ts.productsFound} with demand signals.`);
        await sendProducts(ts);
        await save(ts);
        await reportProgress(ts);
        // Clean up tab
        try { await chrome.tabs.remove(tabId); } catch (e) {}
        await chrome.storage.local.remove("tabId");
        return;
      }

      console.log(`[tick] SEARCH page ${ts.currentPage}`);
      tsLog(ts, `Loading search page ${ts.currentPage}/${ts.totalPages}...`);

      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(ts.keyword)}&ref=search_bar&page=${ts.currentPage}`;
      const ok = await navTab(tabId, searchUrl);
      if (!ok) {
        console.log("[tick] search page load failed");
        tsLog(ts, `Page ${ts.currentPage}: load failed, skipping.`);
        await save(ts);
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
        return;
      }

      // Brief pause via chrome API calls
      for (let i = 0; i < 100; i++) await chrome.storage.local.get(["_kl"]);

      // Captcha?
      if (await isCaptcha(tabId)) {
        console.log("[tick] CAPTCHA on search page!");
        tsLog(ts, "CAPTCHA on search page. Stopping.");
        ts.currentPage--;
        ts.status = "error";
        await save(ts);
        await reportProgress(ts);
        return;
      }

      // Scroll to load lazy content
      await scrollPage(tabId);
      for (let i = 0; i < 50; i++) await chrome.storage.local.get(["_kl"]);

      // Collect listings
      const listings = await collectListings(tabId);
      console.log(`[tick] collected ${listings.length} listings`);

      if (listings.length === 0) {
        tsLog(ts, `Page ${ts.currentPage}: no listings.`);
        await save(ts);
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
        return;
      }

      // Shuffle for natural browsing
      for (let i = listings.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [listings[i], listings[j]] = [listings[j], listings[i]];
      }

      ts.queue = listings;
      ts.phase = "batch";
      tsLog(ts, `Page ${ts.currentPage}: ${listings.length} listings queued.`);
      await save(ts);
      await reportProgress(ts);

      // Schedule first batch
      console.log("[tick] listings queued, scheduling first batch");
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });
      return;
    }

    // Unknown phase
    console.log("[tick] unknown phase:", ts.phase);
    ts.phase = "search";
    await save(ts);
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.1 });

  } catch (e) {
    console.error("[tick] CRASH:", e.message, e.stack);
    if (ts) {
      tsLog(ts, `Error: ${e.message}`);
      ts.status = "error";
      await save(ts);
      await reportProgress(ts);
    }
  }
}

// ============================================================
// START SEARCH
// ============================================================

async function startAlarmSearch(keyword, searchId, backendUrl) {
  console.log(`[start] "${keyword}" id=${searchId}`);

  // Clean stale tab
  const old = await chrome.storage.local.get(["tabId"]);
  if (old.tabId) {
    try { await chrome.tabs.remove(old.tabId); } catch (e) {}
    await chrome.storage.local.remove("tabId");
  }

  const tickState = {
    keyword, searchId, backendUrl,
    currentPage: 0,
    totalPages: TOTAL_SEARCH_PAGES,
    queue: [],
    matchingProducts: [],
    listingsChecked: 0,
    productsFound: 0,
    log: [],
    status: "running",
    phase: "warmup",
  };
  await save(tickState);
  await reportProgress(tickState);

  // Run first tick inline (warmup)
  console.log("[start] running warmup inline");
  await processTick();
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
      if (d.tickState) { d.tickState.status = "cancelled"; await save(d.tickState); await reportProgress(d.tickState); }
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
      console.log("[poll] active:", d.tickState.phase, "p:", d.tickState.currentPage, "q:", (d.tickState.queue || []).length);
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
  } catch (e) { console.log("[poll] err:", e.message); }
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
chrome.runtime.onStartup.addListener(() => pollForQueuedSearches());

console.log("[init] v7.0 loaded");
pollForQueuedSearches();
