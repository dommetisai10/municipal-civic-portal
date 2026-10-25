/**
 * Production Multer Upload & File Security Middleware
 *
 * Implements:
 * - Dual storage backend: Cloudinary (cloud for ephemeral containers like Render) + Disk fallback (local dev)
 * - Controlled by CLOUDINARY_* environment variables or STORAGE_BACKEND=local
 * - In-memory buffer validation for cloud uploads (prevents writing to ephemeral disks)
 * - Strict 5 MB size limit (configurable via MAX_UPLOAD_MB)
 * - Case-insensitive extension and MIME type validation (PDF, JPG, JPEG, PNG)
 * - Binary magic-byte signature inspection on both Buffer and File Stream
 * - Cloudinary file upload & deletion helpers
 * - Standardized MulterError translation to uniform JSON errors
 */

const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;

// Check if Cloudinary credentials are fully configured
const isCloudinaryConfigured = Boolean(
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET &&
  process.env.STORAGE_BACKEND !== 'local'
);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
}

// Local fallback uploads directory (used only if Cloudinary is not configured)
const UPLOADS_BASE_DIR = path.join(__dirname, '..', 'uploads');
const APPLICATIONS_UPLOAD_DIR = path.join(UPLOADS_BASE_DIR, 'applications');

if (!isCloudinaryConfigured) {
  try {
    fs.mkdirSync(APPLICATIONS_UPLOAD_DIR, { recursive: true });
  } catch (err) {
    console.error('[!] Failed to create local uploads directory:', err.message);
  }
}

// Environment configured file limits
const MAX_FILE_SIZE_MB = parseInt(process.env.MAX_UPLOAD_MB || '5', 10);
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

// Permitted extensions and MIME types
const ALLOWED_EXTENSIONS = new Set(['pdf', 'jpg', 'jpeg', 'png']);
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'application/x-pdf',
  'image/jpeg',
  'image/pjpeg',
  'image/png',
  'image/x-png',
  'application/octet-stream' // verified by magic bytes
]);

// Binary magic byte signatures for real payload inspection
const MAGIC_SIGNATURES = {
  pdf: [0x25, 0x50, 0x44, 0x46], // %PDF
  jpg: [0xFF, 0xD8, 0xFF],       // JPEG SOI
  jpeg: [0xFF, 0xD8, 0xFF],      // JPEG SOI
  png: [0x89, 0x50, 0x4E, 0x47]  // PNG signature
};

/**
 * File filter validating extension and MIME type case-insensitively
 */
function fileFilter(req, file, cb) {
  const originalName = file.originalname || '';
  const ext = path.extname(originalName).toLowerCase().replace('.', '');

  if (!ALLOWED_EXTENSIONS.has(ext)) {
    const err = new Error(
      `File "${originalName}" has an unauthorized extension (.${ext}). Permitted formats: PDF, JPG, JPEG, PNG.`
    );
    err.code = 'INVALID_FILE_TYPE';
    return cb(err, false);
  }

  const mime = (file.mimetype || '').toLowerCase();
  if (mime && !ALLOWED_MIME_TYPES.has(mime) && mime !== '') {
    const err = new Error(
      `File "${originalName}" has an unsupported MIME type (${mime}). Permitted formats: PDF, JPG, PNG.`
    );
    err.code = 'INVALID_MIME_TYPE';
    return cb(err, false);
  }

  cb(null, true);
}

// 1. Memory Storage for Cloudinary (zero ephemeral disk usage)
const memoryStorage = multer.memoryStorage();

// 2. Local Disk Storage Engine (development fallback)
const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    try {
      if (!fs.existsSync(APPLICATIONS_UPLOAD_DIR)) {
        fs.mkdirSync(APPLICATIONS_UPLOAD_DIR, { recursive: true });
      }
      cb(null, APPLICATIONS_UPLOAD_DIR);
    } catch (err) {
      cb(err, null);
    }
  },
  filename: (req, file, cb) => {
    const rawExt = path.extname(file.originalname || '').toLowerCase().replace('.', '');
    const ext = ALLOWED_EXTENSIONS.has(rawExt) ? rawExt : 'bin';
    const timestamp = Date.now();
    const randomHex = crypto.randomBytes(6).toString('hex');
    const safeBaseName = (path.basename(file.originalname || 'document', path.extname(file.originalname || '')))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 30);
    const uniqueFilename = `doc_${timestamp}_${randomHex}_${safeBaseName}.${ext}`;
    cb(null, uniqueFilename);
  }
});

// Select active storage engine
const activeStorage = isCloudinaryConfigured ? memoryStorage : diskStorage;

// Multer Instance
const upload = multer({
  storage: activeStorage,
  limits: {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: 10
  },
  fileFilter: fileFilter
});

/**
 * Validates binary magic bytes to prevent file extension spoofing.
 * Supports both in-memory Buffer and disk file path.
 */
function verifyMagicBytes(fileOrPath, originalName) {
  try {
    const buffer = Buffer.isBuffer(fileOrPath)
      ? fileOrPath
      : (fileOrPath && fileOrPath.buffer ? fileOrPath.buffer : null);

    const name = originalName || (fileOrPath && fileOrPath.originalname) || (typeof fileOrPath === 'string' ? fileOrPath : '');
    const ext = path.extname(name).toLowerCase().replace('.', '');
    const expected = MAGIC_SIGNATURES[ext];

    if (!expected) {
      return { valid: false, message: `Unsupported file extension .${ext}` };
    }

    let headerBytes;
    if (buffer) {
      headerBytes = buffer.slice(0, 16);
    } else {
      const filePath = typeof fileOrPath === 'string' ? fileOrPath : (fileOrPath && fileOrPath.path);
      if (!filePath || !fs.existsSync(filePath)) {
        return { valid: false, message: `File not found for verification.` };
      }
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      fs.closeSync(fd);
      headerBytes = buf;
    }

    if (headerBytes.length < expected.length) {
      return { valid: false, message: `File "${name}" is empty or corrupt.` };
    }

    for (let i = 0; i < expected.length; i++) {
      if (headerBytes[i] !== expected[i]) {
        return {
          valid: false,
          message: `Security validation failed: File content of "${name}" does not match its .${ext.toUpperCase()} extension.`
        };
      }
    }

    return { valid: true };
  } catch (err) {
    return { valid: false, message: `Could not verify file integrity: ${err.message}` };
  }
}

/**
 * Uploads a file buffer to Cloudinary using streaming.
 */
function uploadToCloudinary(file, folder = 'msp_applications') {
  return new Promise((resolve, reject) => {
    if (!isCloudinaryConfigured) {
      return reject(new Error('Cloudinary credentials are not configured in environment.'));
    }

    const rawExt = path.extname(file.originalname || '').toLowerCase().replace('.', '');
    const isPdf = rawExt === 'pdf' || (file.mimetype && file.mimetype.includes('pdf'));
    const safeBase = (path.basename(file.originalname || 'document', path.extname(file.originalname || '')))
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 30);
    const publicId = `${folder}/doc_${Date.now()}_${crypto.randomBytes(4).toString('hex')}_${safeBase}`;

    // Cloudinary resource_type: 'auto' handles images and documents
    const uploadStream = cloudinary.uploader.upload_stream(
      {
        public_id: publicId,
        resource_type: isPdf ? 'auto' : 'auto',
        flags: isPdf ? 'attachment' : undefined,
        overwrite: true
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }
        resolve(result);
      }
    );

    uploadStream.end(file.buffer);
  });
}

/**
 * Deletes a file from Cloudinary by public ID.
 */
async function deleteFromCloudinary(publicId, resourceType = 'auto') {
  if (!publicId || !isCloudinaryConfigured) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType || 'auto' });
  } catch (err) {
    console.warn(`[!] Cloudinary deletion warning for ${publicId}:`, err.message);
  }
}

/**
 * Deletes uploaded files from disk if validation or database save fails (prevents orphaned files).
 */
function cleanupUploadedFiles(files) {
  if (!files) return;
  const list = Array.isArray(files) ? files : Object.values(files).flat();
  for (const f of list) {
    if (!f || !f.path) continue;
    try {
      if (fs.existsSync(f.path)) {
        fs.unlinkSync(f.path);
      }
    } catch (err) {
      console.warn(`[!] Could not delete orphaned local file ${f.path}:`, err.message);
    }
  }
}

/**
 * Standard Express middleware wrapper for handling Multer upload and mapping errors to friendly JSON.
 */
function handleUpload(multerMiddleware) {
  return (req, res, next) => {
    multerMiddleware(req, res, (err) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          if (err.code === 'LIMIT_FILE_SIZE') {
            return res.status(400).json({
              success: false,
              data: null,
              error: {
                code: 'FILE_TOO_LARGE',
                message: `Uploaded file exceeds the maximum permitted size limit of ${MAX_FILE_SIZE_MB} MB. Please select a smaller file.`,
                fields: { [err.field || 'documents']: `File exceeds ${MAX_FILE_SIZE_MB} MB limit.` }
              }
            });
          }
          if (err.code === 'LIMIT_UNEXPECTED_FILE') {
            return res.status(400).json({
              success: false,
              data: null,
              error: {
                code: 'UNEXPECTED_FILE',
                message: `Unexpected upload field "${err.field}".`,
                fields: { [err.field]: 'Unexpected file attachment.' }
              }
            });
          }
          return res.status(400).json({
            success: false,
            data: null,
            error: {
              code: 'UPLOAD_ERROR',
              message: `Upload error: ${err.message}`,
              fields: null
            }
          });
        }

        // Custom filter or type errors
        return res.status(400).json({
          success: false,
          data: null,
          error: {
            code: err.code || 'INVALID_FILE',
            message: err.message || 'File upload rejected.',
            fields: null
          }
        });
      }
      next();
    });
  };
}

module.exports = {
  upload,
  handleUpload,
  verifyMagicBytes,
  cleanupUploadedFiles,
  uploadToCloudinary,
  deleteFromCloudinary,
  isCloudinaryConfigured,
  UPLOADS_BASE_DIR,
  APPLICATIONS_UPLOAD_DIR,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
  ALLOWED_EXTENSIONS
};
