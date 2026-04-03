// Content script: bridges the webpage and the extension background script.
// Runs on the backend website pages so the webpage can trigger searches
// and receive progress updates via the extension.

// Listen for search requests from the webpage
window.addEventListener("message", (event) => {
  if (event.source !== window) return;

  if (event.data?.type === "ETSY_START_SEARCH") {
    chrome.runtime.sendMessage({
      type: "startSearch",
      keyword: event.data.keyword,
      backendUrl: event.data.backendUrl,
    });
  } else if (event.data?.type === "ETSY_CANCEL_SEARCH") {
    chrome.runtime.sendMessage({ type: "cancelSearch" });
  } else if (event.data?.type === "ETSY_GET_STATE") {
    chrome.runtime.sendMessage({ type: "getState" }, (resp) => {
      window.postMessage({
        type: "ETSY_STATE",
        state: resp?.state || null,
      }, "*");
    });
  }
});

// Forward progress updates from the background script to the webpage
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") {
    window.postMessage({
      type: "ETSY_PROGRESS",
      state: msg.state,
    }, "*");
  }
});

// Let the page know the extension is installed
window.postMessage({ type: "ETSY_EXTENSION_READY" }, "*");
