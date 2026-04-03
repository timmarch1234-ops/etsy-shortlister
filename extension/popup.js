const DEFAULT_BACKEND = "https://etsy-shortlister-production-3d4e.up.railway.app";

const keywordInput = document.getElementById("keyword");
const searchBtn = document.getElementById("searchBtn");
const cancelBtn = document.getElementById("cancelBtn");
const progressSection = document.getElementById("progressSection");
const progressBar = document.getElementById("progressBar");
const pageInfo = document.getElementById("pageInfo");
const checked = document.getElementById("checked");
const found = document.getElementById("found");
const statusText = document.getElementById("statusText");
const logDiv = document.getElementById("log");
const backendUrlInput = document.getElementById("backendUrl");
const settingsToggle = document.getElementById("settingsToggle");
const settingsBody = document.getElementById("settingsBody");
const saveSettingsBtn = document.getElementById("saveSettings");
const dashboardLink = document.getElementById("dashboardLink");

// Load settings
chrome.storage.local.get(["backendUrl", "searchState"], (data) => {
  const url = data.backendUrl || DEFAULT_BACKEND;
  backendUrlInput.value = url;
  dashboardLink.href = `${url}/shortlisted`;

  // Restore search state if running
  if (data.searchState && data.searchState.status === "running") {
    renderState(data.searchState);
  }
});

settingsToggle.addEventListener("click", () => {
  settingsBody.classList.toggle("hidden");
});

saveSettingsBtn.addEventListener("click", () => {
  const url = backendUrlInput.value.trim().replace(/\/$/, "");
  chrome.storage.local.set({ backendUrl: url });
  dashboardLink.href = `${url}/shortlisted`;
  settingsBody.classList.add("hidden");
});

searchBtn.addEventListener("click", startSearch);
keywordInput.addEventListener("keypress", (e) => {
  if (e.key === "Enter") startSearch();
});

cancelBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "cancelSearch" });
});

function startSearch() {
  const keyword = keywordInput.value.trim();
  if (!keyword) return;

  const backendUrl =
    backendUrlInput.value.trim().replace(/\/$/, "") || DEFAULT_BACKEND;

  searchBtn.disabled = true;
  progressSection.classList.remove("hidden");
  logDiv.innerHTML = "";

  chrome.runtime.sendMessage({
    type: "startSearch",
    keyword,
    backendUrl,
  });
}

function renderState(s) {
  if (!s) return;

  progressSection.classList.remove("hidden");

  const pct = (s.currentPage / s.totalPages) * 100;
  progressBar.style.width = pct + "%";
  pageInfo.textContent = `Page ${s.currentPage}/${s.totalPages}`;
  checked.textContent = `Checked: ${s.listingsChecked}`;
  found.textContent = `Found: ${s.productsFound}`;

  if (s.status === "running") {
    statusText.textContent = "Running...";
    searchBtn.disabled = true;
    cancelBtn.style.display = "inline-block";
  } else {
    statusText.textContent =
      s.status === "completed"
        ? `Done! ${s.productsFound} found`
        : s.status;
    searchBtn.disabled = false;
    cancelBtn.style.display = "none";
  }

  logDiv.innerHTML = s.log
    .map(
      (l) =>
        `<div class="${l.startsWith("MATCH") ? "match" : ""}">${escapeHtml(l)}</div>`
    )
    .join("");
  logDiv.scrollTop = logDiv.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Listen for progress updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "progress") {
    renderState(msg.state);
  }
});

// Also poll state on popup open (in case we missed messages)
chrome.runtime.sendMessage({ type: "getState" }, (resp) => {
  if (resp && resp.state) {
    renderState(resp.state);
  }
});
