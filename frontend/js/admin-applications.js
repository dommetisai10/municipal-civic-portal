/**
 * Administrative Applications Review Controller (ESM)
 * Lists, filters, inspects, and processes citizen municipal service applications.
 */

import { apiFetch, checkDbHealth, logoutUser } from "./api.js";

let adminProfile = null;
let activeReviewAppId = null;
let selectedAppIds = new Set();

document.addEventListener("DOMContentLoaded", initAdminApplications);

async function initAdminApplications() {
  // 1. Verify Administrative Session
  try {
    const authRes = await apiFetch("/admin/auth/me", { method: "GET" });
    if (!authRes.success || !authRes.data) {
      window.location.href = "admin-login.html";
      return;
    }
    adminProfile = authRes.data;
    const userDisplay = document.getElementById("admin-user-display");
    const roleDisplay = document.getElementById("admin-role-display");
    const initialsDisplay = document.getElementById("admin-avatar-initials");

    if (userDisplay) userDisplay.textContent = adminProfile.full_name || adminProfile.email || "Administrator";
    if (roleDisplay) roleDisplay.textContent = adminProfile.admin_role || adminProfile.role || "Admin";
    if (initialsDisplay) {
      const name = adminProfile.full_name || adminProfile.email || "AD";
      initialsDisplay.textContent = name.substring(0, 2).toUpperCase();
    }
  } catch (err) {
    console.error("Admin verification error:", err);
    window.location.href = "admin-login.html";
    return;
  }

  // 2. Setup Controls
  setupSidebarControls();
  setupSignOut();
  setupFilters();
  setupModalHandlers();
  setupBulkActions();

  // 3. Load Dynamic Services Options & Applications List
  await loadServiceFilterOptions();
  await loadApplications();
}

function setupSidebarControls() {
  const toggleBtn = document.getElementById("sidebar-toggle-btn");
  const sidebar = document.getElementById("admin-sidebar");
  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener("click", () => sidebar.classList.toggle("open"));
  }
}

function setupSignOut() {
  const logoutBtn = document.getElementById("btn-admin-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async (e) => {
      e.preventDefault();
      await logoutUser({
        buttonEl: logoutBtn,
        redirect: "admin-login.html"
      });
    });
  }

  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !localStorage.getItem("msp_token") && !localStorage.getItem("msp_admin_token")) {
      window.location.replace("admin-login.html");
    }
  });
}

let currentOverdue = false;

function setupFilters() {
  const searchInput = document.getElementById("app-search-input");
  const rangeFilter = document.getElementById("app-range-filter");
  const statusFilter = document.getElementById("app-status-filter");
  const serviceFilter = document.getElementById("app-service-filter");
  const chkDeleted = document.getElementById("chk-include-deleted");
  const clearBtn = document.getElementById("btn-clear-filters");

  // Read URL query params (?range=...&status=...&service=...&overdue=...&q=...)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("range") && rangeFilter) {
    rangeFilter.value = urlParams.get("range");
  }
  const rawStatus = urlParams.get("status");
  if (rawStatus && statusFilter) {
    let matched = false;
    for (const opt of statusFilter.options) {
      const optVal = opt.value.toLowerCase();
      const paramVal = rawStatus.toLowerCase();
      if (optVal === paramVal ||
          (paramVal === "submitted" && optVal === "pending") ||
          (paramVal === "pending" && optVal === "pending") ||
          (paramVal === "pending review" && optVal === "pending")) {
        statusFilter.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) statusFilter.value = rawStatus;
  }
  if (urlParams.get("service") && serviceFilter) {
    serviceFilter.value = urlParams.get("service");
  }
  if (urlParams.get("overdue") === "true") {
    currentOverdue = true;
  }
  if (urlParams.get("q") && searchInput) {
    searchInput.value = urlParams.get("q");
  }

  let debounceTimer = null;
  searchInput?.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadApplications, 300);
  });

  rangeFilter?.addEventListener("change", loadApplications);
  statusFilter?.addEventListener("change", loadApplications);
  serviceFilter?.addEventListener("change", loadApplications);
  chkDeleted?.addEventListener("change", loadApplications);
  clearBtn?.addEventListener("click", resetAllFilters);

  // Support browser Back/Forward navigation
  window.addEventListener("popstate", () => {
    const currentParams = new URLSearchParams(window.location.search);
    if (rangeFilter) rangeFilter.value = currentParams.get("range") || "all";
    if (statusFilter) {
      const s = currentParams.get("status");
      statusFilter.value = s || "ALL";
    }
    const srvParam = currentParams.get("service");
    if (serviceFilter) {
      if (!srvParam || srvParam.toUpperCase() === "ALL") {
        serviceFilter.value = "ALL";
      } else {
        const sLower = srvParam.toLowerCase();
        let matched = false;
        for (const opt of serviceFilter.options) {
          if (opt.value.toLowerCase() === sLower || opt.textContent.toLowerCase() === sLower || opt.textContent.toLowerCase().includes(sLower)) {
            serviceFilter.value = opt.value;
            matched = true;
            break;
          }
        }
        if (!matched) serviceFilter.value = srvParam;
      }
    }
    if (searchInput) searchInput.value = currentParams.get("q") || "";
    currentOverdue = currentParams.get("overdue") === "true";
    loadApplications();
  });
}

function resetAllFilters() {
  const sInput = document.getElementById("app-search-input");
  if (sInput) sInput.value = "";
  const rFilter = document.getElementById("app-range-filter");
  if (rFilter) rFilter.value = "all";
  const stFilter = document.getElementById("app-status-filter");
  if (stFilter) stFilter.value = "ALL";
  const srvFilter = document.getElementById("app-service-filter");
  if (srvFilter) srvFilter.value = "ALL";
  const chkDel = document.getElementById("chk-include-deleted");
  if (chkDel) chkDel.checked = false;
  currentOverdue = false;

  window.history.replaceState({}, "", window.location.pathname);
  loadApplications();
}

function updateFilterChips(searchVal, rangeVal, statusVal, serviceVal) {
  const bar = document.getElementById("filter-chips-bar");
  const container = document.getElementById("filter-chips-container");
  if (!bar || !container) return;

  const chips = [];

  if (searchVal) {
    chips.push({
      label: `Search: "${searchVal}"`,
      remove: () => {
        const inp = document.getElementById("app-search-input");
        if (inp) inp.value = "";
        loadApplications();
      }
    });
  }

  if (rangeVal && rangeVal !== "all") {
    chips.push({
      label: `Date: ${rangeVal.toUpperCase()}`,
      remove: () => {
        const sel = document.getElementById("app-range-filter");
        if (sel) sel.value = "all";
        loadApplications();
      }
    });
  }

  if (statusVal && statusVal !== "ALL") {
    chips.push({
      label: `Status: ${statusVal}`,
      remove: () => {
        const sel = document.getElementById("app-status-filter");
        if (sel) sel.value = "ALL";
        loadApplications();
      }
    });
  }

  if (serviceVal && serviceVal !== "ALL") {
    chips.push({
      label: `Service: ${serviceVal}`,
      remove: () => {
        const sel = document.getElementById("app-service-filter");
        if (sel) sel.value = "ALL";
        loadApplications();
      }
    });
  }

  if (currentOverdue) {
    chips.push({
      label: `Overdue (SLA Breaches)`,
      remove: () => {
        currentOverdue = false;
        loadApplications();
      }
    });
  }

  if (chips.length === 0) {
    bar.classList.add("d-none");
    container.innerHTML = "";
  } else {
    container.innerHTML = "";
    chips.forEach((c) => {
      const chipEl = document.createElement("span");
      chipEl.className = "filter-chip";
      chipEl.innerHTML = `${escapeHtml(c.label)} <span class="chip-remove" aria-label="Remove filter">&times;</span>`;
      chipEl.querySelector(".chip-remove").addEventListener("click", c.remove);
      container.appendChild(chipEl);
    });
    bar.classList.remove("d-none");
  }
}

async function loadServiceFilterOptions() {
  const select = document.getElementById("app-service-filter");
  if (!select) return;
  try {
    const res = await apiFetch("/admin/services", { method: "GET" });
    if (res.success && res.data) {
      select.innerHTML = '<option value="ALL">All Services</option>';
      res.data.forEach((srv) => {
        const opt = document.createElement("option");
        opt.value = srv.slug;
        opt.textContent = srv.name;
        select.appendChild(opt);
      });

      // Synchronize from URL query params (supports slug, hyphenated, or display name)
      const urlParams = new URLSearchParams(window.location.search);
      const targetSrv = (urlParams.get("service") || "").trim();
      if (targetSrv && targetSrv.toUpperCase() !== "ALL") {
        const targetLower = targetSrv.toLowerCase();
        let matchedSlug = null;
        for (const srv of res.data) {
          if (
            srv.slug.toLowerCase() === targetLower ||
            srv.name.toLowerCase() === targetLower ||
            srv.name.toLowerCase().includes(targetLower) ||
            targetLower.includes(srv.slug.toLowerCase())
          ) {
            matchedSlug = srv.slug;
            break;
          }
        }
        if (matchedSlug) {
          select.value = matchedSlug;
        } else {
          const customOpt = document.createElement("option");
          customOpt.value = targetSrv;
          customOpt.textContent = targetSrv;
          customOpt.selected = true;
          select.appendChild(customOpt);
        }
      }
    }
  } catch (err) {
    console.error("Failed to load service filter options:", err);
  }
}

async function loadApplications() {
  const tbody = document.getElementById("admin-apps-tbody");
  const searchVal = document.getElementById("app-search-input")?.value.trim() || "";
  const rangeVal = document.getElementById("app-range-filter")?.value || "all";
  const statusVal = document.getElementById("app-status-filter")?.value || "ALL";
  const serviceVal = document.getElementById("app-service-filter")?.value || "ALL";
  const incDeleted = document.getElementById("chk-include-deleted")?.checked;

  if (!tbody) return;

  updateFilterChips(searchVal, rangeVal, statusVal, serviceVal);

  try {
    const params = new URLSearchParams();
    if (rangeVal !== "all") params.append("range", rangeVal);
    if (statusVal !== "ALL") params.append("status", statusVal);
    if (serviceVal !== "ALL") params.append("service", serviceVal);
    if (searchVal) params.append("q", searchVal);
    if (currentOverdue) params.append("overdue", "true");
    if (incDeleted) params.append("include_deleted", "true");

    const queryStr = params.toString() ? `?${params.toString()}` : "";
    // Synchronize browser URL without reloading so refresh retains filters
    window.history.replaceState({}, "", queryStr || window.location.pathname);

    const res = await apiFetch(`/admin/applications${queryStr}`, { method: "GET" });

    if (!res.success) {
      tbody.innerHTML = `<tr><td colspan="9" class="text-center text-danger py-4">Failed to load applications.</td></tr>`;
      return;
    }

    const applications = res.data || [];
    selectedAppIds.clear();
    updateBulkButtons();

    if (applications.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="text-center py-6 text-muted">
            <div class="empty-state-card" style="margin: 0; border: none;">
              <div class="empty-state-icon">📑</div>
              <div class="empty-state-title">No Applications Match Filter</div>
              <div class="empty-state-subtext">No citizen applications match your current search and filter criteria.</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = applications
      .map((app) => {
        const dateFormatted = app.created_at ? new Date(app.created_at).toLocaleDateString() : "—";
        const badge = getStatusBadge(app.status);
        const isDel = app.is_deleted ? `<span class="badge badge-danger ml-1">Trash</span>` : "";
        const applicantName = app.citizen_name || app.applicant_name || "Citizen";
        const applicantEmail = app.citizen_email || app.applicant_email || "";

        return `
        <tr id="app-row-${escapeHtml(app.application_id)}">
          <td>
            <input type="checkbox" class="chk-app-select" data-id="${escapeHtml(app.application_id)}">
          </td>
          <td><strong class="font-mono text-neutral-900">${escapeHtml(app.application_id)}</strong> ${isDel}</td>
          <td>
            <div class="font-bold">${escapeHtml(app.service_name)}</div>
            <div class="text-xs text-muted">${escapeHtml(app.category || "General")}</div>
          </td>
          <td>
            <div class="font-semibold">${escapeHtml(applicantName)}</div>
            <div class="text-xs text-muted">${escapeHtml(applicantEmail)}</div>
          </td>
          <td>${dateFormatted}</td>
          <td>${badge}</td>
          <td><span class="font-mono text-xs font-bold text-success">${app.fee > 0 ? `₹${Number(app.fee).toFixed(2)}` : "Free"}</span></td>
          <td><span class="text-xs text-muted">${escapeHtml(app.assigned_to || "Unassigned")}</span></td>
          <td>
            <div class="d-flex gap-2">
              <button class="btn btn-xs btn-outline" onclick="window.viewApplicationDetail('${escapeHtml(app.application_id)}')">
                Review
              </button>
              ${
                app.status === "Approved"
                  ? `<button class="btn btn-xs btn-primary" onclick="window.viewCertificate('${escapeHtml(app.application_id)}')">Cert</button>`
                  : ""
              }
            </div>
          </td>
        </tr>`;
      })
      .join("");

    // Wire row select checkboxes
    document.querySelectorAll(".chk-app-select").forEach((chk) => {
      chk.addEventListener("change", (e) => {
        const id = e.target.getAttribute("data-id");
        if (e.target.checked) selectedAppIds.add(id);
        else selectedAppIds.delete(id);
        updateBulkButtons();
      });
    });

    // Wire entire row click for intuitive modal opening
    document.querySelectorAll("#admin-apps-tbody tr").forEach((tr) => {
      tr.style.cursor = "pointer";
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button") || e.target.closest("a") || e.target.closest("input")) return;
        const rowId = tr.getAttribute("id");
        if (rowId && rowId.startsWith("app-row-")) {
          const appId = rowId.replace("app-row-", "");
          window.viewApplicationDetail(appId);
        }
      });
    });

    const selectAll = document.getElementById("chk-select-all");
    if (selectAll) {
      selectAll.checked = false;
      selectAll.addEventListener("change", (e) => {
        document.querySelectorAll(".chk-app-select").forEach((chk) => {
          chk.checked = e.target.checked;
          const id = chk.getAttribute("data-id");
          if (e.target.checked) selectedAppIds.add(id);
          else selectedAppIds.delete(id);
        });
        updateBulkButtons();
      });
    }
  } catch (err) {
    console.error("Applications load error:", err);
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">Error loading application records.</td></tr>`;
  }
}

function updateBulkButtons() {
  const btnApprove = document.getElementById("btn-bulk-approve");
  const btnReject = document.getElementById("btn-bulk-reject");
  const hasSelection = selectedAppIds.size > 0;
  if (btnApprove) btnApprove.disabled = !hasSelection;
  if (btnReject) btnReject.disabled = !hasSelection;
}

function setupBulkActions() {
  document.getElementById("btn-bulk-approve")?.addEventListener("click", async () => {
    if (!selectedAppIds.size) return;
    if (!confirm(`Are you sure you want to approve ${selectedAppIds.size} applications?`)) return;

    try {
      const res = await apiFetch("/admin/applications/bulk", {
        method: "POST",
        body: { action: "approve", application_ids: Array.from(selectedAppIds), remarks: "Bulk Approved by officer." }
      });
      if (res.success) {
        await loadApplications();
      } else {
        alert(res.error?.message || "Bulk approval failed.");
      }
    } catch (err) {
      alert("Network error.");
    }
  });

  document.getElementById("btn-bulk-reject")?.addEventListener("click", async () => {
    if (!selectedAppIds.size) return;
    const reason = prompt(`Enter mandatory rejection reason for ${selectedAppIds.size} applications:`);
    if (!reason || reason.trim().length < 5) {
      alert("Rejection reason is mandatory (minimum 5 characters).");
      return;
    }

    try {
      const res = await apiFetch("/admin/applications/bulk", {
        method: "POST",
        body: { action: "reject", application_ids: Array.from(selectedAppIds), remarks: reason.trim() }
      });
      if (res.success) {
        await loadApplications();
      } else {
        alert(res.error?.message || "Bulk rejection failed.");
      }
    } catch (err) {
      alert("Network error.");
    }
  });
}

function setupModalHandlers() {
  const modal = document.getElementById("app-review-modal");
  const closeBtn = document.getElementById("btn-close-app-modal");
  const cancelBtn = document.getElementById("btn-cancel-app-modal");

  const hideModal = () => modal?.classList.add("d-none");
  closeBtn?.addEventListener("click", hideModal);
  cancelBtn?.addEventListener("click", hideModal);

  // Certificate Modal Handlers
  const certModal = document.getElementById("certificate-modal");
  const closeCert = document.getElementById("btn-close-cert-modal");
  const cancelCert = document.getElementById("btn-cancel-cert");
  closeCert?.addEventListener("click", () => certModal?.classList.add("d-none"));
  cancelCert?.addEventListener("click", () => certModal?.classList.add("d-none"));

  window.viewCertificate = async (applicationId) => {
    if (!certModal) return;
    certModal.classList.remove("d-none");
    const certBody = document.getElementById("cert-modal-body");
    certBody.innerHTML = `<div class="text-center py-6 text-muted">Retrieving verified municipal certificate...</div>`;

    try {
      const res = await apiFetch(`/admin/applications/${applicationId}/certificate`, { method: "GET" });
      if (!res.success || !res.data) {
        certBody.innerHTML = `<div class="alert alert-danger">${escapeHtml(res.error?.message || "Certificate unavailable.")}</div>`;
        return;
      }

      const c = res.data;
      certBody.innerHTML = `
        <div style="border: 4px double #dc2626; padding: 24px; background: #fff5f5; border-radius: 8px; text-align: center;">
          <div style="font-size: 2rem; margin-bottom: 4px;">🏛️</div>
          <h2 style="font-family: var(--font-heading); font-size: 1.4rem; color: #7f1d1d; margin: 0;">MUNICIPAL CORPORATION</h2>
          <div style="font-size: 0.8rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #dc2626; margin-bottom: 12px;">Certificate of Municipal Service Approval</div>
          
          <div style="background: white; border: 1px solid #fee2e2; padding: 14px; border-radius: 6px; margin-bottom: 16px; text-align: left; font-size: 0.85rem;">
            <div style="margin-bottom: 6px;"><strong>Certificate No:</strong> <span class="font-mono">${escapeHtml(c.certificate_number)}</span></div>
            <div style="margin-bottom: 6px;"><strong>Application Reference:</strong> ${escapeHtml(c.application_id)}</div>
            <div style="margin-bottom: 6px;"><strong>Service Provided:</strong> ${escapeHtml(c.service_name)}</div>
            <div style="margin-bottom: 6px;"><strong>Citizen Recipient:</strong> ${escapeHtml(c.citizen_name)} (${escapeHtml(c.citizen_email)})</div>
            <div style="margin-bottom: 6px;"><strong>Issuance Date:</strong> ${escapeHtml(c.issued_date)}</div>
            <div><strong>Issuing Authority:</strong> ${escapeHtml(c.issuing_authority)}</div>
          </div>

          <div style="font-size: 0.75rem; color: #64748b; border-top: 1px solid #e2e8f0; padding-top: 8px;">
            🔒 Digitally verified municipal certificate issued via Municipal Service Portal.
          </div>
        </div>
      `;
    } catch (err) {
      certBody.innerHTML = `<div class="alert alert-danger">Error generating certificate.</div>`;
    }
  };

  window.viewApplicationDetail = async (applicationId) => {
    activeReviewAppId = applicationId;
    if (!modal) return;
    modal.classList.remove("d-none");
    document.getElementById("modal-app-id").textContent = applicationId;
    const body = document.getElementById("modal-app-body");
    body.innerHTML = `<div class="text-center py-6 text-muted">Loading full application file...</div>`;

    try {
      const res = await apiFetch(`/admin/applications/${applicationId}`, { method: "GET" });
      if (!res.success || !res.data) {
        body.innerHTML = `<div class="alert alert-danger">${escapeHtml(res.error?.message || "Failed to load application.")}</div>`;
        return;
      }

      const d = res.data;
      const docsHtml = d.documents?.length
        ? `<ul class="modal-doc-list">
            ${d.documents.map((doc) => `<li><span class="check-icon">✓</span> <a href="${escapeHtml(doc.download_url)}" target="_blank" class="text-primary font-bold">${escapeHtml(doc.original_filename)}</a> (${Math.round((doc.file_size || 0) / 1024)} KB)</li>`).join("")}
           </ul>`
        : `<div class="text-muted text-sm mt-1">No uploaded documents attached.</div>`;

      const formDataHtml = Object.entries(d.form_data || {})
        .map(([k, v]) => `<div><span class="text-xs text-muted uppercase font-bold">${escapeHtml(k.replace(/_/g, " "))}:</span> <strong>${escapeHtml(String(v))}</strong></div>`)
        .join("");

      const notesHtml = d.internal_notes?.length
        ? d.internal_notes.map((n) => `<div class="bg-neutral-50 p-2 rounded border mb-2 text-xs"><strong>${escapeHtml(n.author)}:</strong> ${escapeHtml(n.note)}</div>`).join("")
        : `<div class="text-muted text-xs">No internal notes on this file.</div>`;

      body.innerHTML = `
        <div class="mb-4 pb-3 border-bottom">
          <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
            <div>
              <h3 class="text-base font-bold text-neutral-900 m-0">${escapeHtml(d.service_name)}</h3>
              <span class="text-xs text-muted">${escapeHtml(d.category)} • Applicant: <strong>${escapeHtml(d.applicant_name || d.citizen_name)}</strong> (${escapeHtml(d.applicant_email || d.citizen_email)}) • Fee: <strong class="text-success">₹${Number(d.fee || 0).toFixed(2)}</strong> <span class="badge ${d.payment_status === 'Paid' ? 'badge-success' : 'badge-neutral'} ml-1">${escapeHtml(d.payment_status || 'Paid')}</span></span>
            </div>
            <div class="d-flex gap-2 align-items-center">
              <div>${getStatusBadge(d.status)}</div>
              <button type="button" class="btn btn-xs btn-outline" id="btn-toggle-edit-mode">✏️ Edit Details</button>
            </div>
          </div>
        </div>

        <!-- Alert Notification for Modal -->
        <div id="modal-app-alert" class="alert d-none mb-3" role="alert"></div>

        <!-- Review View Mode -->
        <div id="section-app-review">
          <div class="mb-4">
            <h4 class="text-xs font-bold uppercase text-neutral-500 mb-2">Submitted Form Particulars</h4>
            <div class="bg-neutral-50 p-3 rounded border text-sm" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <div><span class="text-xs text-muted uppercase font-bold">Applicant Mobile:</span> <strong>${escapeHtml(d.applicant_mobile || 'Not provided')}</strong></div>
              <div><span class="text-xs text-muted uppercase font-bold">Residential Ward / Address:</span> <strong>${escapeHtml(d.address || 'Not specified')}</strong></div>
              <div><span class="text-xs text-muted uppercase font-bold">Statutory Service Fee:</span> <strong class="text-success">₹${Number(d.fee || 0).toFixed(2)}</strong> <span class="badge ${d.payment_status === 'Paid' ? 'badge-success' : 'badge-neutral'} ml-1">${escapeHtml(d.payment_status || 'Paid')}</span></div>
              ${formDataHtml || '<span class="text-muted">No custom form fields</span>'}
            </div>
          </div>

          <div class="mb-4">
            <h4 class="text-xs font-bold uppercase text-neutral-500 mb-1">Attached Verification Documents</h4>
            ${docsHtml}
          </div>

          <div class="mb-4">
            <h4 class="text-xs font-bold uppercase text-neutral-500 mb-1">Internal Officer Notes</h4>
            ${notesHtml}
            <div class="d-flex gap-2 mt-2">
              <input type="text" id="input-new-note" class="form-control" placeholder="Add confidential internal note..." style="font-size: 0.8rem;">
              <button class="btn btn-xs btn-outline" id="btn-add-note">Add Note</button>
            </div>
          </div>

          <div class="mb-4">
            <h4 class="text-xs font-bold uppercase text-neutral-500 mb-2">Administrative Workflow Decision</h4>
            <div class="d-flex gap-3 mb-3">
              <select id="modal-status-select" class="form-select" style="max-width: 220px;">
                <option value="Pending" ${d.status === "Pending" ? "selected" : ""}>Mark as Pending Review</option>
                <option value="Under Review" ${d.status === "Under Review" ? "selected" : ""}>Mark Under Review</option>
                <option value="Action Required" ${d.status === "Action Required" ? "selected" : ""}>Request More Info</option>
                <option value="Approved" ${d.status === "Approved" ? "selected" : ""}>Approve Application</option>
                <option value="Rejected" ${d.status === "Rejected" ? "selected" : ""}>Reject Application</option>
              </select>
            </div>
            <div>
              <textarea id="modal-status-remarks" class="form-control" rows="2" placeholder="Mandatory officer decision remarks or rejection justification..."></textarea>
            </div>
          </div>
        </div>

        <!-- Edit View Mode -->
        <div id="section-app-edit" class="d-none">
          <form id="form-edit-app-particulars">
            <div class="card p-3 mb-3 bg-neutral-50 border">
              <h4 class="text-xs font-bold uppercase text-neutral-700 mb-3">Edit Applicant &amp; Application Information</h4>
              <div class="d-flex gap-3 mb-3 flex-wrap">
                <div class="flex-1" style="min-width: 200px;">
                  <label class="form-label text-xs font-bold">Applicant Full Name *</label>
                  <input type="text" id="input-edit-app-name" class="form-control" value="${escapeHtml(d.applicant_name || d.citizen_name || '')}" required minlength="2">
                </div>
                <div class="flex-1" style="min-width: 200px;">
                  <label class="form-label text-xs font-bold">Applicant Email *</label>
                  <input type="email" id="input-edit-app-email" class="form-control" value="${escapeHtml(d.applicant_email || d.citizen_email || '')}" required>
                </div>
              </div>
              <div class="d-flex gap-3 mb-3 flex-wrap">
                <div class="flex-1" style="min-width: 200px;">
                  <label class="form-label text-xs font-bold">Applicant Mobile Number</label>
                  <input type="text" id="input-edit-app-phone" class="form-control" value="${escapeHtml(d.applicant_mobile || '')}" placeholder="10-digit mobile number">
                </div>
                <div class="flex-1" style="min-width: 200px;">
                  <label class="form-label text-xs font-bold">Residential Ward / Address</label>
                  <input type="text" id="input-edit-app-address" class="form-control" value="${escapeHtml(d.address || '')}" placeholder="Residential ward or street address">
                </div>
              </div>
              <div class="mb-3">
                <label class="form-label text-xs font-bold">Application Description / Remarks</label>
                <textarea id="input-edit-app-desc" class="form-control" rows="2" placeholder="Application remarks or special requirements...">${escapeHtml(d.description || '')}</textarea>
              </div>
              <div class="d-flex justify-content-end gap-2">
                <button type="button" class="btn btn-sm btn-outline" id="btn-cancel-edit-mode">Cancel</button>
                <button type="submit" class="btn btn-sm btn-primary" id="btn-submit-edit-app">Save Application Changes</button>
              </div>
            </div>
          </form>
        </div>
      `;

      const footer = document.getElementById("modal-app-footer");
      footer.innerHTML = `
        <button class="btn btn-sm btn-outline text-danger" id="btn-delete-app">Move to Trash</button>
        <button class="btn btn-sm btn-outline" id="btn-cancel-modal">Close</button>
        <button class="btn btn-sm btn-primary" id="btn-save-status">Save Status Decision</button>
      `;

      document.getElementById("btn-cancel-modal")?.addEventListener("click", hideModal);

      // Toggle edit mode
      const reviewSec = document.getElementById("section-app-review");
      const editSec = document.getElementById("section-app-edit");
      const toggleEditBtn = document.getElementById("btn-toggle-edit-mode");
      const cancelEditBtn = document.getElementById("btn-cancel-edit-mode");

      toggleEditBtn?.addEventListener("click", () => {
        const isEditing = !editSec.classList.contains("d-none");
        if (isEditing) {
          editSec.classList.add("d-none");
          reviewSec.classList.remove("d-none");
          toggleEditBtn.textContent = "✏️ Edit Details";
        } else {
          reviewSec.classList.add("d-none");
          editSec.classList.remove("d-none");
          toggleEditBtn.textContent = "📋 Back to Review";
        }
      });

      cancelEditBtn?.addEventListener("click", () => {
        editSec.classList.add("d-none");
        reviewSec.classList.remove("d-none");
        toggleEditBtn.textContent = "✏️ Edit Details";
      });

      // Submit edited application particulars
      document.getElementById("form-edit-app-particulars")?.addEventListener("submit", async (e) => {
        e.preventDefault();
        const alertBox = document.getElementById("modal-app-alert");
        const name = document.getElementById("input-edit-app-name")?.value.trim();
        const email = document.getElementById("input-edit-app-email")?.value.trim();
        const phone = document.getElementById("input-edit-app-phone")?.value.trim();
        const address = document.getElementById("input-edit-app-address")?.value.trim();
        const description = document.getElementById("input-edit-app-desc")?.value.trim();

        if (!name || name.length < 2) {
          alert("Applicant name must be at least 2 characters.");
          return;
        }

        const submitBtn = document.getElementById("btn-submit-edit-app");
        if (submitBtn) submitBtn.disabled = true;

        try {
          const res = await apiFetch(`/admin/applications/${applicationId}`, {
            method: "PUT",
            body: { applicant_name: name, applicant_email: email, applicant_mobile: phone, address, description }
          });

          if (res.success) {
            alert("Application details updated successfully and logged in audit history.");
            await window.viewApplicationDetail(applicationId);
            await loadApplications();
          } else {
            alert(res.error?.message || "Failed to update application details.");
          }
        } catch (err) {
          alert("Network error updating application details.");
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });

      // Add note
      document.getElementById("btn-add-note")?.addEventListener("click", async () => {
        const noteInput = document.getElementById("input-new-note");
        const note = noteInput?.value.trim();
        if (!note) return;
        await apiFetch(`/admin/applications/${applicationId}/notes`, {
          method: "POST",
          body: { note }
        });
        window.viewApplicationDetail(applicationId);
      });

      // Save status decision
      document.getElementById("btn-save-status")?.addEventListener("click", async () => {
        const select = document.getElementById("modal-status-select");
        const remarksInput = document.getElementById("modal-status-remarks");
        const newStatus = select?.value;
        const remarks = remarksInput?.value.trim();

        if (!remarks || remarks.length < 5) {
          alert("Please provide substantive remarks (minimum 5 characters) explaining the administrative decision.");
          return;
        }

        try {
          const updateRes = await apiFetch(`/admin/applications/${applicationId}/status`, {
            method: "PATCH",
            body: { status: newStatus, remarks }
          });

          if (!updateRes.success) {
            alert(updateRes.error?.message || "Failed to update status.");
            return;
          }

          hideModal();
          await loadApplications();
        } catch (err) {
          alert("Network error.");
        }
      });

      // Soft delete
      document.getElementById("btn-delete-app")?.addEventListener("click", async () => {
        const isApproved = d.status === "Approved";
        const msg = isApproved
          ? "WARNING: This application has been Approved with an issued municipal certificate. Are you sure you want to move it to trash?"
          : "Are you sure you want to move this application to trash?";
        if (!confirm(msg)) return;
        const res = await apiFetch(`/admin/applications/${applicationId}?force=${isApproved}`, { method: "DELETE" });
        if (!res.success) {
          alert(res.error?.message || "Failed to delete application.");
          return;
        }
        hideModal();
        await loadApplications();
      });
    } catch (err) {
      body.innerHTML = `<div class="alert alert-danger">Error loading application details.</div>`;
    }
  };
}

function getStatusBadge(status) {
  const s = status || "Submitted";
  if (s === "Approved" || s === "Resolved" || s === "Completed") {
    return `<span class="badge badge-success">${escapeHtml(s)}</span>`;
  }
  if (s === "Pending" || s === "Submitted") {
    return `<span class="badge badge-info">${escapeHtml(s)}</span>`;
  }
  if (s === "Under Review" || s === "In Progress" || s === "Action Required") {
    return `<span class="badge badge-warning">${escapeHtml(s)}</span>`;
  }
  if (s === "Rejected" || s === "Closed") {
    return `<span class="badge badge-danger">${escapeHtml(s)}</span>`;
  }
  return `<span class="badge badge-neutral">${escapeHtml(s)}</span>`;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
