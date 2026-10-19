/**
 * Administrative Applications Review Controller (ESM)
 * Lists, filters, inspects, and processes citizen municipal service applications.
 */

import { apiFetch, checkDbHealth, updateDbStatusPill } from "./api.js";

let activeReviewAppId = null;

async function initAdminApplications() {
  // 1. Verify Administrative Session
  try {
    const authRes = await apiFetch("/admin/auth/me", { method: "GET" });
    if (!authRes.success || !authRes.data || authRes.data.role !== "admin") {
      window.location.href = "admin-login.html";
      return;
    }
    const userDisplay = document.getElementById("admin-user-display");
    if (userDisplay) userDisplay.textContent = authRes.data.email || "Administrator";
  } catch (err) {
    console.error("Admin verification error:", err);
    window.location.href = "admin-login.html";
    return;
  }

  // 2. Sign Out
  document.getElementById("btn-admin-logout")?.addEventListener("click", async () => {
    await apiFetch("/admin/auth/logout", { method: "POST" });
    window.location.href = "admin-login.html";
  });

  // 3. Setup Filter & Search Listeners
  setupFilters();

  // 4. Modal Event Listeners
  setupModalHandlers();

  // 5. Initial Data Load
  await loadApplications();
}

function setupFilters() {
  const searchInput = document.getElementById("app-search-input");
  const statusFilter = document.getElementById("app-status-filter");

  let debounceTimer = null;
  searchInput?.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      loadApplications();
    }, 300);
  });

  statusFilter?.addEventListener("change", () => {
    loadApplications();
  });
}

async function loadApplications() {
  const tbody = document.getElementById("admin-apps-tbody");
  const searchVal = document.getElementById("app-search-input")?.value.trim() || "";
  const statusVal = document.getElementById("app-status-filter")?.value || "ALL";

  if (!tbody) return;

  try {
    const params = new URLSearchParams();
    if (statusVal !== "ALL") params.append("status", statusVal);
    if (searchVal) params.append("q", searchVal);

    const queryStr = params.toString() ? `?${params.toString()}` : "";
    const res = await apiFetch(`/admin/applications${queryStr}`, { method: "GET" });

    if (!res.success) {
      tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-4">Failed to load applications.</td></tr>`;
      return;
    }

    const applications = res.data || [];
    if (applications.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="7" class="text-center py-6 text-muted">
            No citizen applications match your search criteria (0 records).
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = applications.map(app => {
      const dateFormatted = app.created_at ? new Date(app.created_at).toLocaleDateString() : "N/A";
      const badgeClass = getStatusBadgeClass(app.status);

      return `
        <tr id="app-row-${escapeHtml(app.application_id)}">
          <td><strong class="font-mono">${escapeHtml(app.application_id)}</strong></td>
          <td>
            <strong>${escapeHtml(app.service_name)}</strong>
            <span class="badge badge-category ml-2">${escapeHtml(app.category || "General")}</span>
          </td>
          <td>
            <div>${escapeHtml(app.citizen_name || "Citizen")}</div>
            <div class="text-xs text-muted">${escapeHtml(app.citizen_email || "")}</div>
          </td>
          <td><span class="status-badge ${badgeClass}">${escapeHtml(app.status)}</span></td>
          <td class="text-center">${app.documents_count} file(s)</td>
          <td>${dateFormatted}</td>
          <td>
            <button class="btn btn-sm btn-primary btn-review-app" data-id="${escapeHtml(app.application_id)}">
              Review
            </button>
          </td>
        </tr>
      `;
    }).join("");

    // Attach click handlers to Review buttons
    tbody.querySelectorAll(".btn-review-app").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const appId = e.currentTarget.getAttribute("data-id");
        await openReviewModal(appId);
      });
    });

  } catch (err) {
    console.error("Load applications error:", err);
    tbody.innerHTML = `<tr><td colspan="7" class="text-center text-danger py-4">Database query error.</td></tr>`;
  }
}

async function openReviewModal(appId) {
  activeReviewAppId = appId;
  const modal = document.getElementById("app-review-modal");
  const modalTitle = document.getElementById("modal-app-title");
  const modalId = document.getElementById("modal-app-id");
  const modalCategory = document.getElementById("modal-app-category");
  const citizenName = document.getElementById("modal-citizen-name");
  const citizenEmail = document.getElementById("modal-citizen-email");
  const appDate = document.getElementById("modal-app-date");
  const formGrid = document.getElementById("modal-form-data-grid");
  const docsList = document.getElementById("modal-documents-list");
  const statusSelect = document.getElementById("officer-new-status");
  const remarksInput = document.getElementById("officer-remarks");
  const alertBox = document.getElementById("modal-action-alert");

  if (alertBox) alertBox.classList.add("d-none");
  if (remarksInput) remarksInput.value = "";

  try {
    const res = await apiFetch(`/admin/applications/${encodeURIComponent(appId)}`, { method: "GET" });
    if (!res.success || !res.data) {
      alert("Failed to retrieve application details.");
      return;
    }

    const app = res.data;
    if (modalTitle) modalTitle.textContent = app.service_name;
    if (modalId) modalId.textContent = app.application_id;
    if (modalCategory) modalCategory.textContent = app.category || "General";
    if (citizenName) citizenName.textContent = app.citizen_name || "-";
    if (citizenEmail) citizenEmail.textContent = app.citizen_email || "-";
    if (appDate) appDate.textContent = app.created_at ? new Date(app.created_at).toLocaleString() : "-";

    // Set current status in dropdown
    if (statusSelect) statusSelect.value = app.status;

    // Render Submitted Form Fields
    if (formGrid) {
      const fields = Object.entries(app.form_data || {});
      if (fields.length === 0) {
        formGrid.innerHTML = `<p class="text-xs text-muted">No custom form fields submitted.</p>`;
      } else {
        formGrid.innerHTML = fields.map(([key, val]) => `
          <div class="form-data-item">
            <span class="form-data-key">${escapeHtml(formatFieldLabel(key))}</span>
            <span class="form-data-val">${escapeHtml(val)}</span>
          </div>
        `).join("");
      }
    }

    // Render Attached Documents with download links
    if (docsList) {
      const docs = app.documents || [];
      if (docs.length === 0) {
        docsList.innerHTML = `<p class="text-xs text-muted">No supporting documents attached.</p>`;
      } else {
        docsList.innerHTML = docs.map((doc, idx) => {
          const sizeKb = (doc.file_size / 1024).toFixed(0);
          return `
            <div class="document-review-chip" id="doc-chip-${idx}">
              <span class="doc-icon">📄</span>
              <span class="doc-name" title="${escapeHtml(doc.original_filename)}">${escapeHtml(doc.original_filename)}</span>
              <span class="doc-size">(${sizeKb} KB)</span>
              <a href="${escapeHtml(doc.download_url)}" class="btn btn-xs btn-outline ml-auto" target="_blank" download>
                Download / Inspect
              </a>
            </div>
          `;
        }).join("");
      }
    }

    if (modal) modal.classList.remove("d-none");

  } catch (err) {
    console.error("Open modal error:", err);
    alert("Connection error loading application detail.");
  }
}

function setupModalHandlers() {
  const modal = document.getElementById("app-review-modal");
  const closeBtn = document.getElementById("btn-close-modal");
  const cancelBtn = document.getElementById("btn-cancel-modal");
  const form = document.getElementById("officer-decision-form");
  const submitBtn = document.getElementById("btn-save-decision");
  const spinner = document.getElementById("decision-spinner");
  const btnText = submitBtn?.querySelector(".btn-text");

  function closeModal() {
    if (modal) modal.classList.add("d-none");
    activeReviewAppId = null;
  }

  closeBtn?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", closeModal);

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeReviewAppId) return;

    const newStatus = document.getElementById("officer-new-status")?.value;
    const remarks = document.getElementById("officer-remarks")?.value.trim();
    const alertBox = document.getElementById("modal-action-alert");

    if (!remarks || remarks.length < 5) {
      if (alertBox) {
        alertBox.className = "alert alert-danger mb-3";
        alertBox.textContent = "Please provide substantive decision remarks (minimum 5 characters).";
        alertBox.classList.remove("d-none");
      }
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    if (spinner) spinner.classList.remove("d-none");
    if (btnText) btnText.textContent = "Updating Status...";

    try {
      const res = await apiFetch(`/admin/applications/${encodeURIComponent(activeReviewAppId)}/status`, {
        method: "PATCH",
        body: { status: newStatus, remarks }
      });

      if (!res.success) {
        if (alertBox) {
          alertBox.className = "alert alert-danger mb-3";
          alertBox.textContent = res.error?.message || "Failed to update application status.";
          alertBox.classList.remove("d-none");
        }
        return;
      }

      closeModal();
      showAdminAppAlert(`Application ${activeReviewAppId} status updated to '${newStatus}'.`, "success");
      await loadApplications();

    } catch (err) {
      console.error("Status update error:", err);
      if (alertBox) {
        alertBox.className = "alert alert-danger mb-3";
        alertBox.textContent = "Network error while saving administrative decision.";
        alertBox.classList.remove("d-none");
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (spinner) spinner.classList.add("d-none");
      if (btnText) btnText.textContent = "Persist Status Decision";
    }
  });
}

function showAdminAppAlert(msg, type = "success") {
  const alertBox = document.getElementById("admin-app-alert");
  if (!alertBox) return;

  alertBox.className = `alert alert-${type} mb-4`;
  alertBox.textContent = msg;
  alertBox.classList.remove("d-none");
  alertBox.scrollIntoView({ behavior: "smooth", block: "center" });
}

function formatFieldLabel(key) {
  return key.replace(/_/g, " ").replace(/\b\w/g, l => l.toUpperCase());
}

function getStatusBadgeClass(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("approved") || s.includes("completed") || s.includes("resolved")) return "badge-success";
  if (s.includes("reject")) return "badge-danger";
  if (s.includes("review") || s.includes("action") || s.includes("progress")) return "badge-warning";
  return "badge-info";
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
  const isHealthy = await checkDbHealth();
  updateDbStatusPill(isHealthy);

  await initAdminApplications();
});
