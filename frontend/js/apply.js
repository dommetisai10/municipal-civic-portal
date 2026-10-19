/**
 * Service Application Module (ESM)
 * Dynamically renders form schema from MongoDB and handles multipart file uploads.
 */

import { apiFetch, checkDbHealth, updateDbStatusPill } from "./api.js";

let currentService = null;
let selectedFiles = [];

// Magic bytes signatures for instant client-side validation
const MAGIC_SIGNATURES = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  jpg: [0xFF, 0xD8, 0xFF],       // JPEG
  jpeg: [0xFF, 0xD8, 0xFF],      // JPEG
  png: [0x89, 0x50, 0x4E, 0x47]  // PNG
};

async function verifyClientMagicBytes(file) {
  const ext = file.name.split(".").pop().toLowerCase();
  const expectedSig = MAGIC_SIGNATURES[ext];
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

async function initApplicationPage() {
  const params = new URLSearchParams(window.location.search);
  const serviceSlug = params.get("service");

  const loadingCard = document.getElementById("service-loading-card");
  const authCard = document.getElementById("auth-required-card");
  const unavailCard = document.getElementById("service-unavailable-card");
  const appContainer = document.getElementById("application-container");

  if (!serviceSlug) {
    if (loadingCard) {
      loadingCard.innerHTML = `
        <div class="empty-icon">⚠️</div>
        <h3>No Service Selected</h3>
        <p class="text-muted mb-4">Please select a municipal service from the directory to begin an application.</p>
        <a href="services.html" class="btn btn-primary">Browse Services Directory</a>
      `;
    }
    return;
  }

  // 1. Verify Citizen Session
  try {
    const authRes = await apiFetch("/auth/me", { method: "GET" });
    if (!authRes.success || !authRes.data || authRes.data.role !== "citizen") {
      if (loadingCard) loadingCard.classList.add("d-none");
      if (authCard) {
        authCard.classList.remove("d-none");
        const loginLink = document.getElementById("auth-login-link");
        if (loginLink) loginLink.href = `login.html?returnUrl=${encodeURIComponent(window.location.href)}`;
      }
      return;
    }
    updateNavCitizen(authRes.data);
  } catch (err) {
    console.error("Auth check failed:", err);
  }

  // 2. Fetch Service Details from Database
  try {
    const srvRes = await apiFetch(`/services/${encodeURIComponent(serviceSlug)}`, { method: "GET" });
    if (!srvRes.success || !srvRes.data) {
      if (loadingCard) {
        loadingCard.innerHTML = `
          <div class="empty-icon">❌</div>
          <h3>Service Not Found</h3>
          <p class="text-muted mb-4">The requested service '${escapeHtml(serviceSlug)}' could not be found in the database.</p>
          <a href="services.html" class="btn btn-outline">Back to Services</a>
        `;
      }
      return;
    }

    currentService = srvRes.data;

    // 3. Availability Check
    if (currentService.availability === "Unavailable") {
      if (loadingCard) loadingCard.classList.add("d-none");
      if (unavailCard) {
        unavailCard.classList.remove("d-none");
        document.getElementById("unavailable-service-title").textContent = `${currentService.name} (Unavailable)`;
      }
      return;
    }

    // 4. Render Active Service Application Form
    if (loadingCard) loadingCard.classList.add("d-none");
    if (appContainer) appContainer.classList.remove("d-none");

    renderServiceHeader(currentService);
    renderDynamicForm(currentService.form_schema || []);
    setupFileUploadHandlers();
    setupFormSubmission();

  } catch (err) {
    console.error("Failed to load service:", err);
    if (loadingCard) {
      loadingCard.innerHTML = `
        <div class="empty-icon">🔌</div>
        <h3>Database Offline</h3>
        <p class="text-muted mb-4">Could not retrieve application requirements from the database.</p>
        <a href="services.html" class="btn btn-outline">Back to Services</a>
      `;
    }
  }
}

function renderServiceHeader(srv) {
  document.title = `Apply for ${srv.name} | Municipal Service Portal`;

  const breadcrumb = document.getElementById("breadcrumb-service-name");
  if (breadcrumb) breadcrumb.textContent = srv.name;

  const titleEl = document.getElementById("apply-service-name");
  if (titleEl) titleEl.textContent = srv.name;

  const categoryEl = document.getElementById("apply-service-category");
  if (categoryEl) categoryEl.textContent = srv.category || "General";

  const descEl = document.getElementById("apply-service-desc");
  if (descEl) descEl.textContent = srv.description || "";

  const slugInput = document.getElementById("apply-service-slug");
  if (slugInput) slugInput.value = srv.slug;

  const docsList = document.getElementById("apply-required-docs-list");
  if (docsList) {
    const docs = Array.isArray(srv.required_documents) ? srv.required_documents : [];
    if (docs.length === 0) {
      docsList.innerHTML = `<li class="text-muted text-xs">No formal documents required. Personal identity verification only.</li>`;
    } else {
      docsList.innerHTML = docs.map(d => `
        <li><span class="check-icon">✓</span> <span>${escapeHtml(d)}</span></li>
      `).join("");
    }
  }
}

function renderDynamicForm(schema) {
  const container = document.getElementById("dynamic-form-fields");
  if (!container) return;

  if (schema.length === 0) {
    container.innerHTML = `<p class="text-muted text-xs">No additional custom fields required for this application.</p>`;
    return;
  }

  container.innerHTML = schema.map(field => {
    const isRequired = field.required ? '<span class="text-danger">*</span>' : '<span class="text-muted text-xs">(Optional)</span>';
    const fieldId = `field_${escapeHtml(field.name)}`;

    if (field.type === "select") {
      const optionsHtml = (field.options || []).map(opt => `
        <option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>
      `).join("");

      return `
        <div class="form-group">
          <label for="${fieldId}" class="form-label">${escapeHtml(field.label)} ${isRequired}</label>
          <select 
            id="${fieldId}" 
            name="${escapeHtml(field.name)}" 
            class="form-control" 
            ${field.required ? 'required' : ''}
          >
            <option value="">-- Select ${escapeHtml(field.label)} --</option>
            ${optionsHtml}
          </select>
          <div class="field-error-text text-danger text-xs mt-1 d-none" id="error_${fieldId}"></div>
        </div>
      `;
    }

    if (field.type === "textarea") {
      return `
        <div class="form-group dynamic-full-width">
          <label for="${fieldId}" class="form-label">${escapeHtml(field.label)} ${isRequired}</label>
          <textarea 
            id="${fieldId}" 
            name="${escapeHtml(field.name)}" 
            class="form-control" 
            rows="3" 
            placeholder="${escapeHtml(field.placeholder || '')}"
            ${field.required ? 'required' : ''}
          ></textarea>
          <div class="field-error-text text-danger text-xs mt-1 d-none" id="error_${fieldId}"></div>
        </div>
      `;
    }

    const inputType = field.type === "date" ? "date" : "text";
    return `
      <div class="form-group">
        <label for="${fieldId}" class="form-label">${escapeHtml(field.label)} ${isRequired}</label>
        <input 
          type="${inputType}" 
          id="${fieldId}" 
          name="${escapeHtml(field.name)}" 
          class="form-control" 
          placeholder="${escapeHtml(field.placeholder || '')}"
          ${field.required ? 'required' : ''}
        >
        <div class="field-error-text text-danger text-xs mt-1 d-none" id="error_${fieldId}"></div>
      </div>
    `;
  }).join("");
}

function setupFileUploadHandlers() {
  const dropzone = document.getElementById("file-dropzone");
  const fileInput = document.getElementById("document-files-input");
  const filesListContainer = document.getElementById("selected-files-list");

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
      await handleIncomingFiles(e.dataTransfer.files);
    }
  });

  fileInput.addEventListener("change", async () => {
    if (fileInput.files) {
      await handleIncomingFiles(fileInput.files);
      fileInput.value = ""; // Reset to allow re-selecting same file
    }
  });

  async function handleIncomingFiles(fileList) {
    const alertBox = document.getElementById("apply-alert");
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const ext = file.name.split(".").pop().toLowerCase();

      // Extension check
      if (!["pdf", "jpg", "jpeg", "png"].includes(ext)) {
        showFormAlert(`File '${file.name}' has an unsupported extension. Allowed: PDF, JPG, PNG.`, "danger");
        continue;
      }

      // Size check (5 MB)
      if (file.size > 5 * 1024 * 1024) {
        showFormAlert(`File '${file.name}' exceeds the maximum allowed 5 MB limit (${(file.size / (1024 * 1024)).toFixed(1)} MB).`, "danger");
        continue;
      }

      if (file.size === 0) {
        showFormAlert(`File '${file.name}' is empty (0 bytes).`, "danger");
        continue;
      }

      // Binary magic bytes check on the client
      const magicValid = await verifyClientMagicBytes(file);
      if (!magicValid) {
        showFormAlert(`File '${file.name}' failed binary signature verification. The file content does not match the '.${ext}' extension.`, "danger");
        continue;
      }

      // Check duplicates
      if (selectedFiles.some(f => f.name === file.name && f.size === file.size)) {
        continue;
      }

      selectedFiles.push(file);
    }
    renderSelectedFiles();
  }

  function renderSelectedFiles() {
    if (!filesListContainer) return;
    if (selectedFiles.length === 0) {
      filesListContainer.innerHTML = "";
      return;
    }

    filesListContainer.innerHTML = selectedFiles.map((file, idx) => {
      const sizeKb = (file.size / 1024).toFixed(0);
      return `
        <div class="selected-file-chip" id="file-chip-${idx}">
          <span class="file-chip-icon">📄</span>
          <span class="file-chip-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
          <span class="file-chip-size">(${sizeKb} KB)</span>
          <button type="button" class="btn-remove-file" data-idx="${idx}" aria-label="Remove ${escapeHtml(file.name)}">×</button>
        </div>
      `;
    }).join("");

    filesListContainer.querySelectorAll(".btn-remove-file").forEach(btn => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(e.currentTarget.getAttribute("data-idx"), 10);
        selectedFiles.splice(idx, 1);
        renderSelectedFiles();
      });
    });
  }
}

function setupFormSubmission() {
  const form = document.getElementById("application-form");
  const submitBtn = document.getElementById("btn-submit-application");
  const spinner = document.getElementById("submit-spinner");
  const btnText = submitBtn?.querySelector(".btn-text");

  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFormAlerts();

    // 1. Check Declaration
    const declarationCheck = document.getElementById("declaration-check");
    if (!declarationCheck || !declarationCheck.checked) {
      showFormAlert("You must confirm the legal declaration before submitting your application.", "danger");
      return;
    }

    // 2. Validate Dynamic Fields
    const formDataObj = {};
    let hasFieldErrors = false;
    const schema = currentService.form_schema || [];

    for (const field of schema) {
      const inputEl = document.getElementById(`field_${field.name}`);
      const errorEl = document.getElementById(`error_field_${field.name}`);
      const val = inputEl ? inputEl.value.trim() : "";

      if (field.required && !val) {
        if (errorEl) {
          errorEl.textContent = `${field.label} is required.`;
          errorEl.classList.remove("d-none");
        }
        inputEl?.classList.add("input-error");
        hasFieldErrors = true;
      } else {
        if (errorEl) errorEl.classList.add("d-none");
        inputEl?.classList.remove("input-error");
        formDataObj[field.name] = val;
      }
    }

    if (hasFieldErrors) {
      showFormAlert("Please complete all required fields highlighted in red.", "danger");
      return;
    }

    // 3. Validate Documents
    const reqDocs = currentService.required_documents || [];
    if (reqDocs.length > 0 && selectedFiles.length === 0) {
      showFormAlert(`This service requires supporting documentation. Please attach at least one valid document scan (PDF, JPG, PNG).`, "danger");
      return;
    }

    // 4. Construct Multipart Form Data
    const payload = new FormData();
    payload.append("service_slug", currentService.slug);
    payload.append("form_data", JSON.stringify(formDataObj));

    selectedFiles.forEach(file => {
      payload.append("documents", file);
    });

    // 5. Submit Application with CSRF Protection
    setSubmitting(true);

    try {
      const res = await apiFetch("/applications", {
        method: "POST",
        body: payload
      });

      if (!res.success) {
        let msg = res.error?.message || "Failed to submit application.";
        if (res.error?.fields) {
          const detailMsgs = Object.values(res.error.fields).join(" ");
          msg += ` Details: ${detailMsgs}`;
        }
        showFormAlert(msg, "danger");
        setSubmitting(false);
        return;
      }

      // Success Display
      showApplicationSuccess(res.data);

    } catch (err) {
      console.error("Submission failed:", err);
      showFormAlert("Connection failed while submitting application to the database. Please try again.", "danger");
      setSubmitting(false);
    }
  });

  function setSubmitting(isSubmitting) {
    if (submitBtn) submitBtn.disabled = isSubmitting;
    if (spinner) spinner.classList.toggle("d-none", !isSubmitting);
    if (btnText) btnText.textContent = isSubmitting ? "Submitting Application..." : "Submit Application";
  }
}

function showApplicationSuccess(data) {
  const appContainer = document.getElementById("application-container");
  const successCard = document.getElementById("application-success-card");

  if (appContainer) appContainer.classList.add("d-none");
  if (successCard) {
    successCard.classList.remove("d-none");
    const idEl = document.getElementById("success-app-id");
    if (idEl) idEl.textContent = data.application_id || "MSP-APP-2026-XXXXXXXX";

    const srvNameEl = document.getElementById("success-service-name");
    if (srvNameEl) srvNameEl.textContent = data.service_name || currentService.name;

    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

function showFormAlert(message, type = "danger") {
  const alertBox = document.getElementById("apply-alert");
  if (!alertBox) return;

  alertBox.className = `alert alert-${type} mb-4`;
  alertBox.textContent = message;
  alertBox.classList.remove("d-none");
  alertBox.scrollIntoView({ behavior: "smooth", block: "center" });
}

function clearFormAlerts() {
  const alertBox = document.getElementById("apply-alert");
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

  await initApplicationPage();
});
