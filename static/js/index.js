const dropzone = document.getElementById("dropzone");
const input = document.getElementById("fileInput");
const uploadBtn = document.getElementById("uploadBtn");
const statusEl = document.getElementById("uploadStatus");
const straiveModal = document.getElementById("straiveModal");
const modalStraiveKey = document.getElementById("modalStraiveKey");
const saveStraiveModalBtn = document.getElementById("saveStraiveModalBtn");
const modalStraiveStatus = document.getElementById("modalStraiveStatus");
const openStraiveModalBtn = document.getElementById("openStraiveModalBtn");

let pendingFile = null;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setLoadingStatus(message) {
  statusEl.classList.add("loading-status");
  statusEl.innerHTML = `${message} <span class="loading-dots" aria-hidden="true"></span>`;
}

function clearLoadingStatus(message) {
  statusEl.classList.remove("loading-status");
  statusEl.textContent = message;
}

function openStraiveModal() {
  straiveModal.classList.remove("hidden");
}

function closeStraiveModal() {
  straiveModal.classList.add("hidden");
}

async function loadStraiveConfigOnHome() {
  const res = await fetch("/api/config/straive");
  if (!res.ok) {
    modalStraiveStatus.textContent = "";
    return;
  }
  await res.json();
}

async function saveStraiveFromModal() {
  modalStraiveStatus.textContent = "Saving...";
  const res = await fetch("/api/config/straive", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: modalStraiveKey.value || "",
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    modalStraiveStatus.textContent = data.detail || "Failed to save settings.";
    return;
  }
  modalStraiveKey.value = "";
  modalStraiveStatus.textContent = "Saved.";
  closeStraiveModal();
}

["dragenter", "dragover"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((evt) => {
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (e) => {
  pendingFile = e.dataTransfer.files?.[0] || null;
  if (pendingFile) {
    statusEl.textContent = `Selected: ${pendingFile.name}`;
  }
});

input.addEventListener("change", () => {
  pendingFile = input.files?.[0] || null;
  if (pendingFile) {
    statusEl.textContent = `Selected: ${pendingFile.name}`;
  }
});

uploadBtn.addEventListener("click", async () => {
  const file = pendingFile || input.files?.[0];
  if (!file) {
    statusEl.textContent = "Select a DXF or STEP file first.";
    return;
  }

  const ext = file.name.toLowerCase();
  if (!ext.endsWith(".dxf") && !ext.endsWith(".step") && !ext.endsWith(".stp") && !ext.endsWith(".glb") && !ext.endsWith(".gltf") && !ext.endsWith(".stl")) {
    statusEl.textContent = "Unsupported format.";
    return;
  }

  setLoadingStatus("Uploading");
  uploadBtn.disabled = true;
  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    if (!res.ok) {
      clearLoadingStatus("Upload failed.");
      return;
    }

    const data = await res.json();
    if (data.cached) {
      setLoadingStatus("Using cached analysis");
    } else {
      setLoadingStatus("Preparing analysis workspace");
    }
    await wait(4500);
    window.location.href = data.analysis_url;
  } catch (_err) {
    clearLoadingStatus("Upload failed.");
  } finally {
    uploadBtn.disabled = false;
  }
});

saveStraiveModalBtn.addEventListener("click", saveStraiveFromModal);
openStraiveModalBtn.addEventListener("click", openStraiveModal);
loadStraiveConfigOnHome();
