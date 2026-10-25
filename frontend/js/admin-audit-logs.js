/**
 * Municipal Service Portal - Administrative Audit Logs & Compliance Module (ESM)
 * Queries immutable audit trails, dynamic filtering, pagination, inspection modal, and CSV export.
 */

import { apiRequest, showToast, getAuthUser, logoutUser, escapeHtml } from './api.js';

let currentPage = 1;
const pageSize = 20;
let totalPages = 1;
let totalRecords = 0;
let cachedLogs = [];
let filtersPopulated = false;

let currentFilters = {
  action: 'ALL',
  actor_role: 'ALL',
  target_collection: 'ALL',
  start_date: '',
  end_date: '',
  q: ''
};

document.addEventListener('DOMContentLoaded', async () => {
  await verifyAdminSession();
  initSidebar();
  setupFilterHandlers();
  setupModalHandlers();
  setupPaginationHandlers();
  await fetchAuditLogs(1);
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
    window.location.href = 'admin-login.html?redirect=admin-audit-logs.html';
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

  const globalSearch = document.getElementById('global-search-input');
  if (globalSearch) {
    globalSearch.addEventListener('input', (e) => {
      const searchInput = document.getElementById('filter-search');
      if (searchInput) {
        searchInput.value = e.target.value;
        currentFilters.q = e.target.value.trim();
        fetchAuditLogs(1);
      }
    });
  }

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
}

function setupFilterHandlers() {
  const form = document.getElementById('audit-filter-form');
  const resetBtn = document.getElementById('btn-reset-filters');
  const refreshBtn = document.getElementById('btn-refresh-audit');
  const exportBtn = document.getElementById('btn-export-audit');

  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      currentFilters.q = document.getElementById('filter-search')?.value.trim() || '';
      currentFilters.action = document.getElementById('filter-action')?.value || 'ALL';
      currentFilters.actor_role = document.getElementById('filter-role')?.value || 'ALL';
      currentFilters.target_collection = document.getElementById('filter-collection')?.value || 'ALL';
      currentFilters.start_date = document.getElementById('filter-start-date')?.value || '';
      currentFilters.end_date = document.getElementById('filter-end-date')?.value || '';
      fetchAuditLogs(1);
    });
  }

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (form) form.reset();
      currentFilters = {
        action: 'ALL',
        actor_role: 'ALL',
        target_collection: 'ALL',
        start_date: '',
        end_date: '',
        q: ''
      };
      fetchAuditLogs(1);
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => fetchAuditLogs(currentPage));
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const params = new URLSearchParams();
      if (currentFilters.action !== 'ALL') params.set('action', currentFilters.action);
      if (currentFilters.actor_role !== 'ALL') params.set('actor_role', currentFilters.actor_role);
      if (currentFilters.target_collection !== 'ALL') params.set('target_collection', currentFilters.target_collection);
      if (currentFilters.start_date) params.set('start_date', currentFilters.start_date);
      if (currentFilters.end_date) params.set('end_date', currentFilters.end_date);
      if (currentFilters.q) params.set('q', currentFilters.q);
      window.open(`/api/admin/audit-logs/export?${params.toString()}`, '_blank');
    });
  }
}

function setupPaginationHandlers() {
  const prevBtn = document.getElementById('btn-prev-page');
  const nextBtn = document.getElementById('btn-next-page');

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (currentPage > 1) fetchAuditLogs(currentPage - 1);
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      if (currentPage < totalPages) fetchAuditLogs(currentPage + 1);
    });
  }
}

function setupModalHandlers() {
  const modal = document.getElementById('audit-detail-modal');
  const closeBtn = document.getElementById('btn-close-audit-modal');
  const dismissBtn = document.getElementById('btn-dismiss-audit-modal');
  const copyBtn = document.getElementById('btn-copy-payload');

  const closeModal = () => modal?.classList.add('d-none');

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (dismissBtn) dismissBtn.addEventListener('click', closeModal);

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const payloadText = document.getElementById('modal-payload-box')?.textContent;
      if (payloadText) {
        navigator.clipboard.writeText(payloadText).then(() => {
          showToast('JSON payload copied to clipboard.', 'success');
        }).catch(() => {
          showToast('Unable to copy JSON.', 'warning');
        });
      }
    });
  }
}

async function fetchAuditLogs(page = 1) {
  currentPage = page;
  const tbody = document.getElementById('audit-tbody');
  const countText = document.getElementById('audit-count-text');

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-6 text-muted">
          Querying audit trail from MongoDB database...
        </td>
      </tr>
    `;
  }

  try {
    const params = new URLSearchParams({
      page: String(currentPage),
      limit: String(pageSize)
    });

    if (currentFilters.action && currentFilters.action !== 'ALL') {
      params.set('action', currentFilters.action);
    }
    if (currentFilters.actor_role && currentFilters.actor_role !== 'ALL') {
      params.set('actor_role', currentFilters.actor_role);
    }
    if (currentFilters.target_collection && currentFilters.target_collection !== 'ALL') {
      params.set('target_collection', currentFilters.target_collection);
    }
    if (currentFilters.start_date) {
      params.set('start_date', currentFilters.start_date);
    }
    if (currentFilters.end_date) {
      params.set('end_date', currentFilters.end_date);
    }
    if (currentFilters.q) {
      params.set('q', currentFilters.q);
    }

    const res = await apiRequest(`/admin/audit-logs?${params.toString()}`);
    if (res.ok && res.success && res.data) {
      cachedLogs = res.data.logs || [];
      const pagination = res.data.pagination || {};
      totalPages = pagination.total_pages || 1;
      totalRecords = pagination.total_records || 0;

      if (countText) countText.textContent = `${totalRecords}`;

      if (!filtersPopulated && res.data.filter_options) {
        populateFilterOptions(res.data.filter_options);
        filtersPopulated = true;
      }

      renderTable(cachedLogs);
      renderPagination();
    } else {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="6" class="text-center py-4 text-danger">
              Failed to query audit trail: ${escapeHtml(res.error?.message || 'Database error')}
            </td>
          </tr>
        `;
      }
    }
  } catch (err) {
    console.error('Failed to query audit logs:', err);
    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" class="text-center py-4 text-danger">
            Network error communicating with backend API.
          </td>
        </tr>
      `;
    }
  }
}

function populateFilterOptions(options) {
  const actionSelect = document.getElementById('filter-action');
  const colSelect = document.getElementById('filter-collection');

  if (actionSelect && options.actions) {
    options.actions.forEach(action => {
      const opt = document.createElement('option');
      opt.value = action;
      opt.textContent = action;
      actionSelect.appendChild(opt);
    });
  }

  if (colSelect && options.target_collections) {
    options.target_collections.forEach(col => {
      const opt = document.createElement('option');
      opt.value = col;
      opt.textContent = col;
      colSelect.appendChild(opt);
    });
  }
}

function renderTable(logs) {
  const tbody = document.getElementById('audit-tbody');
  if (!tbody) return;

  if (!logs || logs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-8 text-muted">
          <div style="font-size: 2rem; margin-bottom: 8px;">📜</div>
          <strong>No audit log records found.</strong>
          <p class="text-xs mt-1">There are no system actions matching your active filters.</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const dateFormatted = log.created_at ? new Date(log.created_at).toLocaleString() : 'N/A';
    const actorRole = log.actor_role || 'system';
    const actorEmail = log.actor_email || log.actor_id || 'System Process';
    const targetCol = log.target_collection || 'general';
    const targetId = log.target_id || '-';
    const ipAddr = log.ip_address || '127.0.0.1';

    return `
      <tr>
        <td>
          <span class="text-xs font-mono text-muted">${escapeHtml(dateFormatted)}</span>
        </td>
        <td>
          <span class="badge ${getActionBadgeClass(log.action)}">${escapeHtml(log.action)}</span>
        </td>
        <td>
          <div class="font-bold text-xs text-neutral-900">${escapeHtml(actorEmail)}</div>
          <span class="badge badge-neutral text-xs">${escapeHtml(actorRole)}</span>
        </td>
        <td>
          <div class="text-xs font-medium">${escapeHtml(targetCol)}</div>
          <code class="text-xs text-muted">${escapeHtml(targetId)}</code>
        </td>
        <td>
          <code class="text-xs">${escapeHtml(ipAddr)}</code>
        </td>
        <td class="text-right">
          <button type="button" class="btn btn-xs btn-outline btn-inspect-log" data-id="${escapeHtml(log.id)}">
            🔍 Inspect
          </button>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('.btn-inspect-log').forEach(btn => {
    btn.addEventListener('click', () => {
      const logId = btn.dataset.id;
      const logRecord = cachedLogs.find(l => l.id === logId);
      if (logRecord) openAuditDetailModal(logRecord);
    });
  });
}

function getActionBadgeClass(action = '') {
  const a = action.toLowerCase();
  if (a.includes('approve') || a.includes('verified') || a.includes('resolve')) return 'badge-success';
  if (a.includes('reject') || a.includes('delete') || a.includes('suspend')) return 'badge-danger';
  if (a.includes('update') || a.includes('review') || a.includes('assign')) return 'badge-info';
  if (a.includes('create') || a.includes('login') || a.includes('submit')) return 'badge-warning';
  return 'badge-neutral';
}

function renderPagination() {
  const infoEl = document.getElementById('pagination-info');
  const prevBtn = document.getElementById('btn-prev-page');
  const nextBtn = document.getElementById('btn-next-page');
  const currentDisplay = document.getElementById('current-page-display');

  if (infoEl) {
    infoEl.textContent = `Showing page ${currentPage} of ${totalPages || 1} (${totalRecords} audit events)`;
  }
  if (currentDisplay) {
    currentDisplay.textContent = `Page ${currentPage} of ${totalPages || 1}`;
  }

  if (prevBtn) prevBtn.disabled = currentPage <= 1;
  if (nextBtn) nextBtn.disabled = currentPage >= totalPages;
}

function openAuditDetailModal(log) {
  const modal = document.getElementById('audit-detail-modal');
  if (!modal) return;

  const titleEl = document.getElementById('modal-audit-title');
  const badgeEl = document.getElementById('modal-audit-badge');
  const idEl = document.getElementById('modal-audit-id');
  const timeEl = document.getElementById('modal-timestamp');
  const actorEl = document.getElementById('modal-actor');
  const colEl = document.getElementById('modal-target-col');
  const targetIdEl = document.getElementById('modal-target-id');
  const ipEl = document.getElementById('modal-ip');
  const payloadBox = document.getElementById('modal-payload-box');

  if (titleEl) titleEl.textContent = log.action || 'Audit Event';
  if (badgeEl) {
    badgeEl.textContent = log.action || 'ACTION';
    badgeEl.className = `badge ${getActionBadgeClass(log.action)}`;
  }
  if (idEl) idEl.textContent = `Log ID: ${log.id}`;
  if (timeEl) timeEl.textContent = log.created_at ? new Date(log.created_at).toUTCString() : 'N/A';
  if (actorEl) actorEl.textContent = `${log.actor_email || log.actor_id} (Role: ${log.actor_role || 'system'})`;
  if (colEl) colEl.textContent = log.target_collection || 'general';
  if (targetIdEl) targetIdEl.textContent = log.target_id || '-';
  if (ipEl) ipEl.textContent = log.ip_address || '127.0.0.1';

  if (payloadBox) {
    const details = log.details || {};
    payloadBox.textContent = JSON.stringify(details, null, 2);
  }

  modal.classList.remove('d-none');
}
