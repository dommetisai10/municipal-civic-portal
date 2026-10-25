/**
 * Municipal Service Portal - Frontend Configuration
 *
 * Configures the API Base URL for both local development and production deployment.
 *
 * Deployment on Vercel:
 * Set PRODUCTION_API_URL below to your live Render Web Service URL:
 * e.g., 'https://municipal-service-portal-api.onrender.com'
 *
 * Alternatively, you can override this dynamically at runtime in the browser console:
 *   localStorage.setItem('msp_api_base_url', 'https://your-backend.onrender.com');
 *   location.reload();
 */

// Production Render Web Service Backend URL (replace with your live Render URL after creating the service)
export const PRODUCTION_API_URL = 'https://municipal-service-portal-api.onrender.com';

// Local Development Backend URL
export const LOCAL_API_URL = 'http://127.0.0.1:5000';

export const CONFIG = {
  /**
   * Resolves the active backend base URL without trailing slash.
   */
  getApiBaseUrl() {
    if (typeof window === 'undefined') {
      return LOCAL_API_URL;
    }

    // 1. Injected global window config (e.g. script tag before module loads)
    if (window.__MSP_CONFIG__ && window.__MSP_CONFIG__.API_URL) {
      return String(window.__MSP_CONFIG__.API_URL).trim().replace(/\/+$/, '');
    }

    // 2. LocalStorage override (convenient for immediate testing on live Vercel deployments)
    try {
      const stored = localStorage.getItem('msp_api_base_url');
      if (stored && stored.trim()) {
        return stored.trim().replace(/\/+$/, '');
      }
    } catch (_) {}

    // 3. Localhost detection
    const hostname = window.location.hostname;
    const isLocalhost =
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname.endsWith('.local');

    if (isLocalhost) {
      const port = window.location.port;
      // If frontend is being served by the backend server on 5000, use relative paths
      if (port === '5000') {
        return '';
      }
      return `${window.location.protocol}//${hostname}:5000`;
    }

    // 4. Production deployment (Vercel / Cloud)
    // If vercel.json rewrites /api/* to Render, return '' (same-origin proxy).
    // Otherwise return the direct Render Web Service URL.
    return PRODUCTION_API_URL.replace(/\/+$/, '');
  },

  /**
   * Helper to set API URL dynamically from browser console.
   */
  setApiBaseUrl(url) {
    if (typeof window !== 'undefined' && url) {
      localStorage.setItem('msp_api_base_url', url.trim().replace(/\/+$/, ''));
      console.log(`[MSP Config] API Base URL updated to: ${url}`);
    }
  }
};
