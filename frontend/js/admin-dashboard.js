/**
 * Municipal Operations Dashboard Controller (ESM)
 * Live database metrics, KPI drill-downs, Chart.js visualizations, SLA tracking, and workflow reviews.
 */

import { apiFetch, checkDbHealth, logoutUser } from "./api.js";

let adminProfile = null;
let currentRange = "30d";
let chartTimeline = null;
let chartStatus = null;
let chartService = null;
let chartCategory = null;

// Initialize on DOM Ready
document.addEventListener("DOMContentLoaded", initAdminDashboard);

async function initAdminDashboard() {
  // 1. Verify Administrative Session
  const isAuthenticated = await verifyAdminSession();
  if (!isAuthenticated) return;

  // 2. Setup Navigation & Shell Controls
  setupSidebarControls();
  setupDateFilters();
  setupKpiDrilldowns();
  setupGlobalSearch();
  setupExportDropdown();
  setupSignOut();
  setupModals();

  // 3. Check Live Database Health
  checkDatabaseStatus();

  // 4. Load Live Data
  await loadDashboardData();
}

/**
 * Validates authenticated administrator session via API.
 */
async function verifyAdminSession() {
  try {
    const res = await apiFetch("/admin/auth/me", { method: "GET" });
    if (!res.success || !res.data) {
      window.location.href = "admin-login.html";
      return false;
    }

    adminProfile = res.data;
    const nameDisplay = document.getElementById("admin-user-display");
    const roleDisplay = document.getElementById("admin-role-display");
    const initialsDisplay = document.getElementById("admin-avatar-initials");

    if (nameDisplay) {
      nameDisplay.textContent = adminProfile.full_name || adminProfile.email || "Administrator";
    }
    if (roleDisplay) {
      const roleName = adminProfile.admin_role || adminProfile.role || "Admin";
      roleDisplay.textContent = formatRole(roleName);
    }
    if (initialsDisplay) {
      const name = adminProfile.full_name || adminProfile.email || "AD";
      initialsDisplay.textContent = name.substring(0, 2).toUpperCase();
    }

    return true;
  } catch (err) {
    console.error("Admin verification error:", err);
    window.location.href = "admin-login.html";
    return false;
  }
}

function formatRole(role) {
  if (role === "super_admin") return "Super Admin";
  if (role === "officer") return "Municipal Officer";
  if (role === "viewer") return "Auditor (Read-Only)";
  return "Portal Admin";
}

/**
 * Handles sidebar toggling for mobile viewports.
 */
function setupSidebarControls() {
  const toggleBtn = document.getElementById("sidebar-toggle-btn");
  const sidebar = document.getElementById("admin-sidebar");

  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener("click", () => {
      sidebar.classList.toggle("open");
    });

    document.addEventListener("click", (e) => {
      if (window.innerWidth <= 900 && sidebar.classList.contains("open")) {
        if (!sidebar.contains(e.target) && !toggleBtn.contains(e.target)) {
          sidebar.classList.remove("open");
        }
      }
    });
  }
}

/**
 * Date range filter buttons (Today, 7D, 30D, All Time).
 */
function setupDateFilters() {
  const btns = document.querySelectorAll(".date-filter-btn");
  btns.forEach((btn) => {
    btn.addEventListener("click", async () => {
      btns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      currentRange = btn.getAttribute("data-range") || "30d";
      await loadDashboardData();
    });
  });
}

/**
 * KPI Drill-Down: Makes every KPI card clickable & keyboard-accessible,
 * carrying over filters and current date range to target views.
 */
function setupKpiDrilldowns() {
  const cards = document.querySelectorAll(".clickable-kpi");
  cards.forEach((card) => {
    // Ensure keyboard accessibility
    if (!card.hasAttribute("role")) card.setAttribute("role", "button");
    if (!card.hasAttribute("tabindex")) card.setAttribute("tabindex", "0");

    const navigate = () => {
      const action = card.getAttribute("data-action");
      const status = card.getAttribute("data-status");

      if (action === "apps") {
        if (status) {
          window.location.href = `admin-applications.html?status=${encodeURIComponent(status)}&range=${encodeURIComponent(currentRange)}`;
        } else {
          window.location.href = `admin-applications.html?range=${encodeURIComponent(currentRange)}`;
        }
      } else if (action === "cmps") {
        if (status) {
          window.location.href = `admin-complaints.html?status=${encodeURIComponent(status)}&range=${encodeURIComponent(currentRange)}`;
        } else {
          window.location.href = `admin-complaints.html?range=${encodeURIComponent(currentRange)}`;
        }
      } else if (action === "citizens") {
        window.location.href = "citizens.html";
      } else if (action === "services") {
        const avail = status || "Available";
        window.location.href = `service-management.html?availability=${encodeURIComponent(avail)}`;
      } else if (action === "processing") {
        window.location.href = `reports.html?range=${encodeURIComponent(currentRange)}&view=processing_time`;
      } else if (action === "overdue") {
        window.location.href = `admin-applications.html?overdue=true&range=${encodeURIComponent(currentRange)}`;
      }
    };

    card.addEventListener("click", navigate);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        navigate();
      }
    });
  });

  const unavailBtn = document.getElementById("btn-view-unavailable-services");
  if (unavailBtn) {
    unavailBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.location.href = "service-management.html?availability=Unavailable";
    });
  }
}

/**
 * Functional Export Reports Dropdown (CSV, Excel, PDF).
 */
function setupExportDropdown() {
  const btn = document.getElementById("btn-export-dropdown");
  const menu = document.getElementById("export-dropdown-menu");
  const wrapper = document.getElementById("export-dropdown-wrapper");

  if (!btn || !menu) return;

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const isExpanded = btn.getAttribute("aria-expanded") === "true";
    btn.setAttribute("aria-expanded", String(!isExpanded));
    menu.classList.toggle("d-none");
  });

  document.addEventListener("click", (e) => {
    if (wrapper && !wrapper.contains(e.target)) {
      menu.classList.add("d-none");
      btn.setAttribute("aria-expanded", "false");
    }
  });

  menu.querySelectorAll(".dropdown-item-custom").forEach((item) => {
    item.addEventListener("click", () => {
      const format = item.getAttribute("data-format") || "csv";
      menu.classList.add("d-none");
      btn.setAttribute("aria-expanded", "false");
      window.open(
        `/api/admin/reports/export?type=applications&format=${encodeURIComponent(format)}&range=${encodeURIComponent(currentRange)}`,
        "_blank"
      );
    });
  });
}

/**
 * Global search routing with debouncing and categorized live dropdown.
 */
function setupGlobalSearch() {
  const searchInput = document.getElementById("global-search-input");
  const resultsContainer = document.getElementById("global-search-results");
  if (!searchInput || !resultsContainer) return;

  let debounceTimer = null;

  searchInput.addEventListener("input", () => {
    clearTimeout(debounceTimer);
    const q = searchInput.value.trim();

    if (q.length < 2) {
      resultsContainer.classList.add("d-none");
      resultsContainer.innerHTML = "";
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const res = await apiFetch(`/admin/search?q=${encodeURIComponent(q)}`, { method: "GET" });
        if (!res.success || !res.data) {
          resultsContainer.innerHTML = `<div class="search-empty-state">No search results available.</div>`;
          resultsContainer.classList.remove("d-none");
          return;
        }

        renderSearchResults(res.data, resultsContainer);
      } catch (err) {
        console.error("Global search error:", err);
        resultsContainer.innerHTML = `<div class="search-empty-state text-danger">Search error. Please retry.</div>`;
        resultsContainer.classList.remove("d-none");
      }
    }, 300);
  });

  // Close search dropdown on Escape or outside click
  document.addEventListener("click", (e) => {
    if (!searchInput.contains(e.target) && !resultsContainer.contains(e.target)) {
      resultsContainer.classList.add("d-none");
    }
  });

  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      resultsContainer.classList.add("d-none");
    } else if (e.key === "Enter") {
      const q = searchInput.value.trim();
      if (!q) return;
      resultsContainer.classList.add("d-none");
      if (q.toUpperCase().startsWith("MSP-APP")) {
        window.location.href = `admin-applications.html?q=${encodeURIComponent(q)}`;
      } else if (q.toUpperCase().startsWith("MSP-CMP")) {
        window.location.href = `admin-complaints.html?q=${encodeURIComponent(q)}`;
      } else {
        window.location.href = `admin-applications.html?q=${encodeURIComponent(q)}`;
      }
    }
  });
}

function renderSearchResults(data, container) {
  const apps = data.applications || [];
  const cmps = data.complaints || [];
  const citizens = data.citizens || [];
  const services = data.services || [];

  const totalResults = apps.length + cmps.length + citizens.length + services.length;

  if (totalResults === 0) {
    container.innerHTML = `<div class="search-empty-state">No records found matching your search.</div>`;
    container.classList.remove("d-none");
    return;
  }

  let html = "";

  if (apps.length > 0) {
    html += `<div class="search-result-group"><div class="search-group-title">📑 Applications (${apps.length})</div>`;
    apps.forEach((a) => {
      html += `
        <a href="admin-applications.html?q=${encodeURIComponent(a.application_id)}" class="search-result-item">
          <div>
            <strong>${escapeHtml(a.application_id)}</strong> - ${escapeHtml(a.service_name || "Application")}
            <div class="text-xs text-muted">${escapeHtml(a.citizen_name || "")} (${escapeHtml(a.citizen_email || "")})</div>
          </div>
          <span class="badge ${a.status === "Approved" ? "badge-success" : a.status === "Rejected" ? "badge-danger" : "badge-info"}">${escapeHtml(a.status || "Submitted")}</span>
        </a>
      `;
    });
    html += `</div>`;
  }

  if (cmps.length > 0) {
    html += `<div class="search-result-group"><div class="search-group-title">🛠️ Grievances (${cmps.length})</div>`;
    cmps.forEach((c) => {
      html += `
        <a href="admin-complaints.html?q=${encodeURIComponent(c.complaint_id)}" class="search-result-item">
          <div>
            <strong>${escapeHtml(c.complaint_id)}</strong> - ${escapeHtml(c.title || "Grievance")}
            <div class="text-xs text-muted">${escapeHtml(c.department || "Municipal")} • ${escapeHtml(c.citizen_name || "")}</div>
          </div>
          <span class="badge ${c.status === "Resolved" ? "badge-success" : "badge-warning"}">${escapeHtml(c.status || "Submitted")}</span>
        </a>
      `;
    });
    html += `</div>`;
  }

  if (citizens.length > 0) {
    html += `<div class="search-result-group"><div class="search-group-title">👥 Citizens (${citizens.length})</div>`;
    citizens.forEach((c) => {
      html += `
        <a href="citizens.html?q=${encodeURIComponent(c.email)}" class="search-result-item">
          <div>
            <strong>${escapeHtml(c.name || "Citizen")}</strong>
            <div class="text-xs text-muted">${escapeHtml(c.email)} • ${escapeHtml(c.phone || "No phone")}</div>
          </div>
          <span class="badge ${c.is_active === false ? "badge-danger" : "badge-success"}">${c.is_active === false ? "Suspended" : "Active"}</span>
        </a>
      `;
    });
    html += `</div>`;
  }

  if (services.length > 0) {
    html += `<div class="search-result-group"><div class="search-group-title">🏛️ Services Catalog (${services.length})</div>`;
    services.forEach((s) => {
      const isAvail = s.availability === "Available" || s.availability === "Active";
      html += `
        <a href="service-management.html?q=${encodeURIComponent(s.name)}" class="search-result-item">
          <div>
            <strong>${escapeHtml(s.name)}</strong>
            <div class="text-xs text-muted">${escapeHtml(s.category || "")} • ${escapeHtml(s.department || "")}</div>
          </div>
          <span class="badge ${isAvail ? "badge-success" : "badge-neutral"}">${isAvail ? "Available" : "Unavailable"}</span>
        </a>
      `;
    });
    html += `</div>`;
  }

  container.innerHTML = html;
  container.classList.remove("d-none");
}

/**
 * Administrative Sign Out handler with history/bfcache protection.
 */
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

  // Prevent browser back button from showing cached administrative view after sign out
  window.addEventListener("pageshow", (event) => {
    if (event.persisted && !localStorage.getItem("msp_token") && !localStorage.getItem("msp_admin_token")) {
      window.location.replace("admin-login.html");
    }
  });
}

/**
 * Checks database health and updates top indicator with 30-second polling.
 */
async function checkDatabaseStatus() {
  const dot = document.getElementById("db-status-dot");
  const text = document.getElementById("db-status-text");

  const poll = async () => {
    try {
      const res = await apiFetch("/health", { method: "GET" });
      const isHealthy = Boolean(res.success && res.data && res.data.database === "connected");
      if (isHealthy) {
        if (dot) dot.className = "status-dot online";
        if (text) text.textContent = res.data.latency_ms ? `Live Database (${res.data.latency_ms}ms)` : "Live Database";
      } else {
        if (dot) dot.className = "status-dot offline";
        if (text) text.textContent = "Database Unavailable";
      }
    } catch (err) {
      if (dot) dot.className = "status-dot offline";
      if (text) text.textContent = "Connection Error";
    }
  };

  poll();
  setInterval(poll, 30000);
}

/**
 * Primary data fetcher: queries /api/admin/dashboard and populates widgets.
 */
async function loadDashboardData() {
  try {
    const res = await apiFetch(`/admin/dashboard?range=${encodeURIComponent(currentRange)}`, { method: "GET" });
    if (!res.success || !res.data) {
      showDashboardAlert(res.error?.message || "Failed to load dashboard metrics.", "danger");
      return;
    }

    const { metrics, charts, needs_attention, recent_applications, recent_complaints } = res.data;

    // 1. Populate Metric Numbers
    populateKpiCounters(metrics);

    // 2. Render Charts
    renderCharts(charts);

    // 3. Render Needs Attention Panel
    renderNeedsAttention(needs_attention);

    // 4. Render Recent Tables
    renderRecentApplications(recent_applications || []);
    renderRecentComplaints(recent_complaints || []);
  } catch (err) {
    console.error("Dashboard data load error:", err);
    showDashboardAlert("Network error while connecting to administrative backend.", "danger");
  }
}

/**
 * Populates all KPI counters and trend indicators with data reconciliation.
 */
function populateKpiCounters(metrics) {
  const apps = metrics.applications || {};
  const cmps = metrics.complaints || {};

  // Applications
  const pendingCount = apps.Pending !== undefined ? apps.Pending : (apps.Submitted ?? 0);
  setText("stat-total-apps", apps.total ?? 0);
  setText("stat-submitted-apps", pendingCount);
  setText("stat-review-apps", apps["Under Review"] ?? 0);
  setText("stat-approved-apps", apps.Approved ?? 0);
  setText("stat-rejected-apps", apps.Rejected ?? 0);

  // Complaints
  setText("stat-total-cmps", cmps.total ?? 0);
  setText("stat-open-cmps", metrics.total_open_complaints ?? 0);
  setText("stat-resolved-cmps", cmps.Resolved ?? 0);

  // Citizens & Services (All-time totals)
  setText("stat-citizens-count", metrics.citizens_count ?? 0);
  setText("stat-services-count", metrics.services_active_count ?? 0);
  setText("stat-inactive-services", metrics.services_inactive_count ?? 0);

  // SLA & Performance
  setText("stat-avg-time", `${metrics.avg_processing_time_days ?? 0} d`);
  setText("stat-sla-breaches", metrics.sla_breach_count ?? 0);

  // Dynamic Trend & Range Labels
  const vsLabel = metrics.vs_label || "vs previous period";
  setText("trend-label-apps", vsLabel);
  setText("trend-label-cmps", vsLabel);

  if (currentRange === "all") {
    // Hide trend badges when viewing all-time
    hideTrend("trend-apps");
    hideTrend("trend-cmps");
    hideTrend("trend-citizens");
  } else {
    showTrend("trend-apps");
    showTrend("trend-cmps");
    showTrend("trend-citizens");

    if (metrics.trends) {
      setTrend("trend-apps", metrics.trends.applications);
      setTrend("trend-cmps", metrics.trends.complaints);
      setTrend("trend-citizens", metrics.trends.citizens);
    }
  }

  // Sidebar badge counts for items needing immediate action
  setText("badge-pending-apps", pendingCount);
  setText("badge-open-cmps", metrics.total_open_complaints ?? 0);
}

function setTrend(id, trendVal) {
  const el = document.getElementById(id);
  if (!el) return;

  if (!trendVal || trendVal === "None" || trendVal === "-") {
    el.textContent = "-";
    el.className = "trend-badge neutral";
    return;
  }

  el.textContent = trendVal;
  if (trendVal === "New" || (trendVal.startsWith("+") && trendVal !== "+0%")) {
    el.className = "trend-badge positive";
  } else if (trendVal.startsWith("-") && trendVal !== "-0%") {
    el.className = "trend-badge negative";
  } else {
    el.className = "trend-badge neutral";
  }
}

function hideTrend(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add("d-none");
}

function showTrend(id) {
  const el = document.getElementById(id);
  if (el) el.classList.remove("d-none");
}

/**
 * Initializes or updates Chart.js instances.
 */
function renderCharts(charts) {
  if (typeof Chart === "undefined") {
    console.warn("Chart.js library unavailable.");
    return;
  }

  // Common colors
  const primaryRed = "#dc2626";
  const softRed = "rgba(220, 38, 38, 0.1)";

  // 1. Applications Timeline (Line Chart)
  const timelineCanvas = document.getElementById("chart-applications-timeline");
  if (timelineCanvas) {
    if (chartTimeline) chartTimeline.destroy();

    const timelineData = charts?.applications_timeline || [];
    const labels = timelineData.map((d) => d.date);
    const dataVals = timelineData.map((d) => d.count);

    chartTimeline = new Chart(timelineCanvas, {
      type: "line",
      data: {
        labels: labels.length ? labels : ["No data in period"],
        datasets: [
          {
            label: "Submissions",
            data: dataVals.length ? dataVals : [0],
            borderColor: primaryRed,
            backgroundColor: softRed,
            borderWidth: 2.5,
            fill: true,
            tension: 0.35,
            pointBackgroundColor: primaryRed,
            pointRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { precision: 0, font: { family: "Inter", size: 11 } }
          },
          x: {
            grid: { display: false },
            ticks: { font: { family: "Inter", size: 11 } }
          }
        }
      }
    });
  }

  // 2. Applications Status Breakdown (Doughnut)
  const statusCanvas = document.getElementById("chart-status-breakdown");
  if (statusCanvas) {
    if (chartStatus) chartStatus.destroy();

    const statusData = charts?.applications_by_status || [];
    const labels = statusData.map((d) => d.status);
    const counts = statusData.map((d) => d.count);

    const statusColors = {
      Approved: "#059669",
      Submitted: "#dc2626",
      "Under Review": "#d97706",
      Rejected: "#64748b",
      "Action Required": "#f59e0b"
    };

    chartStatus = new Chart(statusCanvas, {
      type: "doughnut",
      data: {
        labels: labels.length ? labels : ["No Records"],
        datasets: [
          {
            data: counts.length ? counts : [1],
            backgroundColor: counts.length
              ? labels.map((l) => statusColors[l] || "#94a3b8")
              : ["#e2e8f0"],
            borderWidth: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: "bottom",
            labels: { font: { family: "Inter", size: 11 } }
          }
        },
        cutout: "70%"
      }
    });
  }

  // 3. Applications By Service (Bar Chart)
  const serviceCanvas = document.getElementById("chart-services-breakdown");
  if (serviceCanvas) {
    if (chartService) chartService.destroy();

    const serviceData = charts?.applications_by_service || [];
    const labels = serviceData.map((d) => d.service_name || d.service_slug);
    const counts = serviceData.map((d) => d.count);

    chartService = new Chart(serviceCanvas, {
      type: "bar",
      data: {
        labels: labels.length ? labels : ["No Records"],
        datasets: [
          {
            label: "Applications",
            data: counts.length ? counts : [0],
            backgroundColor: primaryRed,
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: "y",
        plugins: { legend: { display: false } },
        scales: {
          x: {
            beginAtZero: true,
            ticks: { precision: 0, font: { family: "Inter", size: 11 } }
          },
          y: {
            grid: { display: false },
            ticks: { font: { family: "Inter", size: 11 } }
          }
        }
      }
    });
  }

  // 4. Grievance Department Distribution (Bar Chart)
  const categoryCanvas = document.getElementById("chart-categories-breakdown");
  if (categoryCanvas) {
    if (chartCategory) chartCategory.destroy();

    const catData = charts?.complaints_by_department || [];
    const labels = catData.map((d) => d.department);
    const counts = catData.map((d) => d.count);

    chartCategory = new Chart(categoryCanvas, {
      type: "bar",
      data: {
        labels: labels.length ? labels : ["No Records"],
        datasets: [
          {
            label: "Grievances",
            data: counts.length ? counts : [0],
            backgroundColor: "#d97706",
            borderRadius: 4
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { precision: 0, font: { family: "Inter", size: 11 } }
          },
          x: {
            grid: { display: false },
            ticks: { font: { family: "Inter", size: 11 } }
          }
        }
      }
    });
  }
}

/**
 * Renders the Needs Immediate Attention items (overdue apps and unassigned cmps).
 */
function renderNeedsAttention(panelData) {
  const countEl = document.getElementById("attention-count");
  const appsList = document.getElementById("attention-apps-list");
  const cmpsList = document.getElementById("attention-cmps-list");

  const staleApps = panelData?.stale_applications || [];
  const unassignedCmps = panelData?.unassigned_complaints || [];
  const totalAttention = staleApps.length + unassignedCmps.length;

  if (countEl) countEl.textContent = totalAttention;

  // Stale Applications
  if (appsList) {
    if (staleApps.length === 0) {
      appsList.innerHTML = `<div class="text-muted text-sm py-2">No stale applications found. All requests up to date.</div>`;
    } else {
      appsList.innerHTML = staleApps
        .map(
          (app) => `
        <div class="attention-item">
          <div>
            <div class="font-bold text-neutral-900">${escapeHtml(app.application_id)}</div>
            <div class="text-xs text-muted">${escapeHtml(app.service_name)} • Filed ${app.days_pending} days ago</div>
          </div>
          <button class="btn btn-xs btn-outline" onclick="window.viewApplicationDetail('${escapeHtml(app.application_id)}')">Review</button>
        </div>
      `
        )
        .join("");
    }
  }

  // Unassigned Grievances
  if (cmpsList) {
    if (unassignedCmps.length === 0) {
      cmpsList.innerHTML = `<div class="text-muted text-sm py-2">No unassigned grievances found.</div>`;
    } else {
      cmpsList.innerHTML = unassignedCmps
        .map(
          (cmp) => `
        <div class="attention-item">
          <div>
            <div class="font-bold text-neutral-900">${escapeHtml(cmp.complaint_id)}</div>
            <div class="text-xs text-muted">${escapeHtml(cmp.title)} • ${escapeHtml(cmp.department)}</div>
          </div>
          <a href="admin-complaints.html?q=${escapeHtml(cmp.complaint_id)}" class="btn btn-xs btn-outline">Route</a>
        </div>
      `
        )
        .join("");
    }
  }
}

/**
 * Renders recent application submissions table.
 */
function renderRecentApplications(apps) {
  const tbody = document.getElementById("tbody-recent-apps");
  if (!tbody) return;

  if (apps.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">No recent applications submitted in this timeframe.</td></tr>`;
    return;
  }

  tbody.innerHTML = apps
    .map((app) => {
      const dateFormatted = app.created_at ? new Date(app.created_at).toLocaleDateString() : "—";
      const statusBadge = getStatusBadge(app.status);

      return `
      <tr>
        <td><strong class="font-mono text-neutral-900">${escapeHtml(app.application_id)}</strong></td>
        <td>
          <div class="font-bold">${escapeHtml(app.service_name)}</div>
          <div class="text-xs text-muted">${escapeHtml(app.category || "General")}</div>
        </td>
        <td>
          <div>${escapeHtml(app.citizen_name || "Citizen")}</div>
          <div class="text-xs text-muted">${escapeHtml(app.citizen_email || "")}</div>
        </td>
        <td>${dateFormatted}</td>
        <td>${statusBadge}</td>
        <td class="text-right">
          <button class="btn btn-xs btn-outline" onclick="window.viewApplicationDetail('${escapeHtml(app.application_id)}')">Review</button>
        </td>
      </tr>
    `;
    })
    .join("");
}

/**
 * Renders recent grievances table.
 */
function renderRecentComplaints(complaints) {
  const tbody = document.getElementById("tbody-recent-cmps");
  if (!tbody) return;

  if (complaints.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-muted">No recent grievances filed in this timeframe.</td></tr>`;
    return;
  }

  tbody.innerHTML = complaints
    .map((cmp) => {
      const dateFormatted = cmp.created_at ? new Date(cmp.created_at).toLocaleDateString() : "—";
      const statusBadge = getComplaintStatusBadge(cmp.status);

      return `
      <tr>
        <td><strong class="font-mono text-neutral-900">${escapeHtml(cmp.complaint_id)}</strong></td>
        <td>
          <div class="font-bold">${escapeHtml(cmp.title)}</div>
          <div class="text-xs text-muted">${escapeHtml(cmp.department)}</div>
        </td>
        <td>
          <div>${escapeHtml(cmp.citizen_name || "Citizen")}</div>
          <div class="text-xs text-muted">${escapeHtml(cmp.citizen_email || "")}</div>
        </td>
        <td>${dateFormatted}</td>
        <td>${statusBadge}</td>
        <td class="text-right">
          <a href="admin-complaints.html?q=${escapeHtml(cmp.complaint_id)}" class="btn btn-xs btn-outline">Inspect</a>
        </td>
      </tr>
    `;
    })
    .join("");
}

function getStatusBadge(status) {
  if (status === "Approved") return `<span class="badge badge-success">Approved</span>`;
  if (status === "Under Review") return `<span class="badge badge-warning">Under Review</span>`;
  if (status === "Action Required") return `<span class="badge badge-warning">Action Req.</span>`;
  if (status === "Rejected") return `<span class="badge badge-danger">Rejected</span>`;
  return `<span class="badge badge-info">Submitted</span>`;
}

function getComplaintStatusBadge(status) {
  if (status === "Resolved") return `<span class="badge badge-success">Resolved</span>`;
  if (status === "In Progress") return `<span class="badge badge-warning">In Progress</span>`;
  if (status === "Assigned") return `<span class="badge badge-info">Assigned</span>`;
  return `<span class="badge badge-danger">Submitted</span>`;
}

/**
 * Application Detail Modal logic
 */
function setupModals() {
  const modal = document.getElementById("app-review-modal");
  const closeBtn = document.getElementById("modal-app-close");

  const hideModal = () => {
    if (modal) modal.classList.add("d-none");
  };

  if (closeBtn) closeBtn.addEventListener("click", hideModal);
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) hideModal();
    });
  }

  window.viewApplicationDetail = async (applicationId) => {
    if (!modal) return;
    modal.classList.remove("d-none");
    const body = document.getElementById("modal-app-body");
    const title = document.getElementById("modal-app-title");
    if (title) title.textContent = `Application Review: ${applicationId}`;
    if (body) body.innerHTML = `<div class="p-6 text-center text-muted">Retrieving application details from database...</div>`;

    try {
      const res = await apiFetch(`/admin/applications/${applicationId}`, { method: "GET" });
      if (!res.success || !res.data) {
        body.innerHTML = `<div class="alert alert-danger">Error retrieving application: ${escapeHtml(res.error?.message || "Record not found")}</div>`;
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

      body.innerHTML = `
        <div class="mb-4 pb-3 border-bottom">
          <div class="d-flex justify-content-between align-items-center">
            <div>
              <h3 class="text-base font-bold text-neutral-900 m-0">${escapeHtml(d.service_name)}</h3>
              <span class="text-xs text-muted">${escapeHtml(d.category)} • Applicant: <strong>${escapeHtml(d.citizen_name)}</strong> (${escapeHtml(d.citizen_email)})</span>
            </div>
            <div>${getStatusBadge(d.status)}</div>
          </div>
        </div>

        <div class="mb-4">
          <h4 class="text-xs font-bold uppercase text-neutral-500 mb-2">Submitted Form Particulars</h4>
          <div class="bg-neutral-50 p-3 rounded border text-sm" style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
            ${formDataHtml || '<span class="text-muted">No custom form fields</span>'}
          </div>
        </div>

        <div class="mb-4">
          <h4 class="text-xs font-bold uppercase text-neutral-500 mb-1">Attached Verification Documents</h4>
          ${docsHtml}
        </div>

        <div class="mb-4">
          <h4 class="text-xs font-bold uppercase text-neutral-500 mb-2">Administrative Decision</h4>
          <div class="d-flex gap-3 mb-3">
            <select id="modal-status-select" class="form-select" style="max-width: 220px;">
              <option value="Approved" ${d.status === "Approved" ? "selected" : ""}>Approve Application</option>
              <option value="Under Review" ${d.status === "Under Review" ? "selected" : ""}>Mark Under Review</option>
              <option value="Action Required" ${d.status === "Action Required" ? "selected" : ""}>Request More Info</option>
              <option value="Rejected" ${d.status === "Rejected" ? "selected" : ""}>Reject Application</option>
            </select>
          </div>
          <div>
            <textarea id="modal-status-remarks" class="form-control" rows="2" placeholder="Mandatory officer decision remarks or rejection justification..."></textarea>
          </div>
        </div>
      `;

      const footer = document.getElementById("modal-app-footer");
      footer.innerHTML = `
        <button class="btn btn-sm btn-outline" id="btn-cancel-modal">Cancel</button>
        <button class="btn btn-sm btn-primary" id="btn-save-status">Save Status Decision</button>
      `;

      document.getElementById("btn-cancel-modal")?.addEventListener("click", hideModal);
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
            alert(updateRes.error?.message || "Failed to update application status.");
            return;
          }

          hideModal();
          await loadDashboardData();
        } catch (err) {
          alert("Network error updating application status.");
        }
      });
    } catch (err) {
      body.innerHTML = `<div class="alert alert-danger">Error retrieving application detail.</div>`;
    }
  };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showDashboardAlert(message, type = "danger") {
  const alert = document.getElementById("admin-alert");
  if (!alert) return;
  alert.className = `alert alert-${type} mb-6`;
  alert.textContent = message;
  alert.classList.remove("d-none");
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
