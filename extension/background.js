const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";

let state = null;
let searchTabId = null;

function defaultState(keyword) {
  return {
    status: "running",
    keyword,
    currentPage: 0,
    totalPages: 20,
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

// Check if page has a CAPTCHA
async function hasCaptcha(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const title = document.title || "";
      const iframes = document.querySelectorAll("iframe");
      const divs = document.querySelectorAll("div");
      // DataDome CAPTCHA: nearly empty page with an iframe
      if (divs.length < 5 && iframes.length > 0 && title.length < 20) return true;
      if (document.body?.innerText?.toLowerCase().includes("captcha")) return true;
      return false;
    },
  });
  return results[0]?.result || false;
}

// Extract products with demand signals directly from search results page
// This avoids visiting each listing individually (which triggers rate limits)
async function extractProductsFromSearchPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const products = [];
      // Etsy search results are in listing cards
      // Look for all listing links and their surrounding context
      const listingCards = document.querySelectorAll('[data-listing-id], .v2-listing-card, .wt-grid__item-xs-6');

      if (listingCards.length > 0) {
        listingCards.forEach((card) => {
          const text = card.innerText || "";
          const boughtMatch = text.match(
            /(\d+\+?)\s+(?:people\s+)?bought\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s+hours/i
          );
          const basketMatch = text.match(/[Ii]n\s+(\d+\+?)\s+baskets?/i);
          const demandMatch = boughtMatch || basketMatch;

          if (demandMatch) {
            const link = card.querySelector('a[href*="/listing/"]');
            const img = card.querySelector('img');
            const titleEl = card.querySelector('h3, h2, [class*="title"], .v2-listing-card__title');

            if (link) {
              products.push({
                title: titleEl?.textContent?.trim() || "",
                url: link.href.split("?")[0],
                image_url: img?.src || "",
                sold_count: demandMatch[0].trim(),
              });
            }
          }
        });
      }

      // Fallback: scan the full page text for demand signals near listing links
      if (products.length === 0) {
        const allLinks = document.querySelectorAll('a[href*="/listing/"]');
        const seen = new Set();
        allLinks.forEach((link) => {
          const listingMatch = link.href.match(/\/listing\/(\d+)/);
          if (!listingMatch || seen.has(listingMatch[1])) return;

          // Check the parent elements for demand signals
          let el = link;
          for (let i = 0; i < 5; i++) {
            el = el.parentElement;
            if (!el) break;
            const text = el.innerText || "";
            const boughtMatch = text.match(
              /(\d+\+?)\s+(?:people\s+)?bought\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s+hours/i
            );
            const basketMatch = text.match(/[Ii]n\s+(\d+\+?)\s+baskets?/i);
            const demandMatch = boughtMatch || basketMatch;

            if (demandMatch) {
              seen.add(listingMatch[1]);
              const img = el.querySelector('img');
              const titleEl = el.querySelector('h3, h2');
              products.push({
                title: titleEl?.textContent?.trim() || "",
                url: `https://www.etsy.com/listing/${listingMatch[1]}`,
                image_url: img?.src || "",
                sold_count: demandMatch[0].trim(),
              });
              break;
            }
          }
        });
      }

      // Also return total listing count for progress
      const allListingLinks = document.querySelectorAll('a[href*="/listing/"]');
      const uniqueIds = new Set();
      allListingLinks.forEach((a) => {
        const m = a.href.match(/\/listing\/(\d+)/);
        if (m) uniqueIds.add(m[1]);
      });

      return { products, totalListings: uniqueIds.size };
    },
  });
  return results[0]?.result || { products: [], totalListings: 0 };
}

async function runSearch(keyword, backendUrl) {
  state = defaultState(keyword);
  saveState();
  broadcast();

  const matchingProducts = [];

  try {
    log("Starting search...");

    // Create a tab for searching (in background)
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    searchTabId = tab.id;

    for (let page = 1; page <= 20; page++) {
      if (state.cancelled) {
        log("Search cancelled.");
        break;
      }

      state.currentPage = page;
      log(`Scanning page ${page} of 20...`);
      broadcast();

      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

      try {
        await navigateTab(searchTabId, searchUrl);
        // Wait for page to fully render
        await sleep(3000 + Math.random() * 2000);
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
          if (searchTabId) {
            chrome.tabs.update(searchTabId, { active: true });
          }
          return;
        }
      } catch (e) {}

      // Extract products with demand signals directly from the search page
      let result;
      try {
        result = await extractProductsFromSearchPage(searchTabId);
      } catch (e) {
        log(`Page ${page}: Failed to extract - ${e.message}`);
        continue;
      }

      state.listingsChecked += result.totalListings;

      if (result.products.length > 0) {
        for (const p of result.products) {
          matchingProducts.push(p);
          state.productsFound++;
          log(`MATCH: ${p.sold_count} - ${p.title.substring(0, 60)}`);
        }

        // Send batch every 5 matches
        if (matchingProducts.length >= 5) {
          await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
        }
      }

      log(`Page ${page}: ${result.totalListings} listings, ${result.products.length} with demand signals.`);
      broadcast();

      if (result.totalListings === 0 && page > 1) continue;

      // Longer delay between pages to avoid rate limits
      await sleep(4000 + Math.random() * 3000);
    }

    // Send remaining matches
    if (matchingProducts.length > 0) {
      await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
    }

    if (!state.cancelled) {
      state.status = "completed";
      log(`Search completed! Found ${state.productsFound} trending product(s).`);
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
  state = defaultState(keyword);
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

    // Create a tab for searching
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    searchTabId = tab.id;

    for (let page = 1; page <= 20; page++) {
      if (state.cancelled) {
        log("Search cancelled.");
        break;
      }

      // Check if cancelled from website
      try {
        const pr = await fetch(
          `${backendUrl}/api/queue/${queueSearchId}/progress`
        );
        const prData = await pr.json();
        if (prData.status === "cancelled") {
          state.cancelled = true;
          log("Search cancelled from website.");
          break;
        }
      } catch (e) {}

      state.currentPage = page;
      log(`Searching page ${page} of 20...`);
      broadcast();
      await reportProgress("running");

      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

      try {
        await navigateTab(searchTabId, searchUrl);
        await sleep(3000 + Math.random() * 2000);
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
          await reportProgress("error");
          return;
        }
      } catch (e) {}

      let result;
      try {
        result = await extractProductsFromSearchPage(searchTabId);
      } catch (e) {
        log(`Page ${page}: Failed to extract - ${e.message}`);
        continue;
      }

      state.listingsChecked += result.totalListings;

      if (result.products.length > 0) {
        for (const p of result.products) {
          matchingProducts.push(p);
          state.productsFound++;
          log(`MATCH: ${p.sold_count} - ${p.title.substring(0, 60)}`);
        }

        if (matchingProducts.length >= 5) {
          await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
        }
      }

      log(`Page ${page}: ${result.totalListings} listings, ${result.products.length} with demand signals.`);
      broadcast();
      await reportProgress("running");

      if (result.totalListings === 0 && page > 1) continue;

      await sleep(4000 + Math.random() * 3000);
    }

    if (matchingProducts.length > 0) {
      await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
    }

    if (!state.cancelled) {
      state.status = "completed";
      log(`Search completed! Found ${state.productsFound} trending product(s).`);
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
  await reportProgress(state.status);
  currentQueuedSearchId = null;
}

// Poll every 3 seconds
setInterval(pollForQueuedSearches, 3000);
// Also poll on startup
pollForQueuedSearches();
