/**
 * Municipal Services Directory Module (ESM)
 * Fetches and displays services live from MongoDB with search and filtering.
 */

import { apiFetch, checkDbHealth, updateDbStatusPill } from "./api.js";

let allServices = [];

async function loadServices() {
  const grid = document.getElementById("services-grid");
  const countText = document.getElementById("catalog-count-text");
  const alertBox = document.getElementById("catalog-alert");

  try {
    const res = await apiFetch("/services", { method: "GET" });

    if (!res.success) {
      grid.innerHTML = `
        <div class="empty-state-card">
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
      <div class="empty-state-card">
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
    const isAvailable = srv.availability === "Active";
    const docsCount = Array.isArray(srv.required_documents) ? srv.required_documents.length : 0;
    
    const docsListHtml = docsCount > 0 
      ? `
        <div class="service-docs-preview">
          <span class="text-xs text-muted font-bold">Required Documents (${docsCount}):</span>
          <ul class="doc-checklist">
            ${srv.required_documents.slice(0, 3).map(d => `<li><span class="check-icon">✓</span> ${escapeHtml(d)}</li>`).join("")}
            ${docsCount > 3 ? `<li class="text-muted text-xs">+ ${docsCount - 3} more document${docsCount - 3 === 1 ? "" : "s"}</li>` : ""}
          </ul>
        </div>
      `
      : `<p class="text-xs text-muted service-no-docs">No pre-requisite physical documents required.</p>`;

    return `
      <article class="service-card ${isAvailable ? 'service-available' : 'service-unavailable'}" id="service-${escapeHtml(srv.slug)}">
        <div class="service-card-header">
          <span class="badge badge-category">${escapeHtml(srv.category || "General")}</span>
          <span class="badge ${isAvailable ? 'badge-success' : 'badge-warning'}">
            ${isAvailable ? '● Available' : '○ Unavailable'}
          </span>
        </div>

        <h3 class="service-title">${escapeHtml(srv.name)}</h3>
        <p class="service-desc">${escapeHtml(srv.description || "Official municipal civic service.")}</p>

        ${docsListHtml}

        <div class="service-card-footer">
          ${isAvailable 
            ? `<a href="apply-service.html?service=${encodeURIComponent(srv.slug)}" class="btn btn-primary btn-block" id="btn-apply-${escapeHtml(srv.slug)}">
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
}

function setupFilterHandlers() {
  const searchInput = document.getElementById("service-search-input");
  const categorySelect = document.getElementById("category-filter-select");

  function applyFilters() {
    const query = (searchInput?.value || "").toLowerCase().trim();
    const category = categorySelect?.value || "ALL";

    const filtered = allServices.filter(srv => {
      const matchCat = category === "ALL" || srv.category === category;
      const matchQuery = !query || 
        (srv.name && srv.name.toLowerCase().includes(query)) ||
        (srv.description && srv.description.toLowerCase().includes(query)) ||
        (srv.category && srv.category.toLowerCase().includes(query)) ||
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

async function checkNavAuth() {
  const authContainer = document.getElementById("nav-auth-actions");
  if (!authContainer) return;

  try {
    const res = await apiFetch("/auth/me", { method: "GET" });
    if (res.success && res.data) {
      const user = res.data;
      if (user.role === "citizen") {
        authContainer.innerHTML = `
          <a href="user-dashboard.html" class="btn btn-sm btn-outline">Dashboard</a>
          <button class="btn btn-sm btn-ghost" id="nav-logout-btn">Sign Out</button>
        `;
        document.getElementById("nav-logout-btn")?.addEventListener("click", async () => {
          await apiFetch("/auth/logout", { method: "POST" });
          window.location.reload();
        });
      } else if (user.role === "admin") {
        authContainer.innerHTML = `
          <a href="admin-dashboard.html" class="btn btn-sm btn-outline">Admin Portal</a>
          <button class="btn btn-sm btn-ghost" id="nav-logout-btn">Sign Out</button>
        `;
        document.getElementById("nav-logout-btn")?.addEventListener("click", async () => {
          await apiFetch("/admin/auth/logout", { method: "POST" });
          window.location.reload();
        });
      }
    }
  } catch {
    // User is unauthenticated, default Sign In / Register buttons remain
  }
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
  // Update year
  const yearEl = document.getElementById("footer-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Mobile menu toggle
  const menuToggle = document.getElementById("mobile-menu-toggle");
  const mainNav = document.getElementById("main-nav");
  if (menuToggle && mainNav) {
    menuToggle.addEventListener("click", () => {
      const isExpanded = menuToggle.getAttribute("aria-expanded") === "true";
      menuToggle.setAttribute("aria-expanded", !isExpanded);
      mainNav.classList.toggle("nav-open");
    });
  }

  // Health check pill
  const isHealthy = await checkDbHealth();
  updateDbStatusPill(isHealthy);

  // Setup UI and load services
  await checkNavAuth();
  setupFilterHandlers();
  await loadServices();
});
