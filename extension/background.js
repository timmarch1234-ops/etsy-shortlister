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

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
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
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError) {
          done();
          return;
        }
        if (tab && tab.status === "complete") {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          done();
        }
      });
    } catch (e) {
      done();
    }
  });
}

async function waitForAllTabs(tabIds, timeoutMs = 20000) {
  await Promise.all(tabIds.map((id) => waitForTabComplete(id, timeoutMs)));
}

async function closeTab(tabId) {
  try {
    await chrome.tabs.remove(tabId);
  } catch (e) {}
}

// ============================================================
// HUMAN SIMULATION — Bezier curve mouse movement
//
// Real humans move the mouse in smooth curves, not straight
// lines or random jumps. We use cubic Bezier curves with
// randomized control points — the same technique ghost-cursor
// and other anti-detection libraries use.
// ============================================================

// Inject Bezier mouse path + micro-movements on a page
async function humanMouseMovement(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Cubic Bezier interpolation
        function bezier(t, p0, p1, p2, p3) {
          const u = 1 - t;
          return (
            u * u * u * p0 +
            3 * u * u * t * p1 +
            3 * u * t * t * p2 +
            t * t * t * p3
          );
        }

        const w = window.innerWidth;
        const h = window.innerHeight;

        // Start from a natural position (center-ish area)
        const startX = w * (0.2 + Math.random() * 0.6);
        const startY = h * (0.2 + Math.random() * 0.5);

        // End at another natural position
        const endX = w * (0.1 + Math.random() * 0.7);
        const endY = h * (0.15 + Math.random() * 0.6);

        // Random control points create the human curve
        const cp1x = startX + (Math.random() - 0.5) * w * 0.4;
        const cp1y = startY + (Math.random() - 0.3) * h * 0.4;
        const cp2x = endX + (Math.random() - 0.5) * w * 0.4;
        const cp2y = endY + (Math.random() - 0.3) * h * 0.4;

        // 15-30 points along the curve
        const steps = 15 + Math.floor(Math.random() * 16);

        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          // Add micro-jitter (hand tremor)
          const jitterX = (Math.random() - 0.5) * 3;
          const jitterY = (Math.random() - 0.5) * 3;
          const x = Math.max(
            2,
            Math.min(w - 2, bezier(t, startX, cp1x, cp2x, endX) + jitterX)
          );
          const y = Math.max(
            2,
            Math.min(h - 2, bezier(t, startY, cp1y, cp2y, endY) + jitterY)
          );

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

// Scroll search page down to the next row of results
async function scrollToNextRow(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Etsy shows ~4 items per row, each card is ~320-380px tall
        // Scroll roughly one row height with some variance
        const rowHeight = 300 + Math.random() * 100;
        window.scrollBy({ top: rowHeight, behavior: "smooth" });
      },
    });
  } catch (e) {}
  // Wait for smooth scroll to finish
  await sleep(400 + Math.random() * 400);
}

// Simulate browsing a listing page (scroll down, mouse movement)
async function browseListingPage(tabId) {
  // Mouse movement (reading the title area)
  await humanMouseMovement(tabId);

  // Scroll down a bit (looking at images/description)
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const amount = 200 + Math.random() * 500;
        window.scrollBy({ top: amount, behavior: "smooth" });
      },
    });
  } catch (e) {}

  await sleep(200 + Math.random() * 500);

  // Another small mouse movement
  await humanMouseMovement(tabId);
}

// Full human simulation on search page (initial browse)
async function browseSearchPage(tabId) {
  await humanMouseMovement(tabId);
  // Scroll through the page naturally in 2-4 stages
  const scrollSteps = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < scrollSteps; i++) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const px = 250 + Math.random() * 450;
          window.scrollBy({ top: px, behavior: "smooth" });
        },
      });
    } catch (e) {}
    await sleep(500 + Math.random() * 800);
    await humanMouseMovement(tabId);
  }
  // Scroll back to top to start row-by-row
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => window.scrollTo({ top: 0, behavior: "smooth" }),
    });
  } catch (e) {}
  await sleep(400 + Math.random() * 600);
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
        if (divs.length < 5 && iframes.length > 0 && title.length < 20)
          return true;
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

// Extract listing URLs in top-to-bottom, left-to-right order
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

// Check listing page for "sold/bought in past 24 hours" only
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
// MAIN SEARCH — Row-by-row human browsing pattern
//
// Exactly mimics how a real person browses Etsy search results:
//
// 1. Land on search page, scroll through it casually
// 2. Scroll back to top, look at first row of 4 results
// 3. Ctrl+click all 4 to open in background tabs
// 4. Switch to each tab, browse it (mouse + scroll), check signal
// 5. Close all 4 tabs, return to search page
// 6. Scroll down to next row of 4
// 7. Repeat until all rows done
// 8. Go to next search page
//
// Anti-detection:
// - Bezier curve mouse movement (ghost-cursor algorithm)
// - Real tab switching (document.hidden flips correctly)
// - Natural smooth scrolling between rows
// - Variable timing — no two actions take the same time
// - Dynamic pacing to fit 25-30 min budget
// ============================================================

const ROW_SIZE = 4; // Etsy shows 4 items per row

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

    // Create main search tab (foreground)
    const mainTab = await chrome.tabs.create({
      url: "about:blank",
      active: true,
    });
    searchTabId = mainTab.id;

    // ---- Warm up: visit Etsy homepage ----
    log("Warming up...");
    try {
      await navigateTab(searchTabId, "https://www.etsy.com");
      await sleep(2000 + Math.random() * 3000);
      await humanMouseMovement(searchTabId);
      await sleep(1000 + Math.random() * 2000);
      // Scroll around the homepage like a real person
      await browseSearchPage(searchTabId);
      await sleep(1500 + Math.random() * 2000);
    } catch (e) {}

    // ---- Process each search page ----
    for (let page = 1; page <= totalPages; page++) {
      if (state.cancelled) {
        log("Search cancelled.");
        break;
      }

      // Time budget check
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        log(`Time limit reached at page ${page}.`);
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
        await sleep(1500 + Math.random() * 1500);
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

      // Browse the search page naturally first (scroll through, then back to top)
      await browseSearchPage(searchTabId);
      await sleep(300 + Math.random() * 500);

      // Extract all listing URLs
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

      log(`Page ${page}: ${listingUrls.length} listings across ${Math.ceil(listingUrls.length / ROW_SIZE)} rows.`);

      // ---- Dynamic pacing ----
      const timeLeft = TIME_BUDGET_MS - (Date.now() - startTime);
      const listingsLeft =
        listingUrls.length + Math.max(0, totalPages - page) * 55;
      const msPerListing = Math.max(600, timeLeft / Math.max(1, listingsLeft));

      // ---- Row by row ----
      for (let rowStart = 0; rowStart < listingUrls.length; rowStart += ROW_SIZE) {
        if (state.cancelled) break;
        if (Date.now() - startTime > TIME_BUDGET_MS) break;

        const rowEnd = Math.min(rowStart + ROW_SIZE, listingUrls.length);
        const rowUrls = listingUrls.slice(rowStart, rowEnd);
        const rowNum = Math.floor(rowStart / ROW_SIZE) + 1;

        // If not the first row, scroll down to next row on search page
        if (rowStart > 0) {
          // Switch back to search tab
          try {
            await chrome.tabs.update(searchTabId, { active: true });
          } catch (e) {}
          await sleep(150 + Math.random() * 250);
          await scrollToNextRow(searchTabId);
          // Quick mouse movement on search page (scanning the row)
          await humanMouseMovement(searchTabId);
          await sleep(200 + Math.random() * 400);
        }

        // ---- Open this row's listings in background tabs ----
        const rowTabs = [];
        for (const url of rowUrls) {
          try {
            const tab = await chrome.tabs.create({ url, active: false });
            rowTabs.push({ id: tab.id, url });
            activeTabs.push(tab.id);
            // Slight delay between Ctrl+clicks
            await sleep(60 + Math.random() * 140);
          } catch (e) {}
        }

        // Wait for all tabs to load in parallel
        if (rowTabs.length > 0) {
          await waitForAllTabs(
            rowTabs.map((t) => t.id),
            15000
          );
        }

        // ---- Visit each tab one by one (like a human clicking through) ----
        for (let j = 0; j < rowTabs.length; j++) {
          const { id: tabId, url } = rowTabs[j];
          state.listingsChecked++;

          try {
            // Switch to this tab (human clicks on tab)
            await chrome.tabs.update(tabId, { active: true });
            await sleep(150 + Math.random() * 250);

            // CAPTCHA check
            if (await hasCaptcha(tabId)) {
              log(
                `CAPTCHA on listing after ${state.listingsChecked} checks. Solve it and restart.`
              );
              state.status = "error";
              saveState();
              broadcast();
              if (reportProgress) await reportProgress("error");
              for (const bt of rowTabs) {
                if (bt.id !== tabId) await closeTab(bt.id);
              }
              activeTabs = activeTabs.filter(
                (t) => !rowTabs.map((b) => b.id).includes(t)
              );
              return;
            }

            // Browse the listing page naturally
            await browseListingPage(tabId);

            // Check for demand signal
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

          // Delay before switching to next tab
          // Variable: sometimes quick glance, sometimes longer read
          const browseTime =
            Math.random() < 0.15
              ? 800 + Math.random() * 1200 // 15% chance: longer look (2s)
              : 200 + Math.random() * 400; // 85%: quick scan
          await sleep(browseTime);
        }

        // ---- Close all tabs in this row ----
        for (const { id: tabId } of rowTabs) {
          await closeTab(tabId);
          activeTabs = activeTabs.filter((t) => t !== tabId);
        }

        // Switch back to search tab
        try {
          await chrome.tabs.update(searchTabId, { active: true });
        } catch (e) {}

        broadcast();

        // Send matches to backend
        if (matchingProducts.length >= 5) {
          await sendToBackend(
            keyword,
            matchingProducts.splice(0),
            backendUrl
          );
        }

        // Brief pause before next row (human deciding what to click next)
        await sleep(200 + Math.random() * 500);

        // Occasional longer distraction pause (~12% of rows)
        if (Math.random() < 0.12) {
          await sleep(1500 + Math.random() * 3000);
        }
      }

      // ---- Between search pages ----
      if (page < totalPages) {
        // Pause before clicking "Next" (human behaviour)
        await sleep(1000 + Math.random() * 2000);

        // Every 5 pages, take a slightly longer break
        if (page % 5 === 0) {
          log("Brief break...");
          await sleep(3000 + Math.random() * 5000);
        }
      }
    }

    // Send remaining matches
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

  // Cleanup
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
      await fetch(`${backendUrl}/api/queue/${search.search_id}/claim`, {
        method: "POST",
      });
      await runQueuedSearch(search.keyword, search.search_id, backendUrl);
    }
  } catch (e) {}
}

setInterval(pollForQueuedSearches, 3000);
pollForQueuedSearches();
