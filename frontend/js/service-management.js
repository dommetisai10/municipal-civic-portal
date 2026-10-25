/**
 * Service Management Module (ESM)
 * Administrative catalog CRUD, detail drawer with live statistics,
 * document checklist builder, dynamic form field schema, and instant availability toggling.
 */

import { apiRequest, showToast, getAuthUser, logoutUser, escapeHtml } from "./api.js";

let adminProfile = null;
let allServices = [];
let currentEditSlug = null;
let currentMode = "create"; // 'create' or 'edit'
let pendingAvailSlug = null;
let currentServicesPage = 1;
const servicesPerPage = 10;

document.addEventListener("DOMContentLoaded", async () => {
  await verifyAdminSession();
  initSidebar();
  initUrlParams();
  initEventListeners();
  await loadAdminServices();
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
    window.location.href = "admin-login.html?redirect=service-management.html";
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
      const searchInput = document.getElementById("service-search-input");
      if (searchInput) {
        searchInput.value = e.target.value;
        applyFilters();
      }
    });
  }
}

function initUrlParams() {
  const params = new URLSearchParams(window.location.search);
  if (params.get("q")) {
    const sInput = document.getElementById("service-search-input");
    if (sInput) sInput.value = params.get("q").trim();
  }
  if (params.get("category")) {
    const catSelect = document.getElementById("category-filter");
    if (catSelect) catSelect.value = params.get("category");
  }
  if (params.get("department")) {
    const deptSelect = document.getElementById("department-filter");
    if (deptSelect) deptSelect.value = params.get("department");
  }
  const availParam = params.get("availability") || params.get("status");
  if (availParam) {
    const availSelect = document.getElementById("availability-filter");
    if (availSelect) {
      if (availParam.toLowerCase() === "available" || availParam.toLowerCase() === "active") {
        availSelect.value = "Available";
      } else if (availParam.toLowerCase() === "unavailable") {
        availSelect.value = "Unavailable";
      }
    }
  }
  if (params.get("page")) {
    const p = parseInt(params.get("page"), 10);
    if (!isNaN(p) && p >= 1) currentServicesPage = p;
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

  // Action buttons
  document.getElementById("btn-add-service")?.addEventListener("click", () => openServiceFormModal("create"));
  document.getElementById("btn-refresh-services")?.addEventListener("click", loadAdminServices);
  document.getElementById("btn-clear-filters")?.addEventListener("click", resetAllFilters);

  // Filters
  document.getElementById("service-search-input")?.addEventListener("input", applyFilters);
  document.getElementById("category-filter")?.addEventListener("change", applyFilters);
  document.getElementById("department-filter")?.addEventListener("change", applyFilters);
  document.getElementById("availability-filter")?.addEventListener("change", applyFilters);

  // Form modal controls
  document.getElementById("modal-service-close")?.addEventListener("click", closeServiceFormModal);
  document.getElementById("modal-service-cancel")?.addEventListener("click", closeServiceFormModal);
  document.getElementById("btn-add-doc-field")?.addEventListener("click", () => addDocInputField(""));
  document.getElementById("btn-add-form-field")?.addEventListener("click", () => addFormFieldRow({}));
  document.getElementById("service-form")?.addEventListener("submit", handleServiceFormSubmit);

  // Detail drawer modal controls
  document.getElementById("modal-detail-close")?.addEventListener("click", closeDetailModal);
  document.getElementById("modal-detail-cancel")?.addEventListener("click", closeDetailModal);

  // Availability modal controls
  document.getElementById("modal-avail-close")?.addEventListener("click", closeAvailModal);
  document.getElementById("modal-avail-cancel")?.addEventListener("click", closeAvailModal);
  document.getElementById("btn-confirm-avail")?.addEventListener("click", handleConfirmAvailability);

  // Pagination controls
  document.getElementById("btn-services-prev-page")?.addEventListener("click", () => {
    if (currentServicesPage > 1) {
      currentServicesPage--;
      applyFilters(false);
    }
  });

  document.getElementById("btn-services-next-page")?.addEventListener("click", () => {
    currentServicesPage++;
    applyFilters(false);
  });

  // Browser Back/Forward navigation support
  window.addEventListener("popstate", () => {
    initUrlParams();
    applyFilters(false);
  });
}

function resetAllFilters() {
  const sInput = document.getElementById("service-search-input");
  if (sInput) sInput.value = "";
  const catSelect = document.getElementById("category-filter");
  if (catSelect) catSelect.value = "ALL";
  const deptSelect = document.getElementById("department-filter");
  if (deptSelect) deptSelect.value = "ALL";
  const availSelect = document.getElementById("availability-filter");
  if (availSelect) availSelect.value = "ALL";

  applyFilters();
}

/**
 * Loads catalog services from live database.
 */
async function loadAdminServices() {
  const tbody = document.getElementById("services-table-body");
  const countText = document.getElementById("services-count-text");

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-6 text-muted">
          Loading catalog from database...
        </td>
      </tr>
    `;
  }

  try {
    const res = await apiRequest("/admin/services");
    if (res.ok && res.success && Array.isArray(res.data)) {
      allServices = res.data;
      populateDepartmentFilter();
      applyFilters();
    } else {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" class="text-center py-6 text-danger">
              Failed to load services: ${escapeHtml(res.error?.message || "Database error")}
            </td>
          </tr>
        `;
      }
      if (countText) countText.textContent = "0";
    }
  } catch (err) {
    console.error("Failed to load admin services:", err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="8" class="text-center py-6 text-danger">
            Network error contacting backend API.
          </td>
        </tr>
      `;
    }
  }
}

function populateDepartmentFilter() {
  const deptSelect = document.getElementById("department-filter");
  if (!deptSelect) return;

  const currentVal = deptSelect.value;
  const depts = new Set();
  allServices.forEach((s) => {
    if (s.department) depts.add(s.department);
  });

  deptSelect.innerHTML = `<option value="ALL">All Departments</option>`;
  Array.from(depts)
    .sort()
    .forEach((dept) => {
      const opt = document.createElement("option");
      opt.value = dept;
      opt.textContent = dept;
      if (dept === currentVal) opt.selected = true;
      deptSelect.appendChild(opt);
    });
}

function applyFilters(resetPage = true) {
  if (resetPage) {
    currentServicesPage = 1;
  }

  const query = (document.getElementById("service-search-input")?.value || "").toLowerCase().trim();
  const cat = document.getElementById("category-filter")?.value || "ALL";
  const dept = document.getElementById("department-filter")?.value || "ALL";
  const avail = document.getElementById("availability-filter")?.value || "ALL";

  // Synchronize browser URL query parameters without reloading
  const params = new URLSearchParams();
  if (query) params.set("q", query);
  if (cat !== "ALL") params.set("category", cat);
  if (dept !== "ALL") params.set("department", dept);
  if (avail !== "ALL") params.set("availability", avail);
  if (currentServicesPage > 1) params.set("page", currentServicesPage);

  const newUrl = params.toString() ? `${window.location.pathname}?${params.toString()}` : window.location.pathname;
  window.history.replaceState({}, "", newUrl);

  updateFilterChips(query, cat, dept, avail);

  const filtered = allServices.filter((s) => {
    const matchCat = cat === "ALL" || s.category === cat;
    const matchDept = dept === "ALL" || s.department === dept;
    const isAvail = s.availability === "Available" || s.availability === "Active" || s.is_active === true;
    const matchAvail =
      avail === "ALL" ||
      (avail === "Available" && isAvail) ||
      (avail === "Unavailable" && !isAvail);
    const matchQuery =
      !query ||
      (s.name && s.name.toLowerCase().includes(query)) ||
      (s.slug && s.slug.toLowerCase().includes(query)) ||
      (s.description && s.description.toLowerCase().includes(query)) ||
      (s.category && s.category.toLowerCase().includes(query)) ||
      (s.department && s.department.toLowerCase().includes(query));

    return matchCat && matchDept && matchAvail && matchQuery;
  });

  const totalRecords = filtered.length;
  const totalPages = Math.ceil(totalRecords / servicesPerPage) || 1;
  if (currentServicesPage > totalPages) currentServicesPage = totalPages;
  if (currentServicesPage < 1) currentServicesPage = 1;

  const startIndex = (currentServicesPage - 1) * servicesPerPage;
  const pagedServices = filtered.slice(startIndex, startIndex + servicesPerPage);

  renderServicesTable(pagedServices, totalRecords);
  updateServicesPagination(totalRecords, totalPages);
}

function updateFilterChips(query, cat, dept, avail) {
  const bar = document.getElementById("filter-chips-bar");
  const container = document.getElementById("filter-chips-container");
  if (!bar || !container) return;

  const chips = [];

  if (query) {
    chips.push({
      label: `Search: "${query}"`,
      remove: () => {
        const inp = document.getElementById("service-search-input");
        if (inp) inp.value = "";
        applyFilters();
      }
    });
  }

  if (cat !== "ALL") {
    chips.push({
      label: `Category: ${cat}`,
      remove: () => {
        const sel = document.getElementById("category-filter");
        if (sel) sel.value = "ALL";
        applyFilters();
      }
    });
  }

  if (dept !== "ALL") {
    chips.push({
      label: `Department: ${dept}`,
      remove: () => {
        const sel = document.getElementById("department-filter");
        if (sel) sel.value = "ALL";
        applyFilters();
      }
    });
  }

  if (avail !== "ALL") {
    chips.push({
      label: `Status: ${avail.toUpperCase()}`,
      remove: () => {
        const sel = document.getElementById("availability-filter");
        if (sel) sel.value = "ALL";
        applyFilters();
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

function renderServicesTable(services, totalRecords = 0) {
  const tbody = document.getElementById("services-table-body");
  const countText = document.getElementById("services-count-text");

  if (!tbody) return;

  if (countText) {
    countText.textContent = `${totalRecords}`;
  }

  if (totalRecords === 0 || services.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-8 text-muted">
          <div style="font-size: 2rem; margin-bottom: 8px;">🏛️</div>
          <strong>No catalog services match your filter criteria.</strong>
          <p class="text-xs mt-1">Try resetting the search terms or create a new municipal service.</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = "";
  services.forEach((srv) => {
    const tr = document.createElement("tr");
    const isAvail = srv.availability === "Available" || srv.availability === "Active" || srv.is_active === true;
    const appsCount = srv.applications_count || 0;

    tr.innerHTML = `
      <td>
        <div class="font-bold text-neutral-900">${escapeHtml(srv.name)}</div>
        <div class="text-xs text-muted" style="max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(srv.description || '')}">${escapeHtml(srv.description || 'Civic municipal service catalog')}</div>
        <code class="text-xs text-muted font-mono">${escapeHtml(srv.slug)}</code>
      </td>
      <td>
        <span class="badge badge-category">${escapeHtml(srv.category || "General")}</span>
      </td>
      <td>
        <span class="text-xs font-medium text-neutral-700">${escapeHtml(srv.department || "Administration")}</span>
      </td>
      <td>
        <span class="text-xs">${srv.processing_days || srv.sla_days || 7} Days</span>
      </td>
      <td>
        <span class="text-xs font-bold">${srv.fee ? `₹${srv.fee}` : "Free"}</span>
      </td>
      <td>
        <a href="admin-applications.html?service=${encodeURIComponent(srv.slug)}" class="badge ${appsCount > 0 ? "badge-info" : "badge-neutral"} btn-view-service-apps" data-slug="${escapeHtml(srv.slug)}" style="text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;" title="View all applications submitted for ${escapeHtml(srv.name)}">
          <span>${appsCount} submitted</span>
          <span aria-hidden="true">&rarr;</span>
        </a>
      </td>
      <td>
        <button type="button" class="btn btn-xs ${isAvail ? "btn-success" : "btn-warning"} btn-toggle-avail" data-slug="${escapeHtml(srv.slug)}" data-avail="${isAvail ? "Available" : "Unavailable"}">
          ${isAvail ? "● Available" : "○ Unavailable"}
        </button>
      </td>
      <td class="text-right">
        <div class="d-flex gap-1 justify-content-end">
          <button type="button" class="btn btn-xs btn-outline btn-inspect-service" title="Inspect Service Details">
            👁️
          </button>
          <button type="button" class="btn btn-xs btn-outline btn-edit-service" title="Edit Service">
            ✏️
          </button>
          <button type="button" class="btn btn-xs btn-outline btn-duplicate-service" title="Duplicate Service">
            📋
          </button>
          <button type="button" class="btn btn-xs btn-danger-outline btn-delete-service" title="Delete Service">
            🗑️
          </button>
        </div>
      </td>
    `;

    tr.style.cursor = "pointer";
    tr.addEventListener("click", (e) => {
      if (e.target.closest("button") || e.target.closest("a") || e.target.closest("input")) return;
      openServiceDetailDrawer(srv.slug);
    });

    // Row events
    tr.querySelector(".btn-inspect-service")?.addEventListener("click", () => openServiceDetailDrawer(srv.slug));
    tr.querySelector(".btn-toggle-avail")?.addEventListener("click", () => openAvailModal(srv.slug, isAvail));
    tr.querySelector(".btn-edit-service")?.addEventListener("click", () => openServiceFormModal("edit", srv));
    tr.querySelector(".btn-duplicate-service")?.addEventListener("click", () => duplicateService(srv.slug, srv.name));
    tr.querySelector(".btn-delete-service")?.addEventListener("click", () => deleteService(srv.slug, srv.name, appsCount));

    tbody.appendChild(tr);
  });
}

function updateServicesPagination(totalRecords, totalPages) {
  const infoEl = document.getElementById("services-pagination-info");
  const prevBtn = document.getElementById("btn-services-prev-page");
  const nextBtn = document.getElementById("btn-services-next-page");
  const pageText = document.getElementById("services-current-page-text");

  if (totalRecords === 0) {
    if (infoEl) infoEl.textContent = "Showing 0 records";
    if (pageText) pageText.textContent = "Page 1 of 1";
    if (prevBtn) prevBtn.disabled = true;
    if (nextBtn) nextBtn.disabled = true;
    return;
  }

  const startRecord = (currentServicesPage - 1) * servicesPerPage + 1;
  const endRecord = Math.min(currentServicesPage * servicesPerPage, totalRecords);

  if (infoEl) infoEl.textContent = `Showing ${startRecord} to ${endRecord} of ${totalRecords} catalog services`;
  if (pageText) pageText.textContent = `Page ${currentServicesPage} of ${totalPages}`;
  if (prevBtn) prevBtn.disabled = currentServicesPage <= 1;
  if (nextBtn) nextBtn.disabled = currentServicesPage >= totalPages;
}

/**
 * Service Detail View / Drawer: fetches full service statistics and application history.
 */
async function openServiceDetailDrawer(slug) {
  const modal = document.getElementById("service-detail-modal");
  const nameEl = document.getElementById("detail-name");
  const slugEl = document.getElementById("modal-detail-slug");
  const metaEl = document.getElementById("detail-meta");
  const descEl = document.getElementById("detail-desc");
  const badgeEl = document.getElementById("detail-avail-badge");
  const reasonBox = document.getElementById("detail-reason-box");
  const reasonText = document.getElementById("detail-reason-text");

  const statApps = document.getElementById("detail-stat-total-apps");
  const statRate = document.getElementById("detail-stat-approval-rate");
  const statDays = document.getElementById("detail-stat-avg-days");

  const docsList = document.getElementById("detail-docs-list");
  const fieldsList = document.getElementById("detail-fields-list");
  const recentAppsTbody = document.getElementById("detail-recent-apps-tbody");

  if (!modal) return;
  modal.classList.remove("d-none");

  if (nameEl) nameEl.textContent = "Loading Service Details...";
  if (slugEl) slugEl.textContent = `Slug: ${slug}`;

  try {
    const res = await apiRequest(`/admin/services/${encodeURIComponent(slug)}`);
    if (res.ok && res.success && res.data) {
      const { service, statistics, recent_applications, required_documents, form_fields } = res.data;

      const isAvail = service.availability === "Available" || service.availability === "Active" || service.is_active === true;

      if (nameEl) nameEl.textContent = service.name;
      if (badgeEl) {
        badgeEl.className = isAvail ? "badge badge-success" : "badge badge-neutral";
        badgeEl.textContent = isAvail ? "● Available (Active)" : "○ Unavailable";
      }
      if (metaEl) {
        metaEl.textContent = `${service.category || "General"} • ${service.department || "Municipal Administration"} • Fee: ₹${service.fee || 0} • SLA: ${service.sla_days || service.processing_days || 7} Days`;
      }
      if (descEl) descEl.textContent = service.description || "No description provided.";

      if (service.availability_reason && !isAvail) {
        reasonBox?.classList.remove("d-none");
        if (reasonText) reasonText.textContent = service.availability_reason;
      } else {
        reasonBox?.classList.add("d-none");
      }

      // Stats
      if (statApps) statApps.textContent = statistics?.total_applications ?? 0;
      if (statRate) statRate.textContent = `${statistics?.approval_rate ?? 0}%`;
      if (statDays) statDays.textContent = `${statistics?.avg_processing_days ?? 0} d`;

      // Docs Checklist
      if (docsList) {
        const docs = required_documents || [];
        if (docs.length === 0) {
          docsList.innerHTML = `<span class="text-muted">No mandatory documents required.</span>`;
        } else {
          docsList.innerHTML = `<ul class="modal-doc-list">${docs.map((d) => `<li><span class="check-icon">✓</span> ${escapeHtml(d)}</li>`).join("")}</ul>`;
        }
      }

      // Dynamic Form Schema
      if (fieldsList) {
        const fields = form_fields || [];
        if (fields.length === 0) {
          fieldsList.innerHTML = `<span class="text-muted">Standard civic applicant fields.</span>`;
        } else {
          fieldsList.innerHTML = `<div class="d-flex flex-column gap-1">${fields.map((f) => `<div class="p-2 border rounded bg-white text-xs"><strong>${escapeHtml(f.label || f.name)}</strong> <span class="badge badge-neutral">${escapeHtml(f.type || "text")}</span> ${f.required ? '<span class="text-danger font-bold">*</span>' : ""}</div>`).join("")}</div>`;
        }
      }

      // Recent Applications
      if (recentAppsTbody) {
        const apps = recent_applications || [];
        if (apps.length === 0) {
          recentAppsTbody.innerHTML = `<tr><td colspan="4" class="text-center py-4 text-muted">No recent applications submitted for this service.</td></tr>`;
        } else {
          recentAppsTbody.innerHTML = apps
            .map(
              (a) => `
            <tr>
              <td><code>${escapeHtml(a.application_id)}</code></td>
              <td>${escapeHtml(a.citizen_name || "Citizen")} (${escapeHtml(a.citizen_email || "")})</td>
              <td><span class="badge ${a.status === "Approved" ? "badge-success" : a.status === "Rejected" ? "badge-danger" : "badge-info"}">${escapeHtml(a.status || "Submitted")}</span></td>
              <td class="text-xs text-muted">${a.created_at ? new Date(a.created_at).toLocaleDateString() : "—"}</td>
            </tr>
          `
            )
            .join("");
        }
      }

      // Drawer Action buttons
      const viewAllAppsBtn = document.getElementById("detail-btn-view-all-apps");
      if (viewAllAppsBtn) {
        viewAllAppsBtn.href = `admin-applications.html?service=${encodeURIComponent(service.slug)}`;
      }

      const btnToggleAvail = document.getElementById("detail-btn-toggle-avail");
      if (btnToggleAvail) {
        btnToggleAvail.onclick = () => {
          closeDetailModal();
          openAvailModal(service.slug, isAvail);
        };
      }
      const btnEdit = document.getElementById("detail-btn-edit");
      if (btnEdit) {
        btnEdit.onclick = () => {
          closeDetailModal();
          openServiceFormModal("edit", service);
        };
      }
      const btnDup = document.getElementById("detail-btn-dup");
      if (btnDup) {
        btnDup.onclick = () => {
          closeDetailModal();
          duplicateService(service.slug, service.name);
        };
      }
    } else {
      showToast(res.error?.message || "Failed to load service particulars.", "danger");
    }
  } catch (err) {
    showToast("Network error fetching service details.", "danger");
  }
}

function closeDetailModal() {
  const modal = document.getElementById("service-detail-modal");
  if (modal) modal.classList.add("d-none");
}

/**
 * Service Form Modal (Create or Edit with document checklist & dynamic form builder).
 */
function openServiceFormModal(mode, service = null) {
  const modal = document.getElementById("service-form-modal");
  const titleEl = document.getElementById("modal-service-title");
  const nameInput = document.getElementById("service-name-input");
  const slugInput = document.getElementById("service-slug-input");
  const catInput = document.getElementById("service-category-input");
  const deptInput = document.getElementById("service-dept-input");
  const descInput = document.getElementById("service-desc-input");
  const slaInput = document.getElementById("service-sla-input");
  const feeInput = document.getElementById("service-fee-input");
  const availInput = document.getElementById("service-availability-input");
  const docsContainer = document.getElementById("required-docs-container");
  const fieldsContainer = document.getElementById("form-fields-container");

  if (!modal) return;
  currentMode = mode;

  if (docsContainer) docsContainer.innerHTML = "";
  if (fieldsContainer) fieldsContainer.innerHTML = "";

  if (mode === "create") {
    currentEditSlug = null;
    if (titleEl) titleEl.textContent = "Add New Municipal Service";
    if (nameInput) nameInput.value = "";
    if (slugInput) {
      slugInput.value = "";
      slugInput.disabled = false;
    }
    if (catInput) catInput.value = "Civil Registration";
    if (deptInput) deptInput.value = "Public Health & Sanitation";
    if (descInput) descInput.value = "";
    if (slaInput) slaInput.value = "7";
    if (feeInput) feeInput.value = "0";
    if (availInput) availInput.value = "Available";

    // Default required documents
    addDocInputField("Proof of Identity (Aadhaar / Voter ID / Passport)");
    addDocInputField("Proof of Address (Utility Bill / Lease Agreement)");

    // Default dynamic form fields
    addFormFieldRow({ label: "Applicant Full Name", type: "text", required: true });
    addFormFieldRow({ label: "Residential Ward Number", type: "number", required: true });
  } else if (service) {
    currentEditSlug = service.slug;
    if (titleEl) titleEl.textContent = `Edit Service: ${service.name}`;
    if (nameInput) nameInput.value = service.name || "";
    if (slugInput) {
      slugInput.value = service.slug || "";
      slugInput.disabled = true; // Slugs cannot be mutated after creation
    }
    if (catInput) catInput.value = service.category || "Civil Registration";
    if (deptInput) deptInput.value = service.department || "General Administration";
    if (descInput) descInput.value = service.description || "";
    if (slaInput) slaInput.value = service.processing_days || service.sla_days || 7;
    if (feeInput) feeInput.value = service.fee || 0;
    if (availInput) {
      const isAvail = service.availability === "Available" || service.availability === "Active" || service.is_active === true;
      availInput.value = isAvail ? "Available" : "Unavailable";
    }

    // Populate required documents
    const docs = Array.isArray(service.required_documents) ? service.required_documents : [];
    if (docs.length === 0) {
      addDocInputField("");
    } else {
      docs.forEach((d) => addDocInputField(d));
    }

    // Populate dynamic form schema
    const fields = service.form_fields || service.form_schema || [];
    if (fields.length === 0) {
      addFormFieldRow({ label: "Applicant Name", type: "text", required: true });
    } else {
      fields.forEach((f) => addFormFieldRow(f));
    }
  }

  modal.classList.remove("d-none");
}

function closeServiceFormModal() {
  const modal = document.getElementById("service-form-modal");
  if (modal) modal.classList.add("d-none");
}

function addDocInputField(value = "") {
  const container = document.getElementById("required-docs-container");
  if (!container) return;

  const div = document.createElement("div");
  div.className = "builder-row";
  div.innerHTML = `
    <span class="text-muted text-xs">📄</span>
    <input type="text" class="form-control doc-field-input flex-1" placeholder="e.g. Birth Attendant Certificate" value="${escapeHtml(value)}">
    <button type="button" class="btn btn-xs btn-outline text-danger btn-remove-row" title="Remove Document" aria-label="Remove document">✕</button>
  `;

  div.querySelector(".btn-remove-row").addEventListener("click", () => {
    container.removeChild(div);
  });

  container.appendChild(div);
}

function addFormFieldRow(field = {}) {
  const container = document.getElementById("form-fields-container");
  if (!container) return;

  const div = document.createElement("div");
  div.className = "builder-row";
  const type = field.type || "text";
  const isReq = field.required !== false;

  div.innerHTML = `
    <input type="text" class="form-control form-field-label flex-1" placeholder="Field Label (e.g. Property Tax ID)" value="${escapeHtml(field.label || field.name || "")}">
    <select class="form-select form-field-type" style="max-width: 130px;">
      <option value="text" ${type === "text" ? "selected" : ""}>Text</option>
      <option value="number" ${type === "number" ? "selected" : ""}>Number</option>
      <option value="date" ${type === "date" ? "selected" : ""}>Date</option>
      <option value="select" ${type === "select" ? "selected" : ""}>Select</option>
      <option value="textarea" ${type === "textarea" ? "selected" : ""}>Textarea</option>
    </select>
    <label class="d-flex align-items-center gap-1 text-xs font-bold text-neutral-700 m-0">
      <input type="checkbox" class="form-field-required" ${isReq ? "checked" : ""}> Req.
    </label>
    <button type="button" class="btn btn-xs btn-outline text-danger btn-remove-row" title="Remove Field" aria-label="Remove field">✕</button>
  `;

  div.querySelector(".btn-remove-row").addEventListener("click", () => {
    container.removeChild(div);
  });

  container.appendChild(div);
}

async function handleServiceFormSubmit(e) {
  e.preventDefault();
  const name = document.getElementById("service-name-input")?.value.trim();
  const slug = document.getElementById("service-slug-input")?.value.trim();
  const category = document.getElementById("service-category-input")?.value;
  const department = document.getElementById("service-dept-input")?.value.trim() || "General Administration";
  const description = document.getElementById("service-desc-input")?.value.trim();
  const sla_days = parseInt(document.getElementById("service-sla-input")?.value, 10) || 7;
  const fee = parseFloat(document.getElementById("service-fee-input")?.value) || 0;
  const availability = document.getElementById("service-availability-input")?.value || "Available";

  if (!name || name.length < 3) {
    showToast("Service name must be at least 3 characters.", "warning");
    return;
  }
  if (!description || description.length < 10) {
    showToast("Substantive service description (min 10 characters) is required.", "warning");
    return;
  }

  // Gather required documents
  const docInputs = document.querySelectorAll(".doc-field-input");
  const required_documents = [];
  docInputs.forEach((input) => {
    const val = input.value.trim();
    if (val) required_documents.push(val);
  });

  // Gather dynamic form schema
  const fieldRows = document.querySelectorAll("#form-fields-container .builder-row");
  const form_fields = [];
  fieldRows.forEach((row) => {
    const label = row.querySelector(".form-field-label")?.value.trim();
    const type = row.querySelector(".form-field-type")?.value || "text";
    const required = row.querySelector(".form-field-required")?.checked ?? true;
    if (label) {
      form_fields.push({
        name: label.toLowerCase().replace(/[^a-z0-9]/g, "_"),
        label,
        type,
        required
      });
    }
  });

  const payload = {
    name,
    category,
    department,
    description,
    sla_days,
    processing_days: sla_days,
    fee,
    availability,
    required_documents,
    form_fields,
    form_schema: form_fields
  };
  if (slug) payload.slug = slug;

  const saveBtn = document.getElementById("btn-save-service");
  if (saveBtn) saveBtn.disabled = true;

  try {
    let res;
    if (currentMode === "create") {
      res = await apiRequest("/admin/services", {
        method: "POST",
        body: payload
      });
    } else {
      res = await apiRequest(`/admin/services/${encodeURIComponent(currentEditSlug)}`, {
        method: "PUT",
        body: payload
      });
    }

    if (res.ok && res.success) {
      showToast(currentMode === "create" ? "New service published to catalog!" : "Service particulars updated successfully!", "success");
      closeServiceFormModal();
      await loadAdminServices();
    } else {
      showToast(res.error?.message || "Failed to save service.", "danger");
    }
  } catch (err) {
    showToast("Network error saving service.", "danger");
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * Availability Toggle Modal logic with reason message.
 */
function openAvailModal(slug, currentlyAvailable) {
  pendingAvailSlug = slug;
  const modal = document.getElementById("service-avail-modal");
  const select = document.getElementById("avail-status-select");
  const reasonInput = document.getElementById("avail-reason-input");

  if (!modal) return;
  if (select) select.value = currentlyAvailable ? "Unavailable" : "Available";
  if (reasonInput) reasonInput.value = "";

  modal.classList.remove("d-none");
}

function closeAvailModal() {
  const modal = document.getElementById("service-avail-modal");
  if (modal) modal.classList.add("d-none");
  pendingAvailSlug = null;
}

async function handleConfirmAvailability() {
  if (!pendingAvailSlug) return;
  const select = document.getElementById("avail-status-select");
  const reasonInput = document.getElementById("avail-reason-input");
  const newAvail = select?.value || "Available";
  const reason = reasonInput?.value.trim() || "";

  try {
    const res = await apiRequest(`/admin/services/${encodeURIComponent(pendingAvailSlug)}/availability`, {
      method: "PATCH",
      body: { availability: newAvail, reason }
    });

    if (res.ok && res.success) {
      showToast(`Service status updated to '${newAvail}'.`, "success");
      closeAvailModal();
      await loadAdminServices();
    } else {
      showToast(res.error?.message || "Failed to update availability.", "danger");
    }
  } catch (err) {
    showToast("Network error updating service status.", "danger");
  }
}

async function duplicateService(slug, name) {
  if (!confirm(`Duplicate service '${name}'? This will create a catalog copy.`)) {
    return;
  }
  try {
    const res = await apiRequest(`/admin/services/${encodeURIComponent(slug)}/duplicate`, {
      method: "POST"
    });
    if (res.ok && res.success) {
      showToast(`Service duplicated successfully as '${res.data?.name}'.`, "success");
      await loadAdminServices();
    } else {
      showToast(res.error?.message || "Failed to duplicate service.", "danger");
    }
  } catch (err) {
    showToast("Network error duplicating service.", "danger");
  }
}

async function deleteService(slug, name, appsCount) {
  if (appsCount > 0) {
    showToast(`Cannot delete '${name}' because it has ${appsCount} citizen application(s) on record. Please toggle availability to 'Unavailable' instead.`, "warning");
    return;
  }

  if (!confirm(`Are you sure you want to delete service '${name}'? This action is recorded in the administrative audit log.`)) {
    return;
  }

  try {
    const res = await apiRequest(`/admin/services/${encodeURIComponent(slug)}`, {
      method: "DELETE"
    });
    if (res.ok && res.success) {
      showToast(`Service '${name}' removed from catalog.`, "success");
      await loadAdminServices();
    } else {
      showToast(res.error?.message || "Failed to delete service.", "danger");
    }
  } catch (err) {
    showToast("Network error deleting service.", "danger");
  }
}
