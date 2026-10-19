/**
 * Citizen Dashboard Client Module (ES Module)
 * Fetches live aggregations from /api/dashboard/user and enforces clean empty states.
 */

import { apiRequest, showToast, getAuthUser, logoutUser } from './api.js';

let currentUser = null;

document.addEventListener('DOMContentLoaded', async () => {
  currentUser = await getAuthUser();
  if (!currentUser) {
    window.location.href = 'login.html';
    return;
  }

  if (currentUser.role === 'admin') {
    window.location.href = 'admin-dashboard.html';
    return;
  }

  // Populate user display info
  const nameEl = document.getElementById('user-display-name');
  if (nameEl) nameEl.textContent = currentUser.full_name;

  initSidebarNavigation();
  initLogoutButtons();
  initSystemHealth();
  await loadDashboardData();
  initProfileForm();
  initPasswordForm();
});

/**
 * System Health Indicator in Header
 */
async function initSystemHealth() {
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  if (!dot || !text) return;

  const res = await apiRequest('/health');
  if (res.ok && res.data && res.data.database === 'connected') {
    dot.className = 'status-dot online';
    text.textContent = 'DB Live';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'DB Offline';
  }
}

/**
 * Sidebar Tab Switching
 */
function initSidebarNavigation() {
  const links = document.querySelectorAll('.sidebar-link[data-section]');
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetSection = link.getAttribute('data-section');
      switchSection(targetSection);
    });
  });

  const viewAllBtns = document.querySelectorAll('.view-all-btn');
  viewAllBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const target = btn.getAttribute('data-target');
      switchSection(target);
    });
  });

  const bellBtn = document.getElementById('notif-bell-btn');
  if (bellBtn) {
    bellBtn.addEventListener('click', () => {
      switchSection('notifications');
    });
  }
}

function switchSection(sectionName) {
  // Update sidebar active link
  document.querySelectorAll('.sidebar-link[data-section]').forEach(l => {
    l.classList.toggle('active', l.getAttribute('data-section') === sectionName);
  });

  // Toggle main sections
  document.querySelectorAll('.dash-section').forEach(sec => {
    sec.style.display = 'none';
  });

  const target = document.getElementById(`section-${sectionName}`);
  if (target) {
    target.style.display = 'block';
  }

  if (sectionName === 'notifications') {
    loadNotifications();
  }
}

/**
 * Loads Live Dashboard Numbers and Tables
 * STRICT CLEAN DATA:
 * If no records exist, counters are 0 and empty-state boxes are rendered.
 */
async function loadDashboardData() {
  const res = await apiRequest('/dashboard/user');

  if (res.ok && res.success && res.data) {
    const { stats, recent_applications, recent_complaints } = res.data;

    // 1. Applications Stats
    setText('stat-total-apps', stats.applications.total);
    setText('stat-pending-apps', stats.applications.pending);
    setText('stat-approved-apps', stats.applications.approved);
    setText('stat-rejected-apps', stats.applications.rejected);

    // 2. Complaints Stats
    setText('stat-total-cmps', stats.complaints.total);
    setText('stat-resolved-cmps', stats.complaints.resolved);

    // 3. Notifications Badge
    const unread = stats.unread_notifications || 0;
    setText('unread-notif-count', unread);
    setText('sidebar-notif-badge', unread);

    // 4. Render Tables
    renderApplicationsTable('recent-apps-container', recent_applications, true);
    renderApplicationsTable('all-apps-container', recent_applications, false);

    renderComplaintsTable('recent-cmps-container', recent_complaints, true);
    renderComplaintsTable('all-cmps-container', recent_complaints, false);
  } else {
    showToast('Failed to load dashboard metrics from database.', 'error');
  }
}

function renderApplicationsTable(containerId, apps, isCompact) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!apps || apps.length === 0) {
    container.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-state-icon">📄</div>
        <h3 class="empty-state-title">No applications submitted yet.</h3>
        <p class="empty-state-text">You have not submitted any civic service applications.</p>
        <div style="margin-top: 16px;">
          <a href="services.html" class="btn btn-sm btn-primary">Apply for a Service</a>
        </div>
      </div>
    `;
    return;
  }

  let html = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Application ID</th>
          <th>Service Name</th>
          <th>Status</th>
          <th>Submitted Date</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
  `;

  apps.forEach(app => {
    const dateFormatted = app.created_at ? new Date(app.created_at).toLocaleDateString() : 'N/A';
    const badgeClass = getStatusBadgeClass(app.status);

    html += `
      <tr>
        <td><strong>${escapeText(app.application_id)}</strong></td>
        <td>${escapeText(app.service_name || 'Municipal Service')}</td>
        <td><span class="status-badge ${badgeClass}">${escapeText(app.status)}</span></td>
        <td>${dateFormatted}</td>
        <td>
          <a href="track-status.html?id=${encodeURIComponent(app.application_id)}" class="link-action">Track &rarr;</a>
        </td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

function renderComplaintsTable(containerId, complaints, isCompact) {
  const container = document.getElementById(containerId);
  if (!container) return;

  if (!complaints || complaints.length === 0) {
    container.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-state-icon">🛠️</div>
        <h3 class="empty-state-title">No complaints found.</h3>
        <p class="empty-state-text">You have not submitted any civic complaints.</p>
        <div style="margin-top: 16px;">
          <a href="submit-complaint.html" class="btn btn-sm btn-secondary">Report a Grievance</a>
        </div>
      </div>
    `;
    return;
  }

  let html = `
    <table class="data-table">
      <thead>
        <tr>
          <th>Complaint ID</th>
          <th>Category</th>
          <th>Title</th>
          <th>Status</th>
          <th>Date</th>
          <th>Action</th>
        </tr>
      </thead>
      <tbody>
  `;

  complaints.forEach(cmp => {
    const dateFormatted = cmp.created_at ? new Date(cmp.created_at).toLocaleDateString() : 'N/A';
    const badgeClass = getStatusBadgeClass(cmp.status);

    html += `
      <tr>
        <td><strong>${escapeText(cmp.complaint_id)}</strong></td>
        <td>${escapeText(cmp.category)}</td>
        <td>${escapeText(cmp.title)}</td>
        <td><span class="status-badge ${badgeClass}">${escapeText(cmp.status)}</span></td>
        <td>${dateFormatted}</td>
        <td>
          <a href="track-status.html?id=${encodeURIComponent(cmp.complaint_id)}" class="link-action">Track &rarr;</a>
        </td>
      </tr>
    `;
  });

  html += `</tbody></table>`;
  container.innerHTML = html;
}

/**
 * Loads User Notifications
 */
async function loadNotifications() {
  const container = document.getElementById('notifications-list-container');
  if (!container) return;

  container.innerHTML = `<p style="padding: 20px; color: var(--neutral-500);">Loading notifications...</p>`;

  const res = await apiRequest('/notifications');
  if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
    let html = `<ul class="notifications-list">`;
    res.data.forEach(notif => {
      const dateFormatted = notif.created_at ? new Date(notif.created_at).toLocaleString() : '';
      const readClass = notif.is_read ? 'read' : 'unread';

      html += `
        <li class="notification-item ${readClass}" id="notif-${notif.id}">
          <div class="notif-content">
            <div class="notif-message">${escapeText(notif.message)}</div>
            <div class="notif-meta">
              <span>${dateFormatted}</span>
              ${notif.related_id ? `<span>Reference: <code>${escapeText(notif.related_id)}</code></span>` : ''}
            </div>
          </div>
          ${!notif.is_read ? `
            <button class="btn btn-sm btn-outline mark-read-btn" data-id="${notif.id}">
              Mark Read
            </button>
          ` : ''}
        </li>
      `;
    });
    html += `</ul>`;
    container.innerHTML = html;

    // Attach mark-read handlers
    container.querySelectorAll('.mark-read-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const notifId = btn.getAttribute('data-id');
        const updateRes = await apiRequest(`/notifications/${notifId}/read`, { method: 'PATCH' });
        if (updateRes.ok) {
          showToast('Notification marked as read.', 'info');
          loadNotifications();
          loadDashboardData();
        }
      });
    });
  } else {
    container.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-state-icon">🔔</div>
        <h3 class="empty-state-title">No notifications available.</h3>
        <p class="empty-state-text">You have no new alerts or status updates at this time.</p>
      </div>
    `;
  }
}

/**
 * Profile Management Form
 */
function initProfileForm() {
  const form = document.getElementById('profile-form');
  if (!form || !currentUser) return;

  document.getElementById('prof-fullname').value = currentUser.full_name || '';
  document.getElementById('prof-email').value = currentUser.email || '';
  document.getElementById('prof-mobile').value = currentUser.mobile || '';
  document.getElementById('prof-address').value = currentUser.address || '';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const full_name = document.getElementById('prof-fullname').value.trim();
    const mobile = document.getElementById('prof-mobile').value.trim();
    const address = document.getElementById('prof-address').value.trim();

    const saveBtn = document.getElementById('save-profile-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const res = await apiRequest('/auth/profile', {
      method: 'PATCH',
      body: { full_name, mobile, address }
    });

    saveBtn.disabled = false;
    saveBtn.textContent = 'Update Profile';

    if (res.ok && res.success) {
      showToast('Profile updated successfully!', 'success');
      currentUser.full_name = full_name;
      currentUser.mobile = mobile;
      currentUser.address = address;
      setText('user-display-name', full_name);
    } else {
      const msg = (res.error && res.error.message) || 'Failed to update profile.';
      showToast(msg, 'error');
    }
  });
}

/**
 * Password Update Form
 */
function initPasswordForm() {
  const form = document.getElementById('password-change-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current_password = document.getElementById('pwd-current').value;
    const new_password = document.getElementById('pwd-new').value;
    const confirm_password = document.getElementById('pwd-confirm').value;

    if (new_password !== confirm_password) {
      showToast('New passwords do not match.', 'error');
      return;
    }

    if (new_password.length < 8) {
      showToast('New password must be at least 8 characters.', 'error');
      return;
    }

    const saveBtn = document.getElementById('save-password-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Updating...';

    const res = await apiRequest('/auth/change-password', {
      method: 'POST',
      body: { current_password, new_password }
    });

    saveBtn.disabled = false;
    saveBtn.textContent = 'Update Password';

    if (res.ok && res.success) {
      showToast('Password changed successfully!', 'success');
      form.reset();
    } else {
      const msg = (res.error && res.error.message) || 'Failed to update password.';
      showToast(msg, 'error');
    }
  });
}

/**
 * Logout Handlers
 */
function initLogoutButtons() {
  const logoutBtns = [
    document.getElementById('dash-logout-btn'),
    document.getElementById('sidebar-logout-btn')
  ];

  logoutBtns.forEach(btn => {
    if (btn) {
      btn.addEventListener('click', async () => {
        await logoutUser();
        showToast('Signed out successfully.', 'info');
        setTimeout(() => {
          window.location.href = 'index.html';
        }, 500);
      });
    }
  });
}

function getStatusBadgeClass(status) {
  switch (status) {
    case 'Approved':
    case 'Resolved':
    case 'Completed':
      return 'badge-success';
    case 'Rejected':
      return 'badge-danger';
    case 'Under Review':
    case 'In Progress':
    case 'Assigned':
      return 'badge-warning';
    default:
      return 'badge-info';
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(text);
}

function escapeText(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
