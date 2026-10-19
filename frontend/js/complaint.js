/**
 * Grievance Submission Module (ESM)
 * Handles citizen complaints, municipal department selection, geolocation, and image proof verification.
 */

import { apiFetch, checkDbHealth, updateDbStatusPill } from "./api.js";

let selectedImages = [];

// Magic bytes signatures for images only
const IMAGE_MAGIC_SIGNATURES = {
  jpg: [0xFF, 0xD8, 0xFF],
  jpeg: [0xFF, 0xD8, 0xFF],
  png: [0x89, 0x50, 0x4E, 0x47]
};

async function verifyClientImageMagicBytes(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  const expectedSig = IMAGE_MAGIC_SIGNATURES[ext];
  if (!expectedSig) return false;

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = (e) => {
      if (!e.target || !e.target.result) {
        resolve(false);
        return;
      }
      const arr = new Uint8Array(e.target.result).subarray(0, expectedSig.length);
      const matches = expectedSig.every((byte, idx) => arr[idx] === byte);
      resolve(matches);
    };
    reader.onerror = () => resolve(false);
    reader.readAsArrayBuffer(file.slice(0, 16));
  });
}

async function initComplaintPage() {
  const authCard = document.getElementById("auth-required-card");
  const formContainer = document.getElementById("complaint-form-container");

  // 1. Check Citizen Authentication
  try {
    const authRes = await apiFetch("/auth/me", { method: "GET" });
    if (!authRes.success || !authRes.data || authRes.data.role !== "citizen") {
      if (formContainer) formContainer.classList.add("d-none");
      if (authCard) {
        authCard.classList.remove("d-none");
        const loginLink = document.getElementById("auth-login-link");
        if (loginLink) loginLink.href = `login.html?returnUrl=${encodeURIComponent(window.location.href)}`;
      }
      return;
    }
    updateNavCitizen(authRes.data);
  } catch (err) {
    console.error("Auth verification failed:", err);
  }

  // 2. Load Department Options
  await loadDepartments();

  // 3. Initialize Interactive Features
  setupCharacterCounter();
  setupGeolocation();
  setupImageDropzone();
  setupComplaintFormSubmit();
}

async function loadDepartments() {
  const deptSelect = document.getElementById("complaint-department");
  if (!deptSelect) return;

  try {
    const res = await apiFetch("/complaints/departments", { method: "GET" });
    if (res.success && Array.isArray(res.data)) {
      deptSelect.innerHTML = `<option value="">-- Select Department --</option>` +
        res.data.map(dept => `<option value="${escapeHtml(dept)}">${escapeHtml(dept)}</option>`).join("");
    }
  } catch (err) {
    console.error("Failed to load departments:", err);
  }
}

function setupCharacterCounter() {
  const descInput = document.getElementById("complaint-description");
  const counter = document.getElementById("desc-char-counter");

  if (descInput && counter) {
    descInput.addEventListener("input", () => {
      const len = descInput.value.length;
      counter.textContent = `${len} / 2000`;
      if (len > 2000) {
        counter.classList.add("text-danger");
      } else {
        counter.classList.remove("text-danger");
      }
    });
  }
}

function setupGeolocation() {
  const geoBtn = document.getElementById("btn-detect-geo");
  const statusIndicator = document.getElementById("geo-status-indicator");
  const statusText = document.getElementById("geo-status-text");
  const pill = document.getElementById("geo-coordinates-pill");
  const latDisplay = document.getElementById("geo-lat-display");
  const lngDisplay = document.getElementById("geo-lng-display");
  const clearBtn = document.getElementById("btn-clear-geo");
  const latInput = document.getElementById("geo-latitude");
  const lngInput = document.getElementById("geo-longitude");

  if (!geoBtn) return;

  geoBtn.addEventListener("click", () => {
    if (!navigator.geolocation) {
      alert("Geolocation is not supported by your browser.");
      return;
    }

    if (statusIndicator) statusIndicator.classList.remove("d-none");
    if (statusText) statusText.textContent = "Requesting device GPS coordinates...";
    geoBtn.disabled = true;

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const lat = position.coords.latitude.toFixed(6);
        const lng = position.coords.longitude.toFixed(6);

        if (latInput) latInput.value = lat;
        if (lngInput) lngInput.value = lng;
        if (latDisplay) latDisplay.textContent = lat;
        if (lngDisplay) lngDisplay.textContent = lng;

        if (statusIndicator) statusIndicator.classList.add("d-none");
        if (pill) pill.classList.remove("d-none");
        geoBtn.disabled = false;
      },
      (error) => {
        let msg = "Could not detect location.";
        if (error.code === error.PERMISSION_DENIED) {
          msg = "Location access was denied. You may manually specify the landmark address.";
        } else if (error.code === error.TIMEOUT) {
          msg = "GPS location request timed out.";
        }
        if (statusText) statusText.textContent = msg;
        geoBtn.disabled = false;
      },
      { timeout: 10000, enableHighAccuracy: true }
    );
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      if (latInput) latInput.value = "";
      if (lngInput) lngInput.value = "";
      if (pill) pill.classList.add("d-none");
    });
  }
}

function setupImageDropzone() {
  const dropzone = document.getElementById("image-dropzone");
  const fileInput = document.getElementById("image-files-input");
  const listContainer = document.getElementById("selected-images-list");

  if (!dropzone || !fileInput) return;

  dropzone.addEventListener("click", () => fileInput.click());

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("dragover");
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.classList.remove("dragover");
  });

  dropzone.addEventListener("drop", async (e) => {
    e.preventDefault();
    dropzone.classList.remove("dragover");
    if (e.dataTransfer && e.dataTransfer.files) {
      await handleIncomingImages(e.dataTransfer.files);
    }
  });

  fileInput.addEventListener("change", async () => {
    if (fileInput.files) {
      await handleIncomingImages(fileInput.files);
      fileInput.value = "";
    }
  });

  async function handleIncomingImages(fileList) {
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const ext = file.name.split(".").pop().toLowerCase();

      // Only images allowed for complaints
      if (!["jpg", "jpeg", "png"].includes(ext)) {
        showComplaintAlert(`File '${file.name}' is not an accepted image. Grievance evidence must be JPG or PNG.`, "danger");
        continue;
      }

      if (file.size > 5 * 1024 * 1024) {
        showComplaintAlert(`Image '${file.name}' exceeds the 5 MB limit (${(file.size / (1024 * 1024)).toFixed(1)} MB).`, "danger");
        continue;
      }

      if (file.size === 0) {
        showComplaintAlert(`Image '${file.name}' is empty (0 bytes).`, "danger");
        continue;
      }

      // Check binary magic bytes
      const isValidSig = await verifyClientImageMagicBytes(file);
      if (!isValidSig) {
        showComplaintAlert(`Image '${file.name}' failed binary validation. The contents do not match a valid ${ext.toUpperCase()} file.`, "danger");
        continue;
      }

      if (selectedImages.some(img => img.name === file.name && img.size === file.size)) {
        continue;
      }

      selectedImages.push(file);
    }
    renderSelectedImages();
  }

  function renderSelectedImages() {
    if (!listContainer) return;
    if (selectedImages.length === 0) {
      listContainer.innerHTML = "";
      return;
    }

    listContainer.innerHTML = selectedImages.map((file, idx) => {
      const sizeKb = (file.size / 1024).toFixed(0);
      return `
        <div class="selected-file-chip" id="image-chip-${idx}">
          <span class="file-chip-icon">📷</span>
          <span class="file-chip-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="file-chip-size">(${sizeKb} KB)</span>
          <button type="button" class="btn-remove-file" data-idx="${idx}" aria-label="Remove image">×</button>
        </div>
      `;
    }).join("");

    listContainer.querySelectorAll(".btn-remove-file").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(e.currentTarget.getAttribute("data-idx"), 10);
        selectedImages.splice(idx, 1);
        renderSelectedImages();
      });
    });
  }
}

function setupComplaintFormSubmit() {
  const form = document.getElementById("complaint-form");
  const submitBtn = document.getElementById("btn-submit-complaint");
  const spinner = document.getElementById("submit-spinner");
  const btnText = submitBtn?.querySelector(".btn-text");

  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearComplaintAlert();

    const titleInput = document.getElementById("complaint-title");
    const deptSelect = document.getElementById("complaint-department");
    const descInput = document.getElementById("complaint-description");
    const locInput = document.getElementById("complaint-location");
    const declCheck = document.getElementById("complaint-declaration");
    const latInput = document.getElementById("geo-latitude");
    const lngInput = document.getElementById("geo-longitude");

    let hasErrors = false;

    // Validate Title
    const titleVal = titleInput?.value.trim() || "";
    if (titleVal.length < 5 || titleVal.length > 120) {
      showFieldError("title", "Title must be between 5 and 120 characters.");
      hasErrors = true;
    } else {
      clearFieldError("title");
    }

    // Validate Department
    const deptVal = deptSelect?.value.trim() || "";
    if (!deptVal) {
      showFieldError("department", "Please select a municipal department.");
      hasErrors = true;
    } else {
      clearFieldError("department");
    }

    // Validate Description
    const descVal = descInput?.value.trim() || "";
    if (descVal.length < 15 || descVal.length > 2000) {
      showFieldError("description", "Description must be between 15 and 2000 characters.");
      hasErrors = true;
    } else {
      clearFieldError("description");
    }

    // Validate Location
    const locVal = locInput?.value.trim() || "";
    if (locVal.length < 5 || locVal.length > 300) {
      showFieldError("location", "Location address must be between 5 and 300 characters.");
      hasErrors = true;
    } else {
      clearFieldError("location");
    }

    // Check Declaration
    if (!declCheck || !declCheck.checked) {
      showComplaintAlert("You must confirm the legal certification before submitting.", "danger");
      return;
    }

    if (hasErrors) {
      showComplaintAlert("Please correct the highlighted fields before proceeding.", "danger");
      return;
    }

    // Build Payload
    const payload = new FormData();
    payload.append("title", titleVal);
    payload.append("department", deptVal);
    payload.append("description", descVal);
    payload.append("location", locVal);

    if (latInput?.value && lngInput?.value) {
      payload.append("latitude", latInput.value);
      payload.append("longitude", lngInput.value);
    }

    selectedImages.forEach(img => {
      payload.append("images", img);
    });

    // Submit with CSRF protection
    setSubmitting(true);

    try {
      const res = await apiFetch("/complaints", {
        method: "POST",
        body: payload
      });

      if (!res.success) {
        let msg = res.error?.message || "Failed to submit grievance.";
        if (res.error?.fields) {
          const detailMsgs = Object.values(res.error.fields).join(" ");
          msg += ` Details: ${detailMsgs}`;
        }
        showComplaintAlert(msg, "danger");
        setSubmitting(false);
        return;
      }

      showComplaintSuccess(res.data);

    } catch (err) {
      console.error("Grievance submission error:", err);
      showComplaintAlert("Connection failed while registering complaint in the database. Please try again.", "danger");
      setSubmitting(false);
    }
  });

  function setSubmitting(isSubmitting) {
    if (submitBtn) submitBtn.disabled = isSubmitting;
    if (spinner) spinner.classList.toggle("d-none", !isSubmitting);
    if (btnText) btnText.textContent = isSubmitting ? "Registering Grievance..." : "Register Grievance";
  }
}

function showComplaintSuccess(data) {
  const formContainer = document.getElementById("complaint-form-container");
  const successCard = document.getElementById("complaint-success-card");

  if (formContainer) formContainer.classList.add("d-none");
  if (successCard) {
    successCard.classList.remove("d-none");
    const idEl = document.getElementById("success-complaint-id");
    if (idEl) idEl.textContent = data.complaint_id || "MSP-CMP-2026-XXXXXXXX";

    const titleEl = document.getElementById("success-complaint-title");
    if (titleEl) titleEl.textContent = data.title || "";

    const deptEl = document.getElementById("success-complaint-dept");
    if (deptEl) deptEl.textContent = data.department || "";

    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function showFieldError(field, msg) {
  const errEl = document.getElementById(`error_${field}`);
  const inputEl = document.getElementById(`complaint-${field}`);
  if (errEl) {
    errEl.textContent = msg;
    errEl.classList.remove("d-none");
  }
  inputEl?.classList.add("input-error");
}

function clearFieldError(field) {
  const errEl = document.getElementById(`error_${field}`);
  const inputEl = document.getElementById(`complaint-${field}`);
  if (errEl) errEl.classList.add("d-none");
  inputEl?.classList.remove("input-error");
}

function showComplaintAlert(msg, type = "danger") {
  const alertBox = document.getElementById("complaint-alert");
  if (!alertBox) return;

  alertBox.className = `alert alert-${type} mb-4`;
  alertBox.textContent = msg;
  alertBox.classList.remove("d-none");
  alertBox.scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearComplaintAlert() {
  const alertBox = document.getElementById("complaint-alert");
  if (alertBox) alertBox.classList.add("d-none");
}

function updateNavCitizen(user) {
  const authContainer = document.getElementById("nav-auth-actions");
  if (!authContainer) return;

  authContainer.innerHTML = `
    <a href="user-dashboard.html" class="btn btn-sm btn-outline">Dashboard</a>
    <button class="btn btn-sm btn-ghost" id="nav-logout-btn">Sign Out</button>
  `;
  document.getElementById("nav-logout-btn")?.addEventListener("click", async () => {
    await apiFetch("/auth/logout", { method: "POST" });
    window.location.reload();
  });
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

document.addEventListener("DOMContentLoaded", async () => {
  const yearEl = document.getElementById("footer-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const isHealthy = await checkDbHealth();
  updateDbStatusPill(isHealthy);

  await initComplaintPage();
});
