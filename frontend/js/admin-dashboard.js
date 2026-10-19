/**
 * Administrative Dashboard Controller (ESM)
 * Loads live MongoDB metrics, renders recent activities, and handles services catalog availability.
 */

import { apiFetch, checkDbHealth, updateDbStatusPill } from "./api.js";

let adminProfile = null;
let servicesCatalog = [];

async function initAdminDashboard() {
  // 1. Verify Administrative Session
  try {
    const authRes = await apiFetch("/admin/auth/me", { method: "GET" });
    if (!authRes.success || !authRes.data || authRes.data.role !== "admin") {
      window.location.href = "admin-login.html";
      return;
    }
    adminProfile = authRes.data;
    const userDisplay = document.getElementById("admin-user-display");
    if (userDisplay) {
      userDisplay.textContent = adminProfile.email || "Administrator";
    }
  } catch (err) {
    console.error("Admin verification error:", err);
    window.location.href = "admin-login.html";
    return;
  }

  // 2. Setup Sign Out
  const logoutBtn = document.getElementById("btn-admin-logout");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      await apiFetch("/admin/auth/logout", { method: "POST" });
      window.location.href = "admin-login.html";
    });
  }

  // 3. Setup Tabs
  setupAdminTabs();

  // 4. Fetch Live Data
  await loadDashboardMetrics();
  await loadServicesCatalog();
}

function setupAdminTabs() {
  const tabs = [
    { btn: "tab-btn-services", panel: "tab-content-services" },
    { btn: "tab-btn-apps", panel: "tab-content-apps" },
    { btn: "tab-btn-cmps", panel: "tab-content-cmps" }
  ];

  tabs.forEach(tab => {
    const btn = document.getElementById(tab.btn);
    if (!btn) return;

    btn.addEventListener("click", () => {
      tabs.forEach(t => {
        document.getElementById(t.btn)?.classList.remove("active");
        document.getElementById(t.panel)?.classList.add("d-none");
      });
      btn.classList.add("active");
      document.getElementById(tab.panel)?.classList.remove("d-none");
    });
  });
}

async function loadDashboardMetrics() {
  try {
    const res = await apiFetch("/admin/dashboard", { method: "GET" });
    if (!res.success) {
      showAdminAlert(res.error?.message || "Failed to retrieve administrative metrics.", "danger");
      return;
    }

    const { metrics, recent_applications, recent_complaints } = res.data;

    // 1. Applications Metrics
    setText("stat-total-apps", metrics.applications?.total ?? 0);
    setText("stat-submitted-apps", metrics.applications?.Submitted ?? 0);
    setText("stat-review-apps", metrics.applications?.["Under Review"] ?? 0);
    setText("stat-approved-apps", metrics.applications?.Approved ?? 0);

    // 2. Complaints Metrics
    const totalCmps = metrics.complaints?.total ?? 0;
    const openCmps = (metrics.complaints?.Submitted ?? 0) + (metrics.complaints?.["Under Review"] ?? 0);
    setText("stat-total-cmps", totalCmps);
    setText("stat-open-cmps", openCmps);

    // 3. System Metrics
    setText("stat-citizens-count", metrics.citizens_count ?? 0);
    setText("stat-services-count", metrics.services_count ?? 0);

    // 4. Render Recent Applications Table
    renderRecentApplications(recent_applications || []);

    // 5. Render Recent Complaints Table
    renderRecentComplaints(recent_complaints || []);

  } catch (err) {
    console.error("Metrics load error:", err);
    showAdminAlert("Could not load administrative metrics from database.", "danger");
  }
}

function renderRecentApplications(apps) {
  const tbody = document.getElementById("recent-apps-tbody");
  if (!tbody) return;

  if (apps.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-6 text-muted">
          No applications have been submitted yet (0 records in database).
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = apps.map(app => {
    const dateFormatted = app.created_at ? new Date(app.created_at).toLocaleDateString() : "N/A";
    const badgeClass = getStatusBadgeClass(app.status);

    return `
      <tr>
        <td><strong class="font-mono">${escapeHtml(app.application_id)}</strong></td>
        <td>${escapeHtml(app.service_name)}</td>
        <td>${escapeHtml(app.citizen_name)}</td>
        <td><span class="status-badge ${badgeClass}">${escapeHtml(app.status)}</span></td>
        <td>${dateFormatted}</td>
        <td>
          <a href="track-status.html?id=${encodeURIComponent(app.application_id)}" class="btn btn-xs btn-outline" target="_blank">
            Track
          </a>
        </td>
      </tr>
    `;
  }).join("");
}

function renderRecentComplaints(cmps) {
  const tbody = document.getElementById("recent-cmps-tbody");
  if (!tbody) return;

  if (cmps.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center py-6 text-muted">
          No grievances have been registered yet (0 records in database).
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = cmps.map(cmp => {
    const dateFormatted = cmp.created_at ? new Date(cmp.created_at).toLocaleDateString() : "N/A";
    const badgeClass = getStatusBadgeClass(cmp.status);

    return `
      <tr>
        <td><strong class="font-mono">${escapeHtml(cmp.complaint_id)}</strong></td>
        <td><span class="badge badge-info">${escapeHtml(cmp.department)}</span></td>
        <td>${escapeHtml(cmp.title)}</td>
        <td>${escapeHtml(cmp.citizen_name)}</td>
        <td class="text-xs text-muted">${escapeHtml(cmp.location)}</td>
        <td><span class="status-badge ${badgeClass}">${escapeHtml(cmp.status)}</span></td>
        <td>${dateFormatted}</td>
      </tr>
    `;
  }).join("");
}

async function loadServicesCatalog() {
  const tbody = document.getElementById("services-tbody");
  if (!tbody) return;

  try {
    const res = await apiFetch("/admin/services", { method: "GET" });
    if (!res.success) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">Failed to load services.</td></tr>`;
      return;
    }

    servicesCatalog = res.data || [];
    const activeCount = servicesCatalog.filter(s => s.availability === "Active").length;
    setText("stat-active-services-count", activeCount);

    if (servicesCatalog.length === 0) {
      tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted py-6">No services in database. Run init_services.py to populate.</td></tr>`;
      return;
    }

    tbody.innerHTML = servicesCatalog.map(srv => {
      const isActive = srv.availability === "Active";
      return `
        <tr id="service-row-${escapeHtml(srv.slug)}">
          <td>
            <strong>${escapeHtml(srv.name)}</strong>
            <p class="text-xs text-muted mt-1">${escapeHtml(srv.description)}</p>
          </td>
          <td><span class="badge badge-category">${escapeHtml(srv.category)}</span></td>
          <td class="text-center font-bold">${srv.applications_count}</td>
          <td>
            <span class="badge ${isActive ? 'badge-success' : 'badge-warning'}" id="status-pill-${escapeHtml(srv.slug)}">
              ${isActive ? '● Active' : '○ Unavailable'}
            </span>
          </td>
          <td>
            <button 
              class="btn btn-sm ${isActive ? 'btn-outline' : 'btn-primary'} btn-toggle-availability" 
              data-slug="${escapeHtml(srv.slug)}"
              data-target="${isActive ? 'Unavailable' : 'Active'}"
            >
              ${isActive ? 'Make Unavailable' : 'Activate Service'}
            </button>
          </td>
        </tr>
      `;
    }).join("");

    // Attach Toggle Listeners
    tbody.querySelectorAll(".btn-toggle-availability").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const slug = e.currentTarget.getAttribute("data-slug");
        const target = e.currentTarget.getAttribute("data-target");
        await toggleServiceAvailability(slug, target);
      });
    });

  } catch (err) {
    console.error("Services catalog error:", err);
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger py-4">Database error while retrieving services.</td></tr>`;
  }
}

async function toggleServiceAvailability(slug, newAvailability) {
  try {
    const res = await apiFetch(`/admin/services/${encodeURIComponent(slug)}/availability`, {
      method: "PATCH",
      body: { availability: newAvailability }
    });

    if (!res.success) {
      showAdminAlert(res.error?.message || "Failed to update service availability.", "danger");
      return;
    }

    showAdminAlert(`Service '${res.data.name}' availability updated to ${res.data.availability}.`, "success");
    await loadServicesCatalog();
    await loadDashboardMetrics();

  } catch (err) {
    console.error("Availability toggle error:", err);
    showAdminAlert("Connection failed while updating service status.", "danger");
  }
}

function getStatusBadgeClass(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("approved") || s.includes("completed") || s.includes("resolved")) return "badge-success";
  if (s.includes("reject")) return "badge-danger";
  if (s.includes("review") || s.includes("action") || s.includes("progress")) return "badge-warning";
  return "badge-info";
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showAdminAlert(msg, type = "danger") {
  const alertBox = document.getElementById("admin-alert");
  if (!alertBox) return;

  alertBox.className = `alert alert-${type} mb-4`;
  alertBox.textContent = msg;
  alertBox.classList.remove("d-none");
  alertBox.scrollIntoView({ behavior: "smooth", block: "center" });
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

  await initAdminDashboard();
});
