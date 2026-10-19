/**
 * Authentication Management Module (ES Module)
 * Handles client-side validation, CSRF auto-inclusion, and session establishment.
 */

import { apiRequest, showToast, getAuthUser } from './api.js';

document.addEventListener('DOMContentLoaded', async () => {
  // If user is already logged in, redirect them to dashboard
  const user = await getAuthUser();
  if (user) {
    if (user.role === 'citizen') {
      window.location.href = 'user-dashboard.html';
      return;
    }
  }

  initLoginForm();
  initRegisterForm();
  initHealthPill();
});

/**
 * Top Notice Bar System Health Status
 */
async function initHealthPill() {
  const dot = document.getElementById('db-status-dot');
  const text = document.getElementById('db-status-text');
  if (!dot || !text) return;

  const res = await apiRequest('/health');
  if (res.ok && res.data && res.data.database === 'connected') {
    dot.className = 'status-dot online';
    text.textContent = 'Database Connected';
  } else {
    dot.className = 'status-dot offline';
    text.textContent = 'Database Offline (HTTP 503)';
  }
}

/**
 * Citizen Login Form Handler
 */
function initLoginForm() {
  const form = document.getElementById('login-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;

    let hasError = false;
    if (!email) {
      showFieldError('email-error', 'Email is required.');
      hasError = true;
    }
    if (!password) {
      showFieldError('password-error', 'Password is required.');
      hasError = true;
    }

    if (hasError) return;

    setLoading('login-submit-btn', true, 'Signing In...');

    const res = await apiRequest('/auth/login', {
      method: 'POST',
      body: { email, password }
    });

    setLoading('login-submit-btn', false, 'Sign In to Dashboard');

    if (res.ok && res.success) {
      showToast('Login successful! Redirecting...', 'success');
      setTimeout(() => {
        window.location.href = 'user-dashboard.html';
      }, 700);
    } else {
      const msg = (res.error && res.error.message) || 'Invalid credentials or login failed.';
      showAlertBox(msg, 'error');
    }
  });
}

/**
 * Citizen Registration Form Handler
 */
function initRegisterForm() {
  const form = document.getElementById('register-form');
  if (!form) return;

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors();

    const fullName = document.getElementById('reg-fullname').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const mobile = document.getElementById('reg-mobile').value.trim();
    const address = document.getElementById('reg-address').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirmPassword = document.getElementById('reg-confirm-password').value;

    let hasError = false;

    if (!fullName || fullName.length < 2) {
      showFieldError('fullname-error', 'Full Name must be at least 2 characters.');
      hasError = true;
    }

    if (!email || !email.includes('@')) {
      showFieldError('email-error', 'Please provide a valid email address.');
      hasError = true;
    }

    if (!mobile || mobile.length < 10) {
      showFieldError('mobile-error', 'Mobile number must be at least 10 digits.');
      hasError = true;
    }

    if (!address || address.length < 5) {
      showFieldError('address-error', 'Address must be at least 5 characters.');
      hasError = true;
    }

    if (!password || password.length < 8) {
      showFieldError('password-error', 'Password must be at least 8 characters long.');
      hasError = true;
    } else if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/[0-9]/.test(password)) {
      showFieldError('password-error', 'Password must include uppercase, lowercase, and a digit.');
      hasError = true;
    }

    if (password !== confirmPassword) {
      showFieldError('confirm-password-error', 'Passwords do not match.');
      hasError = true;
    }

    if (hasError) return;

    setLoading('register-submit-btn', true, 'Creating Account...');

    const res = await apiRequest('/auth/register', {
      method: 'POST',
      body: {
        full_name: fullName,
        email,
        mobile,
        address,
        password
      }
    });

    setLoading('register-submit-btn', false, 'Complete Registration');

    if (res.ok && res.success) {
      showToast('Registration successful! Please sign in.', 'success');
      setTimeout(() => {
        window.location.href = 'login.html';
      }, 1000);
    } else {
      const msg = (res.error && res.error.message) || 'Registration failed. Please check your details.';
      showAlertBox(msg, 'error');

      // Highlight specific fields if returned by server
      if (res.error && res.error.fields) {
        Object.keys(res.error.fields).forEach(key => {
          showFieldError(`${key}-error`, res.error.fields[key]);
        });
      }
    }
  });
}

function showFieldError(elementId, message) {
  const el = document.getElementById(elementId);
  if (el) {
    el.textContent = message;
    el.style.display = 'block';
  }
}

function clearErrors() {
  const errorElements = document.querySelectorAll('.field-error');
  errorElements.forEach(el => {
    el.textContent = '';
    el.style.display = 'none';
  });
  const alert = document.getElementById('auth-alert');
  if (alert) {
    alert.style.display = 'none';
    alert.textContent = '';
  }
}

function showAlertBox(message, type = 'error') {
  const alert = document.getElementById('auth-alert');
  if (alert) {
    alert.className = `alert-box ${type}`;
    alert.textContent = message;
    alert.style.display = 'block';
  }
}

function setLoading(buttonId, isLoading, defaultText) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;

  const textSpan = btn.querySelector('#btn-text');
  const spinnerSpan = btn.querySelector('#btn-spinner');

  if (isLoading) {
    btn.disabled = true;
    if (textSpan) textSpan.textContent = defaultText;
    if (spinnerSpan) spinnerSpan.style.display = 'inline-block';
  } else {
    btn.disabled = false;
    if (textSpan) textSpan.textContent = defaultText;
    if (spinnerSpan) spinnerSpan.style.display = 'none';
  }
}
