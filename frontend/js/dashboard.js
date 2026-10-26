/**
 * Citizen Dashboard Client Module (ES Module)
 * Fetches live aggregations from /api/dashboard/user, lists full submitted applications
 * from /api/applications, grievances from /api/complaints/my, and enforces clean empty states.
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

  // Populate user display info (compact in navbar, full in drawer & tooltip)
  const fullName = currentUser.full_name || currentUser.name || currentUser.email || 'Citizen';
  const firstName = fullName.includes('@') ? fullName.split('@')[0] : fullName.split(' ')[0];
  const nameEl = document.getElementById('user-display-name');
  if (nameEl) {
    nameEl.textContent = firstName;
    nameEl.title = fullName;
  }

  const sidebarNameEl = document.getElementById('sidebar-user-name');
  if (sidebarNameEl) sidebarNameEl.textContent = fullName;

  initSidebarNavigation();
  initLogoutButtons();
  initSystemHealth();
  await loadDashboardData();
  await loadAllApplications();
  await loadAllComplaints();
  initProfileForm();
  initPasswordForm();

  // Support direct URL hash routing (e.g. user-dashboard.html#applications)
  if (window.location.hash) {
    const sectionFromHash = window.location.hash.replace('#', '').trim();
    if (sectionFromHash && document.getElementById(`section-${sectionFromHash}`)) {
      switchSection(sectionFromHash);
    }
  }
});

/**
 * System Health Indicator in Header (30-Second Polling)
 */
async function initSystemHealth() {
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  if (!dot || !text) return;

  const poll = async () => {
    try {
      const res = await apiRequest('/health');
      if (res.ok && res.data && res.data.database === 'connected') {
        dot.className = 'status-dot online';
        text.textContent = res.data.latency_ms ? `DB Live (${res.data.latency_ms}ms)` : 'DB Live';
      } else {
        dot.className = 'status-dot offline';
        text.textContent = 'DB Offline';
      }
    } catch {
      dot.className = 'status-dot offline';
      text.textContent = 'DB Offline';
    }
  };

  poll();
  setInterval(poll, 30000);
}

/**
 * Sidebar Tab Switching & Mobile Drawer Controls
 */
function initSidebarNavigation() {
  const mobileToggle = document.getElementById('mobile-sidebar-toggle');
  const sidebar = document.getElementById('dashboard-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const closeBtn = document.getElementById('sidebar-close-btn');

  function openSidebar() {
    if (sidebar) sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('active');
    if (mobileToggle) mobileToggle.setAttribute('aria-expanded', 'true');
    document.body.classList.add('sidebar-open');
  }

  function closeSidebar() {
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('active');
    if (mobileToggle) mobileToggle.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('sidebar-open');
  }

  if (mobileToggle) {
    mobileToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (sidebar && sidebar.classList.contains('open')) {
        closeSidebar();
      } else {
        openSidebar();
      }
    });
  }

  if (closeBtn) closeBtn.addEventListener('click', closeSidebar);
  if (backdrop) backdrop.addEventListener('click', closeSidebar);

  // Close sidebar on ESC key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar && sidebar.classList.contains('open')) {
      closeSidebar();
    }
  });

  const links = document.querySelectorAll('.sidebar-link[data-section]');
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetSection = link.getAttribute('data-section');
      switchSection(targetSection);
      if (window.innerWidth <= 960) {
        closeSidebar();
      }
    });
  });

  const viewAllBtns = document.querySelectorAll('.view-all-btn');
  viewAllBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const target = btn.getAttribute('data-target');
      switchSection(target);
      if (window.innerWidth <= 960) {
        closeSidebar();
      }
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

  if (sectionName === 'applications') {
    loadAllApplications();
  } else if (sectionName === 'complaints') {
    loadAllComplaints();
  } else if (sectionName === 'notifications') {
    loadNotifications();
  } else if (sectionName === 'overview') {
    loadDashboardData();
  }
}

/**
 * Loads Live Dashboard Numbers and Recent Tables
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

    // 4. Render Recent Tables on Overview
    renderApplicationsTable('recent-apps-container', recent_applications, true);
    renderComplaintsTable('recent-cmps-container', recent_complaints, true);
  } else {
    showToast('Failed to load dashboard metrics from database.', 'error');
  }
}

/**
 * Loads All Citizen Applications for the "My Applications" tab
 */
async function loadAllApplications() {
  const container = document.getElementById('all-apps-container');
  if (!container) return;

  const res = await apiRequest('/applications');
  if (res.ok && res.success && Array.isArray(res.data)) {
    renderApplicationsTable('all-apps-container', res.data, false);
  }
}

/**
 * Loads All Citizen Complaints for the "My Complaints" tab
 */
async function loadAllComplaints() {
  const container = document.getElementById('all-cmps-container');
  if (!container) return;

  const res = await apiRequest('/complaints/my');
  if (res.ok && res.success && Array.isArray(res.data)) {
    renderComplaintsTable('all-cmps-container', res.data, false);
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
      const updatedFirstName = full_name.includes('@') ? full_name.split('@')[0] : full_name.split(' ')[0];
      const updatedNameEl = document.getElementById('user-display-name');
      if (updatedNameEl) {
        updatedNameEl.textContent = updatedFirstName;
        updatedNameEl.title = full_name;
      }
      setText('sidebar-user-name', full_name);
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
 * Logout Handlers with Back-Button Protection
 */
function initLogoutButtons() {
  const logoutBtns = [
    document.getElementById('dash-logout-btn'),
    document.getElementById('sidebar-logout-btn')
  ];

  logoutBtns.forEach(btn => {
    if (btn) {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        await logoutUser({
          buttonEl: btn,
          redirect: 'index.html'
        });
      });
    }
  });

  // Prevent browser back button from showing cached authenticated view after sign out
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && !localStorage.getItem('msp_token')) {
      window.location.replace('login.html');
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
