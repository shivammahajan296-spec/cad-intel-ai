import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const params = new URLSearchParams(window.location.search);
let assetId = params.get("asset_id");
const filenameParam = params.get("filename");

const metaRows = document.getElementById("metaRows");
const summaryBox = document.getElementById("summaryBox");
const captureBtn = document.getElementById("captureBtn");
const summarizeBtn = document.getElementById("summarizeBtn");
const downloadAnalysisBtn = document.getElementById("downloadAnalysisBtn");
const openExtractionEngineBtn = document.getElementById("openExtractionEngineBtn");
const container = document.getElementById("viewerCanvas");
const extractionEngineModal = document.getElementById("extractionEngineModal");
const engineRoleInput = document.getElementById("engineRoleInput");
const engineObjectiveInput = document.getElementById("engineObjectiveInput");
const engineSections = document.getElementById("engineSections");
const addEngineSectionBtn = document.getElementById("addEngineSectionBtn");
const engineClosingInput = document.getElementById("engineClosingInput");
const saveEngineConfigBtn = document.getElementById("saveEngineConfigBtn");
const closeEngineConfigBtn = document.getElementById("closeEngineConfigBtn");
const engineConfigStatus = document.getElementById("engineConfigStatus");

let asset = null;
let scene, camera, renderer, controls, modelRoot;
let savedScreenshots = [];
let previewReady = false;
let analysisRunning = false;
let viewerMode = "module";
let extractionEngineConfig = null;

let stepOcct = null;
let stepScene = null;
let stepCamera = null;
let stepRenderer = null;
let stepControls = null;
let stepModel = null;

let dxfCanvas = null;
let dxfCtx = null;
let dxfDoc = null;
let dxfBounds = null;
let dxfScale = 1;
let dxfOffsetX = 0;
let dxfOffsetY = 0;
let dxfDragging = false;
let dxfLastX = 0;
let dxfLastY = 0;

function canonicalizeSectionTitle(title) {
  const t = String(title || "").trim();
  const n = t.toLowerCase().replace(/\s+/g, " ");
  if (n.includes("dimension inference")) return "Dimension Inference";
  if (n.includes("object identification")) return "Object Identification";
  if (n.includes("geometric analysis")) return "Geometric Analysis";
  if (n.includes("manufacturing analysis")) return "Manufacturing Analysis";
  if (n.includes("dfm review") || n.includes("design for manufacturing")) return "DFM Review";
  if (n.includes("material recommendation")) return "Material Recommendation";
  if (n.includes("improvement suggestions")) return "Improvement Suggestions";
  return t;
}

function sortSectionsByCanonicalOrder(sections) {
  const desired = [
    "Dimension Inference",
    "Object Identification",
    "Geometric Analysis",
    "Manufacturing Analysis",
    "DFM Review",
    "Material Recommendation",
    "Improvement Suggestions",
  ];
  const rank = new Map(desired.map((name, idx) => [name, idx]));
  return (sections || [])
    .map((section, idx) => ({ section, idx }))
    .sort((a, b) => {
      const ar = rank.has(a.section.title) ? rank.get(a.section.title) : 100 + a.idx;
      const br = rank.has(b.section.title) ? rank.get(b.section.title) : 100 + b.idx;
      return ar - br;
    })
    .map((entry) => entry.section);
}

function normalizeEngineConfigClient(engine) {
  const fallback = {
    role: "You are a senior mechanical design engineer, CAD expert, and manufacturing specialist.",
    objective: [
      "Analyze the provided CAD image and extract complete engineering intelligence from it.",
      "Your task is NOT to recreate the image, but to deeply understand and describe it from a professional product engineering perspective.",
    ],
    sections: [
      { title: "Dimension Inference", items: ["If scale is not provided, infer realistic industrial dimensions in millimeters."] },
      { title: "Object Identification", items: ["What is the likely object type?"] },
      { title: "Geometric Analysis", items: ["Identify symmetry and primary geometric primitives."] },
      { title: "Manufacturing Analysis", items: ["Infer likely manufacturing process and tooling complexity."] },
      { title: "DFM Review", items: ["Highlight DFM risks and stress concentration concerns."] },
      { title: "Material Recommendation", items: ["Suggest suitable materials and alternatives."] },
      { title: "Improvement Suggestions", items: ["Suggest structural and manufacturing improvements."] },
    ],
    closing: ["Be precise.", "Use millimeters."],
  };
  if (!engine || typeof engine !== "object") return fallback;

  const role = String(engine.role || "").trim() || fallback.role;
  const objective = Array.isArray(engine.objective)
    ? engine.objective.map((v) => String(v || "").trim()).filter(Boolean)
    : [];
  const sections = Array.isArray(engine.sections)
    ? engine.sections
        .map((section) => ({
          title: canonicalizeSectionTitle(section?.title),
          items: Array.isArray(section?.items)
            ? section.items.map((v) => String(v || "").trim()).filter(Boolean)
            : [],
        }))
        .filter((section) => section.title && section.items.length)
    : [];
  const closing = Array.isArray(engine.closing)
    ? engine.closing.map((v) => String(v || "").trim()).filter(Boolean)
    : [];

  return {
    role,
    objective: objective.length ? objective : fallback.objective,
    sections: sortSectionsByCanonicalOrder(sections.length ? sections : fallback.sections),
    closing: closing.length ? closing : fallback.closing,
  };
}

function escapeAttr(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function splitNonEmptyLines(value) {
  return String(value || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderEngineSections() {
  if (!engineSections || !extractionEngineConfig) return;
  engineSections.innerHTML = extractionEngineConfig.sections
    .map((section, sectionIndex) => {
      const points = section.items
        .map(
          (point, pointIndex) => `
            <div class="engine-point-row">
              <input
                class="text-input engine-point-input"
                data-engine-field="item"
                data-section-index="${sectionIndex}"
                data-point-index="${pointIndex}"
                value="${escapeAttr(point)}"
                type="text"
              />
              <button
                class="mini-btn danger-btn"
                type="button"
                data-engine-action="remove-point"
                data-section-index="${sectionIndex}"
                data-point-index="${pointIndex}"
              >Delete</button>
            </div>
          `
        )
        .join("");
      return `
        <article class="engine-section-card">
          <div class="engine-section-head">
            <span class="engine-section-index">${sectionIndex + 1}</span>
            <input
              class="text-input engine-section-title"
              data-engine-field="title"
              data-section-index="${sectionIndex}"
              value="${escapeAttr(section.title)}"
              type="text"
            />
            <button
              class="mini-btn danger-btn"
              type="button"
              data-engine-action="remove-section"
              data-section-index="${sectionIndex}"
            >Delete Section</button>
          </div>
          <div class="engine-points">${points}</div>
          <div class="actions-row engine-section-actions">
            <button
              class="mini-btn"
              type="button"
              data-engine-action="add-point"
              data-section-index="${sectionIndex}"
            >Add Point</button>
          </div>
        </article>
      `;
    })
    .join("");
}

function syncEngineTopFields() {
  if (!extractionEngineConfig) return;
  if (engineRoleInput) {
    extractionEngineConfig.role = String(engineRoleInput.value || "").trim();
  }
  if (engineObjectiveInput) {
    extractionEngineConfig.objective = splitNonEmptyLines(engineObjectiveInput.value || "");
  }
  if (engineClosingInput) {
    extractionEngineConfig.closing = splitNonEmptyLines(engineClosingInput.value || "");
  }
}

function openExtractionEngineModal() {
  extractionEngineModal?.classList.remove("hidden");
}

function closeExtractionEngineModal() {
  extractionEngineModal?.classList.add("hidden");
}

function populateExtractionEngineEditor() {
  if (!extractionEngineConfig) return;
  if (engineRoleInput) engineRoleInput.value = extractionEngineConfig.role;
  if (engineObjectiveInput) engineObjectiveInput.value = extractionEngineConfig.objective.join("\n");
  if (engineClosingInput) engineClosingInput.value = extractionEngineConfig.closing.join("\n");
  renderEngineSections();
}

async function loadExtractionEngineConfig() {
  if (!engineConfigStatus) return;
  engineConfigStatus.textContent = "Loading extraction engine...";
  try {
    const res = await fetch("/api/config/extraction-engine");
    if (!res.ok) {
      extractionEngineConfig = normalizeEngineConfigClient(null);
      populateExtractionEngineEditor();
      engineConfigStatus.textContent = "Using local defaults. You can still add sections and points.";
      return;
    }
    const data = await res.json();
    extractionEngineConfig = normalizeEngineConfigClient(data.engine);
    populateExtractionEngineEditor();
    engineConfigStatus.textContent = "Edit sections and save. This will become the final prompt.";
  } catch (_err) {
    extractionEngineConfig = normalizeEngineConfigClient(null);
    populateExtractionEngineEditor();
    engineConfigStatus.textContent = "Using local defaults. You can still add sections and points.";
  }
}

async function saveExtractionEngineConfig() {
  if (!engineConfigStatus || !extractionEngineConfig) return;
  syncEngineTopFields();
  extractionEngineConfig.sections = extractionEngineConfig.sections
    .map((section) => ({
      title: String(section.title || "").trim(),
      items: Array.isArray(section.items) ? section.items.map((item) => String(item || "").trim()).filter(Boolean) : [],
    }))
    .filter((section) => section.title && section.items.length);

  if (!extractionEngineConfig.sections.length) {
    engineConfigStatus.textContent = "Add at least one section with one point.";
    return;
  }

  engineConfigStatus.textContent = "Saving...";
  const res = await fetch("/api/config/extraction-engine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ engine: extractionEngineConfig }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    engineConfigStatus.textContent = data.detail || "Failed to save extraction engine.";
    return;
  }
  const data = await res.json();
  extractionEngineConfig = normalizeEngineConfigClient(data.engine);
  renderEngineSections();
  engineConfigStatus.textContent = "Saved. New settings will be used in the next summary run.";
  closeExtractionEngineModal();
}

function downloadAnalysis() {
  const analysisText = (asset?.summary || "").trim() || summaryBox.innerText.trim();
  if (!analysisText || analysisText === "Summary will appear here.") {
    summaryBox.textContent = "No analysis available to download.";
    return;
  }

  const safeBase = (asset?.filename || "analysis")
    .replace(/\.[^/.]+$/, "")
    .replace(/[^a-zA-Z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "analysis";
  const fileName = `${safeBase}_analysis.md`;
  const header = `# CAD Intelligence Analysis\n\n- File: ${asset?.filename || "Unknown"}\n- Type: ${asset?.source_type || "Unknown"}\n\n`;
  const blob = new Blob([header, analysisText, "\n"], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderDynamicSummary(summaryText) {
  if (!summaryText || !summaryText.trim()) {
    summaryBox.textContent = "No summary generated.";
    return;
  }

  const escapeHtml = (value) =>
    String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");

  const renderInlineMarkdown = (text) => {
    let out = escapeHtml(text);
    out = out.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
    out = out.replace(/\*(.+?)\*/g, "<em>$1</em>");
    return out;
  };

  const renderMarkdownBlocks = (lines) => {
    const html = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      if (!line) {
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
  };

  const pillars = [
    { order: 1, title: "Dimension Inference", keys: ["dimension inference"] },
    { order: 2, title: "Object Identification", keys: ["object identification"] },
    { order: 3, title: "Geometric Analysis", keys: ["geometric analysis"] },
    { order: 4, title: "Manufacturing Analysis", keys: ["manufacturing analysis"] },
    { order: 5, title: "DFM Review", keys: ["dfm review", "design for manufacturing"] },
    { order: 6, title: "Material Recommendation", keys: ["material recommendation"] },
    { order: 7, title: "Improvement Suggestions", keys: ["improvement suggestions"] },
  ];

  const normalizeHeading = (line) =>
    line
      .toLowerCase()
      .replace(/^\s*#{1,6}\s*/, "")
      .replace(/^\s*\d+[\)\.\-]?\s*/, "")
      .replace(/:$/, "")
      .replace(/\s+/g, " ")
      .trim();

  const findPillar = (line) => {
    const normalized = normalizeHeading(line);
    return pillars.find((p) => p.keys.some((k) => normalized.includes(k))) || null;
  };

  const isHeadingLine = (line) => {
    const t = line.trim();
    if (!t) return false;
    if (/^[-*•]\s+/.test(t)) return false;
    if (/^#{1,6}\s+/.test(t)) return true;
    if (/^\d+[\)\.\-]\s+[A-Za-z]/.test(t)) return true;
    return !!findPillar(t);
  };

  const cleanHeading = (line) =>
    line
      .trim()
      .replace(/^#{1,6}\s*/, "")
      .replace(/^\d+[\)\.\-]\s*/, "")
      .replace(/:$/, "")
      .trim();

  const rawLines = summaryText.split("\n");
  const introLines = [];
  const sections = [];
  let current = null;

  for (const raw of rawLines) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      if (current) current.lines.push("");
      continue;
    }
    if (isHeadingLine(line)) {
      const pillar = findPillar(line);
      current = {
        title: pillar ? pillar.title : cleanHeading(line),
        order: pillar ? pillar.order : null,
        lines: [],
      };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    } else {
      introLines.push(line);
    }
  }

  const cards = sections
    .filter((s) => s.lines.some((l) => l.trim()))
    .map((section, index) => {
      const bodyHtml = renderMarkdownBlocks(section.lines);
      const displayOrder = section.order || index + 1;
      const badge = `<span class="summary-index">${displayOrder}</span>`;
      return `
        <article class="summary-card">
          <h4>${badge}<strong>${escapeHtml(section.title)}</strong></h4>
          <div class="summary-body">${bodyHtml}</div>
        </article>
      `;
    });

  if (!cards.length && introLines.length) {
    cards.push(`
      <article class="summary-card">
        <h4><strong>Analysis</strong></h4>
        <div class="summary-body">${renderMarkdownBlocks(introLines)}</div>
      </article>
    `);
  }

  const introHtml = introLines.length
    ? `<div class="summary-intro">${renderMarkdownBlocks(introLines)}</div>`
    : "";

  summaryBox.innerHTML = `
    ${introHtml}
    <div class="summary-grid">${cards.join('<hr class="summary-divider" />')}</div>
  `;
}

function setMetaRows(a) {
  const entries = [
    ["File", a.filename],
    ["Type", a.source_type],
    ["Author", a.metadata?.author || "Unknown"],
    ["Version", a.metadata?.version || "Unknown"],
    ["Created", String(a.metadata?.created_date || "Unknown")],
  ];
  metaRows.innerHTML = entries.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join("");
}

function dxfWorldToScreen(x, y) {
  return { x: x * dxfScale + dxfOffsetX, y: -y * dxfScale + dxfOffsetY };
}

function dxfResetView() {
  dxfScale = 1;
  dxfOffsetX = 40;
  dxfOffsetY = 40;
}

function dxfComputeBounds(entities) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const upd = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };

  for (const e of entities || []) {
    if (!e) continue;
    if (e.type === "LINE" && e.vertices?.length >= 2) {
      upd(e.vertices[0].x, e.vertices[0].y);
      upd(e.vertices[1].x, e.vertices[1].y);
    } else if ((e.type === "LWPOLYLINE" || e.type === "POLYLINE") && e.vertices?.length) {
      for (const v of e.vertices) upd(v.x, v.y);
    } else if (e.type === "CIRCLE" && e.center) {
      upd(e.center.x - e.radius, e.center.y - e.radius);
      upd(e.center.x + e.radius, e.center.y + e.radius);
    } else if (e.type === "ARC" && e.center) {
      upd(e.center.x - e.radius, e.center.y - e.radius);
      upd(e.center.x + e.radius, e.center.y + e.radius);
    } else if (e.type === "TEXT" && e.startPoint) {
      upd(e.startPoint.x, e.startPoint.y);
    } else if (e.type === "MTEXT" && e.position) {
      upd(e.position.x, e.position.y);
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

function dxfFitToView() {
  if (!dxfBounds || !dxfCanvas) return;
  const w = dxfCanvas.width;
  const h = dxfCanvas.height;
  const bw = dxfBounds.maxX - dxfBounds.minX || 1;
  const bh = dxfBounds.maxY - dxfBounds.minY || 1;
  dxfScale = Math.min(w / bw, h / bh) * 0.92;
  const cx = (dxfBounds.minX + dxfBounds.maxX) / 2;
  const cy = (dxfBounds.minY + dxfBounds.maxY) / 2;
  dxfOffsetX = w / 2 - cx * dxfScale;
  dxfOffsetY = h / 2 - -cy * dxfScale;
}

function dxfDrawEntity(e) {
  if (!dxfCtx) return;
  if (e.type === "LINE" && e.vertices?.length >= 2) {
    const a = dxfWorldToScreen(e.vertices[0].x, e.vertices[0].y);
    const b = dxfWorldToScreen(e.vertices[1].x, e.vertices[1].y);
    dxfCtx.beginPath();
    dxfCtx.moveTo(a.x, a.y);
    dxfCtx.lineTo(b.x, b.y);
    dxfCtx.stroke();
  } else if ((e.type === "LWPOLYLINE" || e.type === "POLYLINE") && e.vertices?.length) {
    const p0 = dxfWorldToScreen(e.vertices[0].x, e.vertices[0].y);
    dxfCtx.beginPath();
    dxfCtx.moveTo(p0.x, p0.y);
    for (let i = 1; i < e.vertices.length; i += 1) {
      const p = dxfWorldToScreen(e.vertices[i].x, e.vertices[i].y);
      dxfCtx.lineTo(p.x, p.y);
    }
    if (e.closed) dxfCtx.closePath();
    dxfCtx.stroke();
  } else if (e.type === "CIRCLE" && e.center) {
    const c = dxfWorldToScreen(e.center.x, e.center.y);
    dxfCtx.beginPath();
    dxfCtx.arc(c.x, c.y, Math.abs(e.radius * dxfScale), 0, Math.PI * 2);
    dxfCtx.stroke();
  } else if (e.type === "ARC" && e.center) {
    const c = dxfWorldToScreen(e.center.x, e.center.y);
    const start = -(Number(e.startAngle || 0) * Math.PI) / 180;
    const end = -(Number(e.endAngle || 0) * Math.PI) / 180;
    dxfCtx.beginPath();
    dxfCtx.arc(c.x, c.y, Math.abs(e.radius * dxfScale), start, end, false);
    dxfCtx.stroke();
  }
}

function dxfRender() {
  if (!dxfCanvas || !dxfCtx) return;
  const w = dxfCanvas.width;
  const h = dxfCanvas.height;
  dxfCtx.clearRect(0, 0, w, h);
  dxfCtx.strokeStyle = "#e6ebff";
  dxfCtx.lineWidth = 1;
  for (const e of dxfDoc?.entities || []) {
    dxfDrawEntity(e);
  }
}

function initDxfViewer() {
  viewerMode = "dxf";
  previewReady = false;
  container.innerHTML = "";
  dxfCanvas = document.createElement("canvas");
  dxfCanvas.style.width = "100%";
  dxfCanvas.style.height = "100%";
  dxfCanvas.style.display = "block";
  container.appendChild(dxfCanvas);
  dxfCtx = dxfCanvas.getContext("2d");

  const resize = () => {
    if (!dxfCanvas) return;
    dxfCanvas.width = Math.max(1, container.clientWidth || 1);
    dxfCanvas.height = Math.max(1, container.clientHeight || 1);
    dxfRender();
  };
  window.addEventListener("resize", resize);
  resize();

  dxfCanvas.addEventListener("mousedown", (ev) => {
    dxfDragging = true;
    dxfLastX = ev.clientX;
    dxfLastY = ev.clientY;
  });
  window.addEventListener("mouseup", () => {
    dxfDragging = false;
  });
  window.addEventListener("mousemove", (ev) => {
    if (!dxfDragging) return;
    const dx = ev.clientX - dxfLastX;
    const dy = ev.clientY - dxfLastY;
    dxfLastX = ev.clientX;
    dxfLastY = ev.clientY;
    dxfOffsetX += dx;
    dxfOffsetY += dy;
    dxfRender();
  });
  dxfCanvas.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      const rect = dxfCanvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const zoom = Math.exp(-ev.deltaY * 0.001);
      const newScale = Math.max(0.02, Math.min(800, dxfScale * zoom));
      const wx = (mx - dxfOffsetX) / dxfScale;
      const wy = -((my - dxfOffsetY) / dxfScale);
      dxfScale = newScale;
      dxfOffsetX = mx - wx * dxfScale;
      dxfOffsetY = my - -wy * dxfScale;
      dxfRender();
    },
    { passive: false },
  );
}

async function loadDxfFromUrl(url) {
  if (!window.DxfParser) {
    showPreviewError("DXF parser runtime unavailable.");
    return;
  }
  if (!url) {
    showPreviewError("No DXF URL provided.");
    return;
  }
  try {
    summaryBox.textContent = "Loading DXF file...";
    const res = await fetch(url);
    if (!res.ok) throw new Error("Failed to fetch DXF file.");
    const text = await res.text();
    const parser = new window.DxfParser();
    dxfDoc = parser.parseSync(text);
    dxfBounds = dxfComputeBounds(dxfDoc.entities || []);
    dxfResetView();
    if (dxfBounds) dxfFitToView();
    dxfRender();
    previewReady = true;
    summaryBox.textContent = `DXF file loaded (${dxfDoc.entities?.length || 0} entities).`;
  } catch (err) {
    showPreviewError(`DXF load failed: ${err.message}`);
  }
}

function initViewer() {
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101012);

  const w = container.clientWidth || 800;
  const h = container.clientHeight || 500;

  camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 1000);
  camera.position.set(7, 7, 7);

  renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(w, h);
  container.innerHTML = "";
  container.appendChild(renderer.domElement);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  scene.add(new THREE.AmbientLight(0xffffff, 0.8));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(10, 14, 10);
  scene.add(key);

  const grid = new THREE.GridHelper(20, 20, 0xff8c00, 0x555555);
  scene.add(grid);

  modelRoot = new THREE.Group();
  scene.add(modelRoot);

  window.addEventListener("resize", () => {
    const nw = container.clientWidth;
    const nh = container.clientHeight;
    renderer.setSize(nw, nh);
    camera.aspect = nw / nh;
    camera.updateProjectionMatrix();
  });
}

function normalizeAndCenter(obj) {
  const box = new THREE.Box3().setFromObject(obj);
  const center = new THREE.Vector3();
  const size = new THREE.Vector3();
  box.getCenter(center);
  box.getSize(size);

  obj.position.sub(center);
  const maxAxis = Math.max(size.x, size.y, size.z) || 1;
  const scale = 4 / maxAxis;
  obj.scale.setScalar(scale);
}

function showPreviewError(message) {
  previewReady = false;
  modelRoot.clear();
  summaryBox.textContent = message;
}

function renderDxfLines(lines) {
  if (!Array.isArray(lines) || lines.length < 2) {
    showPreviewError("DXF preview unavailable. Could not extract drawable entities.");
    return;
  }

  const points = [];
  for (const p of lines) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = Number(p[0]);
    const y = Number(p[1]);
    const z = Number(p[2] || 0);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      points.push(new THREE.Vector3(x, y, z));
    }
  }

  if (points.length < 2) {
    showPreviewError("DXF preview unavailable. Could not extract drawable entities.");
    return;
  }

  modelRoot.clear();
  const geometry = new THREE.BufferGeometry().setFromPoints(points);
  const linesMesh = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: 0xff9a2e }),
  );
  modelRoot.add(linesMesh);
  normalizeAndCenter(linesMesh);
  triggerDiscoverySpin();
  previewReady = true;
  summaryBox.textContent = `DXF preview loaded (${Math.floor(points.length / 2)} segments).`;
}

function loadModel(path) {
  const ext = path.toLowerCase();
  if (ext.endsWith(".stl")) {
    const loader = new STLLoader();
    loader.load(
      path,
      (geometry) => {
        const mat = new THREE.MeshStandardMaterial({ color: 0xff8c00, metalness: 0.2, roughness: 0.6 });
        const mesh = new THREE.Mesh(geometry, mat);
        modelRoot.clear();
        modelRoot.add(mesh);
        normalizeAndCenter(mesh);
        triggerDiscoverySpin();
        previewReady = true;
      },
      undefined,
      () => showPreviewError("STL preview conversion failed."),
    );
    return;
  }

  const gltfLoader = new GLTFLoader();
  gltfLoader.load(
    path,
    (gltf) => {
      modelRoot.clear();
      modelRoot.add(gltf.scene);
      normalizeAndCenter(gltf.scene);
      triggerDiscoverySpin();
      previewReady = true;
    },
    undefined,
    () => showPreviewError("STEP/GLB preview conversion failed."),
  );
}

function ensureStepEngine() {
  if (stepOcct) {
    return Promise.resolve(stepOcct);
  }
  if (!window.occtimportjs) {
    return Promise.reject(new Error("OCCT engine script unavailable."));
  }
  return window.occtimportjs().then((library) => {
    stepOcct = library;
    return stepOcct;
  });
}

function initStepScene() {
  viewerMode = "step";
  previewReady = false;
  container.innerHTML = "";
  const T = window.THREE;
  if (!T || !window.THREE.OrbitControls) {
    showPreviewError("Three.js STEP runtime unavailable.");
    return;
  }

  stepScene = new T.Scene();
  stepScene.background = new T.Color(0xf4f6f8);
  const w = container.clientWidth || 800;
  const h = container.clientHeight || 500;

  stepCamera = new T.PerspectiveCamera(45, w / h, 1, 5000);
  stepCamera.position.set(150, 120, 150);
  stepRenderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  stepRenderer.setPixelRatio(window.devicePixelRatio || 1);
  stepRenderer.setSize(w, h);
  container.appendChild(stepRenderer.domElement);

  stepControls = new window.THREE.OrbitControls(stepCamera, stepRenderer.domElement);
  stepControls.enableDamping = true;
  stepScene.add(new T.AmbientLight(0xffffff, 0.65));
  const dir = new T.DirectionalLight(0xffffff, 0.9);
  dir.position.set(120, 120, 80);
  stepScene.add(dir);

  const onResize = () => {
    if (!stepCamera || !stepRenderer || viewerMode !== "step") return;
    const nw = container.clientWidth || 800;
    const nh = container.clientHeight || 500;
    stepCamera.aspect = nw / nh;
    stepCamera.updateProjectionMatrix();
    stepRenderer.setSize(nw, nh);
  };
  window.addEventListener("resize", onResize);
}

function animateStep() {
  if (viewerMode !== "step") {
    return;
  }
  requestAnimationFrame(animateStep);
  if (stepControls) stepControls.update();
  if (stepRenderer && stepScene && stepCamera) stepRenderer.render(stepScene, stepCamera);
}

async function loadStepFromUrl(url) {
  const T = window.THREE;
  if (!url) {
    showPreviewError("No STEP URL provided.");
    return;
  }
  try {
    await ensureStepEngine();
  } catch (err) {
    showPreviewError(`STEP engine init failed: ${err.message}`);
    return;
  }

  try {
    summaryBox.textContent = "Loading STEP file...";
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch STEP file.");
    const fileBuffer = new Uint8Array(await response.arrayBuffer());
    const result = stepOcct.ReadStepFile(fileBuffer);

    if (stepModel) stepScene.remove(stepModel);
    stepModel = new T.Group();

    result.meshes.forEach((meshData) => {
      const geometry = new T.BufferGeometry();
      geometry.setAttribute("position", new T.Float32BufferAttribute(meshData.attributes.position.array, 3));
      if (meshData.attributes.normal) {
        geometry.setAttribute("normal", new T.Float32BufferAttribute(meshData.attributes.normal.array, 3));
      }
      geometry.setIndex(new T.Uint32BufferAttribute(meshData.index.array, 1));

      const material = new T.MeshStandardMaterial({
        color: 0x95a5a6,
        metalness: 0.65,
        roughness: 0.35,
        side: T.DoubleSide,
      });
      const mesh = new T.Mesh(geometry, material);
      const edges = new T.EdgesGeometry(geometry);
      const lines = new T.LineSegments(edges, new T.LineBasicMaterial({ color: 0x2c3e50 }));
      mesh.add(lines);
      stepModel.add(mesh);
    });

    stepScene.add(stepModel);
    const box = new T.Box3().setFromObject(stepModel);
    const size = box.getSize(new T.Vector3()).length() || 100;
    const center = box.getCenter(new T.Vector3());
    stepControls.target.copy(center);
    stepCamera.position.copy(center).add(new T.Vector3(size, size, size));
    stepCamera.far = Math.max(2000, size * 10);
    stepCamera.updateProjectionMatrix();
    previewReady = true;
    summaryBox.textContent = "STEP file loaded.";
  } catch (err) {
    showPreviewError(`STEP load failed: ${err.message}`);
  }
}

function triggerDiscoverySpin() {
  const start = performance.now();
  const duration = 2800;
  const startPos = camera.position.clone();
  const radius = startPos.length();

  function spin(ts) {
    const t = Math.min((ts - start) / duration, 1);
    const angle = t * Math.PI * 2;
    camera.position.set(Math.cos(angle) * radius, radius * 0.55, Math.sin(angle) * radius);
    camera.lookAt(0, 0, 0);
    if (t < 1) {
      requestAnimationFrame(spin);
    }
  }

  requestAnimationFrame(spin);
}

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
}

// Write a JS function captureViews() that iterates through an array of camera positions [[0,10,0], [10,0,0], [0,0,10], [7,7,7]].
// For each position, call renderer.render(scene, camera) and push the toDataURL() result to an array.
// Once complete, POST that array to the FastAPI backend.
async function captureViews() {
  const cameraPositions = [[0, 10, 0], [10, 0, 0], [0, 0, 10], [7, 7, 7]];
  const captures = [];
  console.log("[analysis] captureViews.start", { viewerMode, cameraPositions });

  if (viewerMode === "step") {
    if (!stepRenderer || !stepCamera || !stepControls) {
      throw new Error("STEP renderer not ready.");
    }
    for (const pos of cameraPositions) {
      stepCamera.position.set(pos[0] * 24, pos[1] * 24, pos[2] * 24);
      stepCamera.lookAt(stepControls.target);
      stepControls.update();
      stepRenderer.render(stepScene, stepCamera);
      captures.push(stepRenderer.domElement.toDataURL("image/png"));
    }
  } else if (viewerMode === "dxf") {
    if (!dxfCanvas) {
      throw new Error("DXF canvas not ready.");
    }
    // DXF summary uses a single snapshot (current fitted/panned view).
    dxfRender();
    captures.push(dxfCanvas.toDataURL("image/png"));
  } else {
  for (const pos of cameraPositions) {
    camera.position.set(pos[0], pos[1], pos[2]);
    camera.lookAt(0, 0, 0);
    controls.update();
    renderer.render(scene, camera);
    captures.push(renderer.domElement.toDataURL("image/png"));
  }
  }

  const res = await fetch("/api/capture", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ asset_id: assetId, screenshots: captures }),
  });
  if (!res.ok) {
    console.error("[analysis] captureViews.failed", { status: res.status });
    throw new Error("Failed to save captured views.");
  }

  const data = await res.json();
  savedScreenshots = captures;
  console.log("[analysis] captureViews.done", { saved: data.saved, captured: captures.length });
  return data;
}

async function runSummaryPipeline({ captureFirst = true } = {}) {
  if (analysisRunning) {
    return;
  }
  if (!previewReady) {
    summaryBox.textContent = "Wait for preview to load before running summary analysis.";
    return;
  }
  analysisRunning = true;
  try {
    console.log("[analysis] summaryPipeline.start", {
      assetId,
      sourceType: asset?.source_type,
      captureFirst,
      previewReady,
    });
    if (captureFirst || !savedScreenshots.length) {
      summaryBox.textContent = "Capturing technical views...";
      await captureViews();
    }

    summaryBox.textContent = "Generating summary...";
    const payload = {
      asset_id: assetId,
      source_type: asset.source_type,
      text: (asset.texts || []).join("\n"),
      screenshots: savedScreenshots,
    };

    const res = await fetch("/api/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error("[analysis] summarize.failed", { status: res.status });
      throw new Error("Summary API failed.");
    }

    const data = await res.json();
    console.log("[analysis] summarize.done", data);
    asset.summary = data.summary || "";
    renderDynamicSummary(data.summary || "");
  } catch (err) {
    console.error("[analysis] summaryPipeline.error", err);
    summaryBox.textContent = `Analysis failed: ${err.message}`;
  } finally {
    analysisRunning = false;
  }
}

async function boot() {
  if (!assetId && filenameParam) {
    try {
      const cacheRes = await fetch(`/api/analysis-cache?filename=${encodeURIComponent(filenameParam)}`);
      if (cacheRes.ok) {
        const cacheData = await cacheRes.json();
        assetId = cacheData.asset_id;
        const next = new URL(window.location.href);
        next.searchParams.set("asset_id", assetId);
        window.history.replaceState({}, "", next.toString());
      }
    } catch (_err) {
      // Continue to normal missing-id handling below.
    }
  }

  if (!assetId) {
    summaryBox.textContent = "Missing asset_id in URL.";
    return;
  }

  const res = await fetch(`/api/assets/${assetId}`);
  if (!res.ok) {
    summaryBox.textContent = "Asset not found.";
    return;
  }
  asset = await res.json();
  setMetaRows(asset);

  if (asset.source_type === "step") {
    initStepScene();
    animateStep();
    await loadStepFromUrl(asset.step_path);
  } else if (asset.source_type === "dxf") {
    initDxfViewer();
    await loadDxfFromUrl(asset.dxf_path);
  } else if (asset.glb) {
    viewerMode = "module";
    initViewer();
    animate();
    loadModel(asset.glb);
  } else {
    viewerMode = "module";
    initViewer();
    animate();
    showPreviewError("Preview unavailable for this asset.");
  }

  if (asset.summary) {
    renderDynamicSummary(asset.summary);
  } else if (asset.source_type === "step" && previewReady) {
    await runSummaryPipeline({ captureFirst: true });
  }
}

captureBtn.addEventListener("click", async () => {
  try {
    const result = await captureViews();
    summaryBox.textContent = `Captured ${result.saved} views. Ready for summary.`;
  } catch (err) {
    summaryBox.textContent = `Capture failed: ${err.message}`;
  }
});

summarizeBtn.addEventListener("click", () => runSummaryPipeline({ captureFirst: true }));
downloadAnalysisBtn.addEventListener("click", downloadAnalysis);
openExtractionEngineBtn.addEventListener("click", async () => {
  openExtractionEngineModal();
  await loadExtractionEngineConfig();
});
closeEngineConfigBtn.addEventListener("click", closeExtractionEngineModal);
saveEngineConfigBtn.addEventListener("click", saveExtractionEngineConfig);

addEngineSectionBtn.addEventListener("click", () => {
  if (!extractionEngineConfig) return;
  syncEngineTopFields();
  extractionEngineConfig.sections.push({
    title: "New Section",
    items: ["New extraction point"],
  });
  renderEngineSections();
});

engineSections.addEventListener("input", (event) => {
  if (!extractionEngineConfig) return;
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;

  const sectionIndex = Number(target.dataset.sectionIndex);
  if (!Number.isFinite(sectionIndex) || !extractionEngineConfig.sections[sectionIndex]) return;

  if (target.dataset.engineField === "title") {
    extractionEngineConfig.sections[sectionIndex].title = target.value;
    return;
  }
  if (target.dataset.engineField === "item") {
    const pointIndex = Number(target.dataset.pointIndex);
    if (!Number.isFinite(pointIndex) || !extractionEngineConfig.sections[sectionIndex].items[pointIndex]) return;
    extractionEngineConfig.sections[sectionIndex].items[pointIndex] = target.value;
  }
});

engineSections.addEventListener("click", (event) => {
  if (!extractionEngineConfig) return;
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const button = target.closest("button[data-engine-action]");
  if (!button) return;

  const action = button.dataset.engineAction;
  const sectionIndex = Number(button.dataset.sectionIndex);
  if (!Number.isFinite(sectionIndex) || !extractionEngineConfig.sections[sectionIndex]) return;

  if (action === "remove-section") {
    extractionEngineConfig.sections.splice(sectionIndex, 1);
    if (!extractionEngineConfig.sections.length) {
      extractionEngineConfig.sections.push({ title: "New Section", items: ["New extraction point"] });
    }
    renderEngineSections();
    return;
  }

  if (action === "add-point") {
    extractionEngineConfig.sections[sectionIndex].items.push("New extraction point");
    renderEngineSections();
    return;
  }

  if (action === "remove-point") {
    const pointIndex = Number(button.dataset.pointIndex);
    if (!Number.isFinite(pointIndex)) return;
    extractionEngineConfig.sections[sectionIndex].items.splice(pointIndex, 1);
    if (!extractionEngineConfig.sections[sectionIndex].items.length) {
      extractionEngineConfig.sections[sectionIndex].items.push("New extraction point");
    }
    renderEngineSections();
  }
});

extractionEngineModal.addEventListener("click", (event) => {
  if (event.target === extractionEngineModal) {
    closeExtractionEngineModal();
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && extractionEngineModal && !extractionEngineModal.classList.contains("hidden")) {
    closeExtractionEngineModal();
  }
});

boot();
