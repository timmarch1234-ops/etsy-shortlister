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
// NATIVE MESSAGING — Real physical mouse control via pyautogui
//
// The Python host receives commands and moves the REAL cursor.
// Every mouse movement, click, and scroll is a genuine OS event.
// No anti-bot system can detect this — it IS real human input.
// ============================================================

let nativePort = null;
let nativeReady = false;
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
      const err = chrome.runtime.lastError?.message || "no error message";
      console.log("[shortlister] Native host disconnected:", err);
      if (state) log("Native host disconnected: " + err);
      nativePort = null;
      nativeReady = false;
      // Resolve any pending command so it doesn't hang
      if (pendingResolve) {
        const resolve = pendingResolve;
        pendingResolve = null;
        resolve({ ok: false, error: "disconnected" });
      }
    });

    nativeReady = true;
    return true;
  } catch (e) {
    console.log("[shortlister] Failed to connect native host:", e.message);
    nativePort = null;
    nativeReady = false;
    return false;
  }
}

function sendNativeCommand(command) {
  return new Promise((resolve, reject) => {
    if (!nativePort) {
      resolve({ ok: false, error: "not connected" });
      return;
    }
    pendingResolve = resolve;
    try {
      nativePort.postMessage(command);
    } catch (e) {
      pendingResolve = null;
      resolve({ ok: false, error: e.message });
      return;
    }

    // Timeout — don't hang if host doesn't respond
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        resolve({ ok: true, timeout: true });
      }
    }, 3000);
  });
}

// ============================================================
// COORDINATE CALIBRATION
//
// The extension knows viewport coordinates (CSS pixels).
// pyautogui needs screen coordinates. We calibrate by reading
// window.screenX/Y and the browser chrome height, then the
// Python host handles the translation for every command.
// ============================================================

async function calibrateCoordinates(tabId) {
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
    if (info) {
      await sendNativeCommand({ action: "calibrate", ...info });
    }
  } catch (e) {
    console.log("[shortlister] Calibration failed:", e.message);
  }
}

// ============================================================
// MOUSE / SCROLL / CLICK — via native host (real cursor)
// ============================================================

async function trustedMouseMove(toX, toY) {
  try {
    await sendNativeCommand({
      action: "move_bezier",
      fromX: lastMouseX,
      fromY: lastMouseY,
      toX,
      toY,
    });
  } catch (e) {}
  lastMouseX = Math.round(toX);
  lastMouseY = Math.round(toY);
}

async function trustedClick(x, y) {
  try {
    await sendNativeCommand({ action: "click", x, y, button: "left" });
  } catch (e) {}
}

async function trustedScroll(deltaY) {
  try {
    await sendNativeCommand({
      action: "scroll",
      x: lastMouseX,
      y: lastMouseY,
      deltaY,
    });
  } catch (e) {}
}

async function idleMouseWander(cx, cy) {
  try {
    await sendNativeCommand({ action: "wander", x: cx, y: cy });
  } catch (e) {}
  lastMouseX = cx;
  lastMouseY = cy;
}

// ============================================================
// HUMAN SIMULATION — Composites
// ============================================================

async function browsePageNaturally(tabId) {
  await calibrateCoordinates(tabId);
  await idleMouseWander(400 + Math.random() * 300, 300 + Math.random() * 200);
  await sleep(200 + Math.random() * 400);

  // Scroll down in a few stages
  const stages = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < stages; i++) {
    await trustedScroll(200 + Math.random() * 350);
    await sleep(400 + Math.random() * 700);
    if (Math.random() < 0.5) {
      await trustedMouseMove(
        200 + Math.random() * 600,
        200 + Math.random() * 400
      );
    }
  }
}

async function quickBrowseListing(tabId) {
  await calibrateCoordinates(tabId);
  // Move mouse around the listing (title, images, details)
  await trustedMouseMove(300 + Math.random() * 400, 200 + Math.random() * 200);
  await sleep(100 + Math.random() * 250);
  await trustedScroll(150 + Math.random() * 250);
  await sleep(80 + Math.random() * 180);
  await trustedMouseMove(200 + Math.random() * 500, 300 + Math.random() * 200);
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
// MAIN SEARCH — Row-by-row with REAL mouse movement
//
// The physical cursor moves across the screen exactly like a
// human browsing Etsy. pyautogui controls the real OS cursor
// with Bezier curves, micro-jitter, and variable speed.
//
// Flow for each search page:
// 1. Navigate to search page
// 2. Browse naturally (real mouse wander + real scroll)
// 3. Scroll back to top
// 4. For each row of ~4 listings:
//    a. Move real cursor to each listing, linger briefly
//    b. Open listing in new tab
//    c. Switch to tab, browse it (real mouse + scroll)
//    d. Check for demand signal (DOM read only)
//    e. Close tab, back to search page
//    f. Scroll down to next row
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

    // Connect to native mouse controller
    const nativeConnected = connectNative();
    if (nativePort) {
      try {
        const pong = await sendNativeCommand({ action: "ping" });
        if (pong?.ok && !pong.error) {
          log("Real mouse control active.");
        } else {
          log("Native host not responding. Continuing without real mouse.");
          nativePort = null;
          nativeReady = false;
        }
      } catch (e) {
        log("Native host error. Continuing without real mouse.");
        nativePort = null;
        nativeReady = false;
      }
    } else {
      log("No native mouse host. Continuing without real mouse movement.");
    }

    // Create search tab (foreground)
    const mainTab = await chrome.tabs.create({ url: "about:blank", active: true });
    searchTabId = mainTab.id;

    // ---- Warm up: visit Etsy homepage ----
    log("Warming up...");
    await navigateTab(searchTabId, "https://www.etsy.com");
    await sleep(2000 + Math.random() * 2000);

    if (nativePort) {
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

      // CAPTCHA check
      if (await hasCaptcha(searchTabId)) {
        log("Access restricted! Waiting for it to clear...");
        state.status = "error";
        saveState();
        broadcast();
        chrome.tabs.update(searchTabId, { active: true });
        if (reportProgress) await reportProgress("error");
        return;
      }

      // Browse search page naturally with real mouse
      if (nativePort) {
        await browsePageNaturally(searchTabId);
        await sleep(300 + Math.random() * 500);

        // Scroll back to top
        await trustedScroll(-3000);
        await sleep(400 + Math.random() * 400);
      }

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

        // Scroll to next row on search page
        if (rowStart > 0 && nativePort) {
          await chrome.tabs.update(searchTabId, { active: true });
          await sleep(100 + Math.random() * 150);
          await calibrateCoordinates(searchTabId);
          await trustedScroll(300 + Math.random() * 80);
          await sleep(250 + Math.random() * 350);
        }

        // Re-read positions after scroll
        let freshPositions;
        try {
          freshPositions = await getListingPositions(searchTabId);
        } catch (e) {
          freshPositions = [];
        }
        if (nativePort) {
          await calibrateCoordinates(searchTabId);
        }

        // Move mouse to each listing in the row, then open it
        const rowTabs = [];
        for (let j = 0; j < rowListings.length; j++) {
          const listing = rowListings[j];
          const freshPos = freshPositions.find((p) => p.id === listing.id);
          const targetX = freshPos ? freshPos.x : 200 + j * 220;
          const targetY = freshPos ? freshPos.y : 350;

          // Move real cursor to this listing (hover over it)
          if (nativePort) {
            await trustedMouseMove(targetX, targetY);
            await sleep(40 + Math.random() * 100);
          }

          // Open in new tab
          try {
            const tab = await chrome.tabs.create({ url: listing.url, active: false });
            rowTabs.push({ id: tab.id, url: listing.url });
            activeTabs.push(tab.id);
          } catch (e) {}

          await sleep(60 + Math.random() * 120);
        }

        // Wait for all tabs to load in parallel
        if (rowTabs.length > 0) {
          await waitForAllTabs(rowTabs.map((t) => t.id), 15000);
        }
        await sleep(150 + Math.random() * 250);

        // ---- Visit each tab one by one ----
        for (let j = 0; j < rowTabs.length; j++) {
          const { id: tabId, url } = rowTabs[j];
          state.listingsChecked++;

          try {
            // Switch to this tab
            await chrome.tabs.update(tabId, { active: true });
            await sleep(100 + Math.random() * 150);

            // CAPTCHA check
            if (await hasCaptcha(tabId)) {
              log(`Access restricted after ${state.listingsChecked} listings.`);
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

            // Browse listing with real mouse
            if (nativePort) {
              await quickBrowseListing(tabId);
            }

            // Read demand signal (DOM only — invisible)
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
          } catch (e) {}

          // Variable dwell: 85% quick glance, 15% longer read
          const dwell =
            Math.random() < 0.15
              ? 500 + Math.random() * 900
              : 120 + Math.random() * 280;
          await sleep(dwell);
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
        await sleep(150 + Math.random() * 300);

        // Occasional distraction pause (~10%)
        if (Math.random() < 0.1) {
          await sleep(1200 + Math.random() * 2500);
        }
      }

      // Between search pages
      if (page < totalPages) {
        await sleep(800 + Math.random() * 1500);
        if (page % 5 === 0) {
          log("Brief break...");
          await sleep(2500 + Math.random() * 4000);
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
  for (const tabId of activeTabs) await closeTab(tabId);
  activeTabs = [];
  if (searchTabId) {
    await closeTab(searchTabId);
    searchTabId = null;
  }
  // Disconnect native host
  if (nativePort) {
    try { nativePort.disconnect(); } catch (e) {}
    nativePort = null;
    nativeReady = false;
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
