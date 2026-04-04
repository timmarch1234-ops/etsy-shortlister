const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";

let state = null;
let searchTabId = null;
let lastMouseX = 400;
let lastMouseY = 300;

function defaultState(keyword, totalPages) {
  return {
    status: "running",
    keyword,
    currentPage: 0,
    totalPages: totalPages || 20,
    productsFound: 0,
    listingsChecked: 0,
    log: [],
    cancelled: false,
  };
}

function log(msg) {
  if (!state) return;
  console.log(`[shortlister] ${msg}`);
  state.log.push(msg);
  saveState();
  broadcast();
}

function saveState() {
  chrome.storage.local.set({ searchState: state });
}

function broadcast() {
  chrome.runtime.sendMessage({ type: "progress", state }).catch(() => {});
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "progress", state }).catch(() => {});
    }
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendToBackend(keyword, products, backendUrl) {
  try {
    const resp = await fetch(`${backendUrl}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyword, products }),
    });
    const data = await resp.json();
    log(`Sent ${data.count} product(s) to dashboard.`);
  } catch (e) {
    log(`Failed to send to backend: ${e.message}`);
  }
}

// ============================================================
// TAB NAVIGATION
// ============================================================

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Page load timeout"));
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

async function closeTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch (e) {}
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
// COORDINATE CALIBRATION
// ============================================================

async function calibrate(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        screenX: window.screenX,
        screenY: window.screenY,
        chromeOffsetY: window.outerHeight - window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      }),
    });
    const info = results[0]?.result;
    if (info && nativePort) {
      await sendNative({ action: "calibrate", ...info });
    }
  } catch (e) {}
}

// ============================================================
// MOUSE ACTIONS (via native host if available)
// ============================================================

async function mouseMove(toX, toY) {
  if (!nativePort) return;
  try {
    await sendNative({
      action: "move_bezier",
      fromX: lastMouseX, fromY: lastMouseY,
      toX, toY,
    });
  } catch (e) {}
  lastMouseX = Math.round(toX);
  lastMouseY = Math.round(toY);
}

async function mouseScroll(deltaY) {
  if (!nativePort) return;
  try {
    await sendNative({
      action: "scroll",
      x: lastMouseX, y: lastMouseY,
      deltaY,
    });
  } catch (e) {}
}

async function mouseWander(cx, cy) {
  if (!nativePort) return;
  try {
    await sendNative({ action: "wander", x: cx, y: cy });
  } catch (e) {}
  lastMouseX = cx;
  lastMouseY = cy;
}

// ============================================================
// HUMAN SIMULATION
// ============================================================

async function browsePageSlowly(tabId) {
  await calibrate(tabId);

  // Wander mouse around the page
  await mouseWander(400 + Math.random() * 400, 250 + Math.random() * 200);
  await sleep(500 + Math.random() * 800);

  // Scroll down the full page in stages — reading each row
  const scrollStages = 6 + Math.floor(Math.random() * 4);
  for (let i = 0; i < scrollStages; i++) {
    await mouseScroll(250 + Math.random() * 200);
    await sleep(800 + Math.random() * 1200);

    // Move mouse around between scrolls (reading listings)
    if (Math.random() < 0.6) {
      await mouseMove(
        150 + Math.random() * 800,
        200 + Math.random() * 400
      );
      await sleep(300 + Math.random() * 600);
    }
  }
}

// ============================================================
// PAGE ANALYSIS
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

// Extract demand signals directly from search result cards
// Etsy shows "X bought in past 24 hours" on the cards themselves
// No need to visit individual listing pages
async function extractFromSearchPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const products = [];
      const seenIds = new Set();
      const allText = document.body?.innerText || "";

      // Find all listing links
      const links = document.querySelectorAll('a[href*="/listing/"]');

      for (const link of links) {
        const hrefMatch = link.href.match(/\/listing\/(\d+)/);
        if (!hrefMatch || seenIds.has(hrefMatch[1])) continue;
        seenIds.add(hrefMatch[1]);

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

        const cardText = card?.innerText || "";

        // Match "X bought/sold in past 24 hours"
        const soldMatch = cardText.match(
          /(\d+\+?)\s+(?:people\s+)?(?:bought|sold)\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s+hours/i
        );

        if (soldMatch) {
          // Get title
          const titleEl = card?.querySelector('h3, h2, [class*="title"]') || link;
          const title = titleEl?.textContent?.trim()?.substring(0, 120) || "";

          // Get image
          const img = card?.querySelector("img");
          const imageUrl = img?.src || "";

          const listingUrl = `https://www.etsy.com/listing/${hrefMatch[1]}`;

          products.push({
            title,
            url: listingUrl,
            image_url: imageUrl,
            sold_count: soldMatch[0].trim(),
          });
        }
      }

      return { products, totalListings: seenIds.size };
    },
  });
  return results[0]?.result || { products: [], totalListings: 0 };
}

// ============================================================
// MAIN SEARCH
//
// Only loads 20 search result pages — NOT individual listings.
// Etsy shows "X bought in past 24 hours" directly on the
// search result cards. We scroll through each page with real
// mouse movement and extract the signals from the cards.
//
// 20 page loads total = zero ban risk
// ~15-20 minutes with generous delays
// Real mouse movement via pyautogui makes it look fully human
// ============================================================

async function runMainSearch(keyword, backendUrl, reportProgress) {
  const totalPages = 20;
  state = defaultState(keyword, totalPages);
  saveState();
  broadcast();

  const matchingProducts = [];

  try {
    log("Starting search...");
    if (reportProgress) await reportProgress("running");

    // Connect native mouse host
    connectNative();
    if (nativePort) {
      const pong = await sendNative({ action: "ping" });
      if (pong?.ok && !pong.error) {
        log("Real mouse control active.");
      } else {
        log("Mouse host not responding — continuing without.");
        nativePort = null;
      }
    } else {
      log("No mouse host — continuing without real mouse.");
    }

    // Create search tab
    const mainTab = await chrome.tabs.create({ url: "about:blank", active: true });
    searchTabId = mainTab.id;

    // Warm up — visit Etsy homepage
    log("Visiting Etsy homepage...");
    try {
      await navigateTab(searchTabId, "https://www.etsy.com");
      await sleep(3000 + Math.random() * 3000);
      if (nativePort) {
        await browsePageSlowly(searchTabId);
      }
      await sleep(2000 + Math.random() * 3000);
    } catch (e) {
      log("Homepage warm-up issue: " + e.message);
    }

    // ---- Scan each search results page ----
    let totalListingsScanned = 0;

    for (let page = 1; page <= totalPages; page++) {
      if (state.cancelled) { log("Search cancelled."); break; }

      state.currentPage = page;
      log(`Scanning page ${page} of ${totalPages}...`);
      broadcast();
      if (reportProgress) await reportProgress("running");

      // Navigate to search page
      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;
      try {
        await navigateTab(searchTabId, searchUrl);
        await sleep(2000 + Math.random() * 2000);
      } catch (e) {
        log(`Page ${page}: Failed to load — ${e.message}`);
        continue;
      }

      // CAPTCHA check
      if (await hasCaptcha(searchTabId)) {
        log("Access restricted! Please wait, then restart search.");
        state.status = "error";
        saveState();
        broadcast();
        try { chrome.tabs.update(searchTabId, { active: true }); } catch (e) {}
        if (reportProgress) await reportProgress("error");
        return;
      }

      // Browse the search page naturally with real mouse
      // This scrolls through the entire page, reading every row
      if (nativePort) {
        await browsePageSlowly(searchTabId);
      }
      await sleep(1000 + Math.random() * 1500);

      // Scroll back to top so we can get all card positions
      try {
        await chrome.scripting.executeScript({
          target: { tabId: searchTabId },
          func: () => window.scrollTo(0, 0),
        });
      } catch (e) {}
      await sleep(500);

      // Now scroll through the entire page to make sure lazy content loads
      try {
        await chrome.scripting.executeScript({
          target: { tabId: searchTabId },
          func: async () => {
            for (let i = 0; i < 10; i++) {
              window.scrollBy(0, 500);
              await new Promise(r => setTimeout(r, 300));
            }
            // Back to top
            window.scrollTo(0, 0);
          },
        });
      } catch (e) {}
      await sleep(1000);

      // Extract demand signals from search cards
      let pageResults;
      try {
        pageResults = await extractFromSearchPage(searchTabId);
      } catch (e) {
        log(`Page ${page}: Failed to extract — ${e.message}`);
        continue;
      }

      totalListingsScanned += pageResults.totalListings;
      state.listingsChecked = totalListingsScanned;

      if (pageResults.products.length > 0) {
        for (const product of pageResults.products) {
          matchingProducts.push(product);
          state.productsFound++;
          log(`FOUND: ${product.sold_count} — ${product.title.substring(0, 60)}`);
        }
      }

      log(`Page ${page}: ${pageResults.totalListings} listings scanned, ${pageResults.products.length} with demand signals.`);
      broadcast();

      // Send matches to backend in batches
      if (matchingProducts.length >= 5) {
        await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
      }

      // Generous delay between pages — we only have 20 to do
      if (page < totalPages) {
        const delay = 15000 + Math.random() * 25000; // 15-40 seconds
        log(`Waiting before next page...`);
        await sleep(delay);

        // Extra break every 5 pages
        if (page % 5 === 0) {
          const breakTime = 20000 + Math.random() * 20000; // 20-40 seconds
          log("Taking a longer break...");
          await sleep(breakTime);
        }
      }
    }

    // Send remaining matches
    if (matchingProducts.length > 0) {
      await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
    }

    if (!state.cancelled) {
      state.status = "completed";
      log(`Done! Found ${state.productsFound} trending product(s) across ${totalListingsScanned} listings scanned.`);
    } else {
      state.status = "cancelled";
    }
  } catch (e) {
    console.error("[shortlister] Search crash:", e);
    chrome.storage.local.set({ lastError: e.message, lastErrorStack: e.stack });
    if (state) {
      state.status = "error";
      log(`Search failed: ${e.message}`);
    }
  }

  // Cleanup
  if (searchTabId) {
    await closeTab(searchTabId);
    searchTabId = null;
  }
  if (nativePort) {
    try { nativePort.disconnect(); } catch (e) {}
    nativePort = null;
  }

  saveState();
  broadcast();
  if (reportProgress) await reportProgress(state?.status || "error");
}

// ============================================================
// ENTRY POINTS
// ============================================================

async function runSearch(keyword, backendUrl) {
  await runMainSearch(keyword, backendUrl, null);
}

async function runQueuedSearch(keyword, queueSearchId, backendUrl) {
  const reportProgress = async (status) => {
    try {
      await fetch(`${backendUrl}/api/queue/${queueSearchId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: status || "running",
          progress: {
            currentPage: state.currentPage,
            totalPages: state.totalPages,
            listingsChecked: state.listingsChecked,
            productsFound: state.productsFound,
            log: state.log.slice(-50),
          },
        }),
      });
    } catch (e) {}
  };

  await runMainSearch(keyword, backendUrl, reportProgress);
  currentQueuedSearchId = null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "startSearch") {
    const backendUrl = msg.backendUrl || DEFAULT_BACKEND;
    runSearch(msg.keyword, backendUrl);
    sendResponse({ ok: true });
  } else if (msg.type === "cancelSearch") {
    if (state) {
      state.cancelled = true;
      saveState();
    }
    sendResponse({ ok: true });
  } else if (msg.type === "getState") {
    sendResponse({ state });
  }
  return true;
});

// ---- Poll backend for queued searches ----
let currentQueuedSearchId = null;

async function pollForQueuedSearches() {
  let backendUrl = DEFAULT_BACKEND;
  try {
    const data = await chrome.storage.local.get(["backendUrl"]);
    if (data.backendUrl) backendUrl = data.backendUrl;
  } catch (e) {}

  if (state && state.status === "running") return;

  try {
    const resp = await fetch(`${backendUrl}/api/queue/pending`);
    const pending = await resp.json();
    if (pending.length > 0) {
      const search = pending[0];
      currentQueuedSearchId = search.search_id;
      await fetch(`${backendUrl}/api/queue/${search.search_id}/claim`, { method: "POST" });
      await runQueuedSearch(search.keyword, search.search_id, backendUrl);
    }
  } catch (e) {}
}

setInterval(pollForQueuedSearches, 3000);
pollForQueuedSearches();
