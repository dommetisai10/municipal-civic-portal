/**
 * Service Management Module (ESM)
 * Administrative catalog CRUD, document requirement configuration, and live availability toggling.
 */

import { apiRequest, showToast, getAuthUser, logoutUser, escapeHtml } from './api.js';

let allServices = [];

document.addEventListener('DOMContentLoaded', async () => {
  await verifyAdminSession();
  initEventListeners();
  await loadAdminServices();
});

async function verifyAdminSession() {
  const user = await getAuthUser();
  if (!user || user.role !== 'admin') {
    window.location.href = 'admin-login.html?redirect=service-management.html';
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

  const addBtn = document.getElementById('btn-add-service');
  if (addBtn) {
    addBtn.addEventListener('click', () => openServiceFormModal('create'));
  }

  const refreshBtn = document.getElementById('btn-refresh-services');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', loadAdminServices);
  }

  const searchInput = document.getElementById('service-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', applyFilters);
  }

  const catFilter = document.getElementById('category-filter');
  if (catFilter) {
    catFilter.addEventListener('change', applyFilters);
  }

  const availFilter = document.getElementById('availability-filter');
  if (availFilter) {
    availFilter.addEventListener('change', applyFilters);
  }

  // Modal setup
  const modal = document.getElementById('service-form-modal');
  const closeBtn = document.getElementById('modal-service-close');
  const cancelBtn = document.getElementById('modal-service-cancel');
  if (closeBtn) closeBtn.addEventListener('click', closeServiceFormModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeServiceFormModal);

  const addDocBtn = document.getElementById('btn-add-doc-field');
  if (addDocBtn) {
    addDocBtn.addEventListener('click', () => addDocInputField(''));
  }

  const serviceForm = document.getElementById('service-form');
  if (serviceForm) {
    serviceForm.addEventListener('submit', handleServiceFormSubmit);
  }
}

async function loadAdminServices() {
  const tbody = document.getElementById('services-table-body');
  const countText = document.getElementById('services-count-text');

  if (tbody) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-6 text-muted">
          Loading catalog from MongoDB Atlas...
        </td>
      </tr>
    `;
  }

  try {
    const res = await apiRequest('/admin/services');
    if (res.ok && res.success && Array.isArray(res.data)) {
      allServices = res.data;
      applyFilters();
    } else {
      if (tbody) {
        tbody.innerHTML = `
          <tr>
            <td colspan="8" class="text-center py-6 text-danger">
              Failed to load services: ${escapeHtml(res.error?.message || 'Database error')}
            </td>
          </tr>
        `;
      }
      if (countText) countText.textContent = 'Error loading services';
    }
  } catch (err) {
    console.error('Failed to load admin services:', err);
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

function applyFilters() {
  const query = (document.getElementById('service-search-input')?.value || '').toLowerCase().trim();
  const cat = document.getElementById('category-filter')?.value || 'ALL';
  const avail = document.getElementById('availability-filter')?.value || 'ALL';

  const filtered = allServices.filter(s => {
    const matchCat = cat === 'ALL' || s.category === cat;
    const isAvail = s.availability === 'Available' || s.availability === 'Active';
    const matchAvail = avail === 'ALL' ||
      (avail === 'Available' && isAvail) ||
      (avail === 'Unavailable' && !isAvail);
    const matchQuery = !query ||
      (s.name && s.name.toLowerCase().includes(query)) ||
      (s.slug && s.slug.toLowerCase().includes(query)) ||
      (s.category && s.category.toLowerCase().includes(query));
    return matchCat && matchAvail && matchQuery;
  });

  renderServicesTable(filtered);
}

function renderServicesTable(services) {
  const tbody = document.getElementById('services-table-body');
  const countText = document.getElementById('services-count-text');

  if (!tbody) return;

  if (countText) {
    countText.textContent = `Showing ${services.length} of ${allServices.length} registered services`;
  }

  if (services.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="8" class="text-center py-8 text-muted">
          No services match your active search filter.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = '';
  services.forEach(srv => {
    const tr = document.createElement('tr');
    const isAvail = srv.availability === 'Available' || srv.availability === 'Active';
    const docs = Array.isArray(srv.required_documents) ? srv.required_documents : [];
    const appsCount = srv.applications_count || 0;

    tr.innerHTML = `
      <td>
        <div class="font-bold text-neutral-900">${escapeHtml(srv.name)}</div>
        <code class="text-xs text-muted">${escapeHtml(srv.slug)}</code>
      </td>
      <td>
        <span class="badge badge-category">${escapeHtml(srv.category || 'General')}</span>
      </td>
      <td>
        <span class="text-xs font-bold">${docs.length} document${docs.length === 1 ? '' : 's'}</span>
      </td>
      <td>
        <span class="text-xs">${srv.processing_days || 7} Days</span>
      </td>
      <td>
        <span class="text-xs font-bold">${srv.fee ? `$${srv.fee}` : 'Free'}</span>
      </td>
      <td>
        <span class="badge badge-info">${appsCount} submitted</span>
      </td>
      <td>
        <button type="button" class="btn btn-xs ${isAvail ? 'btn-success' : 'btn-warning'} btn-toggle-avail" data-slug="${escapeHtml(srv.slug)}" data-avail="${isAvail ? 'Active' : 'Unavailable'}">
          ${isAvail ? '● Available' : '○ Unavailable'}
        </button>
      </td>
      <td class="text-right">
        <div class="btn-group">
          <button type="button" class="btn btn-xs btn-outline btn-edit-service" data-slug="${escapeHtml(srv.slug)}">
            ✏️ Edit
          </button>
          <button type="button" class="btn btn-xs btn-danger-outline btn-delete-service" data-slug="${escapeHtml(srv.slug)}" data-name="${escapeHtml(srv.name)}" data-apps="${appsCount}">
            🗑️ Delete
          </button>
        </div>
      </td>
    `;

    // Attach row events
    const toggleBtn = tr.querySelector('.btn-toggle-avail');
    toggleBtn.addEventListener('click', () => toggleServiceAvailability(srv.slug, isAvail));

    const editBtn = tr.querySelector('.btn-edit-service');
    editBtn.addEventListener('click', () => openServiceFormModal('edit', srv));

    const deleteBtn = tr.querySelector('.btn-delete-service');
    deleteBtn.addEventListener('click', () => deleteService(srv.slug, srv.name, appsCount));

    tbody.appendChild(tr);
  });
}

async function toggleServiceAvailability(slug, currentlyAvailable) {
  const newAvail = currentlyAvailable ? 'Unavailable' : 'Active';
  try {
    const res = await apiRequest(`/admin/services/${encodeURIComponent(slug)}/availability`, {
      method: 'PATCH',
      body: { availability: newAvail }
    });
    if (res.ok && res.success) {
      showToast(`Service availability set to '${newAvail}'.`, 'success');
      await loadAdminServices();
    } else {
      showToast(res.error?.message || 'Failed to toggle availability.', 'danger');
    }
  } catch (err) {
    showToast('Network error updating service status.', 'danger');
  }
}

async function deleteService(slug, name, appsCount) {
  if (appsCount > 0) {
    showToast(`Cannot delete '${name}' because it has ${appsCount} citizen applications on record. Mark as Unavailable instead.`, 'warning');
    return;
  }

  if (!confirm(`Are you sure you want to delete the service '${name}'? This action is permanent and recorded in the audit log.`)) {
    return;
  }

  try {
    const res = await apiRequest(`/admin/services/${encodeURIComponent(slug)}`, {
      method: 'DELETE'
    });
    if (res.ok && res.success) {
      showToast(`Service '${name}' deleted successfully.`, 'success');
      await loadAdminServices();
    } else {
      showToast(res.error?.message || 'Failed to delete service.', 'danger');
    }
  } catch (err) {
    showToast('Network error deleting service.', 'danger');
  }
}

function openServiceFormModal(mode, service = null) {
  const modal = document.getElementById('service-form-modal');
  const titleEl = document.getElementById('service-modal-title');
  const modeInput = document.getElementById('service-form-mode');
  const origSlugInput = document.getElementById('service-form-orig-slug');
  const nameInput = document.getElementById('service-name-input');
  const slugInput = document.getElementById('service-slug-input');
  const catInput = document.getElementById('service-category-input');
  const availInput = document.getElementById('service-avail-input');
  const procInput = document.getElementById('service-processing-input');
  const feeInput = document.getElementById('service-fee-input');
  const descInput = document.getElementById('service-desc-input');
  const docsContainer = document.getElementById('docs-inputs-container');

  if (!modal) return;

  modeInput.value = mode;
  docsContainer.innerHTML = '';

  if (mode === 'create') {
    titleEl.textContent = 'Add New Municipal Service';
    origSlugInput.value = '';
    nameInput.value = '';
    slugInput.value = '';
    slugInput.disabled = false;
    catInput.value = 'Civil Registration';
    availInput.value = 'Available';
    procInput.value = '7';
    feeInput.value = '0';
    descInput.value = '';
    addDocInputField('Proof of Identity (Aadhaar / Voter ID / Passport)');
    addDocInputField('Proof of Address (Utility Bill / Lease Agreement)');
  } else if (service) {
    titleEl.textContent = `Edit Service: ${service.name}`;
    origSlugInput.value = service.slug;
    nameInput.value = service.name || '';
    slugInput.value = service.slug || '';
    slugInput.disabled = true; // Slug cannot be changed once created
    catInput.value = service.category || 'Civil Registration';
    availInput.value = (service.availability === 'Available' || service.availability === 'Active') ? 'Available' : 'Unavailable';
    procInput.value = service.processing_days || 7;
    feeInput.value = service.fee || 0;
    descInput.value = service.description || '';

    const docs = Array.isArray(service.required_documents) ? service.required_documents : [];
    if (docs.length === 0) {
      addDocInputField('');
    } else {
      docs.forEach(d => addDocInputField(d));
    }
  }

  modal.classList.remove('d-none');
}

function closeServiceFormModal() {
  const modal = document.getElementById('service-form-modal');
  if (modal) modal.classList.add('d-none');
}

function addDocInputField(value = '') {
  const container = document.getElementById('docs-inputs-container');
  if (!container) return;

  const div = document.createElement('div');
  div.className = 'doc-input-row flex gap-2 mb-2';
  div.innerHTML = `
    <input type="text" class="form-control doc-field-input" placeholder="e.g. Birth Attendant Certificate" value="${escapeHtml(value)}">
    <button type="button" class="btn btn-sm btn-ghost btn-remove-doc text-danger" title="Remove Document">×</button>
  `;

  div.querySelector('.btn-remove-doc').addEventListener('click', () => {
    container.removeChild(div);
  });

  container.appendChild(div);
}

async function handleServiceFormSubmit(e) {
  e.preventDefault();
  const mode = document.getElementById('service-form-mode').value;
  const origSlug = document.getElementById('service-form-orig-slug').value;
  const name = document.getElementById('service-name-input').value.trim();
  const slug = document.getElementById('service-slug-input').value.trim();
  const category = document.getElementById('service-category-input').value;
  const availability = document.getElementById('service-avail-input').value;
  const processing_days = parseInt(document.getElementById('service-processing-input').value, 10) || 7;
  const fee = parseFloat(document.getElementById('service-fee-input').value) || 0;
  const description = document.getElementById('service-desc-input').value.trim();

  // Gather required documents
  const docInputs = document.querySelectorAll('.doc-field-input');
  const required_documents = [];
  docInputs.forEach(input => {
    const val = input.value.trim();
    if (val) required_documents.push(val);
  });

  const payload = {
    name,
    category,
    availability,
    processing_days,
    fee,
    description,
    required_documents
  };
  if (slug) payload.slug = slug;

  const submitBtn = document.getElementById('modal-service-submit');
  if (submitBtn) submitBtn.disabled = true;

  try {
    let res;
    if (mode === 'create') {
      res = await apiRequest('/admin/services', {
        method: 'POST',
        body: payload
      });
    } else {
      res = await apiRequest(`/admin/services/${encodeURIComponent(origSlug)}`, {
        method: 'PUT',
        body: payload
      });
    }

    if (res.ok && res.success) {
      showToast(mode === 'create' ? 'Service created successfully!' : 'Service updated successfully!', 'success');
      closeServiceFormModal();
      await loadAdminServices();
    } else {
      showToast(res.error?.message || 'Failed to save service.', 'danger');
    }
  } catch (err) {
    showToast('Network error saving service.', 'danger');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}
