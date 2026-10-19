/**
 * Administrative Reports & Analytics Module (ESM)
 * Fetches live database aggregations and renders analytics breakdowns.
 */

import { apiRequest, showToast, getAuthUser, logoutUser, escapeHtml } from './api.js';

document.addEventListener('DOMContentLoaded', async () => {
  await verifyAdminSession();
  initEventListeners();
  await loadReports();
});

async function verifyAdminSession() {
  const user = await getAuthUser();
  if (!user || user.role !== 'admin') {
    window.location.href = 'admin-login.html?redirect=reports.html';
    return;
  }
  const display = document.getElementById('admin-user-display');
  if (display) {
    display.textContent = user.email || user.name || 'Officer';
  }
}

function initEventListeners() {
  const logoutBtn = document.getElementById('btn-admin-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await logoutUser();
      window.location.href = 'admin-login.html';
    });
  }

  const refreshBtn = document.getElementById('btn-refresh-reports');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadReports);
  }
}

async function loadReports() {
  try {
    const res = await apiRequest('/admin/reports');
    if (res.ok && res.success && res.data) {
      renderSummaryKPIs(res.data.summary);
      renderAppsByService(res.data.applications_by_service || []);
      renderAppsByStatus(res.data.applications_by_status || []);
      renderCmpsByDepartment(res.data.complaints_by_department || []);
      renderCmpsByStatus(res.data.complaints_by_status || []);
      renderMonthlyTrends(res.data.monthly_trends || []);
    } else {
      showToast(res.error?.message || 'Failed to generate reports.', 'danger');
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

function renderAppsByService(data) {
  const tbody = document.getElementById('report-apps-service-tbody');
  if (!tbody) return;

  if (data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="2" class="text-center py-4 text-muted">0 applications on file in the database.</td></tr>';
    return;
  }

  tbody.innerHTML = data.map(item => `
    <tr>
      <td class="font-bold">${escapeHtml(item.service)}</td>
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
      <td class="text-right font-bold">${item.count}</td>
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
      <td class="font-bold">${escapeHtml(item.department)}</td>
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
      <td class="text-right font-bold">${item.count}</td>
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
        <td class="font-bold">${total} transactions</td>
      </tr>
    `;
  }).join('');
}
