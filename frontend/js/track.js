/**
 * Public Status Tracking Module (ESM)
 * Fetches real-time workflow status and milestone history for applications and grievances.
 */

import { apiFetch, checkDbHealth, updateDbStatusPill, logoutUser, getAuthUser, startDbHealthPolling } from "./api.js";

async function performTrack(rawId) {
  const alertBox = document.getElementById("track-alert");
  const resultCard = document.getElementById("tracking-result-card");
  const submitBtn = document.getElementById("btn-track-submit");
  const spinner = document.getElementById("track-spinner");
  const btnText = submitBtn?.querySelector(".btn-text");

  const cleanId = (rawId || "").trim().toUpperCase();
  if (!cleanId) {
    showAlert("Please enter a valid tracking reference number.", "warning");
    return;
  }

  // Clear previous alerts and states
  clearAlert();
  if (submitBtn) submitBtn.disabled = true;
  if (spinner) spinner.classList.remove("d-none");
  if (btnText) btnText.textContent = "Searching...";

  try {
    const res = await apiFetch(`/track/${encodeURIComponent(cleanId)}`, { method: "GET" });

    if (!res.success) {
      if (resultCard) resultCard.classList.add("d-none");
      const msg = res.error?.message || `No record found with tracking reference '${cleanId}'. Please check your ID and try again.`;
      showAlert(msg, "danger");
      return;
    }

    renderTrackingResult(res.data);

  } catch (err) {
    console.error("Tracking request failed:", err);
    if (resultCard) resultCard.classList.add("d-none");
    showAlert("Could not communicate with the database tracking service. Please verify network connectivity.", "danger");
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (spinner) spinner.classList.add("d-none");
    if (btnText) btnText.textContent = "Track Status";
  }
}

function renderTrackingResult(data) {
  const resultCard = document.getElementById("tracking-result-card");
  if (!resultCard) return;

  resultCard.classList.remove("d-none");

  // 1. Badges & Headers
  const typeBadge = document.getElementById("track-type-badge");
  if (typeBadge) typeBadge.textContent = data.record_type || "Record";

  const deptBadge = document.getElementById("track-dept-badge");
  if (deptBadge) deptBadge.textContent = data.department || "Municipal";

  const statusBadge = document.getElementById("track-status-badge");
  if (statusBadge) {
    statusBadge.textContent = data.status || "Submitted";
    statusBadge.className = `status-badge ${getStatusBadgeClass(data.status)}`;
  }

  // 2. Titles and IDs
  const titleEl = document.getElementById("track-title");
  if (titleEl) titleEl.textContent = data.title || "Municipal Record";

  const idEl = document.getElementById("track-record-id");
  if (idEl) idEl.textContent = data.record_id || "";

  // 3. Metadata details
  const createdDateEl = document.getElementById("track-created-date");
  if (createdDateEl) {
    createdDateEl.textContent = data.created_at ? new Date(data.created_at).toLocaleString() : "N/A";
  }

  const updatedDateEl = document.getElementById("track-updated-date");
  if (updatedDateEl) {
    updatedDateEl.textContent = data.updated_at ? new Date(data.updated_at).toLocaleString() : "N/A";
  }

  // 4. Conditional Location display (for complaints)
  const locContainer = document.getElementById("track-location-container");
  const locVal = document.getElementById("track-location-val");
  if (data.record_type === "Complaint" && data.location) {
    if (locContainer) locContainer.classList.remove("d-none");
    if (locVal) locVal.textContent = data.location;
  } else {
    if (locContainer) locContainer.classList.add("d-none");
  }

  // 5. Proofs count
  const proofsCount = document.getElementById("track-proofs-count");
  if (proofsCount) {
    const count = data.documents_attached_count ?? data.images_attached_count ?? 0;
    proofsCount.textContent = `${count} verified document/image file${count === 1 ? "" : "s"}`;
  }

  // 6. Certificate Notice (Applications only)
  const certNotice = document.getElementById("track-cert-notice");
  if (certNotice) {
    if (data.record_type === "Application") {
      certNotice.classList.remove("d-none");
    } else {
      certNotice.classList.add("d-none");
    }
  }

  // 7. Visual Stepper Progress
  updateStepper(data.status);

  // 8. Milestone Timeline
  renderTimeline(data.timeline || []);

  resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateStepper(status) {
  const step1 = document.getElementById("step-submitted");
  const line1 = document.getElementById("line-1");
  const step2 = document.getElementById("step-review");
  const line2 = document.getElementById("line-2");
  const step3 = document.getElementById("step-outcome");
  const outcomeLabel = document.getElementById("step-outcome-label");

  // Reset classes
  [step1, step2, step3].forEach(step => {
    if (step) step.className = "stepper-step";
  });
  [line1, line2].forEach(line => {
    if (line) line.className = "stepper-line";
  });

  const normalized = (status || "").toLowerCase();

  // Stage 1 is always completed
  if (step1) step1.classList.add("step-completed");

  if (normalized === "submitted") {
    if (step1) step1.classList.add("step-active");
    if (outcomeLabel) outcomeLabel.textContent = "Final Resolution";
  } else if (normalized.includes("review") || normalized.includes("action")) {
    if (line1) line1.classList.add("line-completed");
    if (step2) step2.classList.add("step-active");
    if (outcomeLabel) outcomeLabel.textContent = "Final Resolution";
  } else if (normalized.includes("approved") || normalized.includes("completed") || normalized.includes("resolved")) {
    if (line1) line1.classList.add("line-completed");
    if (step2) step2.classList.add("step-completed");
    if (line2) line2.classList.add("line-completed");
    if (step3) step3.classList.add("step-completed", "step-success");
    if (outcomeLabel) outcomeLabel.textContent = "Approved / Resolved";
  } else if (normalized.includes("reject")) {
    if (line1) line1.classList.add("line-completed");
    if (step2) step2.classList.add("step-completed");
    if (line2) line2.classList.add("line-completed");
    if (step3) step3.classList.add("step-completed", "step-danger");
    if (outcomeLabel) outcomeLabel.textContent = "Rejected / Closed";
  }
}

function renderTimeline(timelineEvents) {
  const container = document.getElementById("track-timeline-list");
  if (!container) return;

  if (timelineEvents.length === 0) {
    container.innerHTML = `<p class="text-muted text-xs">No status change events recorded yet.</p>`;
    return;
  }

  container.innerHTML = timelineEvents.map((evt, idx) => {
    const dateFormatted = evt.date ? new Date(evt.date).toLocaleString() : "Date N/A";
    const badgeClass = getStatusBadgeClass(evt.status);
    const remarksHtml = evt.remarks 
      ? `<p class="timeline-remarks">${escapeHtml(evt.remarks)}</p>` 
      : `<p class="timeline-remarks text-muted text-xs">Stage milestone updated in civic registry.</p>`;

    return `
      <div class="timeline-item" id="timeline-event-${idx}">
        <div class="timeline-marker"></div>
        <div class="timeline-content">
          <div class="timeline-top">
            <span class="status-badge ${badgeClass}">${escapeHtml(evt.status)}</span>
            <span class="timeline-date">${escapeHtml(dateFormatted)}</span>
          </div>
          ${remarksHtml}
        </div>
      </div>
    `;
  }).join("");
}

function getStatusBadgeClass(status) {
  const s = (status || "").toLowerCase();
  if (s.includes("approved") || s.includes("completed") || s.includes("resolved")) return "badge-success";
  if (s.includes("reject")) return "badge-danger";
  if (s.includes("review") || s.includes("action") || s.includes("progress")) return "badge-warning";
  return "badge-info";
}

function showAlert(msg, type = "danger") {
  const alertBox = document.getElementById("track-alert");
  if (!alertBox) return;

  alertBox.className = `alert alert-${type} mt-3`;
  alertBox.textContent = msg;
  alertBox.classList.remove("d-none");
}

function clearAlert() {
  const alertBox = document.getElementById("track-alert");
  if (alertBox) alertBox.classList.add("d-none");
}

async function checkNavAuth() {
  const authContainer = document.getElementById("nav-auth-actions");
  if (!authContainer) return;

  function renderGuestNav() {
    authContainer.innerHTML = `
      <a href="login.html" class="btn btn-sm btn-outline" id="nav-login-btn">Sign In</a>
      <a href="register.html" class="btn btn-sm btn-primary" id="nav-register-btn">Sign Up</a>
    `;
  }

  try {
    const user = await getAuthUser();
    if (user && user.authenticated !== false && (user.id || user._id || user.email)) {
      const isAdmin = user.role === 'admin' || user.role === 'super_admin' || Boolean(user.admin_role);
      const dashUrl = isAdmin ? 'admin-dashboard.html' : 'user-dashboard.html';

      authContainer.innerHTML = `
        <a href="${dashUrl}" class="btn btn-sm btn-outline" id="nav-dashboard-btn">Dashboard</a>
        <button class="btn btn-sm btn-ghost btn-signout" id="nav-logout-btn" title="Sign out of your session">Sign Out</button>
      `;

      const logoutBtn = document.getElementById('nav-logout-btn');
      logoutBtn?.addEventListener('click', async (e) => {
        e.preventDefault();
        await logoutUser({
          buttonEl: logoutBtn,
          onImmediate: renderGuestNav
        });
      });
    } else {
      renderGuestNav();
    }
  } catch {
    renderGuestNav();
  }
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

document.addEventListener("DOMContentLoaded", async () => {
  const yearEl = document.getElementById("footer-year");
  if (yearEl) yearEl.textContent = new Date().getFullYear();


  // Database connectivity pill with 30s background polling
  startDbHealthPolling(30000);

  await checkNavAuth();

  // Setup form submission handler
  const form = document.getElementById("track-form");
  const input = document.getElementById("tracking-id-input");

  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      performTrack(input?.value);
    });
  }

  // Check URL query parameters (e.g. ?id=MSP-APP-2026-...)
  const params = new URLSearchParams(window.location.search);
  const initialId = params.get("id") || params.get("q");
  if (initialId && input) {
    input.value = initialId;
    await performTrack(initialId);
  }
});
