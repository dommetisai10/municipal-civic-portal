/**
 * Citizen Management Module (ESM)
 * Lists registered citizens, handles account active toggling, and displays submission history.
 */

import { apiRequest, showToast, getAuthUser, logoutUser, escapeHtml } from './api.js';

let currentPage = 1;
let currentLimit = 15;
let currentSearch = '';

document.addEventListener('DOMContentLoaded', async () => {
  await verifyAdminSession();
  initEventListeners();
  await loadCitizens();
});

async function verifyAdminSession() {
  const user = await getAuthUser();
  if (!user || user.role !== 'admin') {
    window.location.href = 'admin-login.html?redirect=citizens.html';
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

  const searchBtn = document.getElementById('btn-search-citizens');
  const searchInput = document.getElementById('citizen-search-input');
  if (searchBtn && searchInput) {
    searchBtn.addEventListener('click', () => {
      currentSearch = searchInput.value.trim();
      currentPage = 1;
      loadCitizens();
    });
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        currentSearch = searchInput.value.trim();
        currentPage = 1;
        loadCitizens();
      }
    });
  }

  const resetBtn = document.getElementById('btn-reset-citizens');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (searchInput) searchInput.value = '';
      currentSearch = '';
      currentPage = 1;
      loadCitizens();
    });
  }

  const refreshBtn = document.getElementById('btn-refresh-citizens');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadCitizens);
  }

  // Pagination
  const prevBtn = document.getElementById('btn-prev-page');
  const nextBtn = document.getElementById('btn-next-page');
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      if (currentPage > 1) {
        currentPage--;
        loadCitizens();
      }
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      currentPage++;
      loadCitizens();
    });
  }

  // Modal close handlers
  const closeBtn = document.getElementById('modal-citizen-close');
  const cancelBtn = document.getElementById('modal-citizen-cancel');
  if (closeBtn) closeBtn.addEventListener('click', closeCitizenModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeCitizenModal);
}

async function loadCitizens() {
  const tbody = document.getElementById('citizens-table-body');
  const countText = document.getElementById('citizens-count-text');

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-6 text-muted">
          Loading citizens from MongoDB Atlas...
        </td>
      </tr>
    `;
  }

  try {
    const params = new URLSearchParams({
      page: currentPage,
      limit: currentLimit
    });
    if (currentSearch) params.set('q', currentSearch);

    const res = await apiRequest(`/admin/citizens?${params.toString()}`);
    if (res.ok && res.success && res.data) {
      const { citizens, pagination } = res.data;
      renderCitizensTable(citizens);
      updatePagination(pagination);
    } else {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" class="text-center py-6 text-danger">
              Failed to load citizens: ${escapeHtml(res.error?.message || 'Database error')}
            </td>
          </tr>
        `;
      }
      if (countText) countText.textContent = 'Error loading citizens';
    }
  } catch (err) {
    console.error('Failed to load citizens:', err);
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

function renderCitizensTable(citizens) {
  const tbody = document.getElementById('citizens-table-body');
  const countText = document.getElementById('citizens-count-text');

  if (!tbody) return;

  if (countText) {
    countText.textContent = `Showing ${citizens.length} registered citizen${citizens.length === 1 ? '' : 's'}`;
  }

  if (citizens.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-8 text-muted">
          No registered citizens found in the database.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  citizens.forEach(c => {
    const tr = document.createElement('tr');
    const isActive = c.is_active !== false;
    const dateFormatted = c.created_at ? new Date(c.created_at).toLocaleDateString() : 'N/A';

    tr.innerHTML = `
      <td>
        <div class="font-bold text-neutral-900">${escapeHtml(c.name)}</div>
        <div class="text-xs text-muted">ID: <code>${escapeHtml(c.id)}</code></div>
      </td>
      <td>
        <span class="text-xs">${escapeHtml(c.email)}</span>
      </td>
      <td>
        <span class="text-xs">${escapeHtml(c.phone || 'Not provided')}</span>
      </td>
      <td>
        <span class="badge badge-info">${c.applications_count || 0} apps</span>
      </td>
      <td>
        <span class="badge badge-warning">${c.complaints_count || 0} complaints</span>
      </td>
      <td>
        <span class="text-xs text-muted">${dateFormatted}</span>
      </td>
      <td>
        <button type="button" class="btn btn-xs ${isActive ? 'btn-success' : 'btn-danger'} btn-toggle-status" data-id="${escapeHtml(c.id)}" data-active="${isActive}">
          ${isActive ? 'Active' : 'Deactivated'}
        </button>
      </td>
      <td class="text-right">
        <button type="button" class="btn btn-xs btn-outline btn-view-history" data-id="${escapeHtml(c.id)}">
          👁️ Inspect History
        </button>
      </td>
    `;

    const toggleBtn = tr.querySelector('.btn-toggle-status');
    toggleBtn.addEventListener('click', () => toggleCitizenStatus(c.id, isActive));

    const viewBtn = tr.querySelector('.btn-view-history');
    viewBtn.addEventListener('click', () => viewCitizenHistory(c.id));

    tbody.appendChild(tr);
  });
}

function updatePagination(pagination) {
  const infoEl = document.getElementById('pagination-info');
  const prevBtn = document.getElementById('btn-prev-page');
  const nextBtn = document.getElementById('btn-next-page');

  if (!pagination) return;
  const { page, total_pages, total_records } = pagination;

  if (infoEl) {
    infoEl.textContent = `Page ${page} of ${total_pages} (${total_records} total citizens)`;
  }

  if (prevBtn) prevBtn.disabled = page <= 1;
  if (nextBtn) nextBtn.disabled = page >= total_pages;
}

async function toggleCitizenStatus(citizenId, currentlyActive) {
  const newStatus = !currentlyActive;
  try {
    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(citizenId)}/status`, {
      method: 'PATCH',
      body: { is_active: newStatus }
    });
    if (res.ok && res.success) {
      showToast(`Citizen account ${newStatus ? 'activated' : 'deactivated'}.`, 'success');
      await loadCitizens();
    } else {
      showToast(res.error?.message || 'Failed to update account status.', 'danger');
    }
  } catch (err) {
    showToast('Network error updating account status.', 'danger');
  }
}

async function viewCitizenHistory(citizenId) {
  const modal = document.getElementById('citizen-detail-modal');
  const nameEl = document.getElementById('citizen-modal-name');
  const metaEl = document.getElementById('citizen-modal-meta');
  const appsTbody = document.getElementById('modal-apps-tbody');
  const cmpsTbody = document.getElementById('modal-cmps-tbody');

  if (!modal) return;

  if (nameEl) nameEl.textContent = 'Loading Citizen History...';
  if (metaEl) metaEl.textContent = 'Connecting to database...';
  if (appsTbody) appsTbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">Loading...</td></tr>';
  if (cmpsTbody) cmpsTbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">Loading...</td></tr>';

  modal.classList.remove('d-none');

  try {
    const res = await apiRequest(`/admin/citizens/${encodeURIComponent(citizenId)}`);
    if (res.ok && res.success && res.data) {
      const c = res.data;
      if (nameEl) nameEl.textContent = c.name;
      if (metaEl) {
        metaEl.textContent = `Email: ${c.email} | Phone: ${c.phone || 'N/A'} | Status: ${c.is_active ? 'Active' : 'Deactivated'}`;
      }

      // Render applications
      if (appsTbody) {
        if (!c.applications || c.applications.length === 0) {
          appsTbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">Zero service applications on record.</td></tr>';
        } else {
          appsTbody.innerHTML = c.applications.map(app => `
            <tr>
              <td><code>${escapeHtml(app.application_id)}</code></td>
              <td class="font-bold">${escapeHtml(app.service_name)}</td>
              <td><span class="badge badge-category">${escapeHtml(app.category || 'General')}</span></td>
              <td><span class="badge badge-info">${escapeHtml(app.status)}</span></td>
              <td class="text-xs text-muted">${new Date(app.created_at).toLocaleDateString()}</td>
            </tr>
          `).join('');
        }
      }

      // Render complaints
      if (cmpsTbody) {
        if (!c.complaints || c.complaints.length === 0) {
          cmpsTbody.innerHTML = '<tr><td colspan="5" class="text-center py-4 text-muted">Zero grievances lodged on record.</td></tr>';
        } else {
          cmpsTbody.innerHTML = c.complaints.map(cmp => `
            <tr>
              <td><code>${escapeHtml(cmp.complaint_id)}</code></td>
              <td class="font-bold">${escapeHtml(cmp.title)}</td>
              <td>${escapeHtml(cmp.department)}</td>
              <td><span class="badge badge-warning">${escapeHtml(cmp.status)}</span></td>
              <td class="text-xs text-muted">${new Date(cmp.created_at).toLocaleDateString()}</td>
            </tr>
          `).join('');
        }
      }
    } else {
      showToast(res.error?.message || 'Failed to retrieve citizen history.', 'danger');
    }
  } catch (err) {
    showToast('Network error loading citizen details.', 'danger');
  }
}

function closeCitizenModal() {
  const modal = document.getElementById('citizen-detail-modal');
  if (modal) modal.classList.add('d-none');
}
