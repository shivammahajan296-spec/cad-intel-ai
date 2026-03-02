import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { STLLoader } from "three/addons/loaders/STLLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const params = new URLSearchParams(window.location.search);
const assetId = params.get("asset_id");

const metaRows = document.getElementById("metaRows");
const summaryBox = document.getElementById("summaryBox");
const captureBtn = document.getElementById("captureBtn");
const summarizeBtn = document.getElementById("summarizeBtn");
const container = document.getElementById("viewerCanvas");

let asset = null;
let scene, camera, renderer, controls, modelRoot;
let savedScreenshots = [];
let previewReady = false;
let analysisRunning = false;
let viewerMode = "module";

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

function renderDynamicSummary(summaryText) {
  if (!summaryText || !summaryText.trim()) {
    summaryBox.textContent = "No summary generated.";
    return;
  }

  const lines = summaryText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length);

  const isDivider = (line) => /^[-_]{4,}$/.test(line);
  const isHeading = (line) =>
    /^\s*(\d+[\)\.\-]?\s*)?[A-Za-z][A-Za-z0-9/&(),\-\s]{2,}:?\s*$/.test(line) &&
    !/^[\-\*\u2022]/.test(line);

  const cleanHeading = (line) =>
    line
      .replace(/^\s*\d+[\)\.\-]?\s*/, "")
      .replace(/:$/, "")
      .trim();

  const toBullets = (line) => {
    const cleaned = line.replace(/^[\-\*\u2022]\s*/, "").trim();
    if (!cleaned) return [];
    if (cleaned.includes(" - ")) {
      return cleaned.split(" - ").map((item) => item.trim()).filter(Boolean);
    }
    return [cleaned];
  };

  const sections = [];
  let current = { title: "Analysis", items: [] };
  sections.push(current);

  for (const line of lines) {
    if (isDivider(line)) continue;
    if (isHeading(line)) {
      current = { title: cleanHeading(line), items: [] };
      sections.push(current);
      continue;
    }
    const bullets = toBullets(line);
    if (bullets.length) {
      current.items.push(...bullets);
    }
  }

  const cards = sections
    .filter((section) => section.items.length)
    .map((section) => {
      const itemsHtml = section.items.map((item) => `<li>${item}</li>`).join("");
      return `<article class="summary-card"><h4>${section.title}</h4><ul>${itemsHtml}</ul></article>`;
    })
    .join("");

  summaryBox.innerHTML = `
    <div class="summary-grid">${cards}</div>
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
    renderDynamicSummary(data.summary || "");
  } catch (err) {
    console.error("[analysis] summaryPipeline.error", err);
    summaryBox.textContent = `Analysis failed: ${err.message}`;
  } finally {
    analysisRunning = false;
  }
}

async function boot() {
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

boot();
