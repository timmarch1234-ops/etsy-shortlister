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
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "progress", state }).catch(() => {});
    }
  });
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Generous delays to avoid detection — we have far fewer page loads now
function searchPageDelay() {
  return 8000 + Math.random() * 12000; // 8-20 seconds between search pages
}

function listingPageDelay() {
  return 5000 + Math.random() * 10000; // 5-15 seconds between listing visits
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

// Simulate human scrolling — scroll through the full page in stages
async function simulateHumanBehavior(tabId) {
  try {
    // Scroll down in 3-5 increments like a real person browsing
    const scrollSteps = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < scrollSteps; i++) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const step = 300 + Math.random() * 600;
          window.scrollBy({ top: step, behavior: "smooth" });
        },
      });
      await sleep(800 + Math.random() * 1500);
    }
  } catch (e) {}
}

// Check if page has a CAPTCHA or ban
async function hasCaptcha(tabId) {
  try {
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
  } catch (e) {
    return false;
  }
}

// Extract products with demand signals directly from the search results page
// This avoids visiting individual listing pages — the search page often shows
// "X+ bought in past 24 hours" right on the listing cards
async function extractProductsFromSearchPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const products = [];
      const seenIds = new Set();

      // Find all listing cards on the search page
      const listingLinks = document.querySelectorAll('a[href*="/listing/"]');

      for (const link of listingLinks) {
        const hrefMatch = link.href.match(/\/listing\/(\d+)/);
        if (!hrefMatch || seenIds.has(hrefMatch[1])) continue;
        seenIds.add(hrefMatch[1]);

        // Walk up the DOM to find the listing card container
        let card = link.closest('[data-listing-id]') ||
                   link.closest('.v2-listing-card') ||
                   link.closest('.wt-grid__item-xs-6') ||
                   link.closest('[class*="listing-card"]');
        if (!card) {
          // Fallback: walk up to find a reasonable container
          let el = link;
          for (let i = 0; i < 8; i++) {
            if (el.parentElement) el = el.parentElement;
            // Stop at something that looks like a card
            if (el.offsetHeight > 150 && el.offsetWidth > 100) {
              card = el;
              break;
            }
          }
        }
        if (!card) card = link.parentElement?.parentElement || link.parentElement;

        const cardText = card?.innerText || "";

        // ONLY match "bought/sold in past 24 hours" signals
        const soldMatch = cardText.match(
          /(\d+\+?)\s+(?:people\s+)?(?:bought|sold)\s+(?:this\s+)?in\s+(?:the\s+)?(?:past|last)\s+24\s+hours/i
        );

        if (soldMatch) {
          // Extract title from the link or card
          const titleEl = card?.querySelector('h3, h2, [class*="title"]') || link;
          const title = titleEl?.textContent?.trim()?.substring(0, 120) || "";

          // Extract image
          const img = card?.querySelector("img");
          const imageUrl = img?.src || "";

          const listingUrl = `https://www.etsy.com/listing/${hrefMatch[1]}`;

          products.push({
            title,
            url: listingUrl,
            image_url: imageUrl,
            sold_count: soldMatch[0].trim(),
            listing_id: hrefMatch[1],
          });
        }
      }

      return products;
    },
  });
  return results[0]?.result || [];
}

// Check a single listing page for demand signals (used for spot-checks)
async function checkListingPage(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const bodyText = document.body?.innerText || "";

      // ONLY match "bought/sold in past 24 hours" — not baskets
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
}

// ========================================================================
// HYBRID SEARCH APPROACH
// Phase 1: Scan all 20 search result pages (~20 page loads, ~5-10 min)
//   - Extract demand signals shown inline on search cards
//   - Collect listing IDs that had no visible signal for potential spot-check
// Phase 2: Spot-check a sample of listings (~30-50 page loads, ~10-15 min)
//   - Visit a subset of listings without inline signals to catch ones
//     that only show demand signals on the listing page itself
// Total: ~50-70 page loads instead of ~1,200 = no bans, fits in 25-30 min
// ========================================================================

async function runHybridSearch(keyword, backendUrl, reportProgress) {
  const totalPages = 20;
  state = defaultState(keyword, totalPages);
  saveState();
  broadcast();

  const matchingProducts = [];
  const allListingIds = new Set();     // all listings seen across search pages
  const matchedIds = new Set();        // listings that had inline demand signals
  const uncheckedListings = [];        // listings without inline signals (for spot-check)

  try {
    log("Starting smart search...");
    if (reportProgress) await reportProgress("running");

    // Create tab
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    searchTabId = tab.id;

    // Warm up: visit Etsy homepage like a real user
    try {
      await navigateTab(searchTabId, "https://www.etsy.com");
      await sleep(3000 + Math.random() * 4000);
      await simulateHumanBehavior(searchTabId);
      await sleep(2000 + Math.random() * 3000);
    } catch (e) {}

    // ---- PHASE 1: Scan search result pages ----
    log("Phase 1: Scanning search pages for trending products...");

    for (let page = 1; page <= totalPages; page++) {
      if (state.cancelled) break;

      state.currentPage = page;
      log(`Scanning page ${page} of ${totalPages}...`);
      broadcast();
      if (reportProgress) await reportProgress("running");

      const searchUrl = `https://www.etsy.com/search?q=${encodeURIComponent(keyword)}&ref=search_bar&page=${page}`;

      try {
        await navigateTab(searchTabId, searchUrl);
        await sleep(3000 + Math.random() * 3000);
      } catch (e) {
        log(`Page ${page}: Failed to load - ${e.message}`);
        continue;
      }

      // Check for CAPTCHA
      if (await hasCaptcha(searchTabId)) {
        log("CAPTCHA/ban detected! Please solve it in the Etsy tab, then restart.");
        state.status = "error";
        saveState();
        broadcast();
        if (searchTabId) chrome.tabs.update(searchTabId, { active: true });
        if (reportProgress) await reportProgress("error");
        return;
      }

      // Scroll through the page like a real user reading results
      await simulateHumanBehavior(searchTabId);
      await sleep(1000 + Math.random() * 2000);

      // Extract products with demand signals from search page
      let foundProducts = [];
      try {
        foundProducts = await extractProductsFromSearchPage(searchTabId);
      } catch (e) {
        log(`Page ${page}: Failed to extract - ${e.message}`);
      }

      // Also collect ALL listing IDs on this page for tracking
      let allPageListings = [];
      try {
        const idResults = await chrome.scripting.executeScript({
          target: { tabId: searchTabId },
          func: () => {
            const links = document.querySelectorAll('a[href*="/listing/"]');
            const seen = new Set();
            const listings = [];
            links.forEach((a) => {
              const m = a.href.match(/\/listing\/(\d+)/);
              if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                listings.push({
                  id: m[1],
                  url: `https://www.etsy.com/listing/${m[1]}`,
                });
              }
            });
            return listings;
          },
        });
        allPageListings = idResults[0]?.result || [];
      } catch (e) {}

      // Track all listings
      for (const listing of allPageListings) {
        allListingIds.add(listing.id);
      }

      // Track matches found on search page
      for (const product of foundProducts) {
        if (!matchedIds.has(product.listing_id)) {
          matchedIds.add(product.listing_id);
          matchingProducts.push({
            title: product.title,
            url: product.url,
            image_url: product.image_url,
            sold_count: product.sold_count,
          });
          state.productsFound++;
          log(`FOUND: ${product.sold_count} - ${product.title.substring(0, 60)}`);
        }
      }

      // Collect unchecked listings for phase 2
      for (const listing of allPageListings) {
        if (!matchedIds.has(listing.id)) {
          uncheckedListings.push(listing);
        }
      }

      state.listingsChecked += allPageListings.length;
      broadcast();

      // Send batch to backend
      if (matchingProducts.length >= 5) {
        await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
      }

      // Delay between search pages — generous to look human
      if (page < totalPages) {
        const delay = searchPageDelay();
        log(`Pausing before next page...`);
        await sleep(delay);
      }
    }

    log(`Phase 1 complete: Found ${state.productsFound} trending product(s) from search pages.`);
    log(`${uncheckedListings.length} listings had no visible signal on search page.`);

    // ---- PHASE 2: Spot-check a sample of unchecked listings ----
    // Some demand signals only appear on the listing page itself,
    // so we spot-check a random sample to catch extras.
    // Limit to ~40 spot-checks to stay well within time and rate limits.

    const SPOT_CHECK_LIMIT = 40;

    if (uncheckedListings.length > 0 && !state.cancelled) {
      // Shuffle for random sampling but cap at limit
      const shuffled = uncheckedListings.sort(() => Math.random() - 0.5);
      const toCheck = shuffled.slice(0, SPOT_CHECK_LIMIT);

      log(`Phase 2: Spot-checking ${toCheck.length} listings for hidden demand signals...`);
      if (reportProgress) await reportProgress("running");

      for (let i = 0; i < toCheck.length; i++) {
        if (state.cancelled) break;

        const listing = toCheck[i];

        // Check for cancellation from website
        if (reportProgress) {
          try {
            // Check cancelled status handled at top of loop
          } catch (e) {}
        }

        try {
          await sleep(listingPageDelay());
          await navigateTab(searchTabId, listing.url);
          await sleep(3000 + Math.random() * 3000);

          // Check for CAPTCHA
          if (await hasCaptcha(searchTabId)) {
            log("CAPTCHA detected during spot-check! Solve it and restart.");
            state.status = "error";
            saveState();
            broadcast();
            if (searchTabId) chrome.tabs.update(searchTabId, { active: true });
            if (reportProgress) await reportProgress("error");
            return;
          }

          // Simulate reading the listing
          await simulateHumanBehavior(searchTabId);

          const result = await checkListingPage(searchTabId);

          if (result) {
            matchingProducts.push({
              title: result.title,
              url: listing.url,
              image_url: result.imageUrl,
              sold_count: result.soldCount,
            });
            state.productsFound++;
            log(`FOUND: ${result.soldCount} - ${result.title.substring(0, 60)}`);
          }

          if (i % 10 === 9) {
            log(`Spot-checked ${i + 1}/${toCheck.length}...`);
          }
        } catch (e) {
          log(`Error checking listing: ${e.message}`);
        }

        broadcast();
        if (reportProgress) await reportProgress("running");

        // Extra break every 10 listings
        if (i > 0 && i % 10 === 0) {
          const breakTime = 10000 + Math.random() * 15000;
          log("Taking a brief pause...");
          await sleep(breakTime);
        }

        // Send batch to backend
        if (matchingProducts.length >= 5) {
          await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
        }
      }

      log(`Phase 2 complete. Spot-checked ${Math.min(toCheck.length, SPOT_CHECK_LIMIT)} listings.`);
    }

    // Send remaining matches
    if (matchingProducts.length > 0) {
      await sendToBackend(keyword, matchingProducts.splice(0), backendUrl);
    }

    if (!state.cancelled) {
      state.status = "completed";
      log(`Search completed! Found ${state.productsFound} trending product(s) across ${allListingIds.size} listings scanned.`);
    } else {
      state.status = "cancelled";
    }
  } catch (e) {
    state.status = "error";
    log(`Search failed: ${e.message}`);
  }

  // Clean up
  if (searchTabId) {
    try {
      chrome.tabs.remove(searchTabId);
    } catch (e) {}
    searchTabId = null;
  }

  saveState();
  broadcast();
  if (reportProgress) await reportProgress(state.status);
}

// Direct search (from extension popup or content script)
async function runSearch(keyword, backendUrl) {
  await runHybridSearch(keyword, backendUrl, null);
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

  await runHybridSearch(keyword, backendUrl, reportProgress);
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

      await runQueuedSearch(search.keyword, search.search_id, backendUrl);
    }
  } catch (e) {
    // Backend not reachable, skip
  }
}

// Poll every 3 seconds
setInterval(pollForQueuedSearches, 3000);
pollForQueuedSearches();
