/**
 * Citizens Management Module (ESM)
 * Audits citizen accounts, 5-tab profile drawer, inline editing, verification,
 * mandatory suspension reason, delete confirmation, and CSV exports.
 */

import { apiRequest, showToast, getAuthUser, logoutUser, escapeHtml } from "./api.js";

let adminProfile = null;
let currentPage = 1;
const currentLimit = 15;
let currentSearch = "";
let currentStatus = "ALL";
let currentVerification = "ALL";
let currentSortBy = "created_at";
let currentSortDir = "desc";
let activeCitizen = null;

document.addEventListener("DOMContentLoaded", async () => {
  await verifyAdminSession();
  initSidebar();
  initUrlParams();
  initEventListeners();
  await loadCitizens();
});

async function verifyAdminSession() {
  let user = null;
  try {
    const res = await apiRequest("/admin/auth/me");
    if (res.ok && res.success && res.data) {
      user = res.data;
    }
  } catch (_) {}

  if (!user) {
    user = await getAuthUser();
  }

  const role = user?.admin_role || user?.role;
  if (!user || !["super_admin", "admin", "officer", "viewer"].includes(role)) {
    window.location.href = "admin-login.html?redirect=citizens.html";
    return;
  }
  adminProfile = user;
  const display = document.getElementById("admin-user-display");
  const roleDisplay = document.getElementById("admin-role-display");
  const avatar = document.getElementById("admin-avatar-initials");

  const displayName = user.full_name || user.name || user.email?.split("@")[0] || "Admin";
  if (display) display.textContent = displayName;
  if (roleDisplay) roleDisplay.textContent = (user.admin_role || user.role || "Admin").toUpperCase().replace("_", " ");
  if (avatar) avatar.textContent = displayName.substring(0, 2).toUpperCase();

  // If super admin, display permanent delete option in delete modal
  if (user.admin_role === "super_admin" || user.role === "super_admin") {
    const permOpt = document.getElementById("permanent-delete-option");
    if (permOpt) permOpt.classList.remove("d-none");
  }
}

function initSidebar() {
  const toggleBtn = document.getElementById("sidebar-toggle-btn");
  const sidebar = document.getElementById("admin-sidebar");
  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });
  }

  const globalSearch = document.getElementById("global-search-input");
  if (globalSearch) {
    globalSearch.addEventListener("input", (e) => {
      const searchInput = document.getElementById("citizen-search-input");
      if (searchInput) {
        searchInput.value = e.target.value;
        currentSearch = e.target.value.trim();
        currentPage = 1;
        loadCitizens();
      }
    });
  }
}

function initUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("q")) {
    currentSearch = params.get("q").trim();
    const input = document.getElementById("citizen-search-input");
    if (input) input.value = currentSearch;
  }
  if (params.get("status")) {
    currentStatus = params.get("status");
    const select = document.getElementById("status-filter");
    if (select) select.value = currentStatus;
  }
  if (params.get("verified")) {
    currentVerification = params.get("verified");
    const select = document.getElementById("verification-filter");
    if (select) select.value = currentVerification;
  }
}

function initEventListeners() {
  // Sign out
  const logoutBtn = document.getElementById("btn-admin-logout");
  logoutBtn?.addEventListener("click", async (e) => {
    e.preventDefault();
    await logoutUser({
      buttonEl: logoutBtn,
      redirect: "admin-login.html"
    });
  });

  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !localStorage.getItem("msp_token") && !localStorage.getItem("msp_admin_token")) {
      window.location.replace("admin-login.html");
    }
  });

  // Search input debounced
  const searchInput = document.getElementById("citizen-search-input");
  if (searchInput) {
    let debounceTimer;
    searchInput.addEventListener("input", (e) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        currentSearch = e.target.value.trim();
        currentPage = 1;
        loadCitizens();
      }, 300);
    });
  }

  // Filter selects
  document.getElementById("status-filter")?.addEventListener("change", (e) => {
    currentStatus = e.target.value;
    currentPage = 1;
    loadCitizens();
  });

  document.getElementById("verification-filter")?.addEventListener("change", (e) => {
    currentVerification = e.target.value;
    currentPage = 1;
    loadCitizens();
  });

  document.getElementById("sort-by-filter")?.addEventListener("change", (e) => {
    const val = e.target.value;
    const parts = val.split("_");
    currentSortDir = parts.pop();
    currentSortBy = parts.join("_");
    currentPage = 1;
    loadCitizens();
  });

  // Refresh & Export
  document.getElementById("btn-refresh-citizens")?.addEventListener("click", loadCitizens);
  document.getElementById("btn-export-citizens")?.addEventListener("click", exportCitizensCSV);

  // Clear all filters
  document.getElementById("btn-clear-filters")?.addEventListener("click", resetAllFilters);

  // Pagination
  document.getElementById("btn-prev-page")?.addEventListener("click", () => {
    if (currentPage > 1) {
      currentPage--;
      loadCitizens();
    }
  });

  document.getElementById("btn-next-page")?.addEventListener("click", () => {
    currentPage++;
    loadCitizens();
  });

  // Modal close handlers
  document.getElementById("modal-citizen-close")?.addEventListener("click", closeCitizenModal);
  document.getElementById("modal-citizen-cancel")?.addEventListener("click", closeCitizenModal);

  // Tab switching inside profile modal
  document.querySelectorAll(".drawer-tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".drawer-tab-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });
      document.querySelectorAll(".drawer-tab-pane").forEach((p) => p.classList.remove("active"));

      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      const tabId = btn.getAttribute("data-tab");
      document.getElementById(tabId)?.classList.add("active");
    });
  });

  // Profile Form Inline Edit
  document.getElementById("form-edit-citizen-profile")?.addEventListener("submit", handleSaveProfile);

  // Profile modal action buttons
  document.getElementById("btn-toggle-verify")?.addEventListener("click", handleToggleVerify);
  document.getElementById("btn-toggle-suspend")?.addEventListener("click", openSuspendModal);
  document.getElementById("btn-send-reset-pw")?.addEventListener("click", handleSendPasswordReset);
  document.getElementById("btn-delete-citizen")?.addEventListener("click", openDeleteModal);
  document.getElementById("btn-restore-citizen")?.addEventListener("click", handleRestoreCitizen);

  // Suspension modal handlers
  document.getElementById("modal-suspend-close")?.addEventListener("click", closeSuspendModal);
  document.getElementById("modal-suspend-cancel")?.addEventListener("click", closeSuspendModal);
  document.getElementById("btn-confirm-suspend")?.addEventListener("click", handleConfirmSuspend);

  // Delete modal handlers
  document.getElementById("modal-delete-close")?.addEventListener("click", closeDeleteModal);
  document.getElementById("modal-delete-cancel")?.addEventListener("click", closeDeleteModal);
  document.getElementById("btn-confirm-delete")?.addEventListener("click", handleConfirmDelete);

  // Enable delete button only when token matches
  const confirmInput = document.getElementById("delete-confirm-token-input");
  confirmInput?.addEventListener("input", (e) => {
    const val = e.target.value.trim();
    const btn = document.getElementById("btn-confirm-delete");
    if (!btn || !activeCitizen) return;
    const isValid = val === "DELETE" || val === activeCitizen.email;
    btn.disabled = !isValid;
  });
}

function resetAllFilters() {
  currentSearch = "";
  currentStatus = "ALL";
  currentVerification = "ALL";
  currentSortBy = "created_at";
  currentSortDir = "desc";
  currentPage = 1;

  const sInput = document.getElementById("citizen-search-input");
  if (sInput) sInput.value = "";
  const stSelect = document.getElementById("status-filter");
  if (stSelect) stSelect.value = "ALL";
  const vfSelect = document.getElementById("verification-filter");
  if (vfSelect) vfSelect.value = "ALL";
  const sortSelect = document.getElementById("sort-by-filter");
  if (sortSelect) sortSelect.value = "created_at_desc";

  loadCitizens();
}

/**
 * Loads citizen directory from live database with server-side pagination & sorting.
 */
async function loadCitizens() {
  const tbody = document.getElementById("citizens-table-body");
  const countText = document.getElementById("citizens-count-text");

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" class="text-center py-6 text-muted">
          Loading citizen directory from database...
        </td>
      </tr>
    `;
  }

  updateFilterChips();

  try {
    const sortVal = currentSortBy === "created_at" && currentSortDir === "desc" ? "newest" : (currentSortBy === "created_at" ? "oldest" : "name_asc");
    const params = new URLSearchParams({
      page: currentPage,
      limit: currentLimit,
      sort: sortVal,
      sort_by: currentSortBy,
      sort_dir: currentSortDir
    });
    if (currentSearch) params.set("q", currentSearch);
    if (currentStatus !== "ALL") params.set("status", currentStatus);
    if (currentVerification !== "ALL") {
      params.set("verification", currentVerification);
      params.set("verified", currentVerification === "verified" ? "true" : "false");
    }

    const res = await apiRequest(`/admin/citizens?${params.toString()}`);
    if (res.ok && res.success && res.data) {
      const { citizens, pagination } = res.data;
      renderCitizensTable(citizens || []);
      updatePagination(pagination);
      if (countText && pagination) {
        countText.textContent = `${pagination.total_records || 0}`;
      }
    } else {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="10" class="text-center py-6 text-danger">
              Failed to load citizens: ${escapeHtml(res.error?.message || "Database query error")}
            </td>
          </tr>
        `;
      }
    }
  } catch (err) {
    console.error("Failed to load citizens:", err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="10" class="text-center py-6 text-danger">
            Network error contacting backend API.
          </td>
        </tr>
      `;
    }
  }
}

function updateFilterChips() {
  const bar = document.getElementById("filter-chips-bar");
  const container = document.getElementById("filter-chips-container");
  if (!bar || !container) return;

  const chips = [];

  if (currentSearch) {
    chips.push({
      label: `Search: "${currentSearch}"`,
      remove: () => {
        currentSearch = "";
        const inp = document.getElementById("citizen-search-input");
        if (inp) inp.value = "";
        loadCitizens();
      }
    });
  }

  if (currentStatus !== "ALL") {
    chips.push({
      label: `Status: ${currentStatus.toUpperCase()}`,
      remove: () => {
        currentStatus = "ALL";
        const sel = document.getElementById("status-filter");
        if (sel) sel.value = "ALL";
        loadCitizens();
      }
    });
  }

  if (currentVerification !== "ALL") {
    chips.push({
      label: `Verification: ${currentVerification.toUpperCase()}`,
      remove: () => {
        currentVerification = "ALL";
        const sel = document.getElementById("verification-filter");
        if (sel) sel.value = "ALL";
        loadCitizens();
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

function renderCitizensTable(citizens) {
  const tbody = document.getElementById("citizens-table-body");
  if (!tbody) return;

  if (citizens.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10" class="text-center py-8 text-muted">
          <div style="font-size: 2rem; margin-bottom: 8px;">👥</div>
          <strong>No citizen accounts found.</strong>
          <p class="text-xs mt-1">There are no registered citizen records matching your active filters.</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = "";
  citizens.forEach((c) => {
    const tr = document.createElement("tr");
    const isActive = c.is_active !== false;
    const isDeleted = c.is_deleted === true;
    const isVerified = Boolean(c.is_verified);
    const dateFormatted = c.created_at ? new Date(c.created_at).toLocaleDateString() : "N/A";
    const appsCount = c.applications_count || 0;
    const cmpsCount = c.complaints_count || 0;

    let statusBadge = `<span class="badge badge-success">Active</span>`;
    if (isDeleted) {
      statusBadge = `<span class="badge badge-danger">Deleted (Trash)</span>`;
    } else if (!isActive) {
      statusBadge = `<span class="badge badge-danger">Suspended</span>`;
    }

    tr.innerHTML = `
      <td>
        <div class="font-bold text-neutral-900">${escapeHtml(c.name || "Unnamed Citizen")}</div>
        <code class="text-xs text-muted">ID: ${escapeHtml(c.id || c._id || "N/A")}</code>
      </td>
      <td>
        <span class="text-xs font-mono">${escapeHtml(c.email)}</span>
      </td>
      <td>
        <span class="text-xs">${escapeHtml(c.phone || "Not provided")}</span>
      </td>
      <td>
        <span class="text-xs text-muted">${escapeHtml(c.address || "Ward not specified")}</span>
      </td>
      <td>
        <span class="badge ${isVerified ? "badge-success" : "badge-neutral"}">
          ${isVerified ? "✓ Verified" : "Unverified"}
        </span>
      </td>
      <td>${statusBadge}</td>
      <td>
        <span class="badge ${appsCount > 0 ? "badge-info" : "badge-neutral"}">${appsCount}</span>
      </td>
      <td>
        <span class="badge ${cmpsCount > 0 ? "badge-warning" : "badge-neutral"}">${cmpsCount}</span>
      </td>
      <td>
        <span class="text-xs text-muted">${dateFormatted}</span>
      </td>
      <td class="text-right">
        <button type="button" class="btn btn-xs btn-outline btn-view-profile" data-id="${escapeHtml(c.id || c._id)}">
          👁️ Inspect
        </button>
      </td>
    `;

    tr.style.cursor = "pointer";
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("a") || e.target.closest("input")) return;
      viewCitizenProfile(c.id || c._id);
    });

    const viewBtn = tr.querySelector(".btn-view-profile");
    viewBtn.addEventListener("click", () => viewCitizenProfile(c.id || c._id));

    tbody.appendChild(tr);
  });
}

function updatePagination(pagination) {
  const infoEl = document.getElementById("pagination-info");
  const prevBtn = document.getElementById("btn-prev-page");
  const nextBtn = document.getElementById("btn-next-page");
  const pageText = document.getElementById("current-page-text");

  if (!pagination) return;
  const { page, total_pages, total_records } = pagination;

  if (infoEl) {
    infoEl.textContent = `Showing page ${page} of ${total_pages || 1} (${total_records || 0} total records)`;
  }
  if (pageText) {
    pageText.textContent = `Page ${page} of ${total_pages || 1}`;
  }

  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= total_pages;
}

/**
 * Opens 5-tab profile drawer and fetches detailed profile, applications, grievances, audit, and notifications.
 */
async function viewCitizenProfile(citizenId) {
  const modal = document.getElementById("citizen-detail-modal");
  const nameEl = document.getElementById("banner-citizen-name");
  const emailEl = document.getElementById("banner-citizen-email");
  const metaEl = document.getElementById("banner-meta-info");
  const idEl = document.getElementById("modal-citizen-id");
  const statusBadge = document.getElementById("banner-status-badge");
  const verifyBadge = document.getElementById("banner-verify-badge");

  const editName = document.getElementById("edit-citizen-name");
  const editEmail = document.getElementById("edit-citizen-email");
  const editPhone = document.getElementById("edit-citizen-phone");
  const editAddress = document.getElementById("edit-citizen-address");
  const editAadhaar = document.getElementById("edit-citizen-aadhaar");

  const appsTbody = document.getElementById("modal-apps-tbody");
  const cmpsTbody = document.getElementById("modal-cmps-tbody");
  const auditTbody = document.getElementById("modal-audit-tbody");
  const notifsTbody = document.getElementById("modal-notifs-tbody");

  const appsCountEl = document.getElementById("tab-apps-count");
  const cmpsCountEl = document.getElementById("tab-cmps-count");

  const verifyBtn = document.getElementById("btn-toggle-verify");
  const suspendBtn = document.getElementById("btn-toggle-suspend");
  const deleteBtn = document.getElementById("btn-delete-citizen");
  const restoreBtn = document.getElementById("btn-restore-citizen");

  if (!modal) return;

  if (nameEl) nameEl.textContent = "Loading Profile...";
  if (emailEl) emailEl.textContent = "Querying live database...";
  if (idEl) idEl.textContent = `ID: ${citizenId}`;

  // Reset to first tab
  document.querySelectorAll(".drawer-tab-btn").forEach((b, i) => {
    b.classList.toggle("active", i === 0);
    b.setAttribute("aria-selected", String(i === 0));
  });
  document.querySelectorAll(".drawer-tab-pane").forEach((p, i) => p.classList.toggle("active", i === 0));

  modal.classList.remove("d-none");

  try {
    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(citizenId)}`);
    if (res.ok && res.success && res.data) {
      activeCitizen = res.data.citizen || res.data;
      const c = activeCitizen;
      const apps = res.data.applications || [];
      const cmps = res.data.complaints || [];
      const audit = res.data.activity_logs || [];
      const notifs = res.data.notifications || [];

      // Update Header Banner
      if (nameEl) nameEl.textContent = c.name || "Unnamed Citizen";
      if (emailEl) emailEl.textContent = c.email;
      const regDate = c.created_at ? new Date(c.created_at).toLocaleDateString() : "—";
      const lastLogin = c.last_login ? new Date(c.last_login).toLocaleString() : "Never";
      const aadhaarMasked = c.aadhaar_masked || "••••-••••-XXXX";
      if (metaEl) {
        metaEl.textContent = `Registered: ${regDate} • Last Login: ${lastLogin} • Aadhaar: ${aadhaarMasked}`;
      }

      const isDeleted = c.is_deleted === true;
      const isActive = c.is_active !== false;

      if (statusBadge) {
        if (isDeleted) {
          statusBadge.className = "badge badge-danger";
          statusBadge.textContent = "Deleted";
        } else if (!isActive) {
          statusBadge.className = "badge badge-danger";
          statusBadge.textContent = "Suspended";
        } else {
          statusBadge.className = "badge badge-success";
          statusBadge.textContent = "Active";
        }
      }

      if (verifyBadge) {
        verifyBadge.className = c.is_verified ? "badge badge-success" : "badge badge-neutral";
        verifyBadge.textContent = c.is_verified ? "✓ Verified Resident" : "Unverified Resident";
      }

      // Configure Action Buttons
      if (verifyBtn) {
        verifyBtn.textContent = c.is_verified ? "Revoke Verification" : "Verify Identity";
      }
      if (suspendBtn) {
        suspendBtn.textContent = !isActive ? "Reactivate Account" : "Suspend Account";
      }
      if (deleteBtn && restoreBtn) {
        if (isDeleted) {
          deleteBtn.classList.add("d-none");
          restoreBtn.classList.remove("d-none");
        } else {
          deleteBtn.classList.remove("d-none");
          restoreBtn.classList.add("d-none");
        }
      }

      // Populate Tab 1: Edit Form
      if (editName) editName.value = c.name || "";
      if (editEmail) editEmail.value = c.email || "";
      if (editPhone) editPhone.value = c.phone || "";
      if (editAddress) editAddress.value = c.address || "";
      if (editAadhaar) editAadhaar.value = aadhaarMasked;

      // Populate Tab 2: Applications
      if (appsCountEl) appsCountEl.textContent = apps.length;
      if (appsTbody) {
        if (apps.length === 0) {
          appsTbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">No applications submitted by this citizen.</td></tr>`;
        } else {
          appsTbody.innerHTML = apps
            .map(
              (app) => `
            <tr>
              <td><code>${escapeHtml(app.application_id || app.id)}</code></td>
              <td class="font-bold">${escapeHtml(app.service_name || "N/A")}</td>
              <td>${escapeHtml(app.department || "Administration")}</td>
              <td><span class="badge ${app.status === "Approved" ? "badge-success" : app.status === "Rejected" ? "badge-danger" : "badge-info"}">${escapeHtml(app.status || "Submitted")}</span></td>
              <td class="text-xs text-muted">${app.created_at ? new Date(app.created_at).toLocaleDateString() : "N/A"}</td>
              <td class="text-right">
                <a href="admin-applications.html?q=${encodeURIComponent(app.application_id)}" class="btn btn-xs btn-outline">Review</a>
              </td>
            </tr>
          `
            )
            .join("");
        }
      }

      // Populate Tab 3: Grievances
      if (cmpsCountEl) cmpsCountEl.textContent = cmps.length;
      if (cmpsTbody) {
        if (cmps.length === 0) {
          cmpsTbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">No grievances lodged by this citizen.</td></tr>`;
        } else {
          cmpsTbody.innerHTML = cmps
            .map(
              (cmp) => `
            <tr>
              <td><code>${escapeHtml(cmp.complaint_id || cmp.id)}</code></td>
              <td class="font-bold">${escapeHtml(cmp.title || "Grievance")}</td>
              <td>${escapeHtml(cmp.department || "Administration")}</td>
              <td><span class="badge ${cmp.status === "Resolved" ? "badge-success" : "badge-warning"}">${escapeHtml(cmp.status || "Submitted")}</span></td>
              <td class="text-xs text-muted">${cmp.created_at ? new Date(cmp.created_at).toLocaleDateString() : "N/A"}</td>
              <td class="text-right">
                <a href="admin-complaints.html?q=${encodeURIComponent(cmp.complaint_id)}" class="btn btn-xs btn-outline">Inspect</a>
              </td>
            </tr>
          `
            )
            .join("");
        }
      }

      // Populate Tab 4: Activity / Audit History
      if (auditTbody) {
        if (audit.length === 0) {
          auditTbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-muted">No historical audit events logged.</td></tr>`;
        } else {
          auditTbody.innerHTML = audit
            .map(
              (log) => `
            <tr>
              <td><strong class="font-mono text-xs">${escapeHtml(log.action || "EVENT")}</strong></td>
              <td class="text-xs text-muted">${log.timestamp ? new Date(log.timestamp).toLocaleString() : "N/A"}</td>
              <td class="text-xs">${escapeHtml(log.admin_email || log.user_email || "System")}</td>
              <td class="text-xs">${escapeHtml(log.details || log.reason || "—")}</td>
            </tr>
          `
            )
            .join("");
        }
      }

      // Populate Tab 5: Notifications Sent
      if (notifsTbody) {
        if (notifs.length === 0) {
          notifsTbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-muted">No notifications sent to citizen.</td></tr>`;
        } else {
          notifsTbody.innerHTML = notifs
            .map(
              (n) => `
            <tr>
              <td><span class="badge badge-neutral">${escapeHtml(n.type || "ALERT")}</span></td>
              <td class="font-medium text-xs">${escapeHtml(n.title || n.message || "Notification")}</td>
              <td><span class="badge ${n.is_read ? "badge-success" : "badge-warning"}">${n.is_read ? "Delivered & Read" : "Dispatched"}</span></td>
              <td class="text-xs text-muted">${n.created_at ? new Date(n.created_at).toLocaleDateString() : "N/A"}</td>
            </tr>
          `
            )
            .join("");
        }
      }
    } else {
      showToast(res.error?.message || "Failed to retrieve citizen record.", "danger");
    }
  } catch (err) {
    showToast("Network error loading citizen details.", "danger");
  }
}

/**
 * Saves edited profile details with validation & email uniqueness verification.
 */
async function handleSaveProfile(e) {
  e.preventDefault();
  if (!activeCitizen) return;

  const name = document.getElementById("edit-citizen-name")?.value.trim();
  const email = document.getElementById("edit-citizen-email")?.value.trim();
  const phone = document.getElementById("edit-citizen-phone")?.value.trim();
  const address = document.getElementById("edit-citizen-address")?.value.trim();

  if (!name || name.length < 2) {
    showToast("Citizen full name must be at least 2 characters.", "warning");
    return;
  }
  if (!email || !email.includes("@")) {
    showToast("Valid email address is required.", "warning");
    return;
  }

  const saveBtn = document.getElementById("btn-save-citizen-profile");
  if (saveBtn) saveBtn.disabled = true;

  try {
    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(activeCitizen.id)}`, {
      method: "PUT",
      body: { name, email, phone, address }
    });

    if (res.ok && res.success) {
      showToast("Citizen profile updated successfully and logged in audit trail.", "success");
      await viewCitizenProfile(activeCitizen.id);
      await loadCitizens();
    } else {
      showToast(res.error?.message || "Failed to update citizen profile.", "danger");
    }
  } catch (err) {
    showToast("Network error updating citizen profile.", "danger");
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Toggles resident identity verification.
 */
async function handleToggleVerify() {
  if (!activeCitizen) return;
  const newVerified = !activeCitizen.is_verified;
  try {
    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(activeCitizen.id)}/verify`, {
      method: "PATCH",
      body: { is_verified: newVerified }
    });
    if (res.ok && res.success) {
      showToast(`Resident verification ${newVerified ? "granted" : "revoked"}.`, "success");
      await viewCitizenProfile(activeCitizen.id);
      await loadCitizens();
    } else {
      showToast(res.error?.message || "Failed to update verification status.", "danger");
    }
  } catch (err) {
    showToast("Network error updating verification status.", "danger");
  }
}

/**
 * Opens suspension modal requiring mandatory reason.
 */
function openSuspendModal() {
  if (!activeCitizen) return;
  const isActive = activeCitizen.is_active !== false;

  if (!isActive) {
    // If already suspended, reactivate directly with confirm
    if (confirm(`Reactivate citizen account for ${activeCitizen.email}?`)) {
      handleReactivateAccount();
    }
    return;
  }

  const modal = document.getElementById("citizen-suspend-modal");
  const reasonInput = document.getElementById("suspend-reason-input");
  if (reasonInput) reasonInput.value = "";
  if (modal) modal.classList.remove("d-none");
}

function closeSuspendModal() {
  const modal = document.getElementById("citizen-suspend-modal");
  if (modal) modal.classList.add("d-none");
}

async function handleConfirmSuspend() {
  if (!activeCitizen) return;
  const reasonInput = document.getElementById("suspend-reason-input");
  const reason = reasonInput?.value.trim();

  if (!reason || reason.length < 5) {
    showToast("A mandatory suspension reason of at least 5 characters is required.", "warning");
    return;
  }

  try {
    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(activeCitizen.id)}/status`, {
      method: "PATCH",
      body: { is_active: false, reason }
    });

    if (res.ok && res.success) {
      showToast(`Citizen account suspended with reason logged.`, "success");
      closeSuspendModal();
      await viewCitizenProfile(activeCitizen.id);
      await loadCitizens();
    } else {
      showToast(res.error?.message || "Failed to suspend account.", "danger");
    }
  } catch (err) {
    showToast("Network error suspending account.", "danger");
  }
}

async function handleReactivateAccount() {
  if (!activeCitizen) return;
  try {
    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(activeCitizen.id)}/status`, {
      method: "PATCH",
      body: { is_active: true }
    });

    if (res.ok && res.success) {
      showToast("Citizen account reactivated.", "success");
      await viewCitizenProfile(activeCitizen.id);
      await loadCitizens();
    } else {
      showToast(res.error?.message || "Failed to reactivate account.", "danger");
    }
  } catch (err) {
    showToast("Network error reactivating account.", "danger");
  }
}

/**
 * Generates cryptographic reset token and dispatches reset notification.
 */
async function handleSendPasswordReset() {
  if (!activeCitizen) return;
  if (!confirm(`Generate and dispatch a cryptographic password reset link for ${activeCitizen.email}?`)) {
    return;
  }
  try {
    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(activeCitizen.id)}/reset-password`, {
      method: "POST"
    });
    if (res.ok && res.success) {
      showToast("Password reset link issued and logged in audit trail.", "success");
      await viewCitizenProfile(activeCitizen.id);
    } else {
      showToast(res.error?.message || "Failed to trigger password reset.", "danger");
    }
  } catch (err) {
    showToast("Network error sending password reset.", "danger");
  }
}

/**
 * Opens delete modal requiring confirmation token ("DELETE" or citizen email).
 */
function openDeleteModal() {
  if (!activeCitizen) return;
  const modal = document.getElementById("citizen-delete-modal");
  const confirmInput = document.getElementById("delete-confirm-token-input");
  const confirmBtn = document.getElementById("btn-confirm-delete");
  const activeAppsWarn = document.getElementById("delete-active-apps-warning");

  if (confirmInput) confirmInput.value = "";
  if (confirmBtn) confirmBtn.disabled = true;

  // Show active applications warning if applications exist
  if (activeCitizen.applications_count && activeCitizen.applications_count > 0) {
    activeAppsWarn?.classList.remove("d-none");
  } else {
    activeAppsWarn?.classList.add("d-none");
  }

  if (modal) modal.classList.remove("d-none");
}

function closeDeleteModal() {
  const modal = document.getElementById("citizen-delete-modal");
  if (modal) modal.classList.add("d-none");
}

async function handleConfirmDelete() {
  if (!activeCitizen) return;
  const confirmInput = document.getElementById("delete-confirm-token-input");
  const token = confirmInput?.value.trim();
  const isPerm = document.getElementById("chk-permanent-delete")?.checked;

  try {
    const query = new URLSearchParams({ confirmation: token, confirm_token: token });
    if (isPerm) query.set("permanent", "true");
    if (activeCitizen.applications_count > 0) query.set("force", "true");

    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(activeCitizen.id)}?${query.toString()}`, {
      method: "DELETE",
      body: {
        confirmation: token,
        confirm_token: token,
        permanent: Boolean(isPerm),
        force: Boolean(activeCitizen.applications_count > 0)
      }
    });

    if (res.ok && res.success) {
      showToast(isPerm ? "Citizen record permanently deleted." : "Citizen account soft-deleted.", "success");
      closeDeleteModal();
      closeCitizenModal();
      await loadCitizens();
    } else {
      showToast(res.error?.message || "Failed to delete citizen account.", "danger");
    }
  } catch (err) {
    showToast("Network error deleting citizen account.", "danger");
  }
}

/**
 * Restores a soft-deleted citizen account.
 */
async function handleRestoreCitizen() {
  if (!activeCitizen) return;
  if (!confirm(`Restore citizen account for ${activeCitizen.email}?`)) return;

  try {
    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(activeCitizen.id)}/restore`, {
      method: "PATCH"
    });

    if (res.ok && res.success) {
      showToast("Citizen account restored successfully.", "success");
      await viewCitizenProfile(activeCitizen.id);
      await loadCitizens();
    } else {
      showToast(res.error?.message || "Failed to restore citizen account.", "danger");
    }
  } catch (err) {
    showToast("Network error restoring citizen account.", "danger");
  }
}

function closeCitizenModal() {
  const modal = document.getElementById("citizen-detail-modal");
  if (modal) modal.classList.add("d-none");
  activeCitizen = null;
}

function exportCitizensCSV() {
  window.open("/api/admin/citizens/export", "_blank");
}
