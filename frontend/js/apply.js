/**
 * Service Application Module (ESM)
 * 
 * Features:
 * - Single source of truth for document requirements driven by Service.requiredDocuments
 * - Services with 0 required docs (e.g. Streetlight Repair) submit cleanly without files
 * - Individual upload slots per required document with name, size, preview, and remove button
 * - Optional file attachments allowed for all services
 * - Case-insensitive extension (.PDF) and MIME validation
 * - Client-side magic byte inspection
 * - FormData multipart submission with browser boundary management
 * - Field-level error highlights with auto-scroll and focus
 * - Unsaved data warning and draft restoration across auth redirects
 * - Double-submit prevention with loading feedback
 * - Success screen with Tracking ID, View My Applications, and Track Status buttons
 */

import { apiFetch, getAuthUser, logoutUser, escapeHtml, startDbHealthPolling, getStoredToken, getCsrfToken } from "./api.js";

let currentService = null;
let activeCitizen = null;
let isSubmitting = false;
let formIsDirty = false;

// Selected files state map: key -> File object
const selectedDocsState = {};

// Magic bytes signatures for instant client-side binary validation
const MAGIC_SIGNATURES = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  jpg: [0xFF, 0xD8, 0xFF],       // JPEG
  jpeg: [0xFF, 0xD8, 0xFF],      // JPEG
  png: [0x89, 0x50, 0x4E, 0x47]  // PNG
};

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Checks whether a service is active for citizen applications.
 */
export function isServiceAvailable(service) {
  if (!service) return false;
  const avail = String(service.availability || "").trim().toLowerCase();
  return avail === "available" || avail === "active";
}

/**
 * Normalizes document requirements from service record.
 */
function getNormalizedDocs(service) {
  if (Array.isArray(service.requiredDocuments) && service.requiredDocuments.length > 0) {
    return service.requiredDocuments;
  }
  if (Array.isArray(service.required_documents) && service.required_documents.length > 0) {
    return service.required_documents.map(label => ({
      key: label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""),
      label: label,
      required: true,
      allowedTypes: ["pdf", "jpg", "jpeg", "png"],
      maxSizeMB: 5
    }));
  }
  return [];
}

/**
 * Mutually exclusive single state machine renderer
 */
export function setPageState(state, options = {}) {
  const panels = {
    loading: document.getElementById("service-loading-card"),
    unauthenticated: document.getElementById("auth-required-card"),
    unavailable: document.getElementById("service-unavailable-card"),
    error: document.getElementById("service-error-card"),
    ready: document.getElementById("application-container"),
    success: document.getElementById("application-success-card")
  };

  Object.entries(panels).forEach(([key, el]) => {
    if (!el) return;
    if (key === state) {
      el.hidden = false;
      el.removeAttribute("hidden");
      el.classList.remove("d-none", "hidden");
      el.style.display = "";
    } else {
      el.hidden = true;
      el.setAttribute("hidden", "");
      el.classList.add("d-none", "hidden");
      el.style.display = "none";
    }
  });

  if (state === "unauthenticated") {
    const loginLink = document.getElementById("auth-login-link");
    if (loginLink) {
      const returnUrl = options.returnUrl || (window.location.pathname + window.location.search);
      loginLink.href = `login.html?returnUrl=${encodeURIComponent(returnUrl)}`;
    }
  } else if (state === "unavailable") {
    const titleEl = document.getElementById("unavailable-service-title");
    if (titleEl && options.service) {
      titleEl.textContent = `${options.service.name} (Service Currently Unavailable)`;
    }
  } else if (state === "error") {
    const titleEl = document.getElementById("error-card-title");
    const descEl = document.getElementById("error-card-desc");
    const iconEl = document.getElementById("error-card-icon");
    if (titleEl && options.title) titleEl.textContent = options.title;
    if (descEl && options.message) descEl.textContent = options.message;
    if (iconEl && options.icon) iconEl.textContent = options.icon;
  } else if (state === "success") {
    const ref = options.referenceNumber || options.application_id || "MSP-APP-2026-XXXXXXXX";
    const idEl = document.getElementById("success-app-id");
    if (idEl) idEl.textContent = ref;

    const srvNameEl = document.getElementById("success-service-name");
    if (srvNameEl) srvNameEl.textContent = options.service_name || currentService?.name || "Municipal Service";

    // Update Track Status button link
    const trackBtn = document.getElementById("success-track-btn");
    if (trackBtn) {
      trackBtn.href = `track-status.html?ref=${encodeURIComponent(ref)}`;
    }

    formIsDirty = false;
    clearDraftStorage();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
}

/**
 * Validates binary magic byte signature using FileReader
 */
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

/**
 * Main Page Initialization
 */
async function initApplicationPage() {
  const params = new URLSearchParams(window.location.search);
  const serviceSlug = params.get("slug") || params.get("service") || params.get("id");

  setPageState("loading");

  if (!serviceSlug) {
    setPageState("error", {
      title: "No Service Selected",
      message: "Please select a municipal service from the directory to begin an application.",
      icon: "⚠️"
    });
    return;
  }

  // Verify Citizen Authentication
  const citizen = await getAuthUser();
  if (!citizen || citizen.role !== "citizen") {
    // Save draft indicator for return
    setPageState("unauthenticated", {
      returnUrl: window.location.pathname + window.location.search
    });
    return;
  }

  activeCitizen = citizen;
  updateNavCitizen(citizen);

  // Retrieve Service Metadata from Backend
  try {
    const srvRes = await apiFetch(`/services/${encodeURIComponent(serviceSlug)}`, { method: "GET" });
    if (!srvRes.success || !srvRes.data) {
      setPageState("error", {
        title: "Service Not Found",
        message: `The requested service '${escapeHtml(serviceSlug)}' could not be found in the municipal database.`,
        icon: "❌"
      });
      return;
    }

    currentService = srvRes.data;

    // Availability Enforcement
    if (!isServiceAvailable(currentService)) {
      setPageState("unavailable", { service: currentService });
      return;
    }

    // Render Page Components
    setPageState("ready");
    renderServiceHeader(currentService);
    renderDynamicForm(currentService.form_schema || [], citizen);
    renderDocumentUploadSection(currentService);
    restoreDraftStorage();
    setupFormSubmission();
    setupUnloadWarning();

  } catch (err) {
    console.error("Failed to load service:", err);
    setPageState("error", {
      title: "Database Unavailable",
      message: "Could not retrieve application requirements from the database. Please verify connection.",
      icon: "🔌"
    });
  }
}

/**
 * Renders Service Title, Category, and Supporting Documents Checklist Box
 * Driven strictly by Service.requiredDocuments as single source of truth.
 */
function renderServiceHeader(srv) {
  document.title = `Apply for ${srv.name} | Municipal Service Portal`;

  const nameEl = document.getElementById("apply-service-name");
  const catEl = document.getElementById("apply-service-category");
  const descEl = document.getElementById("apply-service-desc");
  const slugInput = document.getElementById("apply-service-slug");
  const breadcrumbName = document.getElementById("breadcrumb-service-name");
  const statusBadge = document.getElementById("apply-service-status");

  if (nameEl) nameEl.textContent = srv.name;
  if (catEl) catEl.textContent = srv.category || "General";
  if (descEl) descEl.textContent = srv.description || "Official municipal public service.";
  if (slugInput) slugInput.value = srv.slug;
  if (breadcrumbName) breadcrumbName.textContent = srv.name;

  if (statusBadge) {
    const isAvail = isServiceAvailable(srv);
    statusBadge.textContent = isAvail ? "Available - Online Application" : "Currently Unavailable";
    statusBadge.className = isAvail ? "badge badge-success" : "badge badge-warning";
  }

  const feeEl = document.getElementById("apply-service-fee");
  const slaEl = document.getElementById("apply-service-sla");
  if (feeEl) {
    const feeVal = srv.fee !== undefined && srv.fee !== null ? parseFloat(srv.fee) : 0;
    feeEl.textContent = feeVal > 0 ? `₹${feeVal.toFixed(2)}` : "Free of Charge";
  }
  if (slaEl) {
    const slaVal = srv.processing_days || srv.sla_days || 7;
    slaEl.textContent = `${slaVal} Working Days`;
  }

  // Supporting Documents Checklist Box
  const checklistBox = document.getElementById("required-docs-checklist-box");
  const subtextEl = document.getElementById("checklist-subtext");
  const docsList = document.getElementById("apply-required-docs-list");

  const reqDocs = getNormalizedDocs(srv).filter(d => d.required !== false);

  if (docsList) {
    docsList.innerHTML = "";
    if (reqDocs.length === 0) {
      if (subtextEl) {
        subtextEl.style.display = "none";
      }
      docsList.innerHTML = `
        <li class="text-success font-medium">
          <span class="check-icon" aria-hidden="true">✓</span>
          <span><strong>No documents required.</strong> Instant online verification.</span>
        </li>
      `;
    } else {
      if (subtextEl) {
        subtextEl.style.display = "";
        subtextEl.textContent = "Ensure you have clear digital scans (PDF, JPG, JPEG, PNG, max 5 MB each):";
      }
      reqDocs.forEach(doc => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="check-icon" aria-hidden="true">✓</span> <span>${escapeHtml(doc.label)}</span>`;
        docsList.appendChild(li);
      });
    }
  }
}

/**
 * Renders Form Details Fields with Full Widths and Controlled Inputs
 */
function renderDynamicForm(schema, citizen) {
  const container = document.getElementById("dynamic-form-fields");
  if (!container) return;

  if (!Array.isArray(schema) || schema.length === 0) {
    container.innerHTML = `
      <div class="dynamic-full-width">
        <label for="field_general_notes" class="form-label">Application Remarks &amp; Statement <span class="text-danger">*</span></label>
        <textarea id="field_general_notes" name="general_notes" class="form-input" rows="4" placeholder="Provide any details relevant to your request..." required></textarea>
        <div class="field-error-text text-danger text-xs mt-1 d-none" id="error_field_general_notes"></div>
      </div>
    `;
    return;
  }

  container.innerHTML = schema.map(field => {
    const fieldId = `field_${field.name}`;
    const isRequired = field.required ? '<span class="text-danger">*</span>' : "";
    const reqAttr = field.required ? "required" : "";
    const fullWidthClass = (field.type === "textarea" || field.full_width) ? "dynamic-full-width" : "";

    let prefilledVal = "";
    if (citizen) {
      if (field.name.includes("applicant_name") || field.name.includes("citizen_name") || field.name === "name") {
        prefilledVal = citizen.full_name || "";
      } else if (field.name.includes("email")) {
        prefilledVal = citizen.email || "";
      } else if (field.name.includes("mobile") || field.name.includes("phone")) {
        prefilledVal = citizen.mobile || "";
      } else if (field.name.includes("address")) {
        prefilledVal = citizen.address || "";
      }
    }

    if (field.type === "select") {
      const optionsHtml = (field.options || [])
        .map(opt => `<option value="${escapeHtml(opt)}">${escapeHtml(opt)}</option>`)
        .join("");

      return `
        <div class="form-group ${fullWidthClass}">
          <label for="${fieldId}" class="form-label font-bold">${escapeHtml(field.label)} ${isRequired}</label>
          <select id="${fieldId}" name="${escapeHtml(field.name)}" class="form-input" ${reqAttr}>
            <option value="">-- Select ${escapeHtml(field.label)} --</option>
            ${optionsHtml}
          </select>
          <div class="field-error-text text-danger text-xs mt-1 d-none" id="error_${fieldId}"></div>
        </div>
      `;
    }

    if (field.type === "textarea") {
      return `
        <div class="form-group ${fullWidthClass}">
          <label for="${fieldId}" class="form-label font-bold">${escapeHtml(field.label)} ${isRequired}</label>
          <textarea 
            id="${fieldId}" 
            name="${escapeHtml(field.name)}" 
            class="form-input" 
            rows="${field.rows || 3}" 
            placeholder="${escapeHtml(field.placeholder || "Enter details...")}" 
            ${reqAttr}
          >${escapeHtml(prefilledVal)}</textarea>
          <div class="field-error-text text-danger text-xs mt-1 d-none" id="error_${fieldId}"></div>
        </div>
      `;
    }

    return `
      <div class="form-group ${fullWidthClass}">
        <label for="${fieldId}" class="form-label font-bold">${escapeHtml(field.label)} ${isRequired}</label>
        <input 
          type="${field.type || "text"}" 
          id="${fieldId}" 
          name="${escapeHtml(field.name)}" 
          class="form-input" 
          placeholder="${escapeHtml(field.placeholder || "")}" 
          value="${escapeHtml(prefilledVal)}"
          ${reqAttr}
        >
        <div class="field-error-text text-danger text-xs mt-1 d-none" id="error_${fieldId}"></div>
      </div>
    `;
  }).join("");

  // Attach dirty tracking
  container.querySelectorAll("input, textarea, select").forEach(el => {
    el.addEventListener("input", () => {
      formIsDirty = true;
      saveDraftStorage();
    });
  });
}

/**
 * Dynamically Renders Upload Slots Based on Service.requiredDocuments
 */
function renderDocumentUploadSection(service) {
  const titleEl = document.getElementById("upload-section-title");
  const descEl = document.getElementById("upload-section-desc");
  const container = document.getElementById("dynamic-upload-slots");

  if (!container) return;
  container.innerHTML = "";

  const docs = getNormalizedDocs(service);
  const requiredDocs = docs.filter(d => d.required !== false);

  if (requiredDocs.length === 0) {
    if (titleEl) titleEl.textContent = "2. Supporting Document Upload (Optional)";
    if (descEl) {
      descEl.textContent = "No physical documents are required for this service. Instant online verification. You may optionally attach photos or evidence (e.g. photo of broken streetlight).";
    }

    // Render single optional upload card
    renderUploadCard(container, {
      key: "optional_attachment",
      label: "Attach Optional Photo or Supporting File",
      required: false,
      hint: "Optional evidence (e.g., photo of broken streetlight). Permitted: PDF, JPG, PNG (Max 5 MB)."
    });

  } else {
    if (titleEl) titleEl.textContent = "2. Supporting Documents Required";
    if (descEl) {
      descEl.textContent = "Please upload clear digital scans for each required document below. Permitted formats: PDF, JPG, PNG (Max 5 MB each).";
    }

    // Render one upload card per required document
    requiredDocs.forEach(doc => {
      renderUploadCard(container, {
        key: doc.key,
        label: doc.label,
        required: true,
        hint: `Official scan of ${doc.label}. Formats: PDF, JPG, PNG (Max 5 MB).`
      });
    });

    // Plus optional additional attachment slot
    renderUploadCard(container, {
      key: "additional_document",
      label: "Additional Supporting Evidence (Optional)",
      required: false,
      hint: "Optional extra documents or photographs. Formats: PDF, JPG, PNG (Max 5 MB)."
    });
  }
}

/**
 * Renders an Individual Document Upload Slot Card
 */
function renderUploadCard(container, doc) {
  const card = document.createElement("div");
  card.className = "upload-slot-card";
  card.id = `slot_card_${doc.key}`;

  const isReqStar = doc.required ? '<span class="text-danger">*</span>' : '<span class="text-muted text-xs font-normal">(Optional)</span>';

  card.innerHTML = `
    <div class="upload-slot-header">
      <div class="upload-slot-title">${escapeHtml(doc.label)} ${isReqStar}</div>
      <div class="upload-slot-meta">Max 5 MB • PDF, JPG, PNG</div>
    </div>
    
    <div class="upload-slot-dropzone" id="dropzone_${doc.key}" tabindex="0" role="button" aria-label="Upload ${escapeHtml(doc.label)}">
      <div class="dropzone-icon" aria-hidden="true">📁</div>
      <div class="font-medium text-sm text-neutral-700">Click or Drag &amp; Drop to upload ${escapeHtml(doc.label)}</div>
      <div class="text-xs text-muted mt-1">${escapeHtml(doc.hint)}</div>
      <input 
        type="file" 
        id="file_input_${doc.key}" 
        name="${escapeHtml(doc.key)}" 
        accept=".pdf, .jpg, .jpeg, .png, application/pdf, image/jpeg, image/png"
        style="display: none;"
      >
    </div>

    <div class="upload-file-preview d-none" id="preview_${doc.key}" style="display: none;">
      <div class="upload-file-info">
        <span class="upload-file-icon" id="preview_icon_${doc.key}">📄</span>
        <img class="upload-file-thumb d-none" id="preview_img_${doc.key}" alt="Preview" style="display: none;">
        <div>
          <div class="upload-file-name" id="preview_name_${doc.key}">file.pdf</div>
          <div class="upload-file-size" id="preview_size_${doc.key}">0 KB</div>
        </div>
      </div>
      <button type="button" class="btn-remove-file" id="btn_remove_${doc.key}" title="Remove file" aria-label="Remove ${escapeHtml(doc.label)}">✕</button>
    </div>

    <div class="field-error-text text-danger text-xs mt-1 d-none" id="error_doc_${doc.key}"></div>
  `;

  container.appendChild(card);

  const dropzone = card.querySelector(`#dropzone_${doc.key}`);
  const input = card.querySelector(`#file_input_${doc.key}`);
  const previewBox = card.querySelector(`#preview_${doc.key}`);
  const nameEl = card.querySelector(`#preview_name_${doc.key}`);
  const sizeEl = card.querySelector(`#preview_size_${doc.key}`);
  const iconEl = card.querySelector(`#preview_icon_${doc.key}`);
  const imgEl = card.querySelector(`#preview_img_${doc.key}`);
  const removeBtn = card.querySelector(`#btn_remove_${doc.key}`);
  const errorEl = card.querySelector(`#error_doc_${doc.key}`);

  // Trigger file selection on dropzone click or Enter key
  dropzone.addEventListener("click", () => input.click());
  dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      input.click();
    }
  });

  // Drag and drop handlers
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
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleFileSelection(doc.key, e.dataTransfer.files[0]);
    }
  });

  // File input change
  input.addEventListener("change", async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      await handleFileSelection(doc.key, e.target.files[0]);
    }
  });

  // Remove button
  removeBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    delete selectedDocsState[doc.key];
    input.value = "";
    previewBox.style.display = "none";
    previewBox.classList.add("d-none");
    dropzone.style.display = "";
    dropzone.classList.remove("d-none");
    card.classList.remove("has-file");
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.classList.add("d-none");
    }
  });

  async function handleFileSelection(key, file) {
    if (errorEl) {
      errorEl.textContent = "";
      errorEl.classList.add("d-none");
    }
    card.classList.remove("has-error");

    if (!file) return;

    // 1. File size check (5 MB)
    if (file.size > MAX_FILE_SIZE_BYTES) {
      showSlotError(doc.key, `File '${file.name}' exceeds the maximum allowed 5 MB limit (${(file.size / (1024 * 1024)).toFixed(1)} MB).`);
      input.value = "";
      return;
    }

    // 2. Case-insensitive extension check
    const ext = file.name.split(".").pop().toLowerCase();
    if (!["pdf", "jpg", "jpeg", "png"].includes(ext)) {
      showSlotError(doc.key, `File '${file.name}' has an unsupported extension (.${ext}). Permitted formats: PDF, JPG, PNG.`);
      input.value = "";
      return;
    }

    // 3. Binary Magic Bytes Verification
    const validBytes = await verifyClientMagicBytes(file);
    if (!validBytes) {
      showSlotError(doc.key, `Security verification failed: File content of '${file.name}' does not match its declared .${ext.toUpperCase()} extension.`);
      input.value = "";
      return;
    }

    // Valid file -> Store in state
    selectedDocsState[key] = file;
    formIsDirty = true;

    // Update UI Preview
    nameEl.textContent = file.name;
    sizeEl.textContent = `${(file.size / 1024).toFixed(1)} KB`;

    if (["jpg", "jpeg", "png"].includes(ext)) {
      iconEl.style.display = "none";
      imgEl.src = URL.createObjectURL(file);
      imgEl.style.display = "block";
      imgEl.classList.remove("d-none");
    } else {
      imgEl.style.display = "none";
      iconEl.textContent = "📄";
      iconEl.style.display = "block";
    }

    dropzone.style.display = "none";
    dropzone.classList.add("d-none");
    previewBox.style.display = "flex";
    previewBox.classList.remove("d-none");
    card.classList.add("has-file");
  }

  function showSlotError(key, msg) {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.classList.remove("d-none");
    }
    card.classList.add("has-error");
  }
}

/**
 * Handles Form Submission with Multipart FormData
 */
function setupFormSubmission() {
  const form = document.getElementById("application-form");
  const submitBtn = document.getElementById("btn-submit-application");
  const spinner = document.getElementById("submit-spinner");
  const btnText = submitBtn?.querySelector(".btn-text");

  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearFormAlerts();

    if (isSubmitting) return; // Prevent double submit

    // 1. Citizen Declaration Validation
    const declaration = document.getElementById("declaration-check");
    if (declaration && !declaration.checked) {
      showFormAlert("You must accept the legal declaration before submitting your application.", "danger");
      declaration.focus();
      return;
    }

    // 2. Validate Dynamic Text Fields
    const formDataObj = {};
    let firstInvalidField = null;
    const schema = currentService?.form_schema || [];

    for (const field of schema) {
      const inputEl = document.getElementById(`field_${field.name}`);
      const errorEl = document.getElementById(`error_field_${field.name}`);
      const val = inputEl ? inputEl.value.trim() : "";

      if (field.required && !val) {
        if (errorEl) {
          errorEl.textContent = `${field.label || field.name} is required.`;
          errorEl.classList.remove("d-none");
        }
        inputEl?.classList.add("input-error");
        if (!firstInvalidField) firstInvalidField = inputEl;
      } else {
        if (errorEl) {
          errorEl.textContent = "";
          errorEl.classList.add("d-none");
        }
        inputEl?.classList.remove("input-error");
        formDataObj[field.name] = val;
      }
    }

    // 3. Validate Required Documents
    const reqDocs = getNormalizedDocs(currentService).filter(d => d.required !== false);
    let firstMissingDoc = null;

    for (const doc of reqDocs) {
      const errorEl = document.getElementById(`error_doc_${doc.key}`);
      const cardEl = document.getElementById(`slot_card_${doc.key}`);
      if (!selectedDocsState[doc.key]) {
        if (errorEl) {
          errorEl.textContent = `Please attach ${doc.label}. This document is required.`;
          errorEl.classList.remove("d-none");
        }
        cardEl?.classList.add("has-error");
        if (!firstMissingDoc) firstMissingDoc = cardEl;
      } else {
        if (errorEl) {
          errorEl.textContent = "";
          errorEl.classList.add("d-none");
        }
        cardEl?.classList.remove("has-error");
      }
    }

    // Scroll to first invalid field or missing document
    if (firstInvalidField) {
      firstInvalidField.focus();
      firstInvalidField.scrollIntoView({ behavior: "smooth", block: "center" });
      showFormAlert("Please complete all required fields highlighted in red.", "danger");
      return;
    }

    if (firstMissingDoc) {
      firstMissingDoc.scrollIntoView({ behavior: "smooth", block: "center" });
      showFormAlert("Please attach all required supporting documents.", "danger");
      return;
    }

    // 4. Construct Multipart FormData
    const formData = new FormData();
    formData.append("service_slug", currentService.slug);
    formData.append("form_data", JSON.stringify(formDataObj));
    formData.append("applicant_name", (activeCitizen?.full_name || "Citizen").trim());
    formData.append("applicant_email", activeCitizen?.email || "");
    formData.append("applicant_mobile", activeCitizen?.mobile || "");

    // Append all selected files using their document keys
    Object.entries(selectedDocsState).forEach(([key, file]) => {
      if (file instanceof File) {
        formData.append(key, file, file.name);
      }
    });

    // 5. Submit with Dual-Layer Auth & Token Header
    setSubmittingState(true);

    try {
      const token = getStoredToken();
      const csrf = await getCsrfToken();
      const headers = {};

      if (token) {
        headers["Authorization"] = `Bearer ${token}`;
      }
      if (csrf) {
        headers["X-CSRF-Token"] = csrf;
      }
      // Note: We deliberately DO NOT set Content-Type header so the browser computes boundary

      const response = await fetch("/api/applications", {
        method: "POST",
        credentials: "include",
        headers: headers,
        body: formData
      });

      const res = await response.json().catch(() => null);

      if (!response.ok || !res || !res.success) {
        // Check for session expiration
        if (response.status === 401) {
          saveDraftStorage();
          showFormAlert("Your session has expired. Redirecting to sign in...", "warning");
          setTimeout(() => {
            window.location.href = `login.html?returnUrl=${encodeURIComponent(window.location.pathname + window.location.search)}`;
          }, 1500);
          return;
        }

        let msg = res?.error?.message || "Application submission failed.";
        if (res?.error?.fields) {
          // Highlight specific fields
          Object.entries(res.error.fields).forEach(([fKey, fMsg]) => {
            const fieldErr = document.getElementById(`error_field_${fKey}`) || document.getElementById(`error_doc_${fKey}`);
            if (fieldErr) {
              fieldErr.textContent = fMsg;
              fieldErr.classList.remove("d-none");
            }
          });
          const detailMsgs = Object.values(res.error.fields).join(" ");
          msg += ` Details: ${detailMsgs}`;
        }

        showFormAlert(msg, "danger");
        setSubmittingState(false);
        return;
      }

      // 6. Success: Transition to Success Confirmation View
      setPageState("success", res.data);

    } catch (err) {
      console.error("Submission error:", err);
      showFormAlert("Network error while submitting application to the database. Please check your connection and retry.", "danger");
      setSubmittingState(false);
    }
  });

  function setSubmittingState(submitting) {
    isSubmitting = submitting;
    if (submitBtn) submitBtn.disabled = submitting;
    if (spinner) {
      spinner.classList.toggle("d-none", !submitting);
      spinner.style.display = submitting ? "inline-block" : "none";
    }
    if (btnText) {
      btnText.textContent = submitting ? "Submitting Application..." : "Submit Application";
    }
  }
}

/**
 * Draft Persistence across Auth Redirects
 */
function saveDraftStorage() {
  if (!currentService) return;
  try {
    const draft = {};
    const schema = currentService.form_schema || [];
    schema.forEach(field => {
      const el = document.getElementById(`field_${field.name}`);
      if (el) draft[field.name] = el.value;
    });
    sessionStorage.setItem(`msp_draft_${currentService.slug}`, JSON.stringify(draft));
  } catch (_) {}
}

function restoreDraftStorage() {
  if (!currentService) return;
  try {
    const raw = sessionStorage.getItem(`msp_draft_${currentService.slug}`);
    if (!raw) return;
    const draft = JSON.parse(raw);
    Object.entries(draft).forEach(([k, v]) => {
      const el = document.getElementById(`field_${k}`);
      if (el && v) el.value = v;
    });
  } catch (_) {}
}

function clearDraftStorage() {
  if (!currentService) return;
  try {
    sessionStorage.removeItem(`msp_draft_${currentService.slug}`);
  } catch (_) {}
}

/**
 * Warns citizen before navigating away with unsaved entries
 */
function setupUnloadWarning() {
  window.addEventListener("beforeunload", (e) => {
    if (formIsDirty && !isSubmitting) {
      e.preventDefault();
      e.returnValue = "You have unsaved application data. Are you sure you want to leave?";
    }
  });
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
  if (alertBox) {
    alertBox.textContent = "";
    alertBox.classList.add("d-none");
  }
}

function updateNavCitizen(user) {
  const authContainer = document.getElementById("nav-auth-actions");
  if (!authContainer) return;

  const firstName = (user.full_name || "Citizen").split(" ")[0];

  authContainer.innerHTML = `
    <a href="user-dashboard.html" class="btn btn-sm btn-primary" id="nav-dashboard-btn">Dashboard (${escapeHtml(firstName)})</a>
    <button class="btn btn-sm btn-outline btn-signout" id="nav-logout-btn" title="Sign out of your session">Sign Out</button>
  `;
  const logoutBtn = document.getElementById("nav-logout-btn");
  logoutBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    await logoutUser({
      buttonEl: logoutBtn,
      redirect: "login.html"
    });
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  const yearEl = document.getElementById("footer-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  startDbHealthPolling(30000);

  // Prevent back-button bfcache from displaying application after logout
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !localStorage.getItem("msp_token")) {
      window.location.replace("login.html");
    }
  });

  await initApplicationPage();
});
