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

function renderStructuredSummary(structured, source = "", reason = "", screenshots = 0) {
  if (!structured || !structured.sections) {
    summaryBox.textContent = "Summary format unavailable.";
    return;
  }

  const badges = (structured.badges || [])
    .map((b) => `<span class="summary-badge tone-${b.tone || "neutral"}">${b.label}</span>`)
    .join("");

  const sections = [
    { key: "part_identification", title: "Part Identification", icon: "PI" },
    { key: "materials", title: "Materials", icon: "MT" },
    { key: "manufacturing", title: "Manufacturing", icon: "MF" },
    { key: "complexity", title: "Complexity", icon: "CX" },
    { key: "recommendation", title: "Recommendation", icon: "RC" },
  ];

  const cards = sections
    .map((section) => {
      const items = structured.sections?.[section.key] || [];
      const list = items.map((item) => `<li>${item}</li>`).join("");
      return `
        <article class="summary-card">
          <div class="summary-card-head">
            <span class="summary-icon">${section.icon}</span>
            <h4>${section.title}</h4>
          </div>
          <ul>${list}</ul>
        </article>
      `;
    })
    .join("");

  summaryBox.innerHTML = `
    <div class="summary-meta subtle">Source: ${source || "unknown"}${reason ? ` (${reason})` : ""} | Screenshots: ${screenshots}</div>
    <div class="summary-badges">${badges}</div>
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
    renderStructuredSummary(
      data.summary_structured,
      data.summary_source || "unknown",
      data.summary_reason || "",
      Number(data.screenshots_count || 0),
    );
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
  } else if (asset.glb) {
    viewerMode = "module";
    initViewer();
    animate();
    loadModel(asset.glb);
  } else if (asset.source_type === "dxf") {
    viewerMode = "module";
    initViewer();
    animate();
    renderDxfLines(asset.preview_lines || []);
  } else {
    viewerMode = "module";
    initViewer();
    animate();
    showPreviewError("Preview unavailable for this asset.");
  }

  if (asset.summary) {
    renderStructuredSummary(
      asset.summary_structured,
      asset.summary_source || "stored",
      asset.summary_reason || "",
      (asset.screenshots || []).length,
    );
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
