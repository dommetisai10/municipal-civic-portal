/**
 * API Client & Shared Frontend Utilities
 * Native Fetch API with credentials: 'include', CSRF auto-injection, and response contract validation.
 */

// Cached CSRF token
let cachedCsrfToken = null;

/**
 * Resolves full API endpoint whether called with '/services', '/api/services', or absolute URL.
 */
function resolveUrl(endpoint) {
  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return endpoint;
  }
  const isPort5000 = window.location.origin.includes('5000');
  const basePrefix = isPort5000 ? '' : 'http://127.0.0.1:5000';
  
  if (endpoint.startsWith('/api/')) {
    return `${basePrefix}${endpoint}`;
  }
  if (endpoint === '/api') {
    return `${basePrefix}/api`;
  }
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${basePrefix}/api${cleanEndpoint}`;
}

/**
 * Updates the cached session CSRF token manually if received in login/refresh response.
 */
export function setCachedCsrfToken(token) {
  cachedCsrfToken = token;
}

/**
 * Fetches or refreshes the session CSRF token.
 */
export async function getCsrfToken() {
  if (cachedCsrfToken) return cachedCsrfToken;
  try {
    const response = await fetch(resolveUrl('/auth/csrf-token'), {
      method: 'GET',
      credentials: 'include'
    });
    const result = await response.json();
    if (result.success && result.data && result.data.csrf_token) {
      cachedCsrfToken = result.data.csrf_token;
      return cachedCsrfToken;
    }
  } catch (err) {
    console.error('Failed to obtain CSRF token:', err);
  }
  return null;
}

/**
 * Core HTTP Request Wrapper using Fetch API.
 * Automatically injects CSRF tokens and enforces credentials: 'include'.
 */
export async function apiRequest(endpoint, options = {}) {
  const url = resolveUrl(endpoint);
  const method = (options.method || 'GET').toUpperCase();
  
  const headers = new Headers(options.headers || {});
  
  // State-changing requests require a CSRF token
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    const token = await getCsrfToken();
    if (token) {
      headers.set('X-CSRF-Token', token);
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

  try {
    const response = await fetch(url, fetchConfig);
    const result = await response.json().catch(() => null);

    if (!result) {
      throw new Error(`Server returned HTTP ${response.status} with an invalid JSON response.`);
    }

    // Refresh cached CSRF token if returned in payload
    if (result.data && result.data.csrf_token) {
      cachedCsrfToken = result.data.csrf_token;
    }

    return {
      ok: response.ok,
      status: response.status,
      ...result
    };
  } catch (err) {
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
export function updateDbStatusPill(isHealthy) {
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  if (!dot || !text) return;
  if (isHealthy) {
    dot.className = 'status-dot online';
    text.textContent = 'Database Connected';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'Database Offline';
  }
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
 * Checks authentication status for the active citizen.
 */
export async function getAuthUser() {
  const res = await apiRequest('/auth/me');
  if (res.ok && res.success && res.data) {
    return res.data;
  }
  return null;
}

/**
 * Logs out the active user and refreshes session state.
 */
export async function logoutUser() {
  const res = await apiRequest('/auth/logout', { method: 'POST' });
  cachedCsrfToken = null;
  return res;
}
