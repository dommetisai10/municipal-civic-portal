/**
 * Municipal Service Portal - Administrative Audit Logs & Compliance
 * Handles querying, pagination, dynamic filtering, and raw payload inspection.
 */

import { apiGet, apiPost } from './api.js';

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
  await checkAdminSession();
  checkHealth();
  setupFilterHandlers();
  setupModalHandlers();
  setupPaginationHandlers();
  fetchAuditLogs(1);
});

/**
 * Validates active admin session and renders officer email.
 */
async function checkAdminSession() {
  try {
    const res = await apiGet('/api/admin/auth/me');
    if (!res.success) {
      window.location.href = '/admin-login.html';
      return;
    }
    const displayEl = document.getElementById('admin-user-display');
    if (displayEl) {
      displayEl.textContent = res.data.email || 'Officer';
    }

    const logoutBtn = document.getElementById('btn-admin-logout');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', async () => {
        try {
          await apiPost('/api/admin/auth/logout', {});
        } finally {
          window.location.href = '/admin-login.html';
        }
      });
    }
  } catch (err) {
    window.location.href = '/admin-login.html';
  }
}

/**
 * Displays live database health status.
 */
async function checkHealth() {
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  try {
    const res = await apiGet('/api/health');
    if (res.success && res.data.database === 'connected') {
      dot.className = 'status-dot dot-online';
      text.textContent = 'MongoDB Connected';
    } else {
      dot.className = 'status-dot dot-offline';
      text.textContent = 'Database Unavailable';
    }
  } catch {
    dot.className = 'status-dot dot-offline';
    text.textContent = 'Connection Error';
  }
}

/**
 * Fetches audit logs from backend with active filters and pagination.
 */
async function fetchAuditLogs(page = 1) {
  currentPage = page;
  const tbody = document.getElementById('audit-tbody');
  tbody.innerHTML = `
    <tr>
      <td colspan="6" class="text-center py-6 text-muted">
        <div class="spinner"></div>
        <p class="mt-2 text-xs">Querying database audit trail...</p>
      </td>
    </tr>
  `;

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

    const res = await apiGet(`/api/admin/audit-logs?${params.toString()}`);

    if (!res.success) {
      showAlert(res.error?.message || 'Failed to load audit logs.', 'danger');
      tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-danger">Error retrieving audit records.</td></tr>`;
      return;
    }

    cachedLogs = res.data.logs || [];
    const pagination = res.data.pagination || {};
    totalPages = pagination.total_pages || 1;
    totalRecords = pagination.total_records || 0;

    // Populate dropdowns once
    if (!filtersPopulated && res.data.filter_options) {
      populateFilterOptions(res.data.filter_options);
      filtersPopulated = true;
    }

    renderTable(cachedLogs);
    renderPagination();

  } catch (err) {
    showAlert('Network error while querying audit logs.', 'danger');
    tbody.innerHTML = `<tr><td colspan="6" class="text-center py-4 text-danger">Network error. Please try again.</td></tr>`;
  }
}

/**
 * Dynamically fills filter select dropdowns from available data.
 */
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

/**
 * Renders audit log rows into the table.
 */
function renderTable(logs) {
  const tbody = document.getElementById('audit-tbody');

  if (!logs || logs.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center py-6 text-muted">
          <div style="font-size: 2rem; margin-bottom: 8px;">📋</div>
          <strong>No audit log records found.</strong>
          <p class="text-xs mt-1">There are no recorded system actions matching your current filter criteria.</p>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = logs.map(log => {
    const dateFormatted = formatDate(log.created_at);
    const badgeClass = getActionBadgeClass(log.action);
    const actorRole = log.actor_role || 'system';
    const targetCol = log.target_collection || '-';
    const targetId = log.target_id || '-';
    const ip = log.ip || 'internal';

    return `
      <tr>
        <td class="text-xs text-muted" style="white-space: nowrap;">${escapeHtml(dateFormatted)}</td>
        <td>
          <span class="badge badge-audit ${badgeClass}">${escapeHtml(log.action)}</span>
        </td>
        <td class="text-xs">
          <span class="badge" style="font-size:0.7rem; background:#f1f5f9; color:#334155;">${escapeHtml(actorRole)}</span>
          <div class="font-mono text-muted text-xs mt-1" style="max-width:140px; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(log.actor_id || '')}">
            ${escapeHtml(log.actor_id || 'system')}
          </div>
        </td>
        <td class="text-xs">
          <strong>${escapeHtml(targetCol)}</strong>
          <div class="font-mono text-muted text-xs" style="max-width:160px; overflow:hidden; text-overflow:ellipsis;" title="${escapeHtml(targetId)}">
            ${escapeHtml(targetId)}
          </div>
        </td>
        <td>
          <span class="ip-pill">${escapeHtml(ip)}</span>
        </td>
        <td>
          <button 
            type="button" 
            class="btn btn-xs btn-outline btn-inspect" 
            data-id="${escapeHtml(log.id)}"
          >
            Inspect Payload
          </button>
        </td>
      </tr>
    `;
  }).join('');

  // Attach inspection handlers
  document.querySelectorAll('.btn-inspect').forEach(btn => {
    btn.addEventListener('click', () => {
      const logId = btn.getAttribute('data-id');
      const item = cachedLogs.find(l => l.id === logId);
      if (item) {
        openInspectionModal(item);
      }
    });
  });
}

/**
 * Returns CSS badge class depending on event type.
 */
function getActionBadgeClass(action = '') {
  const act = action.toUpperCase();
  if (act.includes('LOGIN') || act.includes('LOGOUT')) return 'badge-audit-login';
  if (act.includes('CREATE') || act.includes('REGISTER') || act.includes('SUBMIT')) return 'badge-audit-create';
  if (act.includes('STATUS') || act.includes('AVAILABILITY')) return 'badge-audit-status';
  if (act.includes('UPDATE') || act.includes('CHANGE')) return 'badge-audit-update';
  return 'badge-audit-default';
}

/**
 * Updates pagination bar numbers and buttons.
 */
function renderPagination() {
  const infoEl = document.getElementById('pagination-info');
  const pageDisplay = document.getElementById('current-page-display');
  const prevBtn = document.getElementById('btn-prev-page');
  const nextBtn = document.getElementById('btn-next-page');

  if (totalRecords === 0) {
    infoEl.textContent = 'No records to display';
    pageDisplay.textContent = 'Page 1 of 1';
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalRecords);
  infoEl.textContent = `Showing ${start}–${end} of ${totalRecords} events`;
  pageDisplay.textContent = `Page ${currentPage} of ${totalPages}`;

  prevBtn.disabled = currentPage <= 1;
  nextBtn.disabled = currentPage >= totalPages;
}

/**
 * Connects previous/next pagination buttons.
 */
function setupPaginationHandlers() {
  const prevBtn = document.getElementById('btn-prev-page');
  const nextBtn = document.getElementById('btn-next-page');

  prevBtn.addEventListener('click', () => {
    if (currentPage > 1) {
      fetchAuditLogs(currentPage - 1);
    }
  });

  nextBtn.addEventListener('click', () => {
    if (currentPage < totalPages) {
      fetchAuditLogs(currentPage + 1);
    }
  });
}

/**
 * Opens detailed inspection modal with before/after payload diff.
 */
function openInspectionModal(log) {
  const modal = document.getElementById('audit-detail-modal');
  document.getElementById('modal-audit-badge').textContent = log.action;
  document.getElementById('modal-audit-badge').className = `badge badge-audit ${getActionBadgeClass(log.action)}`;
  document.getElementById('modal-audit-id').textContent = `ID: ${log.id}`;
  document.getElementById('modal-timestamp').textContent = formatDate(log.created_at);
  document.getElementById('modal-actor').textContent = `${log.actor_role} (${log.actor_id || 'system'})`;
  document.getElementById('modal-target-col').textContent = log.target_collection || '-';
  document.getElementById('modal-target-id').textContent = log.target_id || '-';
  document.getElementById('modal-ip').textContent = log.ip || 'N/A';

  const payloadBox = document.getElementById('modal-payload-box');
  payloadBox.textContent = JSON.stringify(log.before_after_summary || {}, null, 2);

  modal.classList.remove('d-none');
}

/**
 * Wires up modal dismissal and clipboard copy.
 */
function setupModalHandlers() {
  const modal = document.getElementById('audit-detail-modal');
  const closeBtn = document.getElementById('btn-close-audit-modal');
  const dismissBtn = document.getElementById('btn-dismiss-audit-modal');
  const copyBtn = document.getElementById('btn-copy-payload');

  const closeModal = () => modal.classList.add('d-none');

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (dismissBtn) dismissBtn.addEventListener('click', closeModal);
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      const text = document.getElementById('modal-payload-box').textContent;
      navigator.clipboard.writeText(text).then(() => {
        const orig = copyBtn.textContent;
        copyBtn.textContent = 'Copied!';
        setTimeout(() => { copyBtn.textContent = orig; }, 1500);
      });
    });
  }
}

/**
 * Handles filter form submit and reset.
 */
function setupFilterHandlers() {
  const form = document.getElementById('audit-filter-form');
  const resetBtn = document.getElementById('btn-reset-filters');

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    currentFilters.q = document.getElementById('filter-search').value.trim();
    currentFilters.action = document.getElementById('filter-action').value;
    currentFilters.actor_role = document.getElementById('filter-role').value;
    currentFilters.target_collection = document.getElementById('filter-collection').value;
    currentFilters.start_date = document.getElementById('filter-start-date').value;
    currentFilters.end_date = document.getElementById('filter-end-date').value;

    fetchAuditLogs(1);
  });

  resetBtn.addEventListener('click', () => {
    form.reset();
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

function showAlert(msg, type = 'info') {
  const el = document.getElementById('audit-alert');
  if (!el) return;
  el.className = `alert alert-${type}`;
  el.textContent = msg;
  el.classList.remove('d-none');
  setTimeout(() => el.classList.add('d-none'), 5000);
}

function formatDate(isoStr) {
  if (!isoStr) return '-';
  try {
    const d = new Date(isoStr);
    return d.toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  } catch {
    return isoStr;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
