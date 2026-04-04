const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";

let state = null;
let searchTabId = null;
let activeTabs = [];
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

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) { settled = true; resolve(); }
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

async function waitForAllTabs(tabIds, timeoutMs = 20000) {
  await Promise.all(tabIds.map((id) => waitForTabComplete(id, timeoutMs)));
}

async function closeTab(tabId) {
  try { await chrome.tabs.remove(tabId); } catch (e) {}
}

// ============================================================
// CHROME DEVTOOLS PROTOCOL — TRUSTED INPUT EVENTS
//
// chrome.debugger dispatches events via CDP, producing
// isTrusted: true events. DataDome cannot distinguish these
// from real human input. This is the same mechanism that
// Puppeteer and Playwright use under the hood.
// ============================================================

const debuggerTabs = new Set();

async function attachDebugger(tabId) {
  if (debuggerTabs.has(tabId)) return true;
  try {
    await new Promise((resolve, reject) => {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
    debuggerTabs.add(tabId);
    return true;
  } catch (e) {
    console.log("Debugger attach failed:", e.message);
    return false;
  }
}

async function detachDebugger(tabId) {
  if (!debuggerTabs.has(tabId)) return;
  try {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId }, () => {
        resolve();
      });
    });
  } catch (e) {}
  debuggerTabs.delete(tabId);
}

// Handle debugger detach (user dismissed the bar, tab closed, etc.)
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) debuggerTabs.delete(source.tabId);
});

async function cdpSend(tabId, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(result);
      }
    });
  });
}

// ============================================================
// TRUSTED MOUSE MOVEMENT — Bezier curves via CDP
//
// Generates isTrusted:true mousemove events along a smooth
// cubic Bezier path with micro-jitter (hand tremor) and
// variable speed (slower at start/end, faster in middle).
// ============================================================

async function trustedMouseMove(tabId, toX, toY) {
  const fromX = lastMouseX;
  const fromY = lastMouseY;
  const dist = Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2);
  const steps = Math.max(8, Math.min(25, Math.round(dist / 15)));

  // Bezier control points — random curves, not straight lines
  const cp1x = fromX + (toX - fromX) * 0.25 + (Math.random() - 0.5) * 80;
  const cp1y = fromY + (toY - fromY) * 0.25 + (Math.random() - 0.5) * 60;
  const cp2x = fromX + (toX - fromX) * 0.75 + (Math.random() - 0.5) * 80;
  const cp2y = fromY + (toY - fromY) * 0.75 + (Math.random() - 0.5) * 60;

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    // Cubic Bezier + micro-jitter
    const x =
      u * u * u * fromX +
      3 * u * u * t * cp1x +
      3 * u * t * t * cp2x +
      t * t * t * toX +
      (Math.random() - 0.5) * 2;
    const y =
      u * u * u * fromY +
      3 * u * u * t * cp1y +
      3 * u * t * t * cp2y +
      t * t * t * toY +
      (Math.random() - 0.5) * 2;

    try {
      await cdpSend(tabId, "Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: Math.round(x),
        y: Math.round(y),
      });
    } catch (e) { break; }

    // Easing: slower at start/end, faster in middle
    const speed = 8 + Math.sin(t * Math.PI) * 18 + Math.random() * 10;
    await sleep(speed);
  }

  lastMouseX = Math.round(toX);
  lastMouseY = Math.round(toY);
}

// Trusted click at current mouse position
async function trustedClick(tabId, x, y) {
  try {
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
    await sleep(40 + Math.random() * 60);
    await cdpSend(tabId, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
  } catch (e) {}
}

// Trusted scroll via mouseWheel event
async function trustedScroll(tabId, deltaY) {
  // Scroll in 2-4 increments (humans don't scroll in one jump)
  const scrollSteps = 2 + Math.floor(Math.random() * 3);
  const perStep = deltaY / scrollSteps;

  for (let i = 0; i < scrollSteps; i++) {
    const jitter = (Math.random() - 0.5) * 30;
    try {
      await cdpSend(tabId, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: lastMouseX,
        y: lastMouseY,
        deltaX: 0,
        deltaY: Math.round(perStep + jitter),
      });
    } catch (e) { break; }
    await sleep(100 + Math.random() * 200);
  }
}

// Trusted keyboard press
async function trustedKeyPress(tabId, key, code, keyCode) {
  try {
    await cdpSend(tabId, "Input.dispatchKeyEvent", {
      type: "keyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
    await sleep(30 + Math.random() * 60);
    await cdpSend(tabId, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  } catch (e) {}
}

// ============================================================
// HUMAN SIMULATION — Composites
// ============================================================

// Casually move mouse around the page (idle browsing)
async function idleMouseWander(tabId) {
  const moves = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < moves; i++) {
    const x = 100 + Math.random() * 900;
    const y = 100 + Math.random() * 500;
    await trustedMouseMove(tabId, x, y);
    await sleep(200 + Math.random() * 600);
  }
}

// Browse a page naturally: mouse wander + scroll down + more mouse
async function browsePageNaturally(tabId) {
  await idleMouseWander(tabId);
  await sleep(300 + Math.random() * 500);

  // Scroll down in a few stages
  const scrollStages = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < scrollStages; i++) {
    await trustedScroll(tabId, 200 + Math.random() * 400);
    await sleep(400 + Math.random() * 800);
    // Occasional mouse wander between scrolls
    if (Math.random() < 0.5) {
      await idleMouseWander(tabId);
    }
  }
}

// Quick browse on a listing tab (glance + small scroll)
async function quickBrowseListing(tabId) {
  // Move mouse around the listing (title, image, details area)
  await trustedMouseMove(tabId, 300 + Math.random() * 400, 200 + Math.random() * 200);
  await sleep(150 + Math.random() * 300);
  await trustedScroll(tabId, 150 + Math.random() * 300);
  await sleep(100 + Math.random() * 200);
  // One more mouse move (scanning the page)
  await trustedMouseMove(tabId, 200 + Math.random() * 600, 300 + Math.random() * 300);
}

// ============================================================
// PAGE ANALYSIS (read-only — no events dispatched)
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

// Get positions and URLs of all listing links (top-to-bottom order)
async function getListingPositions(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const links = document.querySelectorAll('a[href*="/listing/"]');
      const seen = new Set();
      const listings = [];
      links.forEach((a) => {
        const m = a.href.match(/\/listing\/(\d+)/);
        if (m && !seen.has(m[1])) {
          seen.add(m[1]);
          const rect = a.getBoundingClientRect();
          // Only include links that are visible and have a size
          if (rect.width > 0 && rect.height > 0) {
            listings.push({
              url: `https://www.etsy.com/listing/${m[1]}`,
              x: rect.left + rect.width * (0.3 + Math.random() * 0.4),
              y: rect.top + rect.height * (0.3 + Math.random() * 0.4),
              id: m[1],
            });
          }
        }
      });
      return listings;
    },
  });
  return results[0]?.result || [];
}

// Check listing page for "sold/bought in past 24 hours"
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
        const title = document.title?.split(" - Etsy")[0]?.trim() || "";
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
// MAIN SEARCH — Row-by-row with trusted CDP events
//
// How a real person browses Etsy:
// 1. Search page loads, they read/scan the results
// 2. They see a row of ~4 items, mouse moves to one, click
//    to open in new tab, then next one, etc.
// 3. They switch to each tab, glance at it, close it
// 4. Back on search page, scroll down to next row
// 5. Repeat
//
// Our approach:
// - chrome.debugger (CDP) for ALL mouse/scroll/keyboard input
//   → every event is isTrusted:true, indistinguishable from human
// - chrome.scripting.executeScript ONLY for reading the DOM
//   (invisible to detection — no events dispatched)
// - Bezier curve mouse paths with micro-jitter and variable speed
// - Trusted scroll wheel events in natural increments
// - Real tab switching with human-like timing
// - Dynamic pacing to fit within time budget
// ============================================================

const ROW_SIZE = 4;

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

    // Create search tab (foreground)
    const mainTab = await chrome.tabs.create({ url: "about:blank", active: true });
    searchTabId = mainTab.id;

    // ---- Warm up: visit Etsy homepage ----
    log("Warming up...");
    await navigateTab(searchTabId, "https://www.etsy.com");
    await sleep(2000 + Math.random() * 2000);

    // Attach debugger to search tab for trusted events
    const dbgOk = await attachDebugger(searchTabId);
    if (!dbgOk) {
      log("Could not attach debugger. Search may be less stealthy.");
    }

    // Browse homepage naturally (trusted mouse + scroll)
    if (dbgOk) {
      await browsePageNaturally(searchTabId);
      await sleep(1500 + Math.random() * 2500);
    }

    // ---- Process search pages ----
    for (let page = 1; page <= totalPages; page++) {
      if (state.cancelled) { log("Search cancelled."); break; }
      if (Date.now() - startTime > TIME_BUDGET_MS) {
        log(`Time limit reached at page ${page}.`);
        break;
      }

      state.currentPage = page;
      log(`Searching page ${page} of ${totalPages}...`);
      broadcast();
      if (reportProgress) await reportProgress("running");

      // Navigate to search page
      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;
      try {
        await navigateTab(searchTabId, searchUrl);
        await sleep(1500 + Math.random() * 1500);
      } catch (e) {
        log(`Page ${page}: Failed to load, skipping.`);
        continue;
      }

      // Re-attach debugger if needed (navigations can detach it)
      await attachDebugger(searchTabId);

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

      // Browse search page naturally (trusted mouse wander + scroll)
      await browsePageNaturally(searchTabId);
      await sleep(400 + Math.random() * 600);

      // Scroll back to top to start row-by-row
      try {
        await cdpSend(searchTabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: lastMouseX,
          y: lastMouseY,
          deltaX: 0,
          deltaY: -10000,
        });
      } catch (e) {}
      await sleep(500 + Math.random() * 500);

      // Get all listing positions
      let listings;
      try {
        listings = await getListingPositions(searchTabId);
      } catch (e) {
        log(`Page ${page}: Failed to get listings.`);
        continue;
      }

      if (listings.length === 0) {
        log(`Page ${page}: No listings found.`);
        continue;
      }

      log(`Page ${page}: ${listings.length} listings in ${Math.ceil(listings.length / ROW_SIZE)} rows.`);

      // Dynamic pacing
      const timeLeft = TIME_BUDGET_MS - (Date.now() - startTime);
      const listingsLeft = listings.length + Math.max(0, totalPages - page) * 50;
      const msPerListing = Math.max(500, timeLeft / Math.max(1, listingsLeft));

      // ---- Row by row ----
      for (let rowStart = 0; rowStart < listings.length; rowStart += ROW_SIZE) {
        if (state.cancelled) break;
        if (Date.now() - startTime > TIME_BUDGET_MS) break;

        const rowEnd = Math.min(rowStart + ROW_SIZE, listings.length);
        const rowListings = listings.slice(rowStart, rowEnd);

        // Scroll search page to make this row visible
        if (rowStart > 0) {
          await chrome.tabs.update(searchTabId, { active: true });
          await sleep(100 + Math.random() * 150);
          // Scroll one row height (~350px)
          await trustedScroll(searchTabId, 300 + Math.random() * 100);
          await sleep(300 + Math.random() * 400);
        }

        // Mouse wander over the row (scanning results)
        if (debuggerTabs.has(searchTabId)) {
          const centerY = 300 + Math.random() * 200;
          await trustedMouseMove(searchTabId, 200 + Math.random() * 300, centerY);
          await sleep(100 + Math.random() * 200);
        }

        // Re-read positions (may have shifted from scrolling)
        let freshPositions;
        try {
          freshPositions = await getListingPositions(searchTabId);
        } catch (e) {
          freshPositions = [];
        }

        // Open each listing in this row as a new tab
        const rowTabs = [];
        for (let j = 0; j < rowListings.length; j++) {
          const listing = rowListings[j];

          // Find the fresh position for this listing
          const freshPos = freshPositions.find((p) => p.id === listing.id);
          const targetX = freshPos ? freshPos.x : 300 + j * 200;
          const targetY = freshPos ? freshPos.y : 300;

          // Move mouse to this listing (Bezier curve — trusted)
          if (debuggerTabs.has(searchTabId)) {
            await trustedMouseMove(searchTabId, targetX, targetY);
            await sleep(50 + Math.random() * 100);
          }

          // Open in new tab
          try {
            const tab = await chrome.tabs.create({ url: listing.url, active: false });
            rowTabs.push({ id: tab.id, url: listing.url });
            activeTabs.push(tab.id);
          } catch (e) {}

          // Brief pause between "clicks" (human rhythm)
          await sleep(80 + Math.random() * 150);
        }

        // Wait for all tabs to load in parallel
        if (rowTabs.length > 0) {
          await waitForAllTabs(rowTabs.map((t) => t.id), 15000);
        }

        await sleep(200 + Math.random() * 300);

        // ---- Visit each tab one by one ----
        for (let j = 0; j < rowTabs.length; j++) {
          const { id: tabId, url } = rowTabs[j];
          state.listingsChecked++;

          try {
            // Switch to this tab (real tab switch)
            await chrome.tabs.update(tabId, { active: true });
            await sleep(100 + Math.random() * 200);

            // CAPTCHA check
            if (await hasCaptcha(tabId)) {
              log(`CAPTCHA on listing after ${state.listingsChecked} checks. Solve it and restart.`);
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

            // Attach debugger to listing tab for trusted interaction
            const listingDbg = await attachDebugger(tabId);
            if (listingDbg) {
              await quickBrowseListing(tabId);
            }

            // Read demand signal (DOM read only — invisible to detection)
            const result = await checkListingTab(tabId);

            if (result) {
              matchingProducts.push({
                title: result.title,
                url,
                image_url: result.imageUrl,
                sold_count: result.soldCount,
              });
              state.productsFound++;
              log(`MATCH: ${result.soldCount} - ${result.title.substring(0, 60)}`);
            }

            // Detach debugger before closing
            await detachDebugger(tabId);
          } catch (e) {}

          // Variable delay: 85% quick glance, 15% longer read
          const glanceTime =
            Math.random() < 0.15
              ? 600 + Math.random() * 1000
              : 150 + Math.random() * 300;
          await sleep(glanceTime);
        }

        // Close all row tabs
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
          await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
        }

        // Inter-row pause
        await sleep(150 + Math.random() * 350);

        // Occasional "distraction" pause (~10% of rows)
        if (Math.random() < 0.1) {
          await sleep(1500 + Math.random() * 3000);
        }
      }

      // Between search pages
      if (page < totalPages) {
        await sleep(1000 + Math.random() * 2000);

        // Longer break every 5 pages
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
      log(`Done! Found ${state.productsFound} trending product(s) across ${state.listingsChecked} listings.`);
    } else {
      state.status = "cancelled";
    }
  } catch (e) {
    state.status = "error";
    log(`Search failed: ${e.message}`);
  }

  // Cleanup
  for (const tabId of activeTabs) {
    await detachDebugger(tabId);
    await closeTab(tabId);
  }
  activeTabs = [];
  if (searchTabId) {
    await detachDebugger(searchTabId);
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
      await fetch(`${backendUrl}/api/queue/${search.search_id}/claim`, { method: "POST" });
      await runQueuedSearch(search.keyword, search.search_id, backendUrl);
    }
  } catch (e) {}
}

setInterval(pollForQueuedSearches, 3000);
pollForQueuedSearches();
