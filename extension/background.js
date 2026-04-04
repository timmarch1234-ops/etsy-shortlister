const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";

let state = null;
let searchTabId = null;
let activeTabs = [];

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

// Wait for a tab to finish loading (no navigation initiated)
function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };

    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      done();
    }, timeoutMs);

    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        done();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);

    // Maybe it's already loaded
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) { done(); return; }
        if (tab && tab.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          done();
        }
      });
    } catch (e) { done(); }
  });
}

// Wait for multiple tabs to load in parallel
async function waitForAllTabs(tabIds, timeoutMs = 20000) {
  await Promise.all(tabIds.map((id) => waitForTabComplete(id, timeoutMs)));
}

async function closeTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch (e) {}
}

// ============================================================
// ANTI-DETECTION: Human behavior simulation
// ============================================================

// Inject realistic mouse movement across the page
// DataDome's client-side JS monitors mouse telemetry —
// pages with zero mouse activity are flagged as bots
async function injectMouseActivity(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        let x = 100 + Math.random() * 700;
        let y = 150 + Math.random() * 400;
        const steps = 6 + Math.floor(Math.random() * 15);
        for (let i = 0; i < steps; i++) {
          // Curved, natural path — not straight lines
          x += (Math.random() - 0.5) * 140;
          y += (Math.random() - 0.5) * 100;
          x = Math.max(5, Math.min(window.innerWidth - 5, x));
          y = Math.max(5, Math.min(window.innerHeight - 5, y));
          const el = document.elementFromPoint(x, y) || document.body;
          el.dispatchEvent(
            new MouseEvent("mousemove", {
              clientX: x,
              clientY: y,
              bubbles: true,
              cancelable: true,
            })
          );
        }
      },
    });
  } catch (e) {}
}

// Scroll the page in natural increments like a human reading
async function naturalScroll(tabId, totalAmount) {
  const steps = 2 + Math.floor(Math.random() * 4);
  const per = totalAmount / steps;
  for (let i = 0; i < steps; i++) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (px) => window.scrollBy({ top: px, behavior: "smooth" }),
        args: [per + (Math.random() - 0.5) * 80],
      });
    } catch (e) {}
    await sleep(400 + Math.random() * 900);
  }
}

// Full human simulation: mouse movement + scroll + pause
async function simulateHumanOnPage(tabId) {
  await injectMouseActivity(tabId);
  await naturalScroll(tabId, 300 + Math.random() * 800);
  await sleep(300 + Math.random() * 700);
  await injectMouseActivity(tabId);
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

// Extract listing URLs from search page in top-to-bottom order
async function extractListingUrls(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const links = document.querySelectorAll('a[href*="/listing/"]');
      const seen = new Set();
      const urls = [];
      links.forEach((a) => {
        const m = a.href.match(/\/listing\/(\d+)/);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          urls.push(`https://www.etsy.com/listing/${m[1]}`);
        }
      });
      return urls;
    },
  });
  return results[0]?.result || [];
}

// Check a listing page for "sold/bought in past 24 hours" only
async function checkListingTab(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const bodyText = document.body?.innerText || "";
        const soldMatch = bodyText.match(
          /(\d+\+?)\s+(?:people\s+)?(?:bought|sold)\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s+hours/i
        );
        if (!soldMatch) return null;
        const soldCount = soldMatch[0].trim();
        const title =
          document.title?.split(" - Etsy")[0]?.trim() || "";
        const ogImg = document.querySelector('meta[property="og:image"]');
        const imageUrl = ogImg?.content || "";
        return { soldCount, title, imageUrl };
      },
    });
    return results[0]?.result || null;
  } catch (e) {
    return null;
  }
}

// ============================================================
// MAIN SEARCH ENGINE
//
// Strategy: Mimics a real person browsing Etsy search results.
// Opens each search page, then Ctrl+clicks 3-4 listings at a
// time to open them in background tabs (extremely common real
// user behavior). Reviews each tab, closes them, continues.
//
// Anti-detection layers:
// 1. Mouse movement injection (DataDome telemetry)
// 2. Natural scroll patterns
// 3. Multi-tab browsing pattern (not bot-like sequential nav)
// 4. Variable/randomized timing with no fixed intervals
// 5. Occasional longer pauses (simulates distraction)
// 6. Dynamic pace — adjusts to fit 25-30 min budget
// 7. Listings load in parallel (fewer sequential requests)
// ============================================================

async function runMainSearch(keyword, backendUrl, reportProgress) {
  const totalPages = 20;
  state = defaultState(keyword, totalPages);
  saveState();
  broadcast();

  const startTime = Date.now();
  const TIME_BUDGET_MS = 29 * 60 * 1000;
  const matchingProducts = [];

  try {
    log("Starting search...");
    if (reportProgress) await reportProgress("running");

    // Create main search tab (foreground — DataDome checks document.hidden)
    const mainTab = await chrome.tabs.create({
      url: "about:blank",
      active: true,
    });
    searchTabId = mainTab.id;

    // ---- Warm up: visit Etsy homepage like a real user ----
    log("Warming up...");
    try {
      await navigateTab(searchTabId, "https://www.etsy.com");
      await sleep(2500 + Math.random() * 3000);
      await simulateHumanOnPage(searchTabId);
      await sleep(2000 + Math.random() * 3000);
    } catch (e) {}

    // ---- Process each search page ----
    for (let page = 1; page <= totalPages; page++) {
      if (state.cancelled) {
        log("Search cancelled.");
        break;
      }

      // Time budget check
      const elapsed = Date.now() - startTime;
      if (elapsed > TIME_BUDGET_MS) {
        log(`Time limit reached at page ${page}. Finishing up.`);
        break;
      }

      state.currentPage = page;
      log(`Searching page ${page} of ${totalPages}...`);
      broadcast();
      if (reportProgress) await reportProgress("running");

      // Navigate to search results page
      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(
        keyword
      )}&ref=search_bar&page=${page}`;
      try {
        await navigateTab(searchTabId, searchUrl);
        await sleep(1500 + Math.random() * 2000);
      } catch (e) {
        log(`Page ${page}: Failed to load, skipping.`);
        continue;
      }

      // CAPTCHA check
      if (await hasCaptcha(searchTabId)) {
        log("CAPTCHA detected! Solve it in the Etsy tab, then restart.");
        state.status = "error";
        saveState();
        broadcast();
        chrome.tabs.update(searchTabId, { active: true });
        if (reportProgress) await reportProgress("error");
        return;
      }

      // Browse search page naturally before clicking anything
      await simulateHumanOnPage(searchTabId);
      await sleep(500 + Math.random() * 1000);

      // Extract all listings (top to bottom)
      let listingUrls;
      try {
        listingUrls = await extractListingUrls(searchTabId);
      } catch (e) {
        log(`Page ${page}: Failed to extract listings.`);
        continue;
      }

      if (listingUrls.length === 0) {
        log(`Page ${page}: No listings found.`);
        continue;
      }

      log(`Page ${page}: ${listingUrls.length} listings to check.`);

      // ---- Dynamic pacing ----
      // Calculate how much time per listing we can afford
      const timeLeft = TIME_BUDGET_MS - (Date.now() - startTime);
      const listingsLeft =
        listingUrls.length +
        Math.max(0, totalPages - page) * 55; // estimate remaining
      const msPerListing = Math.max(800, timeLeft / Math.max(1, listingsLeft));

      // Batch size: 3-5, randomized each time
      const baseBatch = msPerListing > 2000 ? 3 : 4; // larger batches when tight on time

      // ---- Process listings in batches (Ctrl+click pattern) ----
      for (let i = 0; i < listingUrls.length; ) {
        if (state.cancelled) break;
        if (Date.now() - startTime > TIME_BUDGET_MS) break;

        // Randomize this batch's size (2-5)
        const batchSize = Math.max(
          2,
          Math.min(5, baseBatch + Math.floor(Math.random() * 3) - 1)
        );
        const batch = listingUrls.slice(i, i + batchSize);
        i += batch.length;

        const batchTabs = [];

        // Open listings in background tabs (Ctrl+click pattern)
        for (const url of batch) {
          try {
            const tab = await chrome.tabs.create({ url, active: false });
            batchTabs.push({ id: tab.id, url });
            activeTabs.push(tab.id);
            // Slight delay between "clicks" — human rhythm
            await sleep(80 + Math.random() * 180);
          } catch (e) {}
        }

        // Wait for all tabs to load in parallel
        if (batchTabs.length > 0) {
          await waitForAllTabs(
            batchTabs.map((t) => t.id),
            15000
          );
        }

        // Brief pause before reviewing tabs (human switching focus)
        await sleep(200 + Math.random() * 400);

        // Check each tab for demand signal
        for (let j = 0; j < batchTabs.length; j++) {
          const { id: tabId, url } = batchTabs[j];
          state.listingsChecked++;

          try {
            // CAPTCHA check
            if (await hasCaptcha(tabId)) {
              log(
                `CAPTCHA on listing after ${state.listingsChecked} checks. Solve it and restart.`
              );
              state.status = "error";
              saveState();
              broadcast();
              chrome.tabs.update(tabId, { active: true });
              if (reportProgress) await reportProgress("error");
              // Cleanup other batch tabs
              for (const bt of batchTabs) {
                if (bt.id !== tabId) await closeTab(bt.id);
              }
              activeTabs = activeTabs.filter(
                (t) => !batchTabs.map((b) => b.id).includes(t)
              );
              return;
            }

            // Inject mouse activity on listing page (DataDome telemetry)
            await injectMouseActivity(tabId);

            const result = await checkListingTab(tabId);

            if (result) {
              matchingProducts.push({
                title: result.title,
                url,
                image_url: result.imageUrl,
                sold_count: result.soldCount,
              });
              state.productsFound++;
              log(
                `MATCH: ${result.soldCount} - ${result.title.substring(0, 60)}`
              );
            }
          } catch (e) {}

          // Tiny delay between tab checks (switching tabs)
          if (j < batchTabs.length - 1) {
            await sleep(50 + Math.random() * 150);
          }
        }

        // Close all batch tabs
        for (const { id: tabId } of batchTabs) {
          await closeTab(tabId);
          activeTabs = activeTabs.filter((t) => t !== tabId);
        }

        broadcast();

        // Send matches to backend in batches
        if (matchingProducts.length >= 5) {
          await sendToBackend(
            keyword,
            matchingProducts.splice(0),
            backendUrl
          );
        }

        // ---- Inter-batch timing (the key to looking human) ----
        // Base pause + random jitter
        const basePause = Math.max(300, msPerListing * batch.length - 2500);
        await sleep(basePause + Math.random() * 800);

        // Occasional longer "distraction" pause (~every 5 batches)
        if (Math.random() < 0.18) {
          const distractionPause = 2000 + Math.random() * 4000;
          await sleep(distractionPause);
        }
      }

      // Pause between search pages (human scrolling to "Next")
      if (page < totalPages) {
        const pageGap = 1500 + Math.random() * 3000;
        await sleep(pageGap);

        // Occasional longer break between pages (~every 5 pages)
        if (page % 5 === 0) {
          const breakTime = 4000 + Math.random() * 6000;
          log("Brief break...");
          await sleep(breakTime);
        }
      }
    }

    // Send any remaining matches
    if (matchingProducts.length > 0) {
      await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
    }

    if (!state.cancelled) {
      state.status = "completed";
      log(
        `Done! Found ${state.productsFound} trending product(s) across ${state.listingsChecked} listings.`
      );
    } else {
      state.status = "cancelled";
    }
  } catch (e) {
    state.status = "error";
    log(`Search failed: ${e.message}`);
  }

  // Cleanup all tabs
  for (const tabId of activeTabs) await closeTab(tabId);
  activeTabs = [];
  if (searchTabId) {
    await closeTab(searchTabId);
    searchTabId = null;
  }

  saveState();
  broadcast();
  if (reportProgress) await reportProgress(state.status);
}

// ============================================================
// ENTRY POINTS
// ============================================================

// Direct search (from extension popup or content script)
async function runSearch(keyword, backendUrl) {
  await runMainSearch(keyword, backendUrl, null);
}

// Queued search (from website polling)
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

// Listen for messages from popup and content script
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
      await fetch(`${backendUrl}/api/queue/${search.search_id}/claim`, {
        method: "POST",
      });
      await runQueuedSearch(search.keyword, search.search_id, backendUrl);
    }
  } catch (e) {}
}

setInterval(pollForQueuedSearches, 3000);
pollForQueuedSearches();
