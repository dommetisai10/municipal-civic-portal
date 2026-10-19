/**
 * Homepage Logic (ES Module)
 * Connects to live backend API, loads health status, config branding, and dynamic services.
 */

import { apiRequest, showToast, getAuthUser, logoutUser } from './api.js';

document.addEventListener('DOMContentLoaded', () => {
  initMobileMenu();
  initSystemHealth();
  initPortalConfig();
  initServices();
  initAuthNav();
});

/**
 * Mobile Navigation Toggle
 */
function initMobileMenu() {
  const toggleBtn = document.getElementById('mobile-menu-toggle');
  const mainNav = document.getElementById('main-nav');
  if (toggleBtn && mainNav) {
    toggleBtn.addEventListener('click', () => {
      const isOpen = mainNav.classList.toggle('open');
      toggleBtn.setAttribute('aria-expanded', String(isOpen));
    });
  }
}

/**
 * Live Database Health Verification
 */
async function initSystemHealth() {
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  if (!dot || !text) return;

  try {
    const res = await apiRequest('/health');
    if (res.ok && res.data && res.data.database === 'connected') {
      dot.className = 'status-dot online';
      text.textContent = 'Database Connected';
    } else {
      dot.className = 'status-dot offline';
      text.textContent = 'Database Offline (HTTP 503)';
    }
  } catch (err) {
    dot.className = 'status-dot offline';
    text.textContent = 'Backend Unreachable';
  }
}

/**
 * Config-Driven Portal Metadata & Contact Details
 */
async function initPortalConfig() {
  try {
    const res = await apiRequest('/config');
    if (res.ok && res.data) {
      const { municipality_name, contact_phone, contact_email, office_address } = res.data;

      // Update title branding
      const brandElements = document.querySelectorAll('.dynamic-portal-name');
      brandElements.forEach(el => {
        el.textContent = municipality_name;
      });

      // Update contact card values
      const phoneEl = document.getElementById('contact-phone-val');
      if (phoneEl) phoneEl.textContent = contact_phone;

      const emailEl = document.getElementById('contact-email-val');
      if (emailEl) emailEl.textContent = contact_email;

      const addrEl = document.getElementById('contact-address-val');
      if (addrEl) addrEl.textContent = office_address;
    }
  } catch (err) {
    console.error('Failed to load portal configuration:', err);
  }
}

/**
 * Live Service Catalog Loader
 * STRICT CLEAN DATA RULE:
 * If zero services are in the database, displays an honest empty state box.
 */
async function initServices() {
  const container = document.getElementById('services-grid-container');
  if (!container) return;

  try {
    const res = await apiRequest('/services');
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      container.innerHTML = '';
      container.className = 'services-grid';

      res.data.forEach(service => {
        const card = document.createElement('article');
        card.className = 'service-item-card';

        const header = document.createElement('div');
        header.className = 'service-item-header';

        const title = document.createElement('h3');
        title.className = 'service-item-title';
        title.textContent = service.name;

        const tag = document.createElement('span');
        const isAvailable = service.availability === 'Available';
        tag.className = `availability-tag ${isAvailable ? 'available' : 'unavailable'}`;
        tag.textContent = service.availability || 'Unavailable';

        header.appendChild(title);
        header.appendChild(tag);

        const desc = document.createElement('p');
        desc.className = 'service-item-desc';
        desc.textContent = service.description || 'No description provided.';

        const footer = document.createElement('div');
        footer.className = 'service-item-footer';

        const docCount = document.createElement('span');
        docCount.className = 'doc-count';
        const docLen = Array.isArray(service.required_documents) ? service.required_documents.length : 0;
        docCount.textContent = `${docLen} doc${docLen === 1 ? '' : 's'} required`;

        const applyLink = document.createElement('a');
        applyLink.className = `btn btn-sm ${isAvailable ? 'btn-primary' : 'btn-secondary'}`;
        applyLink.href = isAvailable ? `apply-service.html?slug=${encodeURIComponent(service.slug)}` : '#';
        applyLink.textContent = isAvailable ? 'Apply Online' : 'Unavailable';
        if (!isAvailable) {
          applyLink.setAttribute('aria-disabled', 'true');
          applyLink.addEventListener('click', (e) => {
            e.preventDefault();
            showToast('This service is not currently available for applications.', 'warning');
          });
        }

        footer.appendChild(docCount);
        footer.appendChild(applyLink);

        card.appendChild(header);
        card.appendChild(desc);
        card.appendChild(footer);

        container.appendChild(card);
      });
    } else {
      // Honest Empty State
      container.className = '';
      container.innerHTML = `
        <div class="empty-state-box">
          <div class="empty-state-icon">📋</div>
          <h3 class="empty-state-title">No Municipal Services Published Yet</h3>
          <p class="empty-state-text">
            The municipal service catalog has not been initialized. No services are available for application at this moment.
          </p>
        </div>
      `;
    }
  } catch (err) {
    container.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-state-icon">⚠️</div>
        <h3 class="empty-state-title">Services Currently Unavailable</h3>
        <p class="empty-state-text">Unable to load services from the database.</p>
      </div>
    `;
  }
}

/**
 * Navbar Authentication State
 */
async function initAuthNav() {
  const authContainer = document.getElementById('nav-auth-actions');
  if (!authContainer) return;

  const user = await getAuthUser();
  authContainer.innerHTML = '';

  if (user) {
    // Authenticated Citizen
    const dashLink = document.createElement('a');
    dashLink.href = 'user-dashboard.html';
    dashLink.className = 'btn btn-sm btn-primary';
    dashLink.textContent = `Dashboard (${user.full_name.split(' ')[0]})`;

    const logoutBtn = document.createElement('button');
    logoutBtn.className = 'btn btn-sm btn-outline';
    logoutBtn.textContent = 'Sign Out';
    logoutBtn.addEventListener('click', async () => {
      await logoutUser();
      showToast('You have been signed out.', 'info');
      setTimeout(() => window.location.reload(), 600);
    });

    authContainer.appendChild(dashLink);
    authContainer.appendChild(logoutBtn);
  } else {
    // Guest Citizen
    const loginLink = document.createElement('a');
    loginLink.href = 'login.html';
    loginLink.className = 'btn btn-sm btn-outline';
    loginLink.textContent = 'Sign In';

    const regLink = document.createElement('a');
    regLink.href = 'register.html';
    regLink.className = 'btn btn-sm btn-primary';
    regLink.textContent = 'Register';

    authContainer.appendChild(loginLink);
    authContainer.appendChild(regLink);
  }
}
