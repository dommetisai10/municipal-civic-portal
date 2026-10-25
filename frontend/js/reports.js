/**
 * Municipal Reports & Civic Analytics Module (ESM)
 * Fetches live database aggregations, renders Chart.js visualizations, and handles CSV exports.
 */

import { apiRequest, showToast, getAuthUser, logoutUser, escapeHtml } from './api.js';

let chartServices = null;
let chartStatus = null;
let chartCmpsDept = null;
let chartCmpsStatus = null;
let currentDateRange = '30d';

document.addEventListener('DOMContentLoaded', async () => {
  await verifyAdminSession();
  initSidebar();
  initUrlParams();
  initEventListeners();
  await loadReports();
});

function initUrlParams() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('range')) {
    currentDateRange = urlParams.get('range');
    const dateBtns = document.querySelectorAll('.date-filter-btn');
    dateBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.range === currentDateRange);
    });
  }
  const viewParam = urlParams.get('view');
  if (viewParam) {
    setTimeout(() => {
      const target = document.getElementById('kpi-resolution-rate') || document.getElementById('chart-report-cmps-status');
      if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 400);
  }
}

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
    window.location.href = 'admin-login.html?redirect=reports.html';
    return;
  }
  const display = document.getElementById('admin-user-display');
  const roleDisplay = document.getElementById('admin-role-display');
  const avatar = document.getElementById('admin-avatar-initials');

  const displayName = user.full_name || user.name || user.email?.split('@')[0] || 'Admin';
  if (display) display.textContent = displayName;
  if (roleDisplay) roleDisplay.textContent = (user.admin_role || user.role || 'Admin').toUpperCase().replace('_', ' ');
  if (avatar) avatar.textContent = displayName.substring(0, 2).toUpperCase();
}

function initSidebar() {
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  const sidebar = document.getElementById('admin-sidebar');
  if (toggleBtn && sidebar) {
    toggleBtn.addEventListener('click', () => {
      sidebar.classList.toggle('open');
    });
  }
}

function initEventListeners() {
  const logoutBtn = document.getElementById('btn-admin-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      await logoutUser({
        buttonEl: logoutBtn,
        redirect: 'admin-login.html'
      });
    });
  }

  window.addEventListener('pageshow', (event) => {
    if (event.persisted && !localStorage.getItem('msp_token') && !localStorage.getItem('msp_admin_token')) {
      window.location.replace('admin-login.html');
    }
  });

  const refreshBtn = document.getElementById('btn-refresh-reports');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadReports);
  }

  // Date range filter buttons
  const dateBtns = document.querySelectorAll('.date-filter-btn');
  dateBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      dateBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDateRange = btn.dataset.range;
      loadReports();
    });
  });

  // Export buttons
  const exportBtns = document.querySelectorAll('.btn-export');
  exportBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      window.open(`/api/admin/reports/export?type=${encodeURIComponent(type)}&range=${encodeURIComponent(currentDateRange)}`, '_blank');
    });
  });
}

async function loadReports() {
  try {
    const res = await apiRequest(`/admin/reports?range=${encodeURIComponent(currentDateRange)}`);
    if (res.ok && res.success && res.data) {
      renderSummaryKPIs(res.data.summary);
      renderCharts(res.data);
      renderAppsByService(res.data.applications_by_service || []);
      renderAppsByStatus(res.data.applications_by_status || []);
      renderCmpsByDepartment(res.data.complaints_by_department || []);
      renderCmpsByStatus(res.data.complaints_by_status || []);
      renderMonthlyTrends(res.data.monthly_trends || []);
    } else {
      showToast(res.error?.message || 'Failed to generate reports from database.', 'danger');
    }
  } catch (err) {
    console.error('Failed to load reports:', err);
    showToast('Network error loading reports.', 'danger');
  }
}

function renderSummaryKPIs(summary = {}) {
  const totalApps = summary.total_applications || 0;
  const approvedApps = summary.approved_applications || 0;
  const totalCmps = summary.total_complaints || 0;
  const resolvedCmps = summary.resolved_complaints || 0;
  const activeServices = summary.active_services || 0;

  const rate = totalCmps > 0 ? Math.round((resolvedCmps / totalCmps) * 100) : 0;

  const totalAppsEl = document.getElementById('kpi-total-apps');
  const approvedAppsEl = document.getElementById('kpi-approved-apps');
  const totalCmpsEl = document.getElementById('kpi-total-cmps');
  const resolvedCmpsEl = document.getElementById('kpi-resolved-cmps');
  const activeServicesEl = document.getElementById('kpi-active-services');
  const rateEl = document.getElementById('kpi-resolution-rate');

  if (totalAppsEl) totalAppsEl.textContent = totalApps;
  if (approvedAppsEl) approvedAppsEl.textContent = approvedApps;
  if (totalCmpsEl) totalCmpsEl.textContent = totalCmps;
  if (resolvedCmpsEl) resolvedCmpsEl.textContent = resolvedCmps;
  if (activeServicesEl) activeServicesEl.textContent = activeServices;
  if (rateEl) rateEl.textContent = `${rate}%`;
}

function renderCharts(data) {
  // Chart 1: Applications by Service (Bar)
  const ctxServices = document.getElementById('chart-report-services')?.getContext('2d');
  if (ctxServices) {
    if (chartServices) chartServices.destroy();
    const srvData = data.applications_by_service || [];
    chartServices = new Chart(ctxServices, {
      type: 'bar',
      data: {
        labels: srvData.length > 0 ? srvData.map(s => s.service) : ['No Applications'],
        datasets: [{
          label: 'Applications',
          data: srvData.length > 0 ? srvData.map(s => s.count) : [0],
          backgroundColor: '#dc2626',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { ticks: { maxRotation: 45, minRotation: 0 } }
        }
      }
    });
  }

  // Chart 2: Applications by Status (Donut)
  const ctxStatus = document.getElementById('chart-report-status')?.getContext('2d');
  if (ctxStatus) {
    if (chartStatus) chartStatus.destroy();
    const stData = data.applications_by_status || [];
    chartStatus = new Chart(ctxStatus, {
      type: 'doughnut',
      data: {
        labels: stData.length > 0 ? stData.map(s => s.status) : ['Zero Applications'],
        datasets: [{
          data: stData.length > 0 ? stData.map(s => s.count) : [1],
          backgroundColor: stData.length > 0
            ? ['#dc2626', '#16a34a', '#ca8a04', '#2563eb', '#9333ea', '#6b7280']
            : ['#e5e7eb']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }
        }
      }
    });
  }

  // Chart 3: Grievances by Department (Bar)
  const ctxCmpsDept = document.getElementById('chart-report-cmps-dept')?.getContext('2d');
  if (ctxCmpsDept) {
    if (chartCmpsDept) chartCmpsDept.destroy();
    const deptData = data.complaints_by_department || [];
    chartCmpsDept = new Chart(ctxCmpsDept, {
      type: 'bar',
      data: {
        labels: deptData.length > 0 ? deptData.map(d => d.department) : ['No Grievances'],
        datasets: [{
          label: 'Grievances',
          data: deptData.length > 0 ? deptData.map(d => d.count) : [0],
          backgroundColor: '#b91c1c',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } }
        }
      }
    });
  }

  // Chart 4: Grievances by Status (Donut)
  const ctxCmpsStatus = document.getElementById('chart-report-cmps-status')?.getContext('2d');
  if (ctxCmpsStatus) {
    if (chartCmpsStatus) chartCmpsStatus.destroy();
    const cmpStData = data.complaints_by_status || [];
    chartCmpsStatus = new Chart(ctxCmpsStatus, {
      type: 'doughnut',
      data: {
        labels: cmpStData.length > 0 ? cmpStData.map(c => c.status) : ['Zero Grievances'],
        datasets: [{
          data: cmpStData.length > 0 ? cmpStData.map(c => c.count) : [1],
          backgroundColor: cmpStData.length > 0
            ? ['#ea580c', '#ca8a04', '#16a34a', '#4b5563', '#dc2626']
            : ['#e5e7eb']
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } }
        }
      }
    });
  }
}

function renderAppsByService(data) {
  const tbody = document.getElementById('report-apps-service-tbody');
  if (!tbody) return;

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="text-center py-4 text-muted">0 applications on file in the database.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(item => `
    <tr>
      <td class="font-bold text-neutral-900">${escapeHtml(item.service)}</td>
      <td class="text-right font-bold text-primary">${item.count}</td>
    </tr>
  `).join('');
}

function renderAppsByStatus(data) {
  const tbody = document.getElementById('report-apps-status-tbody');
  if (!tbody) return;

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="text-center py-4 text-muted">0 applications on file in the database.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(item => `
    <tr>
      <td><span class="badge badge-info">${escapeHtml(item.status)}</span></td>
      <td class="text-right font-bold text-neutral-800">${item.count}</td>
    </tr>
  `).join('');
}

function renderCmpsByDepartment(data) {
  const tbody = document.getElementById('report-cmps-dept-tbody');
  if (!tbody) return;

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="text-center py-4 text-muted">0 grievances on file in the database.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(item => `
    <tr>
      <td class="font-bold text-neutral-900">${escapeHtml(item.department)}</td>
      <td class="text-right font-bold text-warning">${item.count}</td>
    </tr>
  `).join('');
}

function renderCmpsByStatus(data) {
  const tbody = document.getElementById('report-cmps-status-tbody');
  if (!tbody) return;

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="text-center py-4 text-muted">0 grievances on file in the database.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(item => `
    <tr>
      <td><span class="badge badge-warning">${escapeHtml(item.status)}</span></td>
      <td class="text-right font-bold text-neutral-800">${item.count}</td>
    </tr>
  `).join('');
}

function renderMonthlyTrends(data) {
  const tbody = document.getElementById('report-monthly-trend-tbody');
  if (!tbody) return;

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-muted">No monthly historical transactions found in database.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(row => {
    const total = (row.applications || 0) + (row.complaints || 0);
    return `
      <tr>
        <td class="font-bold"><code>${escapeHtml(row.month)}</code></td>
        <td><span class="text-primary font-bold">${row.applications || 0}</span> applications</td>
        <td><span class="text-warning font-bold">${row.complaints || 0}</span> complaints</td>
        <td class="font-bold text-neutral-900">${total} transactions</td>
      </tr>
    `;
  }).join('');
}
