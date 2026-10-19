/**
 * Administrative Grievances Review Controller (ESM)
 * Lists, filters, inspects, and resolves citizen municipal complaints.
 */

import { apiFetch, checkDbHealth, updateDbStatusPill } from "./api.js";

let activeReviewCmpId = null;

async function initAdminComplaints() {
  // 1. Verify Admin Session
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

  // 3. Load Departments Dropdown
  await loadDepartments();

  // 4. Setup Filters & Search
  setupFilters();

  // 5. Setup Modal Handlers
  setupModalHandlers();

  // 6. Initial Data Load
  await loadComplaints();
}

async function loadDepartments() {
  const deptSelect = document.getElementById("cmp-dept-filter");
  if (!deptSelect) return;

  try {
    const res = await apiFetch("/complaints/departments", { method: "GET" });
    if (res.success && Array.isArray(res.data)) {
      deptSelect.innerHTML = `<option value="ALL">All Departments</option>` +
        res.data.map(d => `<option value="${escapeHtml(d)}">${escapeHtml(d)}</option>`).join("");
    }
  } catch (err) {
    console.error("Failed to load departments:", err);
  }
}

function setupFilters() {
  const searchInput = document.getElementById("cmp-search-input");
  const deptFilter = document.getElementById("cmp-dept-filter");
  const statusFilter = document.getElementById("cmp-status-filter");

  let debounceTimer = null;
  searchInput?.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      loadComplaints();
    }, 300);
  });

  deptFilter?.addEventListener("change", () => loadComplaints());
  statusFilter?.addEventListener("change", () => loadComplaints());
}

async function loadComplaints() {
  const tbody = document.getElementById("admin-cmps-tbody");
  const searchVal = document.getElementById("cmp-search-input")?.value.trim() || "";
  const deptVal = document.getElementById("cmp-dept-filter")?.value || "ALL";
  const statusVal = document.getElementById("cmp-status-filter")?.value || "ALL";

  if (!tbody) return;

  try {
    const params = new URLSearchParams();
    if (deptVal !== "ALL") params.append("department", deptVal);
    if (statusVal !== "ALL") params.append("status", statusVal);
    if (searchVal) params.append("q", searchVal);

    const queryStr = params.toString() ? `?${params.toString()}` : "";
    const res = await apiFetch(`/admin/complaints${queryStr}`, { method: "GET" });

    if (!res.success) {
      tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">Failed to load grievances.</td></tr>`;
      return;
    }

    const complaints = res.data || [];
    if (complaints.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="text-center py-6 text-muted">
            No citizen grievances match your search criteria (0 records).
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = complaints.map(cmp => {
      const dateFormatted = cmp.created_at ? new Date(cmp.created_at).toLocaleDateString() : "N/A";
      const badgeClass = getStatusBadgeClass(cmp.status);

      return `
        <tr id="cmp-row-${escapeHtml(cmp.complaint_id)}">
          <td><strong class="font-mono">${escapeHtml(cmp.complaint_id)}</strong></td>
          <td><span class="badge badge-info">${escapeHtml(cmp.department)}</span></td>
          <td><strong>${escapeHtml(cmp.title)}</strong></td>
          <td>${escapeHtml(cmp.citizen_name || "Citizen")}</td>
          <td class="text-xs text-muted">${escapeHtml(cmp.location || "")}</td>
          <td><span class="status-badge ${badgeClass}">${escapeHtml(cmp.status)}</span></td>
          <td>${dateFormatted}</td>
          <td>
            <button class="btn btn-sm btn-primary btn-review-cmp" data-id="${escapeHtml(cmp.complaint_id)}">
              Review
            </button>
          </td>
        </tr>
      `;
    }).join("");

    // Attach Review Click Handlers
    tbody.querySelectorAll(".btn-review-cmp").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const cmpId = e.currentTarget.getAttribute("data-id");
        await openComplaintModal(cmpId);
      });
    });

  } catch (err) {
    console.error("Load complaints error:", err);
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">Database query error.</td></tr>`;
  }
}

async function openComplaintModal(cmpId) {
  activeReviewCmpId = cmpId;
  const modal = document.getElementById("cmp-review-modal");
  const modalTitle = document.getElementById("modal-cmp-title");
  const modalId = document.getElementById("modal-cmp-id");
  const modalDept = document.getElementById("modal-cmp-dept");
  const citizenName = document.getElementById("modal-cmp-citizen");
  const cmpLoc = document.getElementById("modal-cmp-loc");
  const cmpDate = document.getElementById("modal-cmp-date");
  const geoBox = document.getElementById("modal-geo-box");
  const geoCoords = document.getElementById("modal-geo-coords");
  const cmpDesc = document.getElementById("modal-cmp-desc");
  const photosList = document.getElementById("modal-cmp-photos");
  const statusSelect = document.getElementById("officer-cmp-status");
  const remarksInput = document.getElementById("officer-cmp-remarks");
  const alertBox = document.getElementById("modal-cmp-action-alert");

  if (alertBox) alertBox.classList.add("d-none");
  if (remarksInput) remarksInput.value = "";

  try {
    const res = await apiFetch(`/admin/complaints/${encodeURIComponent(cmpId)}`, { method: "GET" });
    if (!res.success || !res.data) {
      alert("Failed to retrieve grievance details.");
      return;
    }

    const cmp = res.data;
    if (modalTitle) modalTitle.textContent = cmp.title;
    if (modalId) modalId.textContent = cmp.complaint_id;
    if (modalDept) modalDept.textContent = cmp.department || "General";
    if (citizenName) citizenName.textContent = cmp.citizen_name || "-";
    if (cmpLoc) cmpLoc.textContent = cmp.location || "-";
    if (cmpDate) cmpDate.textContent = cmp.created_at ? new Date(cmp.created_at).toLocaleString() : "-";
    if (cmpDesc) cmpDesc.textContent = cmp.description || "-";

    // Set current status in dropdown
    if (statusSelect) statusSelect.value = cmp.status;

    // GPS Coordinates
    if (cmp.coordinates && geoBox && geoCoords) {
      geoCoords.textContent = `Lat: ${cmp.coordinates.latitude}, Lng: ${cmp.coordinates.longitude}`;
      geoBox.classList.remove("d-none");
    } else if (geoBox) {
      geoBox.classList.add("d-none");
    }

    // Photographic Evidence
    if (photosList) {
      const images = cmp.images || [];
      if (images.length === 0) {
        photosList.innerHTML = `<p class="text-xs text-muted">No photo evidence attached by citizen.</p>`;
      } else {
        photosList.innerHTML = images.map((img, idx) => {
          const sizeKb = (img.file_size / 1024).toFixed(0);
          return `
            <div class="document-review-chip" id="photo-chip-${idx}">
              <span class="doc-icon">📷</span>
              <span class="doc-name" title="${escapeHtml(img.original_filename)}">${escapeHtml(img.original_filename)}</span>
              <span class="doc-size">(${sizeKb} KB)</span>
              <a href="${escapeHtml(img.download_url)}" class="btn btn-xs btn-outline ml-auto" target="_blank" download>
                View Photo
              </a>
            </div>
          `;
        }).join("");
      }
    }

    if (modal) modal.classList.remove("d-none");

  } catch (err) {
    console.error("Open grievance modal error:", err);
    alert("Connection error loading complaint detail.");
  }
}

function setupModalHandlers() {
  const modal = document.getElementById("cmp-review-modal");
  const closeBtn = document.getElementById("btn-close-cmp-modal");
  const cancelBtn = document.getElementById("btn-cancel-cmp-modal");
  const form = document.getElementById("officer-cmp-decision-form");
  const submitBtn = document.getElementById("btn-save-cmp-decision");
  const spinner = document.getElementById("cmp-decision-spinner");
  const btnText = submitBtn?.querySelector(".btn-text");

  function closeModal() {
    if (modal) modal.classList.add("d-none");
    activeReviewCmpId = null;
  }

  closeBtn?.addEventListener("click", closeModal);
  cancelBtn?.addEventListener("click", closeModal);

  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!activeReviewCmpId) return;

    const newStatus = document.getElementById("officer-cmp-status")?.value;
    const remarks = document.getElementById("officer-cmp-remarks")?.value.trim();
    const alertBox = document.getElementById("modal-cmp-action-alert");

    if (!remarks || remarks.length < 5) {
      if (alertBox) {
        alertBox.className = "alert alert-danger mb-3";
        alertBox.textContent = "Please provide substantive resolution remarks (minimum 5 characters).";
        alertBox.classList.remove("d-none");
      }
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    if (spinner) spinner.classList.remove("d-none");
    if (btnText) btnText.textContent = "Recording...";

    try {
      const res = await apiFetch(`/admin/complaints/${encodeURIComponent(activeReviewCmpId)}/status`, {
        method: "PATCH",
        body: { status: newStatus, remarks }
      });

      if (!res.success) {
        if (alertBox) {
          alertBox.className = "alert alert-danger mb-3";
          alertBox.textContent = res.error?.message || "Failed to update complaint status.";
          alertBox.classList.remove("d-none");
        }
        return;
      }

      closeModal();
      showAdminCmpAlert(`Grievance ${activeReviewCmpId} status updated to '${newStatus}'.`, "success");
      await loadComplaints();

    } catch (err) {
      console.error("Status update error:", err);
      if (alertBox) {
        alertBox.className = "alert alert-danger mb-3";
        alertBox.textContent = "Network error while saving grievance decision.";
        alertBox.classList.remove("d-none");
      }
    } finally {
      if (submitBtn) submitBtn.disabled = false;
      if (spinner) spinner.classList.add("d-none");
      if (btnText) btnText.textContent = "Record Resolution";
    }
  });
}

function showAdminCmpAlert(msg, type = "success") {
  const alertBox = document.getElementById("admin-cmp-alert");
  if (!alertBox) return;

  alertBox.className = `alert alert-${type} mb-4`;
  alertBox.textContent = msg;
  alertBox.classList.remove("d-none");
  alertBox.scrollIntoView({ behavior: "smooth", block: "center" });
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
  const yearEl = document.getElementById("footer-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  const isHealthy = await checkDbHealth();
  updateDbStatusPill(isHealthy);

  await initAdminComplaints();
});
