/**
 * Administrative Grievances Redressal Controller (ESM)
 * Department routing, SLA tracking, photo evidence inspection, and resolution verification.
 */

import { apiFetch, checkDbHealth, logoutUser } from "./api.js";

let adminProfile = null;
let activeCmpId = null;

document.addEventListener("DOMContentLoaded", initAdminComplaints);

async function initAdminComplaints() {
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

  // 3. Load Departments & Grievances
  await loadDepartmentsFilter();
  await loadComplaints();
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
  const searchInput = document.getElementById("cmp-search-input");
  const rangeFilter = document.getElementById("cmp-range-filter");
  const deptFilter = document.getElementById("cmp-dept-filter");
  const statusFilter = document.getElementById("cmp-status-filter");
  const priorityFilter = document.getElementById("cmp-priority-filter");
  const chkDeleted = document.getElementById("chk-include-deleted");
  const clearBtn = document.getElementById("btn-clear-filters");

  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get("range") && rangeFilter) rangeFilter.value = urlParams.get("range");
  const rawStatus = urlParams.get("status");
  if (rawStatus && statusFilter) {
    let matched = false;
    for (const opt of statusFilter.options) {
      if (opt.value.toLowerCase() === rawStatus.toLowerCase()) {
        statusFilter.value = opt.value;
        matched = true;
        break;
      }
    }
    if (!matched) statusFilter.value = rawStatus;
  }
  if (urlParams.get("department") && deptFilter) deptFilter.value = urlParams.get("department");
  if (urlParams.get("priority") && priorityFilter) priorityFilter.value = urlParams.get("priority");
  if (urlParams.get("overdue") === "true") currentOverdue = true;
  if (urlParams.get("q") && searchInput) searchInput.value = urlParams.get("q");

  let debounceTimer = null;
  searchInput?.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(loadComplaints, 300);
  });

  rangeFilter?.addEventListener("change", loadComplaints);
  deptFilter?.addEventListener("change", loadComplaints);
  statusFilter?.addEventListener("change", loadComplaints);
  priorityFilter?.addEventListener("change", loadComplaints);
  chkDeleted?.addEventListener("change", loadComplaints);
  clearBtn?.addEventListener("click", resetAllFilters);

  // Support browser Back/Forward navigation
  window.addEventListener("popstate", () => {
    const currentParams = new URLSearchParams(window.location.search);
    if (rangeFilter) rangeFilter.value = currentParams.get("range") || "all";
    if (statusFilter) statusFilter.value = currentParams.get("status") || "ALL";
    if (deptFilter) deptFilter.value = currentParams.get("department") || "ALL";
    if (priorityFilter) priorityFilter.value = currentParams.get("priority") || "ALL";
    if (searchInput) searchInput.value = currentParams.get("q") || "";
    currentOverdue = currentParams.get("overdue") === "true";
    loadComplaints();
  });
}

function resetAllFilters() {
  const sInput = document.getElementById("cmp-search-input");
  if (sInput) sInput.value = "";
  const rFilter = document.getElementById("cmp-range-filter");
  if (rFilter) rFilter.value = "all";
  const dFilter = document.getElementById("cmp-dept-filter");
  if (dFilter) dFilter.value = "ALL";
  const stFilter = document.getElementById("cmp-status-filter");
  if (stFilter) stFilter.value = "ALL";
  const pFilter = document.getElementById("cmp-priority-filter");
  if (pFilter) pFilter.value = "ALL";
  const chkDel = document.getElementById("chk-include-deleted");
  if (chkDel) chkDel.checked = false;
  currentOverdue = false;

  window.history.replaceState({}, "", window.location.pathname);
  loadComplaints();
}

function updateFilterChips(searchVal, rangeVal, deptVal, statusVal, priorityVal) {
  const bar = document.getElementById("filter-chips-bar");
  const container = document.getElementById("filter-chips-container");
  if (!bar || !container) return;

  const chips = [];

  if (searchVal) {
    chips.push({
      label: `Search: "${searchVal}"`,
      remove: () => {
        const inp = document.getElementById("cmp-search-input");
        if (inp) inp.value = "";
        loadComplaints();
      }
    });
  }

  if (rangeVal && rangeVal !== "all") {
    chips.push({
      label: `Date: ${rangeVal.toUpperCase()}`,
      remove: () => {
        const sel = document.getElementById("cmp-range-filter");
        if (sel) sel.value = "all";
        loadComplaints();
      }
    });
  }

  if (statusVal && statusVal !== "ALL") {
    chips.push({
      label: `Status: ${statusVal}`,
      remove: () => {
        const sel = document.getElementById("cmp-status-filter");
        if (sel) sel.value = "ALL";
        loadComplaints();
      }
    });
  }

  if (deptVal && deptVal !== "ALL") {
    chips.push({
      label: `Department: ${deptVal}`,
      remove: () => {
        const sel = document.getElementById("cmp-dept-filter");
        if (sel) sel.value = "ALL";
        loadComplaints();
      }
    });
  }

  if (priorityVal && priorityVal !== "ALL") {
    chips.push({
      label: `Priority: ${priorityVal}`,
      remove: () => {
        const sel = document.getElementById("cmp-priority-filter");
        if (sel) sel.value = "ALL";
        loadComplaints();
      }
    });
  }

  if (currentOverdue) {
    chips.push({
      label: `Overdue Grievances`,
      remove: () => {
        currentOverdue = false;
        loadComplaints();
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

async function loadDepartmentsFilter() {
  const select = document.getElementById("cmp-dept-filter");
  if (!select) return;
  try {
    const res = await apiFetch("/admin/departments", { method: "GET" });
    if (res.success && res.data) {
      res.data.forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.name;
        opt.textContent = d.name;
        select.appendChild(opt);
      });
    }
  } catch (err) {}
}

async function loadComplaints() {
  const tbody = document.getElementById("admin-cmps-tbody");
  const searchVal = document.getElementById("cmp-search-input")?.value.trim() || "";
  const rangeVal = document.getElementById("cmp-range-filter")?.value || "all";
  const deptVal = document.getElementById("cmp-dept-filter")?.value || "ALL";
  const statusVal = document.getElementById("cmp-status-filter")?.value || "ALL";
  const priorityVal = document.getElementById("cmp-priority-filter")?.value || "ALL";
  const incDeleted = document.getElementById("chk-include-deleted")?.checked;

  if (!tbody) return;

  updateFilterChips(searchVal, rangeVal, deptVal, statusVal, priorityVal);

  try {
    const params = new URLSearchParams();
    if (rangeVal !== "all") params.append("range", rangeVal);
    if (deptVal !== "ALL") params.append("department", deptVal);
    if (statusVal !== "ALL") params.append("status", statusVal);
    if (priorityVal !== "ALL") params.append("priority", priorityVal);
    if (searchVal) params.append("q", searchVal);
    if (currentOverdue) params.append("overdue", "true");
    if (incDeleted) params.append("include_deleted", "true");

    const queryStr = params.toString() ? `?${params.toString()}` : "";
    window.history.replaceState({}, "", queryStr || window.location.pathname);
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
            <div class="empty-state-card" style="margin: 0; border: none;">
              <div class="empty-state-icon">🛠️</div>
              <div class="empty-state-title">No Grievances Match Filter</div>
              <div class="empty-state-subtext">No citizen grievances found matching your current filter criteria.</div>
            </div>
          </td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = complaints
      .map((c) => {
        const statusBadge = getStatusBadge(c.status);
        const priorityBadge = getPriorityBadge(c.priority);
        const slaBadge = c.is_overdue
          ? `<span class="badge badge-danger">Overdue</span>`
          : `<span class="badge badge-neutral">On Schedule</span>`;
        const escalatedBadge = c.escalated ? `<span class="badge badge-danger ml-1">Escalated</span>` : "";

        return `
        <tr>
          <td><strong class="font-mono text-neutral-900">${escapeHtml(c.complaint_id)}</strong> ${escalatedBadge}</td>
          <td>
            <div class="font-bold">${escapeHtml(c.title || "Civic Defect")}</div>
            <div class="text-xs text-muted">${escapeHtml(c.location || "Location not given")}</div>
          </td>
          <td><span class="text-xs font-semibold">${escapeHtml(c.department || "General")}</span></td>
          <td>
            <div class="font-semibold">${escapeHtml(c.citizen_name || "Citizen")}</div>
            <div class="text-xs text-muted">${escapeHtml(c.citizen_email || "")}</div>
          </td>
          <td>${priorityBadge}</td>
          <td>${statusBadge}</td>
          <td>${slaBadge}</td>
          <td>
            <button class="btn btn-xs btn-outline" onclick="window.viewComplaintModal('${escapeHtml(c.complaint_id)}')">
              Review
            </button>
          </td>
        </tr>`;
      })
      .join("");
  } catch (err) {
    console.error("Grievances load error:", err);
    tbody.innerHTML = `<tr><td colspan="8" class="text-center text-danger py-4">Error loading grievance records.</td></tr>`;
  }
}

function setupModalHandlers() {
  const modal = document.getElementById("cmp-review-modal");
  const closeBtn = document.getElementById("btn-close-cmp-modal");
  const cancelBtn = document.getElementById("btn-cancel-cmp-modal");

  const hideModal = () => modal?.classList.add("d-none");
  closeBtn?.addEventListener("click", hideModal);
  cancelBtn?.addEventListener("click", hideModal);

  window.viewComplaintModal = async (complaintId) => {
    activeCmpId = complaintId;
    if (!modal) return;
    modal.classList.remove("d-none");
    document.getElementById("modal-cmp-id").textContent = complaintId;
    const body = document.getElementById("modal-cmp-body");
    body.innerHTML = `<div class="text-center py-6 text-muted">Retrieving grievance particulars...</div>`;

    try {
      const res = await apiFetch(`/admin/complaints/${complaintId}`, { method: "GET" });
      if (!res.success || !res.data) {
        body.innerHTML = `<div class="alert alert-danger">${escapeHtml(res.error?.message || "Failed to load grievance.")}</div>`;
        return;
      }

      const d = res.data;
      const imagesHtml = d.images?.length
        ? `<div class="d-flex gap-3 flex-wrap mt-2">
            ${d.images.map((img) => `<a href="${escapeHtml(img.download_url)}" target="_blank"><img src="${escapeHtml(img.download_url)}" alt="Photo evidence" style="width: 90px; height: 90px; object-fit: cover; border-radius: 6px; border: 1px solid #cbd5e1;"></a>`).join("")}
           </div>`
        : `<div class="text-muted text-sm mt-1">No photographs attached to this grievance.</div>`;

      const repliesHtml = d.citizen_replies?.length
        ? d.citizen_replies.map((r) => `<div class="bg-neutral-50 p-2 rounded border mb-2 text-xs"><strong>${escapeHtml(r.author)}:</strong> ${escapeHtml(r.message)}</div>`).join("")
        : `<div class="text-muted text-xs">No replies sent to citizen yet.</div>`;

      const notesHtml = d.internal_notes?.length
        ? d.internal_notes.map((n) => `<div class="bg-neutral-50 p-2 rounded border mb-2 text-xs"><strong>${escapeHtml(n.author)}:</strong> ${escapeHtml(n.note)}</div>`).join("")
        : `<div class="text-muted text-xs">No internal notes on this file.</div>`;

      // Get department options
      const deptsRes = await apiFetch("/admin/departments", { method: "GET" });
      const departments = deptsRes.data || [];
      const deptOptions = departments
        .map((dep) => `<option value="${escapeHtml(dep.name)}" ${dep.name === d.department ? "selected" : ""}>${escapeHtml(dep.name)}</option>`)
        .join("");

      body.innerHTML = `
        <div class="mb-4 pb-3 border-bottom">
          <div class="d-flex justify-content-between align-items-center">
            <div>
              <h3 class="text-base font-bold text-neutral-900 m-0">${escapeHtml(d.title || "Civic Grievance")}</h3>
              <span class="text-xs text-muted">Citizen: <strong>${escapeHtml(d.citizen_name)}</strong> (${escapeHtml(d.citizen_email)})</span>
            </div>
            <div class="d-flex gap-2">
              ${getPriorityBadge(d.priority)}
              ${getStatusBadge(d.status)}
            </div>
          </div>
        </div>

        <div class="mb-4 bg-neutral-50 p-3 rounded border text-sm">
          <div><strong class="text-xs text-muted uppercase">Description:</strong></div>
          <p class="mt-1 mb-2">${escapeHtml(d.description || "No detailed description provided.")}</p>
          <div class="d-flex justify-content-between text-xs text-muted">
            <span><strong>Location:</strong> ${escapeHtml(d.location || "N/A")}</span>
            <span><strong>Coordinates:</strong> ${escapeHtml(d.coordinates ? `${d.coordinates.lat}, ${d.coordinates.lng}` : "N/A")}</span>
          </div>
        </div>

        <div class="mb-4">
          <h4 class="text-xs font-bold uppercase text-neutral-500 mb-1">Attached Photo Evidence</h4>
          ${imagesHtml}
        </div>

        <div class="mb-4">
          <h4 class="text-xs font-bold uppercase text-neutral-500 mb-2">Department Assignment & Priority</h4>
          <div class="d-flex gap-3 flex-wrap">
            <select id="modal-dept-select" class="form-select flex-1" style="min-width: 200px;">
              ${deptOptions}
            </select>
            <select id="modal-priority-select" class="form-select" style="max-width: 150px;">
              <option value="Low" ${d.priority === "Low" ? "selected" : ""}>Low</option>
              <option value="Medium" ${d.priority === "Medium" ? "selected" : ""}>Medium</option>
              <option value="High" ${d.priority === "High" ? "selected" : ""}>High</option>
              <option value="Urgent" ${d.priority === "Urgent" ? "selected" : ""}>Urgent</option>
            </select>
          </div>
        </div>

        <div class="mb-4">
          <h4 class="text-xs font-bold uppercase text-neutral-500 mb-2">Update Resolution Status</h4>
          <div class="d-flex gap-3 mb-2">
            <select id="modal-status-select" class="form-select" style="max-width: 220px;">
              <option value="In Progress" ${d.status === "In Progress" ? "selected" : ""}>In Progress (Dispatched)</option>
              <option value="Resolved" ${d.status === "Resolved" ? "selected" : ""}>Mark Resolved</option>
              <option value="Closed" ${d.status === "Closed" ? "selected" : ""}>Close Grievance</option>
              <option value="Rejected" ${d.status === "Rejected" ? "selected" : ""}>Reject / Invalid</option>
            </select>
          </div>
          <textarea id="modal-status-remarks" class="form-control mb-2" rows="2" placeholder="Mandatory resolution / status remarks (minimum 5 chars)..."></textarea>
          <input type="text" id="modal-proof-input" class="form-control text-xs" placeholder="Optional resolution proof URL or note...">
        </div>

        <div class="mb-4">
          <h4 class="text-xs font-bold uppercase text-neutral-500 mb-1">Official Reply to Citizen</h4>
          ${repliesHtml}
          <div class="d-flex gap-2 mt-2">
            <input type="text" id="input-new-reply" class="form-control text-xs" placeholder="Message will be sent to citizen dashboard...">
            <button class="btn btn-xs btn-outline" id="btn-send-reply">Send Reply</button>
          </div>
        </div>

        <div class="mb-4">
          <h4 class="text-xs font-bold uppercase text-neutral-500 mb-1">Internal Notes</h4>
          ${notesHtml}
          <div class="d-flex gap-2 mt-2">
            <input type="text" id="input-new-note" class="form-control text-xs" placeholder="Confidential note for department records...">
            <button class="btn btn-xs btn-outline" id="btn-add-note">Add Note</button>
          </div>
        </div>
      `;

      const footer = document.getElementById("modal-cmp-footer");
      footer.innerHTML = `
        <button class="btn btn-sm btn-outline text-danger" id="btn-escalate">Escalate</button>
        <button class="btn btn-sm btn-outline" id="btn-cancel-modal">Cancel</button>
        <button class="btn btn-sm btn-primary" id="btn-save-all">Save Changes</button>
      `;

      document.getElementById("btn-cancel-modal")?.addEventListener("click", hideModal);

      // Reply
      document.getElementById("btn-send-reply")?.addEventListener("click", async () => {
        const msg = document.getElementById("input-new-reply")?.value.trim();
        if (!msg || msg.length < 5) return alert("Reply must be at least 5 characters.");
        await apiFetch(`/admin/complaints/${complaintId}/reply`, { method: "POST", body: { message: msg } });
        window.viewComplaintModal(complaintId);
      });

      // Internal note
      document.getElementById("btn-add-note")?.addEventListener("click", async () => {
        const note = document.getElementById("input-new-note")?.value.trim();
        if (!note) return;
        await apiFetch(`/admin/complaints/${complaintId}/notes`, { method: "POST", body: { note } });
        window.viewComplaintModal(complaintId);
      });

      // Escalate
      document.getElementById("btn-escalate")?.addEventListener("click", async () => {
        if (!confirm("Are you sure you want to escalate this complaint to Commissioner level?")) return;
        await apiFetch(`/admin/complaints/${complaintId}/escalate`, { method: "PATCH", body: { reason: "Manual escalation by officer." } });
        hideModal();
        await loadComplaints();
      });

      // Save status & assignment
      document.getElementById("btn-save-all")?.addEventListener("click", async () => {
        const newStatus = document.getElementById("modal-status-select")?.value;
        const remarks = document.getElementById("modal-status-remarks")?.value.trim();
        const proof = document.getElementById("modal-proof-input")?.value.trim();
        const dept = document.getElementById("modal-dept-select")?.value;
        const priority = document.getElementById("modal-priority-select")?.value;

        if (dept !== d.department) {
          await apiFetch(`/admin/complaints/${complaintId}/assign`, {
            method: "PATCH",
            body: { department: dept, remarks: `Reassigned to ${dept}` }
          });
        }

        if (priority !== d.priority) {
          await apiFetch(`/admin/complaints/${complaintId}/priority`, {
            method: "PATCH",
            body: { priority }
          });
        }

        if (newStatus !== d.status || remarks) {
          if (!remarks || remarks.length < 5) {
            alert("Mandatory resolution remarks required (min 5 characters).");
            return;
          }
          const stRes = await apiFetch(`/admin/complaints/${complaintId}/status`, {
            method: "PATCH",
            body: { status: newStatus, remarks, resolution_proof: proof }
          });
          if (!stRes.success) {
            alert(stRes.error?.message || "Failed to update status.");
            return;
          }
        }

        hideModal();
        await loadComplaints();
      });
    } catch (err) {
      body.innerHTML = `<div class="alert alert-danger">Error retrieving complaint details.</div>`;
    }
  };
}

function getStatusBadge(status) {
  const s = status || "Submitted";
  if (s === "Resolved" || s === "Closed") {
    return `<span class="badge badge-success">${escapeHtml(s)}</span>`;
  }
  if (s === "Under Review" || s === "In Progress" || s === "Assigned") {
    return `<span class="badge badge-warning">${escapeHtml(s)}</span>`;
  }
  if (s === "Rejected") {
    return `<span class="badge badge-danger">${escapeHtml(s)}</span>`;
  }
  return `<span class="badge badge-neutral">${escapeHtml(s)}</span>`;
}

function getPriorityBadge(priority) {
  const p = priority || "Medium";
  if (p === "Urgent") return `<span class="badge badge-danger">Urgent</span>`;
  if (p === "High") return `<span class="badge badge-warning">High</span>`;
  if (p === "Low") return `<span class="badge badge-neutral">Low</span>`;
  return `<span class="badge badge-info">Medium</span>`;
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
