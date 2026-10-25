/**
 * Administrative Authentication Module (ESM)
 * Validates admin credentials, checks role, and establishes admin session.
 */

import { apiFetch, checkDbHealth, updateDbStatusPill, setCachedCsrfToken, setStoredToken, setStoredUser, startDbHealthPolling } from "./api.js";

async function checkExistingAdminSession() {
  try {
    const res = await apiFetch("/admin/auth/me", { method: "GET" });
    if (res.success && res.data && (res.data.role === "admin" || res.data.role === "super_admin" || res.data.admin_role)) {
      window.location.href = "admin-dashboard.html";
    }
  } catch {
    // Unauthenticated admin, continue to login view
  }
}

function setupAdminLoginForm() {
  const form = document.getElementById("admin-login-form");
  const emailInput = document.getElementById("admin-email");
  const pwdInput = document.getElementById("admin-password");
  const submitBtn = document.getElementById("btn-admin-login");
  const spinner = document.getElementById("admin-login-spinner");
  const btnText = submitBtn?.querySelector(".btn-text");

  if (!form) return;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    clearAlert();

    const email = emailInput?.value.trim() || "";
    const password = pwdInput?.value || "";

    let hasError = false;
    if (!email) {
      showFieldError("admin_email", "Administrator email is required.");
      hasError = true;
    } else {
      clearFieldError("admin_email");
    }

    if (!password) {
      showFieldError("admin_password", "Password is required.");
      hasError = true;
    } else {
      clearFieldError("admin_password");
    }

    if (hasError) return;

    setLoading(true);

    try {
      const res = await apiFetch("/admin/auth/login", {
        method: "POST",
        body: { email, password }
      });

      if (!res.success) {
        const msg = res.error?.message || "Invalid administrator credentials or access denied.";
        showAlert(msg, "danger");
        setLoading(false);
        return;
      }

      if (res.data) {
        if (res.data.token) {
          setStoredToken(res.data.token);
        }
        setStoredUser(res.data, res.data.token);
        if (res.data.csrf_token) {
          setCachedCsrfToken(res.data.csrf_token);
        }
      }

      // Redirect to Admin Dashboard
      window.location.href = "admin-dashboard.html";

    } catch (err) {
      console.error("Admin login failed:", err);
      showAlert("Could not connect to the authentication server. Please verify backend connectivity.", "danger");
      setLoading(false);
    }
  });

  function setLoading(isLoading) {
    if (submitBtn) submitBtn.disabled = isLoading;
    if (spinner) spinner.classList.toggle("d-none", !isLoading);
    if (btnText) btnText.textContent = isLoading ? "Authenticating..." : "Authenticate as Administrator";
  }
}

function showAlert(msg, type = "danger") {
  const alertBox = document.getElementById("admin-login-alert");
  if (!alertBox) return;

  alertBox.className = `alert alert-${type} mb-4`;
  alertBox.textContent = msg;
  alertBox.classList.remove("d-none");
}

function clearAlert() {
  const alertBox = document.getElementById("admin-login-alert");
  if (alertBox) alertBox.classList.add("d-none");
}

function showFieldError(field, msg) {
  const errEl = document.getElementById(`error_${field}`);
  const inputEl = document.getElementById(field.replace("_", "-"));
  if (errEl) {
    errEl.textContent = msg;
    errEl.classList.remove("d-none");
  }
  inputEl?.classList.add("input-error");
}

function clearFieldError(field) {
  const errEl = document.getElementById(`error_${field}`);
  const inputEl = document.getElementById(field.replace("_", "-"));
  if (errEl) errEl.classList.add("d-none");
  inputEl?.classList.remove("input-error");
}

document.addEventListener("DOMContentLoaded", async () => {
  startDbHealthPolling(30000);

  await checkExistingAdminSession();
  setupAdminLoginForm();
});
