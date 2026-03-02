const grid = document.getElementById("assetGrid");
const searchInput = document.getElementById("searchInput");
const searchBtn = document.getElementById("searchBtn");
const searchResults = document.getElementById("searchResults");
const compareA = document.getElementById("compareA");
const compareB = document.getElementById("compareB");
const compareBtn = document.getElementById("compareBtn");
const compareResults = document.getElementById("compareResults");
const clearLibraryBtn = document.getElementById("clearLibraryBtn");
const clearLibraryStatus = document.getElementById("clearLibraryStatus");

let assets = [];

function card(asset) {
  const thumb = asset.screenshots?.[2] || asset.screenshots?.[0] || "";
  const snippet = asset.summary ? `${asset.summary.slice(0, 170)}...` : "Summary pending.";
  const thumbMarkup = thumb
    ? `<img class="thumb" src="${thumb}" alt="Front view thumbnail" />`
    : `<div class="thumb thumb-empty">Preview pending</div>`;
  return `
    <article class="asset-card">
      ${thumbMarkup}
      <h4>${asset.filename}</h4>
      <p class="subtle">${snippet}</p>
      <a class="cta" href="/analysis.html?asset_id=${asset.asset_id}">Open Analysis</a>
    </article>
  `;
}

async function loadLibrary() {
  const res = await fetch("/api/assets");
  if (!res.ok) {
    grid.innerHTML = "<p>Unable to load assets.</p>";
    return;
  }
  const data = await res.json();
  assets = data.items || [];

  const options = ["<option value=''>Select Asset</option>"]
    .concat(
      assets.map(
        (asset) => `<option value="${asset.asset_id}">${asset.filename} (${String(asset.source_type || "").toUpperCase()})</option>`,
      ),
    )
    .join("");
  compareA.innerHTML = options;
  compareB.innerHTML = options;

  if (!data.items?.length) {
    grid.innerHTML = "<p class='subtle'>No assets yet. Upload a DXF/STEP file from the dashboard.</p>";
    return;
  }
  grid.innerHTML = data.items.map(card).join("");
}

function showSearch(items) {
  if (!items.length) {
    searchResults.innerHTML = "No assets matched this query.";
    return;
  }
  searchResults.innerHTML = items
    .map((item) => {
      const label = item.metadata?.filename || item.asset_id;
      const score = item.distance != null ? `score ${Number(item.distance).toFixed(3)}` : "score n/a";
      const snippet = (item.document || "Matched based on indexed content.").slice(0, 180);
      return `<div class="result-card"><strong>${label}</strong><p>${snippet}</p><a href="/analysis.html?asset_id=${item.asset_id}">Open analysis</a> <span class="subtle">(${score})</span></div>`;
    })
    .join("");
}

async function runSearch() {
  const query = (searchInput.value || "").trim();
  if (!query) {
    searchResults.textContent = "Type a search query first.";
    return;
  }
  searchResults.textContent = "Searching...";
  const res = await fetch("/api/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) {
    searchResults.textContent = "Search failed.";
    return;
  }
  const data = await res.json();
  showSearch(data.items || []);
}

function renderCompare(data) {
  compareResults.innerHTML = `
    <div class="compare-grid">
      <div class="result-card">
        <h5>${data.a.filename}</h5>
        <p>Type: ${String(data.a.source_type).toUpperCase()}</p>
        <p>Author: ${data.a.author}</p>
        <p>Version: ${data.a.version}</p>
        <p>Texts: ${data.a.texts_count}</p>
        <p>Hierarchy: ${data.a.hierarchy_count}</p>
        <p>Screenshots: ${data.a.screenshots_count}</p>
        <p>Summary words: ${data.a.summary_words}</p>
      </div>
      <div class="result-card">
        <h5>${data.b.filename}</h5>
        <p>Type: ${String(data.b.source_type).toUpperCase()}</p>
        <p>Author: ${data.b.author}</p>
        <p>Version: ${data.b.version}</p>
        <p>Texts: ${data.b.texts_count}</p>
        <p>Hierarchy: ${data.b.hierarchy_count}</p>
        <p>Screenshots: ${data.b.screenshots_count}</p>
        <p>Summary words: ${data.b.summary_words}</p>
      </div>
    </div>
    <div class="result-card">
      <strong>Highlights</strong>
      <p>${(data.highlights || []).join("<br/>")}</p>
    </div>
  `;
}

async function runCompare() {
  const assetIdA = compareA.value;
  const assetIdB = compareB.value;
  if (!assetIdA || !assetIdB) {
    compareResults.textContent = "Select two assets first.";
    return;
  }
  if (assetIdA === assetIdB) {
    compareResults.textContent = "Select two different assets.";
    return;
  }
  compareResults.textContent = "Comparing...";
  const res = await fetch("/api/compare", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_id_a: assetIdA, asset_id_b: assetIdB }),
  });
  if (!res.ok) {
    compareResults.textContent = "Compare failed.";
    return;
  }
  const data = await res.json();
  renderCompare(data);
}

async function clearLibrary() {
  const ok = window.confirm("This will permanently remove all uploaded assets, captures, and index data. Continue?");
  if (!ok) {
    return;
  }

  clearLibraryStatus.textContent = "Clearing...";
  const res = await fetch("/api/assets/clear", { method: "POST" });
  if (!res.ok) {
    clearLibraryStatus.textContent = "Failed to clear library.";
    return;
  }

  const data = await res.json();
  clearLibraryStatus.textContent = `Cleared ${data.cleared_assets || 0} assets.`;
  searchResults.textContent = "Run a query to see matched assets.";
  compareResults.textContent = "Choose two assets and run compare.";
  await loadLibrary();
}

searchBtn.addEventListener("click", runSearch);
searchInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    runSearch();
  }
});
compareBtn.addEventListener("click", runCompare);
clearLibraryBtn.addEventListener("click", clearLibrary);

loadLibrary();
