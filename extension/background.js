const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";

let state = null;
let searchTabId = null;

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
  // Also send to all tabs running the content script
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "progress", state }).catch(() => {});
    }
  });
}

// Delay between listing visits (page load itself adds ~1-2s)
// Target: ~1200 listings in 25-30 min = ~1.3s per listing including load
function humanDelay() {
  return 200 + Math.random() * 500; // 0.2-0.7 seconds
}

// Delay between search pages
function pageDelay() {
  return 1500 + Math.random() * 1500; // 1.5-3 seconds
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

// Navigate a tab and wait for it to finish loading
function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Page load timeout"));
    }, 30000);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeout);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.update(tabId, { url });
  });
}

// Simulate human scrolling on the page
async function simulateHumanBehavior(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Scroll down slowly like a human reading
        const scrollStep = 200 + Math.random() * 300;
        window.scrollBy({ top: scrollStep, behavior: "smooth" });
      },
    });
    await sleep(500 + Math.random() * 1000);
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const scrollStep = 300 + Math.random() * 500;
        window.scrollBy({ top: scrollStep, behavior: "smooth" });
      },
    });
  } catch (e) {}
}

// Check if page has a CAPTCHA or ban
async function hasCaptcha(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const title = document.title || "";
      const iframes = document.querySelectorAll("iframe");
      const divs = document.querySelectorAll("div");
      if (divs.length < 5 && iframes.length > 0 && title.length < 20) return true;
      if (document.body?.innerText?.toLowerCase().includes("captcha")) return true;
      if (document.body?.innerText?.includes("Access is temporarily restricted")) return true;
      return false;
    },
  });
  return results[0]?.result || false;
}

// Extract listing URLs from search results page
async function extractListingUrls(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const links = document.querySelectorAll('a[href*="/listing/"]');
      const seen = new Set();
      const urls = [];
      links.forEach((a) => {
        const match = a.href.match(/\/listing\/(\d+)/);
        if (match && !seen.has(match[1])) {
          seen.add(match[1]);
          urls.push(`https://www.etsy.com/listing/${match[1]}`);
        }
      });
      return urls;
    },
  });
  return results[0]?.result || [];
}

// Check a listing page for demand signals
async function checkListingPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const bodyText = document.body?.innerText || "";

      const boughtMatch = bodyText.match(
        /(\d+\+?)\s+(?:people\s+)?bought\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s+hours/i
      );
      const basketMatch = bodyText.match(/[Ii]n\s+(\d+\+?)\s+baskets?/i);
      const match = boughtMatch || basketMatch;

      if (!match) return null;

      const soldCount = match[0].trim();
      const title = document.title?.split(" - Etsy")[0]?.trim() || "";
      const ogImg = document.querySelector('meta[property="og:image"]');
      const imageUrl = ogImg?.content || "";

      return { soldCount, title, imageUrl };
    },
  });
  return results[0]?.result || null;
}

async function runSearch(keyword, backendUrl) {
  const totalPages = 20;
  state = defaultState(keyword, totalPages);
  saveState();
  broadcast();

  const matchingProducts = [];

  try {
    log("Starting search...");

    // Create a tab for searching (in background)
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    searchTabId = tab.id;

    // First visit Etsy homepage to warm up cookies (like a real user)
    try {
      await navigateTab(searchTabId, "https://www.etsy.com");
      await sleep(2000 + Math.random() * 3000);
      await simulateHumanBehavior(searchTabId);
      await sleep(1000 + Math.random() * 2000);
    } catch (e) {}

    for (let page = 1; page <= totalPages; page++) {
      if (state.cancelled) {
        log("Search cancelled.");
        break;
      }

      state.currentPage = page;
      log(`Searching page ${page} of ${totalPages}...`);
      broadcast();

      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

      try {
        await navigateTab(searchTabId, searchUrl);
        // Wait for page to fully render
        await sleep(2000 + Math.random() * 2000);
      } catch (e) {
        log(`Page ${page}: Failed to load - ${e.message}`);
        continue;
      }

      // Check for CAPTCHA / ban
      try {
        if (await hasCaptcha(searchTabId)) {
          log(`CAPTCHA/ban detected! Please solve it in the Etsy tab, then restart the search.`);
          state.status = "error";
          saveState();
          broadcast();
          if (searchTabId) chrome.tabs.update(searchTabId, { active: true });
          return;
        }
      } catch (e) {}

      // Simulate scrolling through search results like a human
      await simulateHumanBehavior(searchTabId);
      await sleep(1000 + Math.random() * 1500);

      // Extract all listing URLs
      let listingUrls;
      try {
        listingUrls = await extractListingUrls(searchTabId);
      } catch (e) {
        log(`Page ${page}: Failed to extract listings - ${e.message}`);
        continue;
      }

      log(`Page ${page}: Found ${listingUrls.length} listings to check.`);

      if (listingUrls.length === 0 && page > 1) continue;

      // Visit each listing top to bottom
      for (let i = 0; i < listingUrls.length; i++) {
        if (state.cancelled) break;

        const listingUrl = listingUrls[i];
        state.listingsChecked++;

        // Human-like delay between listings
        await sleep(humanDelay());

        try {
          await navigateTab(searchTabId, listingUrl);
          // Wait for page to render
          await sleep(500 + Math.random() * 500);

          // Check for CAPTCHA mid-search
          try {
            if (await hasCaptcha(searchTabId)) {
              log(`CAPTCHA detected after ${state.listingsChecked} listings. Solve it and restart.`);
              state.status = "error";
              saveState();
              broadcast();
              if (searchTabId) chrome.tabs.update(searchTabId, { active: true });
              return;
            }
          } catch (e) {}

          // Simulate reading the page
          await simulateHumanBehavior(searchTabId);

          const result = await checkListingPage(searchTabId);

          if (result) {
            matchingProducts.push({
              title: result.title,
              url: listingUrl,
              image_url: result.imageUrl,
              sold_count: result.soldCount,
            });

            state.productsFound++;
            log(`MATCH: ${result.soldCount} - ${result.title.substring(0, 60)}`);

            // Send batch every 5 matches
            if (matchingProducts.length >= 5) {
              await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
            }
          }
        } catch (e) {
          log(`Error checking listing: ${e.message}`);
        }

        broadcast();
      }

      // Longer delay between search pages
      if (page < totalPages) {
        const delay = pageDelay();
        log(`Moving to next page...`);
        await sleep(delay);
      }
    }

    // Send remaining matches
    if (matchingProducts.length > 0) {
      await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
    }

    if (!state.cancelled) {
      state.status = "completed";
      log(`Search completed! Found ${state.productsFound} trending product(s) across ${state.listingsChecked} listings.`);
    } else {
      state.status = "cancelled";
    }
  } catch (e) {
    state.status = "error";
    log(`Search failed: ${e.message}`);
  }

  // Clean up the search tab
  if (searchTabId) {
    try {
      chrome.tabs.remove(searchTabId);
    } catch (e) {}
    searchTabId = null;
  }

  saveState();
  broadcast();
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

// --- Poll backend for queued searches from the website ---

let currentQueuedSearchId = null;

async function pollForQueuedSearches() {
  let backendUrl = DEFAULT_BACKEND;
  try {
    const data = await chrome.storage.local.get(["backendUrl"]);
    if (data.backendUrl) backendUrl = data.backendUrl;
  } catch (e) {}

  // Don't poll if already running a search
  if (state && state.status === "running") return;

  try {
    const resp = await fetch(`${backendUrl}/api/queue/pending`);
    const pending = await resp.json();

    if (pending.length > 0) {
      const search = pending[0];
      currentQueuedSearchId = search.search_id;

      // Claim it
      await fetch(`${backendUrl}/api/queue/${search.search_id}/claim`, {
        method: "POST",
      });

      // Run the search with progress reporting to the queue
      await runQueuedSearch(search.keyword, search.search_id, backendUrl);
    }
  } catch (e) {
    // Backend not reachable, skip
  }
}

async function runQueuedSearch(keyword, queueSearchId, backendUrl) {
  const totalPages = 20;
  state = defaultState(keyword, totalPages);
  saveState();
  broadcast();

  const matchingProducts = [];

  async function reportProgress(status) {
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
  }

  try {
    log("Starting search...");
    await reportProgress("running");

    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    searchTabId = tab.id;

    // Warm up with Etsy homepage
    try {
      await navigateTab(searchTabId, "https://www.etsy.com");
      await sleep(2000 + Math.random() * 3000);
      await simulateHumanBehavior(searchTabId);
      await sleep(1000 + Math.random() * 2000);
    } catch (e) {}

    for (let page = 1; page <= totalPages; page++) {
      if (state.cancelled) {
        log("Search cancelled.");
        break;
      }

      // Check if cancelled from website
      try {
        const pr = await fetch(`${backendUrl}/api/queue/${queueSearchId}/progress`);
        const prData = await pr.json();
        if (prData.status === "cancelled") {
          state.cancelled = true;
          log("Search cancelled from website.");
          break;
        }
      } catch (e) {}

      state.currentPage = page;
      log(`Searching page ${page} of ${totalPages}...`);
      broadcast();
      await reportProgress("running");

      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

      try {
        await navigateTab(searchTabId, searchUrl);
        await sleep(2000 + Math.random() * 2000);
      } catch (e) {
        log(`Page ${page}: Failed to load - ${e.message}`);
        continue;
      }

      try {
        if (await hasCaptcha(searchTabId)) {
          log(`CAPTCHA/ban detected! Solve it and restart.`);
          state.status = "error";
          saveState();
          broadcast();
          if (searchTabId) chrome.tabs.update(searchTabId, { active: true });
          await reportProgress("error");
          return;
        }
      } catch (e) {}

      await simulateHumanBehavior(searchTabId);
      await sleep(1000 + Math.random() * 1500);

      let listingUrls;
      try {
        listingUrls = await extractListingUrls(searchTabId);
      } catch (e) {
        log(`Page ${page}: Failed to extract - ${e.message}`);
        continue;
      }

      log(`Page ${page}: Found ${listingUrls.length} listings to check.`);

      if (listingUrls.length === 0 && page > 1) continue;

      shuffle(listingUrls);

      for (let i = 0; i < listingUrls.length; i++) {
        if (state.cancelled) break;

        const listingUrl = listingUrls[i];
        state.listingsChecked++;

        await sleep(humanDelay());

        try {
          await navigateTab(searchTabId, listingUrl);
          await sleep(1500 + Math.random() * 2000);

          try {
            if (await hasCaptcha(searchTabId)) {
              log(`CAPTCHA detected after ${state.listingsChecked} listings. Solve it and restart.`);
              state.status = "error";
              saveState();
              broadcast();
              if (searchTabId) chrome.tabs.update(searchTabId, { active: true });
              await reportProgress("error");
              return;
            }
          } catch (e) {}

          await simulateHumanBehavior(searchTabId);

          const result = await checkListingPage(searchTabId);

          if (result) {
            matchingProducts.push({
              title: result.title,
              url: listingUrl,
              image_url: result.imageUrl,
              sold_count: result.soldCount,
            });

            state.productsFound++;
            log(`MATCH: ${result.soldCount} - ${result.title.substring(0, 60)}`);

            if (matchingProducts.length >= 5) {
              await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
            }
          }
        } catch (e) {
          log(`Error checking listing: ${e.message}`);
        }

        broadcast();
        await reportProgress("running");

        if (i > 0 && i % 15 === 0) {
          const breakTime = 15000 + Math.random() * 20000;
          log(`Brief pause...`);
          await sleep(breakTime);
        }
      }

      if (page < totalPages) {
        const delay = pageDelay();
        log(`Moving to next page...`);
        await sleep(delay);
      }
    }

    if (matchingProducts.length > 0) {
      await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
    }

    if (!state.cancelled) {
      state.status = "completed";
      log(`Search completed! Found ${state.productsFound} trending product(s) across ${state.listingsChecked} listings.`);
    } else {
      state.status = "cancelled";
    }
  } catch (e) {
    state.status = "error";
    log(`Search failed: ${e.message}`);
  }

  if (searchTabId) {
    try {
      chrome.tabs.remove(searchTabId);
    } catch (e) {}
    searchTabId = null;
  }

  saveState();
  broadcast();
  await reportProgress(state.status);
  currentQueuedSearchId = null;
}

// Poll every 3 seconds
setInterval(pollForQueuedSearches, 3000);
pollForQueuedSearches();
