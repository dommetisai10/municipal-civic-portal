/**
 * API Client & Shared Frontend Utilities
 * Native Fetch API with dual auth support (credentials: 'include' + Bearer token in localStorage),
 * dynamic host resolution, CSRF auto-injection, and response contract validation.
 */

// Cached CSRF token
let cachedCsrfToken = null;

import { CONFIG } from './config.js';

/**
 * Resolves full API endpoint whether called with '/services', '/api/services', or absolute URL.
 * Automatically resolves against CONFIG.getApiBaseUrl() for seamless Vercel <-> Render deployment.
 */
export function resolveUrl(endpoint) {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }
  const baseUrl = CONFIG.getApiBaseUrl();
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;

  if (cleanEndpoint.startsWith('/api/')) {
    return `${baseUrl}${cleanEndpoint}`;
  }
  if (cleanEndpoint === '/api') {
    return `${baseUrl}/api`;
  }
  return `${baseUrl}/api${cleanEndpoint}`;
}

/**
 * LocalStorage Helpers for persistent token and citizen session
 */
export function getStoredToken() {
  try {
    return localStorage.getItem('msp_token') || null;
  } catch {
    return null;
  }
}

export function setStoredToken(token) {
  try {
    if (token) {
      localStorage.setItem('msp_token', token);
    } else {
      localStorage.removeItem('msp_token');
    }
  } catch (err) {
    console.warn('Could not persist auth token to localStorage:', err);
  }
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem('msp_user');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.authenticated === false || (!parsed.id && !parsed._id && !parsed.email)) {
      try { localStorage.removeItem('msp_user'); } catch (_) {}
      return null;
    }
    if (parsed && !parsed.role && parsed.user && parsed.user.role) {
      return { ...parsed, ...parsed.user };
    }
    return parsed;
  } catch {
    return null;
  }
}

export function setStoredUser(user, token = null) {
  try {
    if (user && user.authenticated !== false && (user.id || user._id || user.email || (user.user && (user.user.id || user.user._id)))) {
      const normalized = (user.user && !user.role) ? { ...user, ...user.user } : user;
      localStorage.setItem('msp_user', JSON.stringify(normalized));
    } else {
      localStorage.removeItem('msp_user');
    }
    if (token) {
      localStorage.setItem('msp_token', token);
    }
  } catch (err) {
    console.warn('Could not persist user session to localStorage:', err);
  }
}

export function clearStoredAuth() {
  try {
    // 1. Purge all known tokens and user session data from localStorage
    const keys = [
      'msp_user',
      'msp_token',
      'msp_admin_token',
      'msp_csrf_token',
      'token',
      'user',
      'admin_token',
      'jwt_token'
    ];
    keys.forEach((k) => {
      try { localStorage.removeItem(k); } catch (_) {}
    });

    // 2. Clear sessionStorage completely
    try { sessionStorage.clear(); } catch (_) {}

    // 3. Clear all accessible document cookies across paths
    if (typeof document !== 'undefined' && document.cookie) {
      const cookieList = document.cookie.split(';');
      for (const item of cookieList) {
        const eqPos = item.indexOf('=');
        const name = eqPos > -1 ? item.substring(0, eqPos).trim() : item.trim();
        if (name) {
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax`;
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/api;SameSite=Lax`;
          document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
        }
      }
    }
  } catch (err) {
    console.warn('Could not clear auth storage:', err);
  }
  cachedCsrfToken = null;
}

/**
 * Updates the cached session CSRF token manually if received in login/refresh response.
 */
export function setCachedCsrfToken(token) {
  cachedCsrfToken = token;
  try {
    if (token) {
      localStorage.setItem('msp_csrf_token', token);
    }
  } catch {
    // Ignore storage errors
  }
}

/**
 * Fetches or refreshes the session CSRF token.
 */
export async function getCsrfToken() {
  if (cachedCsrfToken) return cachedCsrfToken;
  try {
    const stored = localStorage.getItem('msp_csrf_token');
    if (stored) {
      cachedCsrfToken = stored;
      return cachedCsrfToken;
    }
  } catch {
    // Continue to network fetch
  }

  try {
    const headers = {};
    const token = getStoredToken();
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(resolveUrl('/auth/csrf-token'), {
      method: 'GET',
      credentials: 'include',
      headers
    });
    const result = await response.json();
    if (result.success && result.data && result.data.csrf_token) {
      cachedCsrfToken = result.data.csrf_token;
      setCachedCsrfToken(cachedCsrfToken);
      return cachedCsrfToken;
    }
  } catch (err) {
    console.error('Failed to obtain CSRF token:', err);
  }
  return null;
}

// Cold-Start Waking Banner State
let wakingBannerEl = null;

function ensureWakingBanner() {
  if (typeof document === 'undefined') return null;
  if (!wakingBannerEl) {
    wakingBannerEl = document.getElementById('msp-waking-banner');
  }
  if (!wakingBannerEl) {
    wakingBannerEl = document.createElement('div');
    wakingBannerEl.id = 'msp-waking-banner';
    wakingBannerEl.setAttribute('role', 'status');
    wakingBannerEl.setAttribute('aria-live', 'polite');
    wakingBannerEl.style.cssText = `
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%) translateY(-20px);
      z-index: 99999;
      background: linear-gradient(135deg, #1e3a8a, #2563eb);
      color: #ffffff;
      padding: 10px 22px;
      border-radius: 9999px;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.3);
      font-family: 'Inter', -apple-system, sans-serif;
      font-size: 13.5px;
      font-weight: 500;
      display: flex;
      align-items: center;
      gap: 10px;
      transition: opacity 0.3s ease, transform 0.3s ease;
      opacity: 0;
      pointer-events: none;
    `;
    wakingBannerEl.innerHTML = `
      <span style="width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:#fff;border-radius:50%;display:inline-block;animation:mspSpin 0.8s linear infinite;"></span>
      <span id="msp-waking-text">⚡ Server is waking up (Render free tier, ~30s)... Please wait</span>
      <style>@keyframes mspSpin { to { transform: rotate(360deg); } }</style>
    `;
    document.body.appendChild(wakingBannerEl);
  }
  return wakingBannerEl;
}

export function showWakingBanner(message = '⚡ Server is waking up on Render (free tier, ~30s)... Please wait') {
  const el = ensureWakingBanner();
  if (!el) return;
  const textEl = document.getElementById('msp-waking-text');
  if (textEl) textEl.textContent = message;
  el.style.opacity = '1';
  el.style.transform = 'translateX(-50%) translateY(0)';
}

export function hideWakingBanner(successMessage = null) {
  const el = ensureWakingBanner();
  if (!el) return;
  if (successMessage) {
    const textEl = document.getElementById('msp-waking-text');
    if (textEl) textEl.textContent = successMessage;
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transform = 'translateX(-50%) translateY(-20px)';
    }, 1500);
  } else {
    el.style.opacity = '0';
    el.style.transform = 'translateX(-50%) translateY(-20px)';
  }
}

/**
 * Core HTTP Request Wrapper using Fetch API with cold-start detection and automatic retry.
 * Automatically injects Authorization header, CSRF tokens, and credentials: 'include'.
 */
export async function apiRequest(endpoint, options = {}, retries = 3, backoffMs = 2500) {
  const url = resolveUrl(endpoint);
  const method = (options.method || 'GET').toUpperCase();
  
  const headers = new Headers(options.headers || {});
  
  // Attach Bearer token if present in localStorage
  const token = getStoredToken();
  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  // State-changing requests require a CSRF token
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const csrfToken = await getCsrfToken();
    if (csrfToken && !headers.has('X-CSRF-Token')) {
      headers.set('X-CSRF-Token', csrfToken);
    }
  }

  // Set Content-Type: application/json if sending a JSON body (and not FormData)
  if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
    if (typeof options.body === 'object') {
      options.body = JSON.stringify(options.body);
    }
  }

  const fetchConfig = {
    ...options,
    method,
    headers,
    credentials: 'include'
  };

  // Cold-start timer: trigger banner if request takes > 3.5s
  let hasShownWaking = false;
  const wakingTimeout = setTimeout(() => {
    hasShownWaking = true;
    showWakingBanner('⚡ Server is waking up (Render free tier, ~30-50s)... Please wait');
  }, 3500);

  try {
    const response = await fetch(url, fetchConfig);
    clearTimeout(wakingTimeout);

    if (hasShownWaking) {
      hideWakingBanner('✅ Server connected!');
    }

    // Auto-retry if container returned 502/503/504 while booting up
    if ([502, 503, 504].includes(response.status) && retries > 0) {
      showWakingBanner(`⚡ Server booting (retrying in ${(backoffMs / 1000).toFixed(0)}s)...`);
      await new Promise((res) => setTimeout(res, backoffMs));
      return apiRequest(endpoint, options, retries - 1, backoffMs * 1.5);
    }

    const result = await response.json().catch(() => null);

    if (!result) {
      throw new Error(`Server returned HTTP ${response.status} with an invalid JSON response.`);
    }

    // Refresh cached CSRF token if returned in payload
    if (result.data && result.data.csrf_token) {
      setCachedCsrfToken(result.data.csrf_token);
    }

    // Refresh auth token if returned in payload
    if (result.data && result.data.token) {
      setStoredToken(result.data.token);
    }

    return {
      ok: response.ok,
      status: response.status,
      ...result
    };
  } catch (err) {
    clearTimeout(wakingTimeout);

    // If network error occurred during cold-start, retry with exponential backoff
    if (retries > 0) {
      showWakingBanner(`⚡ Connecting to server (attempt ${4 - retries}/3)...`);
      await new Promise((res) => setTimeout(res, backoffMs));
      return apiRequest(endpoint, options, retries - 1, backoffMs * 1.5);
    }

    if (hasShownWaking) {
      hideWakingBanner();
    }

    return {
      ok: false,
      status: 0,
      success: false,
      data: null,
      error: {
        code: 'NETWORK_ERROR',
        message: err.message || 'Network connection failed. Please verify that the backend server is running.',
        fields: null
      }
    };
  }
}

/**
 * Direct alias for apiRequest used across modules.
 */
export const apiFetch = apiRequest;

/**
 * Convenience GET helper.
 */
export async function apiGet(endpoint, options = {}) {
  return apiRequest(endpoint, { ...options, method: 'GET' });
}

/**
 * Convenience POST helper.
 */
export async function apiPost(endpoint, body = {}, options = {}) {
  return apiRequest(endpoint, { ...options, method: 'POST', body });
}

/**
 * Live database connectivity health check.
 */
export async function checkDbHealth() {
  try {
    const res = await apiRequest('/health');
    return Boolean(res.ok && res.success && res.data && res.data.database === 'connected');
  } catch {
    return false;
  }
}

/**
 * Updates UI database status indicator pill across all pages.
 */
export function updateDbStatusPill(isHealthy, latencyMs = null) {
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  if (!dot || !text) return;
  if (isHealthy) {
    dot.className = 'status-dot online';
    text.textContent = latencyMs ? `Database Connected (${latencyMs}ms)` : 'Database Connected';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'Database Offline';
  }
}

/**
 * Starts automatic 30-second polling of /api/health and updates UI indicators
 */
export function startDbHealthPolling(intervalMs = 30000) {
  const runPoll = async () => {
    try {
      const res = await apiRequest('/health');
      const isHealthy = Boolean(res.ok && res.success && res.data && res.data.database === 'connected');
      const latency = res.data?.latency_ms || null;
      updateDbStatusPill(isHealthy, latency);
    } catch {
      updateDbStatusPill(false);
    }
  };
  runPoll();
  return setInterval(runPoll, intervalMs);
}

/**
 * Toast Notification Component
 */
export function showToast(message, type = 'info', duration = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'true');
    document.body.appendChild(container);
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'status');

  const textNode = document.createTextNode(message);
  toast.appendChild(textNode);

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, duration);
}

/**
 * Escapes plain text for safe rendering into HTML (output escaping).
 */
export function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const escapeHtml = escapeHTML;

/**
 * Checks authentication status for the active citizen or administrator.
 * Verifies live with /auth/me, updates localStorage, and provides seamless fallback.
 */
export async function getAuthUser() {
  let res = await apiRequest('/auth/me');

  // If live check on /auth/me returned 401 or not ok, try /admin/auth/me for admin session
  if (!res.ok || !res.success || !res.data) {
    try {
      const adminRes = await apiRequest('/admin/auth/me');
      if (adminRes.ok && adminRes.success && adminRes.data) {
        res = adminRes;
      }
    } catch (_) {}
  }

  // If live check returned explicitly unauthenticated or 401
  if (res.status === 401 || (res.data && res.data.authenticated === false)) {
    clearStoredAuth();
    return null;
  }

  // Only consider authenticated if res.data has truthful user details and not authenticated: false
  if (res.ok && res.success && res.data && res.data.authenticated !== false && (res.data.id || res.data._id || (res.data.user && (res.data.user.id || res.data.user._id)))) {
    const rawData = res.data;
    const userData = (rawData.user && !rawData.role) ? { ...rawData, ...rawData.user } : rawData;
    if (!userData.admin_role && ['admin', 'super_admin', 'officer', 'viewer'].includes(userData.role)) {
      userData.admin_role = userData.role;
    }
    const token = userData.token || getStoredToken();
    setStoredUser(userData, token);
    return userData;
  }

  // If network error (backend unreachable / offline), fallback to validated stored user only if token exists
  const token = getStoredToken();
  if (token && res.status === 0) {
    const stored = getStoredUser();
    if (stored && stored.authenticated !== false) {
      if (!stored.admin_role && ['admin', 'super_admin', 'officer', 'viewer'].includes(stored.role)) {
        stored.admin_role = stored.role;
      }
      return stored;
    }
  }

  clearStoredAuth();
  return null;
}

/**
 * Universal Sign Out Handler.
 * - Shows loading feedback on trigger button.
 * - Immediately purges localStorage, sessionStorage, and all browser cookies.
 * - Executes onImmediate callback (e.g. instantly switches navbar to Login/Register without page refresh).
 * - Fires backend logout request to clear HTTP-only server cookies and sessions.
 * - Displays "Signed out successfully" toast.
 * - If redirect path is provided, navigates using window.location.replace so Back button cannot return.
 */
export async function logoutUser(options = {}) {
  const { redirect = null, onImmediate = null, buttonEl = null } = options;

  // 1. Immediate UI loading state on button if provided
  let originalBtnText = '';
  if (buttonEl) {
    buttonEl.disabled = true;
    originalBtnText = buttonEl.textContent;
    buttonEl.textContent = 'Signing Out...';
    buttonEl.classList.add('loading');
  }

  // 2. Immediately purge all local client-side credentials
  clearStoredAuth();

  // 3. Immediately trigger UI update callback (e.g. switch navbar without page reload)
  if (typeof onImmediate === 'function') {
    try {
      onImmediate();
    } catch (cbErr) {
      console.warn('Logout onImmediate callback error:', cbErr);
    }
  }

  // 4. Notify backend to clear server-side session and cookies (non-blocking)
  try {
    await fetch(resolveUrl('/auth/logout'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (_) {}

  try {
    await fetch(resolveUrl('/admin/auth/logout'), {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (_) {}

  // 5. Toast notification
  showToast('Signed out successfully.', 'info');

  // 6. Navigation redirect or reset button
  if (redirect) {
    setTimeout(() => {
      // Use replace to eliminate protected page from history so Back button cannot return
      window.location.replace(redirect);
    }, 350);
  } else if (buttonEl) {
    setTimeout(() => {
      buttonEl.disabled = false;
      buttonEl.textContent = originalBtnText || 'Sign Out';
      buttonEl.classList.remove('loading');
    }, 400);
  }

  return { success: true };
}
