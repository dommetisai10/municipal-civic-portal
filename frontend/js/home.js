/**
 * Homepage Logic (ES Module)
 * Connects to live backend API, loads health status, config branding, dynamic services,
 * in-page smooth scrolling with scroll-spy, search/category filtering, and interactive service detail modal.
 */

import { apiRequest, showToast, getAuthUser, logoutUser, escapeHtml } from './api.js';

let allServices = [];
let activeCategory = 'ALL';
let currentSearchQuery = '';

document.addEventListener('DOMContentLoaded', () => {
  initMobileMenu();
  initSmoothScroll();
  initScrollSpy();
  initSystemHealth();
  initPortalConfig();
  initServices();
  initAuthNav();
  initServiceModal();
});

/**
 * Mobile Navigation Toggle & Auto-Close
 */
function initMobileMenu() {
  const toggleBtn = document.getElementById('mobile-menu-toggle');
  const mainNav = document.getElementById('main-nav');
  if (toggleBtn && mainNav) {
    toggleBtn.addEventListener('click', () => {
      const isOpen = mainNav.classList.toggle('open');
      toggleBtn.setAttribute('aria-expanded', String(isOpen));
    });

    // Close mobile menu when clicking any nav link
    mainNav.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', () => {
        mainNav.classList.remove('open', 'nav-open');
        toggleBtn.setAttribute('aria-expanded', 'false');
      });
    });
  }
}

/**
 * Smooth scrolling for in-page section links with sticky navbar offset
 */
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function(e) {
      const targetId = this.getAttribute('href');
      if (!targetId || targetId === '#') return;
      
      const targetEl = document.querySelector(targetId);
      if (targetEl) {
        e.preventDefault();
        
        // Close mobile drawer if open
        const mainNav = document.getElementById('main-nav');
        const toggleBtn = document.getElementById('mobile-menu-toggle');
        if (mainNav) mainNav.classList.remove('open', 'nav-open');
        if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');

        targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        try {
          history.replaceState(null, '', targetId);
        } catch {
          // Ignore state history errors
        }
      }
    });
  });
}

/**
 * Scroll-Spy: Highlights active top navigation item based on window scroll position
 */
function initScrollSpy() {
  const sections = ['home', 'about', 'services', 'contact'];
  const navLinks = {
    home: document.getElementById('nav-link-home'),
    about: document.getElementById('nav-link-about'),
    services: document.getElementById('nav-link-services'),
    contact: document.getElementById('nav-link-contact')
  };

  function updateActiveNav() {
    const scrollPos = window.scrollY + 120; // Header offset threshold
    let currentSection = 'home';

    sections.forEach(secId => {
      const el = document.getElementById(secId);
      if (el) {
        const top = el.offsetTop;
        const height = el.offsetHeight;
        if (scrollPos >= top && scrollPos < top + height) {
          currentSection = secId;
        }
      }
    });

    // Check if scrolled near bottom of page (activate contact)
    if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 50) {
      currentSection = 'contact';
    }

    Object.keys(navLinks).forEach(secId => {
      const link = navLinks[secId];
      if (link) {
        link.classList.toggle('active', secId === currentSection);
      }
    });
  }

  window.addEventListener('scroll', updateActiveNav, { passive: true });
  // Initial check
  updateActiveNav();
}

/**
 * Live Database Health Verification with 30-Second Polling
 */
let healthPollInterval = null;

async function initSystemHealth() {
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  if (!dot || !text) return;

  try {
    const res = await apiRequest('/health');
    if (res.ok && res.data && res.data.database === 'connected') {
      dot.className = 'status-dot online';
      const latency = res.data.latency_ms !== null && res.data.latency_ms !== undefined ? ` (${res.data.latency_ms}ms)` : '';
      text.textContent = `Database Connected${latency}`;
    } else {
      dot.className = 'status-dot offline';
      text.textContent = 'Database Offline (HTTP 503)';
    }
  } catch (err) {
    dot.className = 'status-dot offline';
    text.textContent = 'Backend Unreachable';
  }

  // Set up 30-second polling interval once
  if (!healthPollInterval) {
    healthPollInterval = setInterval(initSystemHealth, 30000);
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
      if (phoneEl) phoneEl.textContent = contact_phone || '+1 (555) 019-2834';

      const emailEl = document.getElementById('contact-email-val');
      if (emailEl) emailEl.textContent = contact_email || 'citizen.helpdesk@municipality.gov';

      const addrEl = document.getElementById('contact-address-val');
      if (addrEl) addrEl.textContent = office_address || '100 Civic Center Plaza, Ward 1';
    }
  } catch (err) {
    console.error('Failed to load portal configuration:', err);
  }
}

/**
 * Live Service Catalog Loader with Search & Category Filtering
 */
async function initServices() {
  const container = document.getElementById('services-grid-container');
  if (!container) return;

  try {
    const res = await apiRequest('/services');
    if (res.ok && Array.isArray(res.data) && res.data.length > 0) {
      allServices = res.data;
      setupCatalogFilters();
      renderFilteredServices();
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

function setupCatalogFilters() {
  const searchInput = document.getElementById('home-service-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      currentSearchQuery = e.target.value.toLowerCase().trim();
      renderFilteredServices();
    });
  }

  const categoryPills = document.querySelectorAll('#category-pills .category-pill');
  categoryPills.forEach(pill => {
    pill.addEventListener('click', () => {
      categoryPills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      activeCategory = pill.getAttribute('data-category') || 'ALL';
      renderFilteredServices();
    });
  });
}

function renderFilteredServices() {
  const container = document.getElementById('services-grid-container');
  if (!container) return;

  const filtered = allServices.filter(service => {
    const srvCategory = service.category || service.department || '';
    const matchCategory = (activeCategory === 'ALL') || (srvCategory === activeCategory);
    const matchSearch = !currentSearchQuery ||
      (service.name && service.name.toLowerCase().includes(currentSearchQuery)) ||
      (service.description && service.description.toLowerCase().includes(currentSearchQuery)) ||
      (srvCategory && srvCategory.toLowerCase().includes(currentSearchQuery));
    return matchCategory && matchSearch;
  });

  if (filtered.length === 0) {
    container.className = '';
    container.innerHTML = `
      <div class="empty-state-box">
        <div class="empty-state-icon">🔍</div>
        <h3 class="empty-state-title">No Services Matching Filter</h3>
        <p class="empty-state-text">Try adjusting your search query or selecting a different category.</p>
      </div>
    `;
    return;
  }

  container.className = 'services-grid';
  container.innerHTML = '';

  filtered.forEach(service => {
    const card = document.createElement('article');
    const isAvailable = service.availability === 'Available' || service.availability === 'Active';
    card.className = `service-item-card ${isAvailable ? 'service-available' : 'service-unavailable'}`;
    card.setAttribute('tabindex', '0');
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `${service.name} - Click to view requirements`);

    const header = document.createElement('div');
    header.className = 'service-item-header';

    const categorySpan = document.createElement('span');
    categorySpan.className = 'badge badge-category';
    categorySpan.textContent = service.department || service.category || 'General';

    const tag = document.createElement('span');
    tag.className = `availability-tag ${isAvailable ? 'available' : 'unavailable'}`;
    tag.textContent = isAvailable ? 'Available' : 'Unavailable';

    header.appendChild(categorySpan);
    header.appendChild(tag);

    const title = document.createElement('h3');
    title.className = 'service-item-title';
    title.textContent = service.name;

    const desc = document.createElement('p');
    desc.className = 'service-item-desc';
    desc.textContent = service.description || 'Official municipal civic service.';

    const footer = document.createElement('div');
    footer.className = 'service-item-footer';

    const docCount = document.createElement('span');
    docCount.className = 'doc-count';
    const docLen = Array.isArray(service.required_documents) ? service.required_documents.length : 0;
    docCount.textContent = `${docLen} doc${docLen === 1 ? '' : 's'} required`;

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = `btn btn-sm ${isAvailable ? 'btn-primary' : 'btn-secondary'}`;
    applyBtn.textContent = isAvailable ? 'Apply Online' : 'Unavailable';
    if (!isAvailable) {
      applyBtn.disabled = true;
    }

    // Direct apply button action with login check
    applyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleApplyClick(service);
    });

    footer.appendChild(docCount);
    footer.appendChild(applyBtn);

    card.appendChild(header);
    card.appendChild(title);
    card.appendChild(desc);
    card.appendChild(footer);

    // Clicking anywhere on card opens detailed modal
    card.addEventListener('click', () => {
      openServiceModal(service);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openServiceModal(service);
      }
    });

    container.appendChild(card);
  });
}

/**
 * Handle Apply Online click with authentication check and returnUrl redirect
 */
async function handleApplyClick(service) {
  const isAvailable = service.availability === 'Available' || service.availability === 'Active';
  if (!isAvailable) {
    showToast('This service is currently unavailable for applications.', 'warning');
    return;
  }

  const applyUrl = `apply-service.html?slug=${encodeURIComponent(service.slug)}`;
  const user = await getAuthUser();

  if (user && user.role === 'citizen') {
    window.location.href = applyUrl;
  } else {
    // Smooth transition to login with returnUrl parameter
    window.location.href = `login.html?returnUrl=${encodeURIComponent(applyUrl)}`;
  }
}

/**
 * Service Details Interactive Modal
 */
let currentModalService = null;

function initServiceModal() {
  const modal = document.getElementById('service-detail-modal');
  const closeBtn = document.getElementById('modal-close-btn');
  const cancelBtn = document.getElementById('modal-cancel-btn');
  const applyBtn = document.getElementById('modal-apply-btn');

  if (!modal) return;

  function closeModal() {
    modal.classList.add('d-none');
    currentModalService = null;
  }

  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('d-none')) {
      closeModal();
    }
  });

  if (applyBtn) {
    applyBtn.addEventListener('click', () => {
      if (currentModalService) {
        handleApplyClick(currentModalService);
      }
    });
  }
}

function openServiceModal(service) {
  currentModalService = service;
  const modal = document.getElementById('service-detail-modal');
  if (!modal) return;

  const nameEl = document.getElementById('modal-service-name');
  const catEl = document.getElementById('modal-service-category');
  const descEl = document.getElementById('modal-service-desc');
  const procEl = document.getElementById('modal-service-processing');
  const feeEl = document.getElementById('modal-service-fee');
  const statusEl = document.getElementById('modal-service-status');
  const docsList = document.getElementById('modal-service-docs');
  const applyBtn = document.getElementById('modal-apply-btn');

  if (nameEl) nameEl.textContent = service.name;
  if (catEl) catEl.textContent = service.department || service.category || 'General';
  if (descEl) descEl.textContent = service.description || 'No description provided.';
  if (procEl) procEl.textContent = `${service.processing_days || 7} Working Days`;
  if (feeEl) feeEl.textContent = service.fee ? `$${service.fee}` : 'Free of Charge';

  const isAvailable = service.availability === 'Available' || service.availability === 'Active';
  if (statusEl) {
    statusEl.textContent = isAvailable ? 'Active for Applications' : 'Temporarily Unavailable';
    statusEl.className = isAvailable ? 'text-success font-bold' : 'text-warning font-bold';
  }

  if (docsList) {
    docsList.innerHTML = '';
    const docs = Array.isArray(service.required_documents) ? service.required_documents : [];
    if (docs.length === 0) {
      docsList.innerHTML = '<li class="text-muted">No physical documents required. Instant digital verification.</li>';
    } else {
      docs.forEach(doc => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="check-icon" aria-hidden="true">✓</span> <span>${escapeHtml(doc)}</span>`;
        docsList.appendChild(li);
      });
    }
  }

  if (applyBtn) {
    applyBtn.disabled = !isAvailable;
    applyBtn.textContent = isAvailable ? 'Apply Online →' : 'Currently Unavailable';
  }

  modal.classList.remove('d-none');
}

/**
 * Navbar Authentication State
 */
function renderGuestNav(authContainer) {
  authContainer.innerHTML = '';
  const loginLink = document.createElement('a');
  loginLink.href = 'login.html';
  loginLink.className = 'btn btn-sm btn-outline';
  loginLink.id = 'nav-login-btn';
  loginLink.textContent = 'Sign In';

  const regLink = document.createElement('a');
  regLink.href = 'register.html';
  regLink.className = 'btn btn-sm btn-primary';
  regLink.id = 'nav-register-btn';
  regLink.textContent = 'Register';

  authContainer.appendChild(loginLink);
  authContainer.appendChild(regLink);
}

function renderAuthNav(authContainer, user) {
  authContainer.innerHTML = '';
  const isAdmin = user.role === 'admin' || user.role === 'super_admin' || Boolean(user.admin_role);
  const dashUrl = isAdmin ? 'admin-dashboard.html' : 'user-dashboard.html';
  const dashLink = document.createElement('a');
  dashLink.href = dashUrl;
  dashLink.className = 'btn btn-sm btn-primary';
  dashLink.id = 'nav-dashboard-btn';
  const firstName = (user.full_name || user.name || (isAdmin ? 'Admin' : 'User')).split(' ')[0];
  dashLink.textContent = `Dashboard (${firstName})`;

  const logoutBtn = document.createElement('button');
  logoutBtn.className = 'btn btn-sm btn-outline btn-signout';
  logoutBtn.id = 'nav-logout-btn';
  logoutBtn.textContent = 'Sign Out';
  logoutBtn.setAttribute('title', 'Sign out of your session');

  logoutBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    await logoutUser({
      buttonEl: logoutBtn,
      onImmediate: () => {
        // Immediately flip the navbar to guest state without requiring a page refresh
        renderGuestNav(authContainer);
      }
    });
  });

  authContainer.appendChild(dashLink);
  authContainer.appendChild(logoutBtn);
}

async function initAuthNav() {
  const authContainer = document.getElementById('nav-auth-actions');
  if (!authContainer) return;

  const user = await getAuthUser();
  if (user && user.authenticated !== false && (user.id || user._id || user.email)) {
    renderAuthNav(authContainer, user);
  } else {
    renderGuestNav(authContainer);
  }
}
