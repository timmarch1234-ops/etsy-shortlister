// ============================================================
// ETSY PRODUCT SHORTLISTER v4.0 — Stealth Edition
//
// Anti-detection features:
//   1. Gaussian-distributed delays + random "reading pauses"
//   2. Session limits: max 5 search pages, 40 listings per session
//      then 2+ hour cooldown. Resumes where it left off.
//   3. Tab reuse: single persistent tab, navigated like a human
//   4. Natural scrolling: variable speed, pauses, scroll-back
//   5. Smart filtering: only visit listings with card-level
//      demand signals (Bestseller, star count, Popular now)
//   6. Referrer chain: homepage → search → listing (never direct)
//   7. 24h rate limit: max 100 pages in any 24-hour window
//   8. Keyword cooldown: 30-60 min between different keywords
// ============================================================

const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";
const ALARM_NAME = "searchTick";

// Limits
const MAX_SEARCH_PAGES_PER_SESSION = 5;
const MAX_LISTINGS_PER_SESSION = 40;
const MAX_PAGES_PER_24H = 100;
const SESSION_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const KEYWORD_COOLDOWN_MS = 30 * 60 * 1000; // 30 min minimum between keywords

// ============================================================
// UTILITY
// ============================================================

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Gaussian random using Box-Muller transform
// Returns a value centered on `mean` with standard deviation `sd`
// Clamped to [min, max]
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

// Sleep with gaussian-distributed duration
function gaussSleep(meanMs, sdMs, minMs, maxMs) {
  return sleep(gaussRand(meanMs, sdMs, minMs, maxMs));
}

// ============================================================
// 24-HOUR RATE LIMITER
// ============================================================

async function recordPageLoad() {
  const data = await chrome.storage.local.get(["pageLoads24h"]);
  const loads = data.pageLoads24h || [];
  const now = Date.now();
  // Prune entries older than 24h
  const recent = loads.filter(t => (now - t) < 24 * 60 * 60 * 1000);
  recent.push(now);
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
// TAB MANAGEMENT — reuse a single tab
// ============================================================

let browseTabId = null;

async function getOrCreateBrowseTab() {
  // Try to reuse existing tab
  if (browseTabId) {
    try {
      const tab = await chrome.tabs.get(browseTabId);
      if (tab) return browseTabId;
    } catch (e) {}
  }
  // Create new tab
  const tab = await chrome.tabs.create({ url: "about:blank", active: true });
  browseTabId = tab.id;
  // Persist so we survive service worker restart
  await chrome.storage.local.set({ browseTabId: tab.id });
  return tab.id;
}

async function restoreBrowseTab() {
  const data = await chrome.storage.local.get(["browseTabId"]);
  if (data.browseTabId) {
    try {
      await chrome.tabs.get(data.browseTabId);
      browseTabId = data.browseTabId;
    } catch (e) {
      browseTabId = null;
      await chrome.storage.local.remove("browseTabId");
    }
  }
}

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Page load timeout"));
    }, 45000);
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

function waitForTab(tabId) {
  return navigateTab.__waitOnly ? navigateTab.__waitOnly(tabId) : null;
  // Fallback — just use navigateTab to navigate in-place
}

// ============================================================
// NATIVE MESSAGING — Real mouse control via pyautogui
// ============================================================

let nativePort = null;
let pendingResolve = null;

function connectNative() {
  if (nativePort) return true;
  try {
    nativePort = chrome.runtime.connectNative("com.etsy.shortlister");
    nativePort.onMessage.addListener((msg) => {
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve(msg);
      }
    });
    nativePort.onDisconnect.addListener(() => {
      nativePort = null;
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ ok: false, error: "disconnected" });
      }
    });
    return true;
  } catch (e) {
    nativePort = null;
    return false;
  }
}

function sendNative(command) {
  return new Promise((resolve) => {
    if (!nativePort) { resolve({ ok: false }); return; }
    pendingResolve = resolve;
    try {
      nativePort.postMessage(command);
    } catch (e) {
      pendingResolve = null;
      resolve({ ok: false, error: e.message });
      return;
    }
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        resolve({ ok: true, timeout: true });
      }
    }, 5000);
  });
}

// ============================================================
// NATURAL SCROLLING — varies speed, pauses, sometimes scrolls back
// ============================================================

async function scrollPageNaturally(tabId) {
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
          if (min !== undefined) val = Math.max(min, val);
          if (max !== undefined) val = Math.min(max, val);
          return Math.round(val);
        }

        const totalHeight = document.body.scrollHeight;
        let scrolled = 0;
        const stages = gr(8, 2, 5, 14);

        for (let i = 0; i < stages; i++) {
          // Variable scroll amount
          const amount = gr(350, 120, 100, 700);
          window.scrollBy(0, amount);
          scrolled += amount;

          // Variable pause — sometimes long "reading" pauses
          let pause;
          if (Math.random() < 0.15) {
            // "Reading" pause — studying a listing
            pause = gr(4000, 1500, 2000, 8000);
          } else {
            pause = gr(800, 400, 300, 2000);
          }
          await new Promise(r => setTimeout(r, pause));

          // 20% chance to scroll back up slightly
          if (Math.random() < 0.2 && scrolled > 300) {
            const backAmount = gr(150, 60, 50, 300);
            window.scrollBy(0, -backAmount);
            scrolled -= backAmount;
            await new Promise(r => setTimeout(r, gr(600, 200, 300, 1200)));
          }

          // Stop if we've reached the bottom
          if (scrolled >= totalHeight - window.innerHeight) break;
        }

        // Scroll back to top naturally (not instant)
        const currentY = window.scrollY;
        const jumpBackSteps = gr(4, 1, 2, 6);
        const perStep = currentY / jumpBackSteps;
        for (let i = 0; i < jumpBackSteps; i++) {
          window.scrollBy(0, -perStep);
          await new Promise(r => setTimeout(r, gr(200, 80, 80, 400)));
        }
        window.scrollTo(0, 0);
      },
    });
  } catch (e) {}
}

// Scroll a listing page — shorter, like actually reading the item
async function scrollListingNaturally(tabId) {
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
          if (min !== undefined) val = Math.max(min, val);
          if (max !== undefined) val = Math.min(max, val);
          return Math.round(val);
        }

        const stages = gr(5, 2, 3, 9);
        for (let i = 0; i < stages; i++) {
          window.scrollBy(0, gr(300, 100, 100, 500));

          let pause;
          if (Math.random() < 0.25) {
            // Longer pause — reading reviews, description
            pause = gr(3000, 1000, 1500, 6000);
          } else {
            pause = gr(700, 300, 300, 1500);
          }
          await new Promise(r => setTimeout(r, pause));

          // Sometimes scroll back up to re-check photos/price
          if (Math.random() < 0.15) {
            window.scrollBy(0, -gr(200, 80, 80, 400));
            await new Promise(r => setTimeout(r, gr(500, 200, 200, 1000)));
          }
        }
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
// SEARCH PAGE EXTRACTION — collect listings WITH card signals
//
// Only returns listings that already show demand indicators
// on the search card itself: Bestseller, Popular now, star
// ratings, "X bought", etc. Skips bland listings entirely.
// ============================================================

async function collectSignalListings(tabId) {
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

        // Walk up to find the listing card container
        let card = link.closest('[data-listing-id]') ||
                   link.closest('.v2-listing-card') ||
                   link.closest('.wt-grid__item-xs-6') ||
                   link.closest('[class*="listing"]');
        if (!card) {
          let el = link;
          for (let i = 0; i < 8; i++) {
            if (el.parentElement) el = el.parentElement;
            if (el.offsetHeight > 150 && el.offsetWidth > 100) {
              card = el;
              break;
            }
          }
        }
        if (!card) card = link.parentElement?.parentElement || link.parentElement;

        const cardText = (card?.innerText || "").toLowerCase();
        const cardHtml = (card?.innerHTML || "").toLowerCase();

        // Check for ANY demand signal on the card
        let hasSignal = false;
        let cardSignal = "";

        // "X bought in past 24 hours"
        const boughtMatch = cardText.match(
          /(\d+\+?)\s+(?:people\s+)?(?:bought|sold)/i
        );
        if (boughtMatch) { hasSignal = true; cardSignal = "bought_recently"; }

        // Bestseller badge
        if (!hasSignal && /bestseller/i.test(cardText)) {
          hasSignal = true; cardSignal = "bestseller";
        }

        // Popular now
        if (!hasSignal && /popular\s*now/i.test(cardText)) {
          hasSignal = true; cardSignal = "popular_now";
        }

        // "In demand"
        if (!hasSignal && /in\s+demand/i.test(cardText)) {
          hasSignal = true; cardSignal = "in_demand";
        }

        // High star rating with many reviews — e.g. "4.9 (12.6k)"
        if (!hasSignal) {
          const ratingMatch = cardText.match(/(4\.[5-9]|5\.0)\s*\((\d[\d,.k]*)\)/i);
          if (ratingMatch) {
            let reviewStr = ratingMatch[2].toLowerCase().replace(/,/g, "");
            let reviewCount = 0;
            if (reviewStr.includes("k")) {
              reviewCount = parseFloat(reviewStr) * 1000;
            } else {
              reviewCount = parseInt(reviewStr, 10);
            }
            // Only flag if 500+ reviews with 4.5+ stars
            if (reviewCount >= 500) {
              hasSignal = true;
              cardSignal = `${ratingMatch[1]}★ (${ratingMatch[2]} reviews)`;
            }
          }
        }

        // "Only X left"
        if (!hasSignal && /only\s+\d+\s+left/i.test(cardText)) {
          hasSignal = true; cardSignal = "low_stock";
        }

        // Star seller
        if (!hasSignal && /star\s*seller/i.test(cardText)) {
          // Star seller alone isn't enough — skip unless combined with other signals
        }

        if (!hasSignal) continue; // Skip this listing entirely

        // Get title + image from card
        const titleEl = card?.querySelector('h3, h2, [class*="title"]') || link;
        const title = titleEl?.textContent?.trim()?.substring(0, 120) || "";
        const img = card?.querySelector("img");
        const imageUrl = img?.src || "";

        listings.push({
          listingId: m[1],
          url: `https://www.etsy.com/listing/${m[1]}`,
          cardTitle: title,
          cardImage: imageUrl,
          cardSignal,
        });
      }

      return { listings, totalOnPage: seen.size };
    },
  });
  return results[0]?.result || { listings: [], totalOnPage: 0 };
}

// ============================================================
// LISTING PAGE EXTRACTION
// ============================================================

async function extractFromListingPage(tabId) {
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
        const shopMatch = shopLink.href.match(/\/shop\/([^/?]+)/);
        result.shop_name = shopMatch ? shopMatch[1] : "";
      }

      // ----- Demand signals -----

      const boughtMatch = text.match(
        /(\d+\+?)\s+(?:people\s+)?(?:bought|sold)\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s*hours/i
      );
      if (boughtMatch) {
        result.demand_signal = boughtMatch[0].trim();
        result.sold_count = boughtMatch[1];
      }

      if (!result.demand_signal && /in\s+demand/i.test(text)) {
        result.demand_signal = "In demand";
        const nearbyMatch = text.match(/in\s+demand[.\s]*(\d+)\+?\s+(?:people\s+)?bought/i);
        if (nearbyMatch) result.sold_count = nearbyMatch[1];
      }

      if (!result.demand_signal) {
        const basketMatch = text.match(
          /(\d+\+?)\s+people\s+have\s+this\s+in\s+their\s+(?:basket|cart)/i
        );
        if (basketMatch) {
          result.demand_signal = basketMatch[0].trim();
          result.sold_count = basketMatch[1];
        }
      }

      if (!result.demand_signal) {
        const inBasketMatch = text.match(/in\s+(\d+\+?)\s+(?:basket|cart)s?/i);
        if (inBasketMatch) {
          result.demand_signal = inBasketMatch[0].trim();
          result.sold_count = inBasketMatch[1];
        }
      }

      if (!result.demand_signal && /bestseller/i.test(text)) {
        result.demand_signal = "Bestseller";
      }

      if (!result.demand_signal && /popular\s+now/i.test(text)) {
        result.demand_signal = "Popular now";
      }

      if (!result.demand_signal) {
        const lowStock = text.match(/only\s+(\d+)\s+left/i);
        if (lowStock) {
          result.demand_signal = lowStock[0].trim();
          result.sold_count = lowStock[1];
        }
      }

      if (!result.sold_count) {
        const salesMatch = text.match(/([\d,]+)\s+sales?/i);
        if (salesMatch) {
          const salesNum = parseInt(salesMatch[1].replace(/,/g, ""), 10);
          if (salesNum >= 100) {
            result.sold_count = salesMatch[1];
            if (!result.demand_signal) {
              result.demand_signal = `${salesMatch[1]} sales`;
            }
          }
        }
      }

      return result;
    },
  });
  return results[0]?.result || null;
}

// ============================================================
// PROGRESS REPORTING
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
          log: ts.log.slice(-50),
        },
      }),
    });
  } catch (e) {}
}

function tsLog(ts, msg) {
  ts.log.push(msg);
  console.log("[shortlister]", msg);
}

async function sendToBackend(backendUrl, keyword, products) {
  try {
    const resp = await fetch(`${backendUrl}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, products }),
    });
    const data = await resp.json();
    console.log(`[shortlister] Sent ${data.count} products to backend.`);
  } catch (e) {
    console.log("[shortlister] Failed to send:", e.message);
  }
}

// ============================================================
// START A NEW SEARCH
// ============================================================

async function startAlarmSearch(keyword, searchId, backendUrl) {
  const tickState = {
    keyword,
    searchId,
    backendUrl,
    currentPage: 0,
    totalPages: MAX_SEARCH_PAGES_PER_SESSION,
    listingQueue: [],
    listingQueuePage: 0,
    matchingProducts: [],
    listingsChecked: 0,
    listingsVisitedThisSession: 0,
    productsFound: 0,
    log: [],
    status: "running",
    phase: "warmup", // warmup | searchPage | listing | cooldown
  };
  await chrome.storage.local.set({ tickState });
  await updateProgress(tickState);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.01 });
}

// ============================================================
// PROCESS ONE TICK
// ============================================================

async function processTick() {
  const data = await chrome.storage.local.get(["tickState", "backendUrl"]);
  let ts = data.tickState;
  if (!ts || ts.status !== "running") return;
  if (data.backendUrl) ts.backendUrl = data.backendUrl;

  const backendUrl = ts.backendUrl || DEFAULT_BACKEND;

  try {
    // ---- Rate limit check ----
    if (await isOver24hLimit()) {
      tsLog(ts, `Rate limit: ${MAX_PAGES_PER_24H} pages loaded in 24h. Pausing for 2 hours.`);
      ts.status = "rate_limited";
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);
      // Schedule resume in 2 hours
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: 120 });
      return;
    }

    // ---- Session listing limit check ----
    if ((ts.listingsVisitedThisSession || 0) >= MAX_LISTINGS_PER_SESSION && ts.phase === "listing") {
      tsLog(ts, `Session limit: visited ${MAX_LISTINGS_PER_SESSION} listings. Cooling down for 2+ hours.`);
      ts.phase = "cooldown";
      ts.status = "cooldown";
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);
      const cooldown = SESSION_COOLDOWN_MS + gaussRand(10 * 60000, 5 * 60000, 0, 30 * 60000);
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: cooldown / 60000 });
      return;
    }

    // ---- Restore from rate_limited or cooldown ----
    if (ts.status === "rate_limited" || ts.status === "cooldown") {
      if (await isOver24hLimit()) {
        // Still rate limited, keep waiting
        chrome.alarms.create(ALARM_NAME, { delayInMinutes: 30 });
        return;
      }
      tsLog(ts, "Resuming after cooldown...");
      ts.status = "running";
      ts.listingsVisitedThisSession = 0;
      // Continue from where we left off
    }

    // ---- Restore browse tab ----
    await restoreBrowseTab();

    // ==== PHASE: WARMUP ====
    if (ts.phase === "warmup") {
      tsLog(ts, "Warming up — visiting Etsy homepage...");
      const tabId = await getOrCreateBrowseTab();
      try {
        await navigateTab(tabId, "https://www.etsy.com");
      } catch (e) {
        tsLog(ts, "Homepage load issue: " + e.message);
      }
      await recordPageLoad();

      // Browse the homepage naturally
      await gaussSleep(3000, 1000, 2000, 5000);
      await scrollPageNaturally(tabId);
      await gaussSleep(2000, 800, 1000, 4000);

      ts.phase = "searchPage";
      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);

      // Short delay then load first search page
      const delay = gaussRand(8000, 3000, 4000, 15000);
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: delay / 60000 });
      tsLog(ts, `First search page in ${Math.round(delay / 1000)}s...`);
      await chrome.storage.local.set({ tickState: ts });
      return;
    }

    // ==== PHASE: LISTING — visit one listing from the queue ====
    if (ts.phase === "listing" && ts.listingQueue && ts.listingQueue.length > 0) {
      const listing = ts.listingQueue.shift();
      ts.listingsChecked++;
      ts.listingsVisitedThisSession = (ts.listingsVisitedThisSession || 0) + 1;

      tsLog(ts, `Visiting listing ${listing.listingId} [${listing.cardSignal}] (${ts.listingQueue.length} left)...`);

      const tabId = await getOrCreateBrowseTab();

      // Navigate from current page (preserves referrer chain)
      try {
        await navigateTab(tabId, listing.url);
      } catch (e) {
        tsLog(ts, `Listing ${listing.listingId}: load timeout, skipping.`);
        await chrome.storage.local.set({ tickState: ts });
        if (ts.listingQueue.length > 0) {
          scheduleNextListingTick(ts);
        } else {
          ts.phase = "searchPage";
          scheduleNextSearchPageTick(ts);
        }
        return;
      }
      await recordPageLoad();

      // Initial viewing pause (looking at photos)
      await gaussSleep(2500, 800, 1500, 4000);

      // Captcha check
      if (await hasCaptcha(tabId)) {
        tsLog(ts, "Access restricted! Pausing search.");
        ts.status = "error";
        ts.listingQueue.unshift(listing);
        await chrome.storage.local.set({ tickState: ts });
        await updateProgress(ts);
        return;
      }

      // Scroll through the listing naturally
      await scrollListingNaturally(tabId);

      // Random "reading pause" — 10% chance of a long one (30-60s)
      if (Math.random() < 0.10) {
        const longPause = gaussRand(45000, 10000, 30000, 60000);
        tsLog(ts, `Taking a closer look (${Math.round(longPause / 1000)}s)...`);
        await sleep(longPause);
      } else {
        await gaussSleep(1500, 600, 500, 3000);
      }

      // Extract demand signals
      let listingData = null;
      try {
        listingData = await extractFromListingPage(tabId);
      } catch (e) {
        tsLog(ts, `Listing ${listing.listingId}: extract failed — ${e.message}`);
      }

      // Don't close the tab — we reuse it! Just leave it on this page.

      if (listingData && listingData.demand_signal) {
        ts.productsFound++;
        const product = {
          title: listingData.title || listing.cardTitle || "",
          url: listing.url,
          image_url: listingData.image_url || listing.cardImage || "",
          sold_count: listingData.demand_signal,
          price: listingData.price || "",
          shop_name: listingData.shop_name || "",
        };
        ts.matchingProducts.push(product);
        tsLog(ts, `✓ FOUND: ${listingData.demand_signal} — ${product.title.substring(0, 60)}`);
      } else {
        tsLog(ts, `  No demand signal on listing ${listing.listingId}`);
      }

      // Flush matches every 5
      if (ts.matchingProducts.length >= 5) {
        await sendToBackend(backendUrl, ts.keyword, ts.matchingProducts.splice(0));
      }

      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);

      if (ts.listingQueue.length > 0) {
        scheduleNextListingTick(ts);
      } else {
        tsLog(ts, `Finished listings for search page ${ts.listingQueuePage}.`);
        ts.phase = "searchPage";
        scheduleNextSearchPageTick(ts);
      }
      return;
    }

    // ==== PHASE: SEARCH PAGE — load next search results page ====
    if (ts.phase === "searchPage" || ts.phase === "listing") {
      ts.currentPage++;
      if (ts.currentPage > ts.totalPages) {
        // Session complete
        ts.status = "completed";
        tsLog(ts, `Session done! Checked ${ts.listingsChecked} listings, found ${ts.productsFound} with demand signals.`);
        if (ts.matchingProducts.length > 0) {
          await sendToBackend(backendUrl, ts.keyword, ts.matchingProducts);
          ts.matchingProducts = [];
        }
        await setLastKeywordFinishTime();
        await chrome.storage.local.set({ tickState: ts });
        await updateProgress(ts);
        // Clean up browse tab
        if (browseTabId) {
          try { await chrome.tabs.remove(browseTabId); } catch (e) {}
          browseTabId = null;
          await chrome.storage.local.remove("browseTabId");
        }
        return;
      }

      tsLog(ts, `Loading search page ${ts.currentPage} of ${ts.totalPages}...`);
      await updateProgress(ts);

      const tabId = await getOrCreateBrowseTab();

      // Navigate to search (referrer = previous page in same tab)
      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(ts.keyword)}&ref=search_bar&page=${ts.currentPage}`;
      try {
        await navigateTab(tabId, searchUrl);
      } catch (e) {
        tsLog(ts, `Search page ${ts.currentPage}: load timeout, skipping.`);
        await chrome.storage.local.set({ tickState: ts });
        scheduleNextSearchPageTick(ts);
        return;
      }
      await recordPageLoad();
      await gaussSleep(2500, 800, 1500, 4000);

      // Captcha check
      if (await hasCaptcha(tabId)) {
        tsLog(ts, "Access restricted! Pausing search.");
        ts.status = "error";
        ts.currentPage--; // Retry this page later
        await chrome.storage.local.set({ tickState: ts });
        await updateProgress(ts);
        return;
      }

      // Scroll through naturally (loads lazy content too)
      await scrollPageNaturally(tabId);
      await gaussSleep(1500, 500, 800, 3000);

      // Collect only listings with visible demand signals
      let pageData = { listings: [], totalOnPage: 0 };
      try {
        pageData = await collectSignalListings(tabId);
      } catch (e) {
        tsLog(ts, `Search page ${ts.currentPage}: collect failed — ${e.message}`);
      }

      // Shuffle and limit — don't visit more than needed
      const maxThisBatch = Math.min(
        pageData.listings.length,
        MAX_LISTINGS_PER_SESSION - (ts.listingsVisitedThisSession || 0)
      );
      const shuffled = pageData.listings.sort(() => Math.random() - 0.5);
      ts.listingQueue = shuffled.slice(0, maxThisBatch);
      ts.listingQueuePage = ts.currentPage;

      tsLog(ts, `Search page ${ts.currentPage}: ${pageData.totalOnPage} total listings, ${pageData.listings.length} with signals, visiting ${ts.listingQueue.length}.`);

      await chrome.storage.local.set({ tickState: ts });
      await updateProgress(ts);

      if (ts.listingQueue.length > 0) {
        ts.phase = "listing";
        await chrome.storage.local.set({ tickState: ts });
        // Navigate back to the search page first (to have a natural referrer)
        // The tab is already on the search page — that's the referrer for listings
        scheduleNextListingTick(ts);
      } else {
        // No signal listings on this page — move to next search page
        tsLog(ts, "No signal listings on this page, moving on...");
        scheduleNextSearchPageTick(ts);
      }
      return;
    }

  } catch (e) {
    console.error("[shortlister] tick error:", e);
    tsLog(ts, `Tick error: ${e.message}`);
    await chrome.storage.local.set({ tickState: ts });
    chrome.alarms.create(ALARM_NAME, { delayInMinutes: 0.5 });
  }
}

// ============================================================
// SCHEDULING — gaussian delays
// ============================================================

function scheduleNextListingTick(ts) {
  // 10-20s with gaussian distribution centered on 15s
  const delayMs = gaussRand(15000, 3000, 10000, 25000);
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: delayMs / 60000 });
  tsLog(ts, `Next listing in ${Math.round(delayMs / 1000)}s...`);
  chrome.storage.local.set({ tickState: ts });
}

function scheduleNextSearchPageTick(ts) {
  // 25-50s with gaussian distribution, extra break every few pages
  const baseDelay = gaussRand(35000, 8000, 25000, 50000);
  const extraMs = (ts.currentPage % 3 === 0) ? gaussRand(30000, 10000, 20000, 50000) : 0;
  const totalMs = baseDelay + extraMs;
  chrome.alarms.create(ALARM_NAME, { delayInMinutes: totalMs / 60000 });
  tsLog(ts, `Next search page in ${Math.round(totalMs / 1000)}s...`);
  chrome.storage.local.set({ tickState: ts });
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
    })();
    sendResponse({ ok: true });
  } else if (msg.type === "getState") {
    (async () => {
      const data = await chrome.storage.local.get(["tickState"]);
      sendResponse({ state: data.tickState || null });
    })();
    return true; // async sendResponse
  }
  return true;
});

// ============================================================
// QUEUE POLLING
// ============================================================

async function pollForQueuedSearches() {
  console.log("[poll] pollForQueuedSearches called");
  let backendUrl = DEFAULT_BACKEND;
  try {
    const data = await chrome.storage.local.get(["backendUrl", "tickState"]);
    if (data.backendUrl) backendUrl = data.backendUrl;

    // If a search is active (running/cooldown/rate_limited), don't start another
    if (data.tickState && ["running", "cooldown", "rate_limited"].includes(data.tickState.status)) {
      console.log("[poll] search active:", data.tickState.status);
      return;
    }

    // Clear completed/errored state
    if (data.tickState) {
      console.log("[poll] clearing old tickState:", data.tickState.status);
      await chrome.storage.local.remove("tickState");
    }
  } catch (e) {
    console.log("[poll] storage error:", e);
  }

  // Check keyword cooldown
  if (await isKeywordCooldownActive()) {
    const last = await getLastKeywordFinishTime();
    const remaining = Math.round((KEYWORD_COOLDOWN_MS - (Date.now() - last)) / 60000);
    console.log(`[poll] keyword cooldown active, ${remaining} min remaining`);
    return;
  }

  // Check 24h rate limit
  if (await isOver24hLimit()) {
    console.log("[poll] 24h rate limit reached, skipping");
    return;
  }

  try {
    console.log("[poll] Fetching pending from", backendUrl);
    const resp = await fetch(`${backendUrl}/api/queue/pending`);
    const pending = await resp.json();
    console.log("[poll] Pending searches:", pending.length);
    if (pending.length > 0) {
      const search = pending[0];
      console.log("[poll] Claiming search:", search.search_id, search.keyword);
      await fetch(`${backendUrl}/api/queue/${search.search_id}/claim`, { method: "POST" });
      await startAlarmSearch(search.keyword, search.search_id, backendUrl);
      console.log("[poll] Search started!");
    }
  } catch (e) {
    console.log("[poll] fetch error:", e);
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

// Boot immediately
pollForQueuedSearches();
