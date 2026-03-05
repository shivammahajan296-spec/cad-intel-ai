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

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function card(asset) {
  const thumb = asset.screenshots?.[2] || asset.screenshots?.[0] || "";
  const snippet = asset.summary ? `${asset.summary.slice(0, 170)}...` : "Summary pending.";
  const thumbMarkup = thumb
    ? `<img class="thumb" src="${thumb}" alt="Front view thumbnail" />`
    : `<div class="thumb thumb-empty">Preview pending</div>`;
  const analysisHref = `/analysis.html?filename=${encodeURIComponent(asset.filename || "")}`;
  return `
    <article class="asset-card">
      <div class="asset-card-head">
        <h4>${escapeHtml(asset.filename)}</h4>
        <button class="asset-delete-btn" type="button" data-asset-delete="${asset.asset_id}" aria-label="Delete asset" title="Delete asset">
          <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
            <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm-2 6h2v9H7V9Zm4 0h2v9h-2V9Zm4 0h2v9h-2V9Z"/>
          </svg>
        </button>
      </div>
      ${thumbMarkup}
      <p class="subtle">${snippet}</p>
      <a class="cta" href="${analysisHref}">Open Analysis</a>
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
      const href = label ? `/analysis.html?filename=${encodeURIComponent(label)}` : `/analysis.html?asset_id=${item.asset_id}`;
      return `<div class="result-card"><strong>${label}</strong><p>${snippet}</p><a href="${href}">Open analysis</a> <span class="subtle">(${score})</span></div>`;
    })
    .join("");
}

function renderInlineMarkdown(text) {
  let out = escapeHtml(text || "");
  out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*(.+?)\*/g, "<em>$1</em>");
  return out;
}

function renderReportHtml(text) {
  const lines = String(text || "").split("\n");
  const html = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line) {
      i += 1;
      continue;
    }
    if (/^#{1,6}\s+/.test(line) || /^[A-Za-z][A-Za-z0-9\s/&()_-]{2,}:$/.test(line)) {
      const heading = line.replace(/^#{1,6}\s+/, "").replace(/:$/, "");
      html.push(`<h5>${renderInlineMarkdown(heading)}</h5>`);
      i += 1;
      continue;
    }
    if (/^[-*•]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*•]\s+/, ""));
        i += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ul>`);
      continue;
    }
    if (/^\d+[\.\)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+[\.\)]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^\d+[\.\)]\s+/, ""));
        i += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</ol>`);
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^[-*•]\s+/.test(lines[i].trim()) &&
      !/^\d+[\.\)]\s+/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim());
      i += 1;
    }
    html.push(`<p>${renderInlineMarkdown(para.join(" "))}</p>`);
  }
  return html.join("");
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
  const s = data.compare_structured || {};
  const similarityScore = Number(s.similarity_score_pct || 0);
  const scoreTone =
    similarityScore >= 80 ? "high" : similarityScore >= 60 ? "mid" : "low";
  const renderBullets = (items) =>
    `<ul>${(items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;

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
    <div class="result-card compare-main-card">
      <div class="compare-similarity-head">
        <strong>Similarity</strong>
        <span class="similarity-badge similarity-${scoreTone}">${Number.isFinite(similarityScore) ? similarityScore : 0}%</span>
      </div>
      <p class="compare-similarity-reason">${escapeHtml(s.similarity_reason || "No similarity reason available.")}</p>
    </div>
    <div class="result-card compare-main-card">
      <strong>Dimension-wise Key Differences</strong>
      ${renderBullets(s.dimension_key_differences)}
    </div>
    <div class="result-card compare-main-card">
      <strong>Key Differentiators Overall</strong>
      ${renderBullets(s.key_differentiators_overall)}
    </div>
    <div class="result-card compare-main-card">
      <strong>Manufacturing Impact Comparison</strong>
      ${renderBullets(s.manufacturing_impact_comparison)}
    </div>
    <div class="result-card compare-main-card">
      <strong>Complexity/Risk Comparison</strong>
      ${renderBullets(s.complexity_risk_comparison)}
    </div>
    <div class="result-card compare-main-card">
      <strong>Recommendation</strong>
      ${renderBullets(s.recommendation)}
    </div>
    <div class="result-card compare-main-card">
      <strong>Raw Compare Report</strong>
      <p class="subtle">Source: ${escapeHtml(data.compare_source || "fallback")}</p>
      <div class="compare-report">${renderReportHtml(data.compare_report || "No compare report generated.")}</div>
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

async function deleteSingleAsset(assetId) {
  const asset = assets.find((item) => item.asset_id === assetId);
  const label = asset?.filename || "this asset";
  const ok = window.confirm(`Are you sure you want to delete ${label}? This cannot be undone.`);
  if (!ok) return;

  clearLibraryStatus.textContent = "Deleting asset...";
  const res = await fetch(`/api/assets/${encodeURIComponent(assetId)}`, { method: "DELETE" });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    clearLibraryStatus.textContent = data.detail || "Failed to delete asset.";
    return;
  }
  clearLibraryStatus.textContent = "Asset deleted.";
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
grid.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest("button[data-asset-delete]");
  if (!button) return;
  deleteSingleAsset(button.dataset.assetDelete);
});

loadLibrary();
