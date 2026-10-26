/**
 * Municipal Services Directory Module (ESM)
 * Fetches and displays services live from MongoDB with real-time search,
 * department/category filtering, document checklists, fee & SLA indicators,
 * and resilient authentication routing.
 */

import { apiFetch, getAuthUser, logoutUser, checkDbHealth, updateDbStatusPill, escapeHtml, startDbHealthPolling } from "./api.js";

let allServices = [];
let currentModalService = null;

async function loadServices() {
  const grid = document.getElementById("services-grid");
  const countText = document.getElementById("catalog-count-text");

  if (!grid) return;

  grid.innerHTML = `
    <div class="loading-state-card" style="grid-column: 1 / -1;">
      <div class="spinner"></div>
      <p class="mt-4 text-muted">Retrieving active civic services from database...</p>
    </div>
  `;

  try {
    const res = await apiFetch("/services", { method: "GET" });

    if (!res.success) {
      grid.innerHTML = `
        <div class="empty-state-card" style="grid-column: 1 / -1;">
          <div class="empty-icon">⚠️</div>
          <h3>Unable to Load Services</h3>
          <p class="text-muted">${res.error?.message || "An unexpected error occurred while contacting the services database."}</p>
        </div>
      `;
      if (countText) countText.textContent = "Error fetching services.";
      return;
    }

    allServices = res.data || [];
    renderServices(allServices);

  } catch (err) {
    console.error("Failed to fetch services:", err);
    grid.innerHTML = `
      <div class="empty-state-card" style="grid-column: 1 / -1;">
        <div class="empty-icon">🔌</div>
        <h3>Database Connection Offline</h3>
        <p class="text-muted">Could not retrieve services from the database backend. Please verify server connectivity.</p>
      </div>
    `;
    if (countText) countText.textContent = "Database offline.";
  }
}

function renderServices(servicesToRender) {
  const grid = document.getElementById("services-grid");
  const countText = document.getElementById("catalog-count-text");

  if (!grid) return;

  if (servicesToRender.length === 0) {
    grid.innerHTML = `
      <div class="empty-state-card" style="grid-column: 1 / -1;">
        <div class="empty-icon">📂</div>
        <h3>No Municipal Services Found</h3>
        <p class="text-muted">
          ${allServices.length === 0 
            ? "There are currently 0 services registered in the database. When the administration publishes services, they will appear here automatically."
            : "No services match your active search filters. Try adjusting your query or category selection."}
        </p>
      </div>
    `;
    if (countText) {
      countText.textContent = allServices.length === 0 ? "0 services in database" : "0 results matching filter";
    }
    return;
  }

  if (countText) {
    countText.textContent = `Displaying ${servicesToRender.length} of ${allServices.length} municipal service${allServices.length === 1 ? "" : "s"}`;
  }

  grid.innerHTML = servicesToRender.map(srv => {
    const isAvailable = srv.availability === "Active" || srv.availability === "Available";
    const docsCount = Array.isArray(srv.required_documents) ? srv.required_documents.length : 0;
    const departmentName = srv.department || srv.category || "General Administration";
    const processingSLA = `${srv.processing_days || 7} Working Days`;
    const statutoryFee = srv.fee ? `₹${srv.fee}` : "Free of Charge";
    const applyTargetUrl = `apply-service.html?slug=${encodeURIComponent(srv.slug)}`;

    const docsListHtml = docsCount > 0 
      ? `
        <div class="service-docs-preview">
          <span class="text-xs text-muted font-bold">Required Documents (${docsCount}):</span>
          <ul class="doc-checklist">
            ${srv.required_documents.slice(0, 3).map(d => `<li><span class="check-icon">✓</span> <span>${escapeHtml(d)}</span></li>`).join("")}
            ${docsCount > 3 ? `<li class="text-muted text-xs">+ ${docsCount - 3} more supporting document${docsCount - 3 === 1 ? "" : "s"}</li>` : ""}
          </ul>
        </div>
      `
      : `<p class="text-xs text-muted service-no-docs">No physical paperwork required. Instant digital validation.</p>`;

    return `
      <article class="service-card ${isAvailable ? 'service-available' : 'service-unavailable'}" id="service-${escapeHtml(srv.slug)}" data-slug="${escapeHtml(srv.slug)}">
        <div class="service-card-header">
          <span class="badge badge-category">${escapeHtml(departmentName)}</span>
          <span class="badge ${isAvailable ? 'badge-success' : 'badge-warning'}">
            ${isAvailable ? '● Available' : '○ Unavailable'}
          </span>
        </div>

        <h3 class="service-title">${escapeHtml(srv.name)}</h3>
        <p class="service-desc">${escapeHtml(srv.description || "Official municipal civic service.")}</p>

        <!-- Service Metadata (Department, SLA, Fee) -->
        <div class="service-meta-row">
          <div class="meta-item-box">
            <span class="meta-item-label">Timeline</span>
            <span class="meta-item-val">${escapeHtml(processingSLA)}</span>
          </div>
          <div class="meta-item-box">
            <span class="meta-item-label">Statutory Fee</span>
            <span class="meta-item-val fee-highlight">${escapeHtml(statutoryFee)}</span>
          </div>
        </div>

        ${docsListHtml}

        <div class="service-card-footer">
          ${isAvailable 
            ? `<a href="${applyTargetUrl}" class="btn btn-primary btn-block btn-apply-trigger" data-slug="${escapeHtml(srv.slug)}" id="btn-apply-${escapeHtml(srv.slug)}">
                Apply Online →
               </a>`
            : `<button class="btn btn-outline btn-block btn-disabled" disabled title="This service is marked as Unavailable and is currently not accepting applications.">
                Applications Closed
               </button>`
          }
        </div>
      </article>
    `;
  }).join("");

  // Attach click handling for cards and apply buttons
  grid.querySelectorAll(".service-card").forEach(card => {
    const slug = card.getAttribute("data-slug");
    const service = allServices.find(s => s.slug === slug);
    if (!service) return;

    // Apply button click
    const applyBtn = card.querySelector(".btn-apply-trigger");
    if (applyBtn) {
      applyBtn.addEventListener("click", async (e) => {
        e.preventDefault();
        await navigateToApply(service);
      });
    }

    // Card click opens modal if available
    card.addEventListener("click", (e) => {
      // Don't trigger modal if user clicked directly on the apply button or link
      if (e.target.closest(".btn-apply-trigger") || e.target.closest("a")) return;
      openServiceModal(service);
    });
  });
}

/**
 * Clean navigation to apply page with auth check and returnUrl
 */
async function navigateToApply(service) {
  const isAvailable = service.availability === "Active" || service.availability === "Available";
  if (!isAvailable) return;

  const targetUrl = `apply-service.html?slug=${encodeURIComponent(service.slug)}`;
  const citizen = await getAuthUser();

  if (citizen && citizen.role === "citizen") {
    window.location.href = targetUrl;
  } else {
    // Redirect unauthenticated user with safe returnUrl
    window.location.href = `login.html?returnUrl=${encodeURIComponent(targetUrl)}`;
  }
}

function setupFilterHandlers() {
  const searchInput = document.getElementById("service-search-input");
  const categorySelect = document.getElementById("category-filter-select");

  function applyFilters() {
    const query = (searchInput?.value || "").toLowerCase().trim();
    const category = categorySelect?.value || "ALL";

    const filtered = allServices.filter(srv => {
      const srvCat = srv.category || srv.department || "";
      const matchCat = category === "ALL" || srvCat === category;
      const matchQuery = !query || 
        (srv.name && srv.name.toLowerCase().includes(query)) ||
        (srv.description && srv.description.toLowerCase().includes(query)) ||
        (srvCat && srvCat.toLowerCase().includes(query)) ||
        (Array.isArray(srv.required_documents) && srv.required_documents.some(d => d.toLowerCase().includes(query)));
      return matchCat && matchQuery;
    });

    renderServices(filtered);
  }

  if (searchInput) {
    searchInput.addEventListener("input", applyFilters);
  }
  if (categorySelect) {
    categorySelect.addEventListener("change", applyFilters);
  }
}

/**
 * Service Modal Display
 */
function initServiceModal() {
  const modal = document.getElementById("service-detail-modal");
  const closeBtn = document.getElementById("modal-close-btn");
  const cancelBtn = document.getElementById("modal-cancel-btn");
  const applyBtn = document.getElementById("modal-apply-btn");

  if (!modal) return;

  function closeModal() {
    modal.classList.add("d-none");
    currentModalService = null;
  }

  if (closeBtn) closeBtn.addEventListener("click", closeModal);
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);

  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.classList.contains("d-none")) {
      closeModal();
    }
  });

  if (applyBtn) {
    applyBtn.addEventListener("click", async () => {
      if (currentModalService) {
        await navigateToApply(currentModalService);
      }
    });
  }
}

function openServiceModal(service) {
  currentModalService = service;
  const modal = document.getElementById("service-detail-modal");
  if (!modal) return;

  const nameEl = document.getElementById("modal-service-name");
  const catEl = document.getElementById("modal-service-category");
  const descEl = document.getElementById("modal-service-desc");
  const procEl = document.getElementById("modal-service-processing");
  const feeEl = document.getElementById("modal-service-fee");
  const statusEl = document.getElementById("modal-service-status");
  const docsList = document.getElementById("modal-service-docs");
  const applyBtn = document.getElementById("modal-apply-btn");

  if (nameEl) nameEl.textContent = service.name;
  if (catEl) catEl.textContent = service.department || service.category || "General";
  if (descEl) descEl.textContent = service.description || "Official municipal public service.";
  if (procEl) procEl.textContent = `${service.processing_days || 7} Working Days`;
  if (feeEl) feeEl.textContent = service.fee ? `$${service.fee}` : "Free of Charge";

  const isAvailable = service.availability === "Available" || service.availability === "Active";
  if (statusEl) {
    statusEl.textContent = isAvailable ? "Active for Applications" : "Temporarily Unavailable";
    statusEl.className = isAvailable ? "text-success font-bold" : "text-warning font-bold";
  }

  if (docsList) {
    docsList.innerHTML = "";
    const docs = Array.isArray(service.required_documents) ? service.required_documents : [];
    if (docs.length === 0) {
      docsList.innerHTML = '<li class="text-muted">No physical documents required. Instant digital verification.</li>';
    } else {
      docs.forEach(doc => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="check-icon" aria-hidden="true">✓</span> <span>${escapeHtml(doc)}</span>`;
        docsList.appendChild(li);
      });
    }
  }

  if (applyBtn) {
    applyBtn.disabled = !isAvailable;
    applyBtn.textContent = isAvailable ? "Apply Online →" : "Currently Unavailable";
  }

  modal.classList.remove("d-none");
}

async function checkNavAuth() {
  const authContainer = document.getElementById("nav-auth-actions");
  if (!authContainer) return;

  function renderGuestNav() {
    authContainer.innerHTML = `
      <a href="login.html" class="btn btn-sm btn-outline" id="nav-login-btn">Sign In</a>
      <a href="register.html" class="btn btn-sm btn-primary" id="nav-register-btn">Sign Up</a>
    `;
  }

  try {
    const user = await getAuthUser();
    if (user && user.authenticated !== false && (user.id || user._id || user.email)) {
      const isAdmin = user.role === 'admin' || user.role === 'super_admin' || Boolean(user.admin_role);
      const dashUrl = isAdmin ? 'admin-dashboard.html' : 'user-dashboard.html';
      const firstName = (user.full_name || (isAdmin ? 'Admin' : 'Citizen')).split(' ')[0];

      authContainer.innerHTML = `
        <a href="${dashUrl}" class="btn btn-sm btn-primary" id="nav-dashboard-btn">Dashboard (${escapeHtml(firstName)})</a>
        <button class="btn btn-sm btn-outline btn-signout" id="nav-logout-btn" title="Sign out of your session">Sign Out</button>
      `;

      const logoutBtn = document.getElementById('nav-logout-btn');
      logoutBtn?.addEventListener('click', async (e) => {
        e.preventDefault();
        await logoutUser({
          buttonEl: logoutBtn,
          onImmediate: renderGuestNav
        });
      });
    } else {
      renderGuestNav();
    }
  } catch {
    renderGuestNav();
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  // Update year
  const yearEl = document.getElementById("footer-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();


  // Health check indicator with automatic 30s polling
  startDbHealthPolling(30000);

  // Setup UI, modal, and load services
  await checkNavAuth();
  initServiceModal();
  setupFilterHandlers();
  await loadServices();
});
