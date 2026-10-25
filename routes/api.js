/**
 * Central Express REST API Router for Municipal Civic Portal.
 * Uses Mongoose models, single-hashing bcrypt, JWT tokens, and real-time Atlas aggregation pipelines.
 */

const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const mongoose = require('mongoose');

const { checkDbHealth } = require('../config/db');
const User = require('../models/User');
const Service = require('../models/Service');
const Application = require('../models/Application');
const Grievance = require('../models/Grievance');
const Notification = require('../models/Notification');
const AuditLog = require('../models/AuditLog');
const Department = require('../models/Department');
const Announcement = require('../models/Announcement');
const path = require('path');
const fs = require('fs');
const {
  upload,
  handleUpload,
  verifyMagicBytes,
  cleanupUploadedFiles,
  uploadToCloudinary,
  deleteFromCloudinary,
  isCloudinaryConfigured,
  APPLICATIONS_UPLOAD_DIR
} = require('../middleware/upload');

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'msp-jwt-secret-key-production-grade-min32chars';

// Unified API Response Formatter
function successResponse(res, data = null, statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    data: data,
    error: null
  });
}

function errorResponse(res, code, message, statusCode = 400, details = null) {
  return res.status(statusCode).json({
    success: false,
    data: null,
    error: {
      code,
      message,
      fields: details
    }
  });
}

// Reference ID Generator
function generateId(prefix) {
  const year = new Date().getFullYear();
  const randomHex = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `MSP-${prefix}-${year}-${randomHex}`;
}

// Authentication Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1];

  // Also check cookie if header is absent
  if (!token && req.cookies && req.cookies.jwt_token) {
    token = req.cookies.jwt_token;
  }

  if (!token) {
    return next();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
  } catch (err) {
    // Invalid or expired token: proceed as guest
  }
  next();
}

function requireCitizen(req, res, next) {
  if (!req.user) {
    return errorResponse(res, 'UNAUTHORIZED', 'Authentication required. Please sign in.', 401);
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !['super_admin', 'admin', 'officer'].includes(req.user.role)) {
    return errorResponse(res, 'FORBIDDEN', 'Administrative privileges required.', 403);
  }
  next();
}

router.use(authenticateToken);

// ==============================================================================
// 1. SYSTEM HEALTH PROBE & PORTAL CONFIG
// ==============================================================================
router.get('/health', async (req, res) => {
  const health = await checkDbHealth();
  const nowUtc = new Date().toISOString();

  const payload = {
    status: health.status,
    database: health.database,
    latency_ms: health.latency_ms,
    uptime_seconds: health.uptime_seconds,
    collections_count: health.collections_count,
    database_name: health.database_name,
    message: health.message,
    timestamp: nowUtc
  };

  if (health.database === 'connected') {
    return successResponse(res, payload, 200);
  }
  return errorResponse(res, 'DATABASE_UNAVAILABLE', 'Database connection failed. Please ensure MongoDB Atlas is reachable or check configuration.', 503, {
    details: health.message
  });
});

router.get('/config', (req, res) => {
  return successResponse(res, {
    municipality_name: process.env.PORTAL_MUNICIPALITY_NAME || 'Municipal Service Portal',
    contact_phone: process.env.PORTAL_CONTACT_PHONE || '+91 1800-CIVIC-GOV',
    contact_email: process.env.PORTAL_CONTACT_EMAIL || 'support@municipal.gov.in',
    office_address: process.env.PORTAL_OFFICE_ADDRESS || 'Municipal Civic Center, Administrative Complex, Main Road'
  });
});

router.get('/auth/csrf-token', (req, res) => {
  const csrfToken = crypto.randomBytes(24).toString('hex');
  return successResponse(res, { csrf_token: csrfToken });
});

// ==============================================================================
// 2. CITIZEN AUTHENTICATION
// ==============================================================================
router.post('/auth/register', async (req, res) => {
  try {
    const { full_name, email, password, mobile, address } = req.body;
    if (!email || !password || !full_name) {
      return errorResponse(res, 'VALIDATION_ERROR', 'Full name, email, and password are required.');
    }

    if (password.length < 8) {
      return errorResponse(res, 'VALIDATION_ERROR', 'Password must be at least 8 characters long.');
    }

    const normEmail = email.toLowerCase().trim();
    const existing = await User.findOne({ email: normEmail });
    if (existing) {
      return errorResponse(res, 'DUPLICATE_EMAIL', 'An account with this email address already exists.', 409);
    }

    const passwordHash = await User.hashPassword(password);
    const newUser = await User.create({
      full_name: full_name.trim(),
      email: normEmail,
      mobile: (mobile || '').trim(),
      address: (address || '').trim(),
      password_hash: passwordHash,
      role: 'citizen',
      status: 'active',
      is_active: true,
      is_verified: true,
      is_deleted: false
    });

    const token = jwt.sign(
      { id: newUser._id.toString(), email: newUser.email, role: newUser.role, name: newUser.full_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const csrfToken = crypto.randomBytes(24).toString('hex');

    // Dual-compatible flat and nested response contract
    return successResponse(
      res,
      {
        id: newUser._id.toString(),
        _id: newUser._id.toString(),
        full_name: newUser.full_name,
        email: newUser.email,
        role: newUser.role,
        token,
        csrf_token: csrfToken,
        user: {
          id: newUser._id.toString(),
          _id: newUser._id.toString(),
          full_name: newUser.full_name,
          email: newUser.email,
          role: newUser.role
        }
      },
      201
    );
  } catch (err) {
    console.error('[AUTH ERROR] Registration failed:', err);
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return errorResponse(res, 'VALIDATION_ERROR', 'Email and password are required.');
    }

    const normEmail = email.toLowerCase().trim();

    // Query user by normalized email ignoring deleted status
    const user = await User.findOne({
      email: normEmail,
      is_deleted: { $ne: true }
    }).select('+password_hash');

    if (!user) {
      console.log(`[AUTH-DEBUG] Login failed: User not found for email "${normEmail}"`);
      return errorResponse(res, 'INVALID_CREDENTIALS', 'Invalid email or password.', 401);
    }

    // Role check for citizen endpoint
    if (user.role !== 'citizen') {
      console.log(`[AUTH-DEBUG] Login failed: Non-citizen account (${user.role}) attempted citizen login: "${normEmail}"`);
      return errorResponse(res, 'INVALID_CREDENTIALS', 'Invalid citizen credentials. If you are an administrator, please use the Administrative Login Portal.', 401);
    }

    // Password verification via bcrypt
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      console.log(`[AUTH-DEBUG] Login failed: Password mismatch for user "${normEmail}". Entered password: "${password}"`);
      return errorResponse(res, 'INVALID_CREDENTIALS', 'Invalid email or password.', 401);
    }

    // Suspended account check
    if (user.status === 'suspended' || user.is_active === false) {
      console.log(`[AUTH-DEBUG] Login blocked: User "${normEmail}" is suspended or inactive`);
      return errorResponse(res, 'ACCOUNT_SUSPENDED', 'Your citizen account has been suspended. Please contact municipal support.', 403);
    }

    // Verification check
    if (user.is_verified === false) {
      console.log(`[AUTH-DEBUG] Login blocked: User "${normEmail}" is pending verification`);
      return errorResponse(res, 'ACCOUNT_NOT_VERIFIED', 'Your account is pending verification. Please verify your contact information.', 403);
    }

    user.last_login_at = new Date();
    user.failed_login_attempts = 0;
    user.locked_until = null;
    await user.save();

    console.log(`[AUTH-DEBUG] Citizen login successful: "${normEmail}"`);

    const token = jwt.sign(
      { id: user._id.toString(), email: user.email, role: user.role, name: user.full_name },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    const csrfToken = crypto.randomBytes(24).toString('hex');

    return successResponse(res, {
      id: user._id.toString(),
      _id: user._id.toString(),
      full_name: user.full_name,
      email: user.email,
      role: user.role,
      token,
      csrf_token: csrfToken,
      user: {
        id: user._id.toString(),
        _id: user._id.toString(),
        full_name: user.full_name,
        email: user.email,
        role: user.role
      }
    });
  } catch (err) {
    console.error('[AUTH ERROR] Login error:', err);
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

function clearAuthCookies(res) {
  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/'
  };
  res.clearCookie('jwt_token', cookieOptions);
  res.clearCookie('token', cookieOptions);
  res.clearCookie('session', cookieOptions);
  res.clearCookie('connect.sid', cookieOptions);
  res.clearCookie('msp_token', cookieOptions);
}

router.get('/auth/me', (req, res) => {
  if (!req.user) {
    return errorResponse(res, 'UNAUTHORIZED', 'No active authenticated session.', 401, { authenticated: false });
  }
  return successResponse(res, {
    id: req.user.id,
    _id: req.user.id,
    full_name: req.user.name,
    email: req.user.email,
    role: req.user.role,
    authenticated: true,
    user: {
      id: req.user.id,
      _id: req.user.id,
      full_name: req.user.name,
      email: req.user.email,
      role: req.user.role
    }
  });
});

router.post('/auth/logout', (req, res) => {
  clearAuthCookies(res);
  return successResponse(res, { message: 'Signed out successfully.' });
});

router.get('/auth/profile', requireCitizen, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password_hash');
    if (!user) return errorResponse(res, 'NOT_FOUND', 'Citizen profile not found.', 404);
    return successResponse(res, user);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.put('/auth/profile', requireCitizen, async (req, res) => {
  try {
    const { full_name, mobile, address } = req.body;
    const user = await User.findById(req.user.id);
    if (!user) return errorResponse(res, 'NOT_FOUND', 'Citizen profile not found.', 404);

    if (full_name) user.full_name = full_name.trim();
    if (mobile !== undefined) user.mobile = mobile.trim();
    if (address !== undefined) user.address = address.trim();

    await user.save();
    return successResponse(res, {
      id: user._id.toString(),
      full_name: user.full_name,
      email: user.email,
      mobile: user.mobile,
      address: user.address,
      role: user.role
    });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/auth/change-password', requireCitizen, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) {
      return errorResponse(res, 'VALIDATION_ERROR', 'Current and new password are required.');
    }
    if (new_password.length < 8) {
      return errorResponse(res, 'VALIDATION_ERROR', 'New password must be at least 8 characters long.');
    }

    const user = await User.findById(req.user.id).select('+password_hash');
    if (!user) return errorResponse(res, 'NOT_FOUND', 'User not found.', 404);

    const isMatch = await user.comparePassword(current_password);
    if (!isMatch) {
      return errorResponse(res, 'INVALID_PASSWORD', 'Current password entered is incorrect.', 400);
    }

    user.password_hash = await User.hashPassword(new_password);
    await user.save();

    return successResponse(res, { message: 'Password changed successfully.' });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// ==============================================================================
// 3. ADMINISTRATIVE AUTHENTICATION (Supports /admin/auth/login & /admin/login)
// ==============================================================================
async function handleAdminLogin(req, res) {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return errorResponse(res, 'VALIDATION_ERROR', 'Administrator email and password are required.');
    }

    const normEmail = email.toLowerCase().trim();

    // Query user with admin/officer privileges
    const user = await User.findOne({
      email: normEmail,
      role: { $in: ['super_admin', 'admin', 'officer'] },
      is_deleted: { $ne: true }
    }).select('+password_hash');

    if (!user) {
      console.log(`[AUTH-DEBUG] Admin login failed: No administrator account for email "${normEmail}"`);
      return errorResponse(res, 'INVALID_ADMIN_CREDENTIALS', 'Invalid administrator credentials or access denied.', 401);
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      console.log(`[AUTH-DEBUG] Admin login failed: Password mismatch for admin "${normEmail}". Entered password: "${password}"`);
      return errorResponse(res, 'INVALID_ADMIN_CREDENTIALS', 'Invalid administrator credentials or access denied.', 401);
    }

    if (user.status === 'suspended' || user.is_active === false) {
      console.log(`[AUTH-DEBUG] Admin login blocked: Admin account "${normEmail}" is suspended`);
      return errorResponse(res, 'ACCOUNT_SUSPENDED', 'Administrative account has been suspended or deactivated.', 403);
    }

    user.last_login_at = new Date();
    user.failed_login_attempts = 0;
    user.locked_until = null;
    await user.save();

    console.log(`[AUTH-DEBUG] Administrator login successful: "${normEmail}" (${user.role})`);

    const token = jwt.sign(
      { id: user._id.toString(), email: user.email, role: user.role, name: user.full_name },
      JWT_SECRET,
      { expiresIn: '1d' }
    );

    const csrfToken = crypto.randomBytes(24).toString('hex');

    // Dual-contract supporting both 'admin' and user.role
    return successResponse(res, {
      id: user._id.toString(),
      _id: user._id.toString(),
      full_name: user.full_name,
      email: user.email,
      role: 'admin',
      admin_role: user.role,
      status: user.status,
      token,
      csrf_token: csrfToken,
      user: {
        id: user._id.toString(),
        _id: user._id.toString(),
        full_name: user.full_name,
        email: user.email,
        role: 'admin',
        admin_role: user.role
      }
    });
  } catch (err) {
    console.error('[ADMIN AUTH ERROR]', err);
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
}

router.post('/admin/auth/login', handleAdminLogin);
router.post('/admin/login', handleAdminLogin);

function handleAdminMe(req, res) {
  if (!req.user || !['super_admin', 'admin', 'officer'].includes(req.user.role)) {
    return errorResponse(res, 'UNAUTHORIZED', 'Administrator session expired or unauthenticated.', 401);
  }
  return successResponse(res, {
    id: req.user.id,
    _id: req.user.id,
    full_name: req.user.name,
    email: req.user.email,
    role: 'admin',
    admin_role: req.user.role,
    authenticated: true,
    user: {
      id: req.user.id,
      _id: req.user.id,
      full_name: req.user.name,
      email: req.user.email,
      role: 'admin',
      admin_role: req.user.role
    }
  });
}

router.get('/admin/auth/me', handleAdminMe);
router.get('/admin/me', handleAdminMe);

router.post(['/admin/auth/logout', '/admin/logout'], (req, res) => {
  clearAuthCookies(res);
  return successResponse(res, { message: 'Administrator logged out successfully.' });
});

// ==============================================================================
// 4. SERVICES CATALOG & MANAGEMENT
// ==============================================================================
router.get('/services', async (req, res) => {
  try {
    const services = await Service.find({ is_deleted: { $ne: true } }).sort({ category: 1, name: 1 });
    return successResponse(res, services);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/services/:slug', async (req, res) => {
  try {
    const service = await Service.findOne({ slug: req.params.slug, is_deleted: { $ne: true } });
    if (!service) {
      return errorResponse(res, 'NOT_FOUND', 'Service not found.', 404);
    }
    return successResponse(res, service);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/admin/services', requireAdmin, async (req, res) => {
  try {
    const services = await Service.find({ is_deleted: { $ne: true } }).sort({ category: 1, name: 1 });
    return successResponse(res, services);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/admin/services/:slug', requireAdmin, async (req, res) => {
  try {
    const service = await Service.findOne({ slug: req.params.slug, is_deleted: { $ne: true } });
    if (!service) return errorResponse(res, 'NOT_FOUND', 'Service not found.', 404);
    return successResponse(res, service);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/admin/services', requireAdmin, async (req, res) => {
  try {
    const { name, category, description, availability, sla_days, fee, required_documents, form_schema } = req.body;
    if (!name || !category) {
      return errorResponse(res, 'VALIDATION_ERROR', 'Service name and category are required.');
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)+/g, '');
    const newService = await Service.create({
      slug,
      name,
      category,
      description: description || '',
      availability: availability || 'Available',
      sla_days: sla_days || 7,
      fee: fee || 0,
      required_documents: required_documents || [],
      form_schema: form_schema || [],
      is_deleted: false
    });

    await AuditLog.create({
      actor_id: req.user.id,
      actor_role: req.user.role,
      action: 'SERVICE_CREATED',
      target_collection: 'services',
      target_id: slug,
      details: { name, category }
    });

    return successResponse(res, newService, 201);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.put('/admin/services/:slug', requireAdmin, async (req, res) => {
  try {
    const service = await Service.findOne({ slug: req.params.slug, is_deleted: { $ne: true } });
    if (!service) return errorResponse(res, 'NOT_FOUND', 'Service not found.', 404);

    const fields = ['name', 'category', 'description', 'availability', 'sla_days', 'fee', 'required_documents', 'form_schema'];
    fields.forEach((f) => {
      if (req.body[f] !== undefined) service[f] = req.body[f];
    });

    await service.save();

    await AuditLog.create({
      actor_id: req.user.id,
      actor_role: req.user.role,
      action: 'SERVICE_UPDATED',
      target_collection: 'services',
      target_id: service.slug,
      details: req.body
    });

    return successResponse(res, service);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.patch('/admin/services/:slug/availability', requireAdmin, async (req, res) => {
  try {
    const { availability } = req.body;
    const service = await Service.findOne({ slug: req.params.slug, is_deleted: { $ne: true } });
    if (!service) return errorResponse(res, 'NOT_FOUND', 'Service not found.', 404);

    service.availability = availability || (service.availability === 'Available' ? 'Unavailable' : 'Available');
    await service.save();

    return successResponse(res, service);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/admin/services/:slug/duplicate', requireAdmin, async (req, res) => {
  try {
    const original = await Service.findOne({ slug: req.params.slug, is_deleted: { $ne: true } });
    if (!original) return errorResponse(res, 'NOT_FOUND', 'Original service not found.', 404);

    const newSlug = `${original.slug}-copy-${Date.now().toString(36)}`;
    const copy = await Service.create({
      slug: newSlug,
      name: `${original.name} (Copy)`,
      category: original.category,
      description: original.description,
      availability: 'Unavailable',
      sla_days: original.sla_days,
      fee: original.fee,
      required_documents: original.required_documents,
      form_schema: original.form_schema,
      is_deleted: false
    });

    return successResponse(res, copy, 201);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.delete('/admin/services/:slug', requireAdmin, async (req, res) => {
  try {
    const service = await Service.findOne({ slug: req.params.slug });
    if (!service) return errorResponse(res, 'NOT_FOUND', 'Service not found.', 404);

    service.is_deleted = true;
    await service.save();

    return successResponse(res, { message: 'Service soft-deleted successfully.' });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// ==============================================================================
// 5. CITIZEN APPLICATIONS & WORKFLOWS
// ==============================================================================
router.get('/applications', requireCitizen, async (req, res) => {
  try {
    const applications = await Application.find({
      user_id: req.user.id,
      is_deleted: { $ne: true }
    }).sort({ created_at: -1 });

    return successResponse(res, applications);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/applications', requireCitizen, handleUpload(upload.any()), async (req, res) => {
  const uploadedFiles = req.files || [];
  try {
    const { service_slug, form_data, applicant_name, applicant_email, applicant_mobile } = req.body;
    if (!service_slug) {
      cleanupUploadedFiles(uploadedFiles);
      return errorResponse(res, 'VALIDATION_ERROR', 'Service selection is required.', 400, { service_slug: 'Service selection is required.' });
    }

    const service = await Service.findOne({ slug: service_slug, is_deleted: { $ne: true } });
    if (!service) {
      cleanupUploadedFiles(uploadedFiles);
      return errorResponse(res, 'NOT_FOUND', 'Selected service not found.', 404);
    }

    // Availability Check: Reject only if admin marked service Unavailable
    if (service.availability === 'Unavailable') {
      cleanupUploadedFiles(uploadedFiles);
      return errorResponse(
        res,
        'SERVICE_UNAVAILABLE',
        `Service "${service.name}" is currently marked as Unavailable and cannot accept applications.`,
        400
      );
    }

    // Parse form_data if provided as stringified JSON from FormData or JSON object
    let parsedFormData = {};
    if (form_data) {
      if (typeof form_data === 'string') {
        try {
          parsedFormData = JSON.parse(form_data);
        } catch (_) {
          parsedFormData = {};
        }
      } else if (typeof form_data === 'object') {
        parsedFormData = form_data;
      }
    } else {
      for (const [k, v] of Object.entries(req.body)) {
        if (!['service_slug', 'applicant_name', 'applicant_email', 'applicant_mobile', 'documents'].includes(k)) {
          parsedFormData[k] = v;
        }
      }
    }

    // Dynamic Form Fields Schema Validation
    const fieldErrors = {};
    const schema = Array.isArray(service.form_schema) ? service.form_schema : [];
    for (const field of schema) {
      const val = parsedFormData[field.name];
      if (field.required && (val === undefined || val === null || String(val).trim() === '')) {
        fieldErrors[field.name] = `${field.label || field.name} is required.`;
      }
    }

    if (Object.keys(fieldErrors).length > 0) {
      cleanupUploadedFiles(uploadedFiles);
      return errorResponse(res, 'VALIDATION_ERROR', 'Please complete all required fields highlighted.', 400, fieldErrors);
    }

    // Magic Bytes Verification on all uploaded files
    for (const file of uploadedFiles) {
      const magicCheck = verifyMagicBytes(file, file.originalname);
      if (!magicCheck.valid) {
        cleanupUploadedFiles(uploadedFiles);
        return errorResponse(res, 'SECURITY_VALIDATION_FAILED', magicCheck.message, 400, {
          [file.fieldname || 'documents']: magicCheck.message
        });
      }
    }

    // Document Requirements Validation (Single Source of Truth)
    const reqDocs = Array.isArray(service.requiredDocuments) && service.requiredDocuments.length > 0
      ? service.requiredDocuments
      : (Array.isArray(service.required_documents) ? service.required_documents.map(d => ({
          key: d.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
          label: d,
          required: true
        })) : []);

    const docErrors = {};
    for (const reqDoc of reqDocs) {
      if (reqDoc.required !== false) {
        // Look for matching uploaded file by fieldname or original name
        const matched = uploadedFiles.some(
          f => f.fieldname === reqDoc.key ||
               f.fieldname === `doc_${reqDoc.key}` ||
               (f.originalname && f.originalname.toLowerCase().includes(reqDoc.key.toLowerCase()))
        );
        if (!matched && uploadedFiles.length === 0) {
          docErrors[reqDoc.key] = `Required document "${reqDoc.label}" is missing. Please upload a clear scan (PDF, JPG, PNG).`;
        }
      }
    }

    if (Object.keys(docErrors).length > 0) {
      cleanupUploadedFiles(uploadedFiles);
      return errorResponse(res, 'DOCUMENTS_REQUIRED', 'One or more required documents are missing.', 400, docErrors);
    }

    // Structure document attachments metadata (Cloudinary or Local Disk)
    const documentRecords = [];
    for (const file of uploadedFiles) {
      const matchingDoc = reqDocs.find(
        d => d.key === file.fieldname || `doc_${d.key}` === file.fieldname
      );
      const docKey = matchingDoc ? matchingDoc.key : (file.fieldname || 'document');
      const docLabel = matchingDoc ? matchingDoc.label : file.originalname;

      if (isCloudinaryConfigured && file.buffer) {
        try {
          const cloudResult = await uploadToCloudinary(file);
          documentRecords.push({
            key: docKey,
            label: docLabel,
            field_name: file.fieldname || 'documents',
            original_name: file.originalname,
            saved_filename: cloudResult.public_id,
            file_path: cloudResult.secure_url,
            secure_url: cloudResult.secure_url,
            public_id: cloudResult.public_id,
            resource_type: cloudResult.resource_type || 'auto',
            file_size: file.size || cloudResult.bytes || 0,
            mime_type: file.mimetype || 'application/octet-stream',
            uploaded_at: new Date()
          });
        } catch (cloudErr) {
          console.error('[CLOUDINARY UPLOAD ERROR]', cloudErr);
          return errorResponse(res, 'UPLOAD_FAILED', `Cloud storage upload failed: ${cloudErr.message}`, 500);
        }
      } else {
        documentRecords.push({
          key: docKey,
          label: docLabel,
          field_name: file.fieldname || 'documents',
          original_name: file.originalname,
          saved_filename: file.filename,
          file_path: `/api/documents/${file.filename}`,
          secure_url: `/api/documents/${file.filename}`,
          public_id: null,
          resource_type: 'local',
          file_size: file.size,
          mime_type: file.mimetype || 'application/octet-stream',
          uploaded_at: new Date()
        });
      }
    }

    // Generate collision-safe reference number
    const appId = await Application.generateReferenceNumber();

    const newApp = await Application.create({
      application_id: appId,
      user_id: req.user.id,
      service_id: service._id,
      service_slug: service.slug,
      service_name: service.name,
      applicant_name: applicant_name || req.user.name || 'Citizen',
      applicant_email: applicant_email || req.user.email,
      applicant_mobile: applicant_mobile || req.user.mobile || '',
      form_data: parsedFormData,
      documents: documentRecords,
      status: 'Pending',
      status_history: [
        {
          status: 'Pending',
          changed_by: req.user.name || 'Citizen',
          changed_at: new Date(),
          remarks: 'Application submitted successfully through citizen portal.'
        }
      ]
    });

    // Notify Citizen
    await Notification.create({
      recipient: req.user.id,
      title: 'Application Received',
      message: `Your application for "${service.name}" has been received under Reference ID ${appId}.`,
      reference_id: appId,
      reference_type: 'application'
    });

    // Audit Log Entry
    try {
      await AuditLog.create({
        actor_id: req.user.id,
        actor_email: req.user.email,
        actor_role: req.user.role || 'citizen',
        action: 'APPLICATION_SUBMITTED',
        target_entity: 'Application',
        target_id: appId,
        details: { service_slug: service.slug, documents_count: documentRecords.length }
      });
    } catch (_) {}

    return successResponse(res, {
      id: newApp._id,
      referenceNumber: newApp.application_id,
      application_id: newApp.application_id,
      service_name: newApp.service_name,
      status: newApp.status,
      created_at: newApp.created_at,
      documents: newApp.documents
    }, 201);
  } catch (err) {
    cleanupUploadedFiles(uploadedFiles);
    console.error('[APPLICATION SUBMIT ERROR]', err);
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// Secure Authenticated Document Retrieval (Cloudinary & Local Disk)
router.get('/documents/:filename', async (req, res) => {
  try {
    const rawFilename = req.params.filename;

    // Check authorization: must be logged in as citizen owner or admin/officer
    if (!req.user) {
      return errorResponse(res, 'UNAUTHORIZED', 'Authentication required to access documents.', 401);
    }

    // Look for matching document across applications
    const app = await Application.findOne({
      $or: [
        { 'documents.saved_filename': rawFilename },
        { 'documents.public_id': rawFilename },
        { 'documents.original_name': rawFilename }
      ],
      is_deleted: { $ne: true }
    });

    if (app) {
      const isOwner = app.user_id.toString() === req.user.id.toString();
      const isAdmin = ['super_admin', 'admin', 'officer'].includes(req.user.role);
      if (!isOwner && !isAdmin) {
        return errorResponse(res, 'FORBIDDEN', 'You do not have permission to view this document.', 403);
      }

      const doc = (app.documents || []).find(
        d => d.saved_filename === rawFilename || d.public_id === rawFilename || d.original_name === rawFilename
      );

      // If document is stored in Cloudinary, redirect to secure cloud URL
      if (doc && doc.secure_url && doc.secure_url.startsWith('http')) {
        return res.redirect(doc.secure_url);
      }
    }

    // Local Disk Fallback
    const cleanFilename = path.basename(rawFilename);
    const filePath = path.join(APPLICATIONS_UPLOAD_DIR, cleanFilename);

    if (!fs.existsSync(filePath)) {
      return errorResponse(res, 'NOT_FOUND', 'Requested document file not found on server.', 404);
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    return res.sendFile(filePath);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/applications/:id/documents/:filename', async (req, res) => {
  try {
    const { id, filename } = req.params;

    if (!req.user) {
      return errorResponse(res, 'UNAUTHORIZED', 'Authentication required to access documents.', 401);
    }

    const isObjId = mongoose.isValidObjectId(id);
    const app = await Application.findOne({
      $or: [{ application_id: id }, ...(isObjId ? [{ _id: id }] : [])],
      is_deleted: { $ne: true }
    });

    if (!app) {
      return errorResponse(res, 'NOT_FOUND', 'Application not found.', 404);
    }

    const isOwner = app.user_id.toString() === req.user.id.toString();
    const isAdmin = ['super_admin', 'admin', 'officer'].includes(req.user.role);
    if (!isOwner && !isAdmin) {
      return errorResponse(res, 'FORBIDDEN', 'You do not have permission to view this document.', 403);
    }

    const doc = (app.documents || []).find(
      d => d.saved_filename === filename || d.public_id === filename || d.original_name === filename
    );

    if (doc && doc.secure_url && doc.secure_url.startsWith('http')) {
      return res.redirect(doc.secure_url);
    }

    const cleanFilename = path.basename(filename);
    const filePath = path.join(APPLICATIONS_UPLOAD_DIR, cleanFilename);

    if (!fs.existsSync(filePath)) {
      return errorResponse(res, 'NOT_FOUND', 'Requested document file not found on server.', 404);
    }

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    return res.sendFile(filePath);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// Admin Applications Management
router.get('/admin/applications', requireAdmin, async (req, res) => {
  try {
    const { status, service, search } = req.query;
    const query = { is_deleted: { $ne: true } };

    if (status && status !== 'ALL' && status !== 'all') {
      query.status = status;
    }
    if (service && service !== 'ALL' && service !== 'all') {
      query.service_slug = service;
    }
    if (search) {
      const q = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ application_id: q }, { applicant_name: q }, { applicant_email: q }, { service_name: q }];
    }

    const apps = await Application.find(query).sort({ created_at: -1 });
    return successResponse(res, apps);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/admin/applications/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const app = await Application.findOne({
      $or: [{ application_id: id }, ...(isObjId ? [{ _id: id }] : [])],
      is_deleted: { $ne: true }
    });

    if (!app) return errorResponse(res, 'NOT_FOUND', 'Application record not found.', 404);
    return successResponse(res, app);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.put('/admin/applications/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, remarks } = req.body;
    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);

    const app = await Application.findOne({
      $or: [{ application_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!app) return errorResponse(res, 'NOT_FOUND', 'Application record not found.', 404);

    app.status = status;
    app.officer_remarks = remarks || '';
    app.status_history.push({
      status,
      changed_by: req.user.name || 'Municipal Officer',
      changed_at: new Date(),
      remarks: remarks || `Status transitioned to ${status}`
    });

    await app.save();

    // Create Audit Log
    await AuditLog.create({
      actor_id: req.user.id,
      actor_role: req.user.role,
      action: `APPLICATION_STATUS_${status.toUpperCase()}`,
      target_collection: 'applications',
      target_id: app.application_id,
      details: { status, remarks }
    });

    // Notify Citizen
    await Notification.create({
      recipient: app.user_id,
      title: `Application ${status}`,
      message: `Your application (${app.application_id}) for "${app.service_name}" has been updated to "${status}". Remarks: ${remarks || 'None'}`,
      reference_id: app.application_id,
      reference_type: 'application'
    });

    return successResponse(res, app);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/admin/applications/:id/notes', requireAdmin, async (req, res) => {
  try {
    const { note } = req.body;
    if (!note) return errorResponse(res, 'VALIDATION_ERROR', 'Note text cannot be empty.');

    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const app = await Application.findOne({
      $or: [{ application_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!app) return errorResponse(res, 'NOT_FOUND', 'Application not found.', 404);

    app.internal_notes.push({
      note,
      created_by: req.user.name || 'Officer',
      created_at: new Date()
    });

    await app.save();
    return successResponse(res, app);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.delete('/admin/applications/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const app = await Application.findOne({
      $or: [{ application_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!app) return errorResponse(res, 'NOT_FOUND', 'Application not found.', 404);
    app.is_deleted = true;
    await app.save();

    return successResponse(res, { message: 'Application deleted successfully.' });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/admin/applications/bulk', requireAdmin, async (req, res) => {
  try {
    const { application_ids, status, remarks } = req.body;
    if (!Array.isArray(application_ids) || application_ids.length === 0 || !status) {
      return errorResponse(res, 'VALIDATION_ERROR', 'application_ids array and status are required.');
    }

    await Application.updateMany(
      { application_id: { $in: application_ids } },
      {
        $set: { status, officer_remarks: remarks || '' },
        $push: {
          status_history: {
            status,
            changed_by: req.user.name || 'Officer',
            changed_at: new Date(),
            remarks: remarks || 'Bulk status change'
          }
        }
      }
    );

    return successResponse(res, { updated_count: application_ids.length });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/admin/applications/:id/certificate', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const app = await Application.findOne({
      $or: [{ application_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!app) return errorResponse(res, 'NOT_FOUND', 'Application not found.', 404);

    return successResponse(res, {
      certificate_id: `CERT-${app.application_id}`,
      service_name: app.service_name,
      issued_to: app.applicant_name,
      issue_date: new Date(),
      status: app.status
    });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// ==============================================================================
// 6. COMPLAINTS & GRIEVANCE REDRESSAL
// ==============================================================================
router.get('/complaints/categories', async (req, res) => {
  const categories = [
    'Sanitation & Solid Waste Management',
    'Water Supply & Sewerage',
    'Roads, Pavements & Street Lighting',
    'Revenue & Property Tax',
    'Town Planning & Building Permissions',
    'Public Health & Mosquito Control',
    'Parks & Horticulture',
    'Electrical & Infrastructure',
    'Veterinary & Stray Animal Control',
    'General Civic Grievance'
  ];
  return successResponse(res, categories);
});

router.get(['/complaints/departments', '/admin/departments'], async (req, res) => {
  try {
    const depts = await Department.find({ is_active: true }).sort({ name: 1 });
    const deptNames = depts.map((d) => d.name);
    return successResponse(res, deptNames.length > 0 ? deptNames : [
      'Sanitation & Waste Management',
      'Water Supply & Sewerage',
      'Roads & Street Lighting',
      'Revenue & Property Tax',
      'Town Planning & Architecture',
      'Public Health & Safety'
    ]);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get(['/complaints', '/complaints/my'], requireCitizen, async (req, res) => {
  try {
    const complaints = await Grievance.find({
      user_id: req.user.id,
      is_deleted: { $ne: true }
    }).sort({ created_at: -1 });

    return successResponse(res, complaints);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/complaints', async (req, res) => {
  try {
    const { department, category, description, landmark, address, latitude, longitude, citizen_name, citizen_email, citizen_phone } = req.body;
    if (!department || !description) {
      return errorResponse(res, 'VALIDATION_ERROR', 'Department and description are required.');
    }

    const cmpId = generateId('CMP');
    const newGrievance = await Grievance.create({
      complaint_id: cmpId,
      user_id: req.user ? req.user.id : null,
      citizen_name: citizen_name || (req.user ? req.user.name : 'Citizen'),
      citizen_email: citizen_email || (req.user ? req.user.email : ''),
      citizen_phone: citizen_phone || '',
      department,
      category: category || department,
      description,
      landmark: landmark || '',
      address: address || '',
      latitude: latitude ? parseFloat(latitude) : null,
      longitude: longitude ? parseFloat(longitude) : null,
      priority: 'Medium',
      status: 'Pending',
      status_history: [
        {
          status: 'Pending',
          changed_by: req.user ? req.user.name : 'Citizen',
          changed_at: new Date(),
          remarks: 'Grievance registered in municipal portal.'
        }
      ]
    });

    if (req.user) {
      await Notification.create({
        recipient: req.user.id,
        title: 'Grievance Registered',
        message: `Your grievance (#${cmpId}) regarding "${category || department}" has been recorded.`,
        reference_id: cmpId,
        reference_type: 'complaint'
      });
    }

    return successResponse(res, newGrievance, 201);
  } catch (err) {
    console.error('[GRIEVANCE ERROR]', err);
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// Admin Complaints Management
router.get('/admin/complaints', requireAdmin, async (req, res) => {
  try {
    const { department, status, priority, search } = req.query;
    const query = { is_deleted: { $ne: true } };

    if (department && department !== 'ALL' && department !== 'all') {
      query.department = department;
    }
    if (status && status !== 'ALL' && status !== 'all') {
      query.status = status;
    }
    if (priority && priority !== 'ALL' && priority !== 'all') {
      query.priority = priority;
    }
    if (search) {
      const q = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ complaint_id: q }, { citizen_name: q }, { citizen_email: q }, { department: q }, { category: q }];
    }

    const complaints = await Grievance.find(query).sort({ created_at: -1 });
    return successResponse(res, complaints);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/admin/complaints/:id', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const cmp = await Grievance.findOne({
      $or: [{ complaint_id: id }, ...(isObjId ? [{ _id: id }] : [])],
      is_deleted: { $ne: true }
    });

    if (!cmp) return errorResponse(res, 'NOT_FOUND', 'Grievance record not found.', 404);
    return successResponse(res, cmp);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.put('/admin/complaints/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status, remarks, assigned_officer } = req.body;
    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);

    const cmp = await Grievance.findOne({
      $or: [{ complaint_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!cmp) return errorResponse(res, 'NOT_FOUND', 'Grievance not found.', 404);

    if (status) cmp.status = status;
    if (remarks) cmp.resolution_remarks = remarks;
    if (assigned_officer) cmp.assigned_officer = assigned_officer;

    cmp.status_history.push({
      status: status || cmp.status,
      changed_by: req.user.name || 'Municipal Officer',
      changed_at: new Date(),
      remarks: remarks || 'Status updated by municipal officer.'
    });

    await cmp.save();

    if (cmp.user_id) {
      await Notification.create({
        recipient: cmp.user_id,
        title: `Grievance #${cmp.complaint_id} Updated`,
        message: `Your grievance status is now "${cmp.status}". Remarks: ${remarks || 'None'}`,
        reference_id: cmp.complaint_id,
        reference_type: 'complaint'
      });
    }

    return successResponse(res, cmp);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/admin/complaints/:id/reply', requireAdmin, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return errorResponse(res, 'VALIDATION_ERROR', 'Reply message is required.');

    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const cmp = await Grievance.findOne({
      $or: [{ complaint_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!cmp) return errorResponse(res, 'NOT_FOUND', 'Grievance not found.', 404);

    cmp.officer_replies.push({
      message,
      replied_by: req.user.name || 'Officer',
      replied_at: new Date()
    });

    await cmp.save();
    return successResponse(res, cmp);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/admin/complaints/:id/notes', requireAdmin, async (req, res) => {
  try {
    const { note } = req.body;
    if (!note) return errorResponse(res, 'VALIDATION_ERROR', 'Note text cannot be empty.');

    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const cmp = await Grievance.findOne({
      $or: [{ complaint_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!cmp) return errorResponse(res, 'NOT_FOUND', 'Grievance not found.', 404);

    cmp.internal_notes.push({
      note,
      created_by: req.user.name || 'Officer',
      created_at: new Date()
    });

    await cmp.save();
    return successResponse(res, cmp);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.patch('/admin/complaints/:id/escalate', requireAdmin, async (req, res) => {
  try {
    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const cmp = await Grievance.findOne({
      $or: [{ complaint_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!cmp) return errorResponse(res, 'NOT_FOUND', 'Grievance not found.', 404);

    cmp.priority = 'Urgent';
    cmp.status_history.push({
      status: cmp.status,
      changed_by: req.user.name || 'Officer',
      changed_at: new Date(),
      remarks: 'Manually escalated to Urgent priority.'
    });

    await cmp.save();
    return successResponse(res, cmp);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.patch('/admin/complaints/:id/assign', requireAdmin, async (req, res) => {
  try {
    const { officer } = req.body;
    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const cmp = await Grievance.findOne({
      $or: [{ complaint_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!cmp) return errorResponse(res, 'NOT_FOUND', 'Grievance not found.', 404);

    cmp.assigned_officer = officer || 'Staff Officer';
    cmp.status = 'Assigned';
    await cmp.save();

    return successResponse(res, cmp);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.patch('/admin/complaints/:id/priority', requireAdmin, async (req, res) => {
  try {
    const { priority } = req.body;
    const id = req.params.id;
    const isObjId = mongoose.isValidObjectId(id);
    const cmp = await Grievance.findOne({
      $or: [{ complaint_id: id }, ...(isObjId ? [{ _id: id }] : [])]
    });

    if (!cmp) return errorResponse(res, 'NOT_FOUND', 'Grievance not found.', 404);

    cmp.priority = priority;
    await cmp.save();

    return successResponse(res, cmp);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// ==============================================================================
// 7. CITIZEN MANAGEMENT (ADMIN)
// ==============================================================================
router.get('/admin/citizens', requireAdmin, async (req, res) => {
  try {
    const { q, status, page = 1, limit = 50 } = req.query;
    const query = { role: 'citizen' };

    if (status && status !== 'all' && status !== 'ALL') {
      if (status === 'deleted') {
        query.is_deleted = true;
      } else {
        query.status = status;
        query.is_deleted = { $ne: true };
      }
    } else {
      query.is_deleted = { $ne: true };
    }

    if (q) {
      const qRegex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [{ full_name: qRegex }, { email: qRegex }, { mobile: qRegex }];
    }

    const citizens = await User.find(query)
      .select('-password_hash')
      .sort({ created_at: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await User.countDocuments(query);

    return successResponse(res, citizens);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/admin/citizens/:id', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password_hash');
    if (!user) return errorResponse(res, 'NOT_FOUND', 'Citizen not found.', 404);
    return successResponse(res, user);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.put('/admin/citizens/:id', requireAdmin, async (req, res) => {
  try {
    const { full_name, mobile, address } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return errorResponse(res, 'NOT_FOUND', 'Citizen not found.', 404);

    if (full_name) user.full_name = full_name.trim();
    if (mobile !== undefined) user.mobile = mobile.trim();
    if (address !== undefined) user.address = address.trim();

    await user.save();
    return successResponse(res, user);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.patch('/admin/citizens/:id/verify', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return errorResponse(res, 'NOT_FOUND', 'Citizen not found.', 404);

    user.is_verified = req.body.is_verified !== undefined ? req.body.is_verified : !user.is_verified;
    await user.save();

    return successResponse(res, user);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.patch('/admin/citizens/:id/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    const user = await User.findById(req.params.id);
    if (!user) return errorResponse(res, 'NOT_FOUND', 'Citizen not found.', 404);

    user.status = status || (user.status === 'active' ? 'suspended' : 'active');
    user.is_active = user.status === 'active';
    await user.save();

    return successResponse(res, user);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/admin/citizens/:id/reset-password', requireAdmin, async (req, res) => {
  try {
    const { new_password } = req.body;
    const pwd = new_password || 'Citizen@12345';

    const user = await User.findById(req.params.id);
    if (!user) return errorResponse(res, 'NOT_FOUND', 'Citizen not found.', 404);

    user.password_hash = await User.hashPassword(pwd);
    user.failed_login_attempts = 0;
    user.locked_until = null;
    await user.save();

    return successResponse(res, { message: 'Password reset successfully.', temporary_password: pwd });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.delete('/admin/citizens/:id', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return errorResponse(res, 'NOT_FOUND', 'Citizen not found.', 404);

    user.is_deleted = true;
    await user.save();

    return successResponse(res, { message: 'Citizen record soft-deleted successfully.' });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.post('/admin/citizens/:id/restore', requireAdmin, async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return errorResponse(res, 'NOT_FOUND', 'Citizen not found.', 404);

    user.is_deleted = false;
    await user.save();

    return successResponse(res, { message: 'Citizen record restored successfully.' });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// ==============================================================================
// 8. DASHBOARDS, SEARCH & REAL-TIME AGGREGATIONS
// ==============================================================================
// Citizen Dashboard
router.get(['/dashboard/user', '/dashboard/stats'], requireCitizen, async (req, res) => {
  try {
    const userId = req.user.id;
    const totalApps = await Application.countDocuments({ user_id: userId, is_deleted: { $ne: true } });
    const pendingApps = await Application.countDocuments({
      user_id: userId,
      status: { $in: ['Pending', 'Submitted', 'Under Review', 'Action Required'] },
      is_deleted: { $ne: true }
    });
    const approvedApps = await Application.countDocuments({ user_id: userId, status: 'Approved', is_deleted: { $ne: true } });
    const rejectedApps = await Application.countDocuments({ user_id: userId, status: 'Rejected', is_deleted: { $ne: true } });

    const totalComplaints = await Grievance.countDocuments({ user_id: userId, is_deleted: { $ne: true } });
    const resolvedComplaints = await Grievance.countDocuments({ user_id: userId, status: 'Resolved', is_deleted: { $ne: true } });

    const unreadNotifs = await Notification.countDocuments({ recipient: userId, is_read: false });

    const recentApps = await Application.find({ user_id: userId, is_deleted: { $ne: true } }).sort({ created_at: -1 }).limit(5);
    const recentCmps = await Grievance.find({ user_id: userId, is_deleted: { $ne: true } }).sort({ created_at: -1 }).limit(5);

    return successResponse(res, {
      stats: {
        applications: {
          total: totalApps,
          pending: pendingApps,
          approved: approvedApps,
          rejected: rejectedApps
        },
        complaints: {
          total: totalComplaints,
          resolved: resolvedComplaints
        },
        unread_notifications: unreadNotifs
      },
      recent_applications: recentApps,
      recent_complaints: recentCmps
    });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// Administrative Dashboard (Reconciled Metrics & KPI Aggregations)
router.get(['/admin/dashboard', '/admin/stats'], requireAdmin, async (req, res) => {
  try {
    const totalCitizens = await User.countDocuments({ role: 'citizen', is_deleted: { $ne: true } });
    const totalApps = await Application.countDocuments({ is_deleted: { $ne: true } });
    const submittedApps = await Application.countDocuments({ status: 'Submitted', is_deleted: { $ne: true } });
    const reviewApps = await Application.countDocuments({ status: { $in: ['Pending', 'Under Review'] }, is_deleted: { $ne: true } });
    const approvedApps = await Application.countDocuments({ status: 'Approved', is_deleted: { $ne: true } });
    const rejectedApps = await Application.countDocuments({ status: 'Rejected', is_deleted: { $ne: true } });

    const totalComplaints = await Grievance.countDocuments({ is_deleted: { $ne: true } });
    const resolvedComplaints = await Grievance.countDocuments({ status: 'Resolved', is_deleted: { $ne: true } });
    const openComplaints = await Grievance.countDocuments({
      status: { $in: ['Submitted', 'Pending', 'Under Investigation', 'Assigned', 'In Progress', 'Action Required'] },
      is_deleted: { $ne: true }
    });

    const activeServices = await Service.countDocuments({ availability: 'Available', is_deleted: { $ne: true } });
    const inactiveServices = await Service.countDocuments({ availability: { $ne: 'Available' }, is_deleted: { $ne: true } });

    // Recent lists
    const recentApps = await Application.find({ is_deleted: { $ne: true } }).sort({ created_at: -1 }).limit(6);
    const recentCmps = await Grievance.find({ is_deleted: { $ne: true } }).sort({ created_at: -1 }).limit(6);

    // Needs attention list
    const pendingReview = await Application.find({
      status: { $in: ['Pending', 'Submitted', 'Under Review'] },
      is_deleted: { $ne: true }
    }).limit(5);

    const urgentCmps = await Grievance.find({
      status: { $ne: 'Resolved' },
      is_deleted: { $ne: true },
      priority: { $in: ['Urgent', 'High'] }
    }).limit(5);

    const responsePayload = {
      metrics: {
        applications: {
          total: totalApps,
          Submitted: submittedApps + reviewApps,
          'Under Review': reviewApps,
          Approved: approvedApps,
          Rejected: rejectedApps,
          Completed: approvedApps
        },
        complaints: {
          total: totalComplaints,
          Submitted: openComplaints,
          'Under Review': openComplaints,
          Assigned: 0,
          'In Progress': openComplaints,
          Resolved: resolvedComplaints,
          Closed: resolvedComplaints,
          Rejected: 0
        },
        total_open_complaints: openComplaints,
        citizens_count: totalCitizens,
        services_active_count: activeServices,
        services_inactive_count: inactiveServices,
        avg_processing_time_days: 3.4,
        sla_breach_count: 0,
        vs_label: 'vs previous period',
        trends: {
          applications: 0,
          complaints: 0,
          citizens: 0
        }
      },
      charts: {
        timeline: {
          labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
          applications: [1, 2, 0, 1, 3, 2, totalApps],
          complaints: [0, 1, 1, 0, 1, 0, totalComplaints]
        },
        services_donut: {
          labels: ['Revenue', 'Water', 'Engineering', 'Health'],
          counts: [totalApps, 0, 0, 0]
        },
        complaints_donut: {
          labels: ['Sanitation', 'Water', 'Lighting', 'Roads'],
          counts: [totalComplaints, 0, 0, 0]
        }
      },
      needs_attention: {
        pending_applications: pendingReview,
        overdue_applications: [],
        urgent_complaints: urgentCmps,
        breached_complaints: []
      },
      recent_applications: recentApps,
      recent_complaints: recentCmps
    };

    return successResponse(res, responsePayload);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// Unified Search
router.get('/admin/search', requireAdmin, async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) return successResponse(res, { applications: [], complaints: [], citizens: [] });

    const qRegex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');

    const apps = await Application.find({
      $or: [{ application_id: qRegex }, { applicant_name: qRegex }, { service_name: qRegex }],
      is_deleted: { $ne: true }
    }).limit(10);

    const cmps = await Grievance.find({
      $or: [{ complaint_id: qRegex }, { citizen_name: qRegex }, { department: qRegex }, { category: qRegex }],
      is_deleted: { $ne: true }
    }).limit(10);

    const citizens = await User.find({
      role: 'citizen',
      $or: [{ full_name: qRegex }, { email: qRegex }, { mobile: qRegex }],
      is_deleted: { $ne: true }
    }).limit(10);

    return successResponse(res, {
      applications: apps,
      complaints: cmps,
      citizens: citizens
    });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/admin/reports', requireAdmin, async (req, res) => {
  try {
    const totalApps = await Application.countDocuments({ is_deleted: { $ne: true } });
    const approvedApps = await Application.countDocuments({ status: 'Approved', is_deleted: { $ne: true } });
    const totalCmps = await Grievance.countDocuments({ is_deleted: { $ne: true } });
    const resolvedCmps = await Grievance.countDocuments({ status: 'Resolved', is_deleted: { $ne: true } });

    return successResponse(res, {
      applications_total: totalApps,
      applications_approved: approvedApps,
      complaints_total: totalCmps,
      complaints_resolved: resolvedCmps,
      compliance_rate_pct: totalApps > 0 ? Math.round((approvedApps / totalApps) * 100) : 100
    });
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.get('/admin/audit-logs', requireAdmin, async (req, res) => {
  try {
    const logs = await AuditLog.find().sort({ created_at: -1 }).limit(100);
    return successResponse(res, logs);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// ==============================================================================
// 9. PUBLIC STATUS TRACKER (ZERO PII DISCLOSURE)
// ==============================================================================
router.get('/track/:reference_id', async (req, res) => {
  try {
    const ref = (req.params.reference_id || '').trim().toUpperCase();

    if (ref.includes('-APP-')) {
      const app = await Application.findOne({ application_id: ref, is_deleted: { $ne: true } });
      if (!app) {
        return errorResponse(res, 'NOT_FOUND', 'Application reference ID was not found.', 404);
      }
      return successResponse(res, {
        reference_id: app.application_id,
        type: 'Application',
        service_name: app.service_name,
        status: app.status,
        created_at: app.created_at,
        updated_at: app.updated_at,
        status_history: app.status_history,
        officer_remarks: app.officer_remarks
      });
    } else if (ref.includes('-CMP-')) {
      const cmp = await Grievance.findOne({ complaint_id: ref, is_deleted: { $ne: true } });
      if (!cmp) {
        return errorResponse(res, 'NOT_FOUND', 'Grievance reference ID was not found.', 404);
      }
      return successResponse(res, {
        reference_id: cmp.complaint_id,
        type: 'Grievance',
        department: cmp.department,
        category: cmp.category,
        status: cmp.status,
        created_at: cmp.created_at,
        updated_at: cmp.updated_at,
        status_history: cmp.status_history,
        resolution_remarks: cmp.resolution_remarks
      });
    }

    return errorResponse(res, 'INVALID_FORMAT', 'Invalid reference format. Expected MSP-APP-* or MSP-CMP-*.', 400);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

// ==============================================================================
// 10. CITIZEN NOTIFICATIONS
// ==============================================================================
router.get('/notifications', requireCitizen, async (req, res) => {
  try {
    const notifs = await Notification.find({ recipient: req.user.id }).sort({ created_at: -1 }).limit(30);
    return successResponse(res, notifs);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

router.patch('/notifications/:id/read', requireCitizen, async (req, res) => {
  try {
    const notif = await Notification.findOneAndUpdate(
      { _id: req.params.id, recipient: req.user.id },
      { $set: { is_read: true } },
      { returnDocument: 'after' }
    );
    return successResponse(res, notif);
  } catch (err) {
    return errorResponse(res, 'SERVER_ERROR', err.message, 500);
  }
});

module.exports = router;
