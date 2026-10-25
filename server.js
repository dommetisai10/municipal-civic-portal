/**
 * Municipal Service Portal - Production Express Server Entry Point.
 *
 * Production Guarantees:
 * - Listens on 0.0.0.0 and process.env.PORT for cloud container compatibility (Render Web Service).
 * - app.set('trust proxy', 1) for reverse proxy header propagation (IP detection & rate limiting).
 * - HTTP security headers via helmet with cross-origin document viewing support.
 * - Gzip/Brotli response compression via compression.
 * - Access logging via morgan.
 * - Rate limiting (general API limit + strict authentication protection against brute-force).
 * - Dynamic CORS supporting Vercel production & preview domains, configured CLIENT_URL, and localhost.
 * - Starts HTTP server strictly AFTER MongoDB Atlas connection is healthy.
 * - Global JSON error handler (no HTML leak on API errors).
 * - Graceful shutdown hooks for SIGINT / SIGTERM.
 */

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const { connectDB, closeDB, checkDbHealth } = require('./config/db');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = parseInt(process.env.PORT || '5000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// 1. Trust Reverse Proxy (Mandatory on Render / Cloudflare / Vercel proxies)
app.set('trust proxy', 1);

// 2. HTTP Security Headers
app.use(
  helmet({
    contentSecurityPolicy: false, // Frontend is hosted on Vercel; allow cross-origin API assets
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  })
);

// 3. Response Compression
app.use(compression());

// 4. Request Logging
if (process.env.NODE_ENV === 'production') {
  app.use(morgan('combined'));
} else {
  app.use(morgan('dev'));
}

// 5. Dynamic CORS Configuration
const rawClientUrls = process.env.CLIENT_URL || '';
const configuredOrigins = rawClientUrls
  .split(',')
  .map((url) => url.trim().replace(/\/+$/, ''))
  .filter(Boolean);

const defaultOrigins = [
  'http://127.0.0.1:5000',
  'http://localhost:5000',
  'http://127.0.0.1:5500',
  'http://localhost:5500',
  'http://127.0.0.1:3000',
  'http://localhost:3000'
];

const allowedOrigins = [...new Set([...configuredOrigins, ...defaultOrigins])];

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser requests (e.g. server-to-server, curl, Render health checks)
    if (!origin) return callback(null, true);

    const cleanOrigin = origin.replace(/\/+$/, '');

    // 1. Check explicitly configured origins
    if (allowedOrigins.includes(cleanOrigin)) {
      return callback(null, true);
    }

    // 2. Allow all Vercel deployments (production & preview URLs)
    if (/^https:\/\/([a-zA-Z0-9-]+\.)*vercel\.app$/.test(cleanOrigin)) {
      return callback(null, true);
    }

    // 3. Allow localhost in development
    if (process.env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cleanOrigin)) {
      return callback(null, true);
    }

    return callback(new Error(`CORS blocked request from unauthorized origin: ${origin}`), false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Requested-With'],
  exposedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token']
};

app.use(cors(corsOptions));

// 6. Rate Limiting Middleware
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please slow down and try again later.',
      fields: null
    }
  }
});
app.use('/api', generalLimiter);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    data: null,
    error: {
      code: 'AUTH_RATE_LIMIT_EXCEEDED',
      message: 'Too many authentication attempts. Please wait 15 minutes before trying again.',
      fields: null
    }
  }
});
app.use(['/api/auth/login', '/api/auth/register', '/api/admin/login'], authLimiter);

// 7. Body Parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 8. Explicit Root Health Probe for Render / Load Balancers
app.get('/healthz', async (req, res) => {
  const health = await checkDbHealth();
  const statusCode = health.status === 'healthy' ? 200 : 503;
  return res.status(statusCode).json(health);
});

// 9. Mount Central API Routes
app.use('/api', apiRoutes);

// 10. API 404 Handler (Strict JSON, Never Returns HTML)
app.use('/api', (req, res) => {
  return res.status(404).json({
    success: false,
    data: null,
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `API endpoint '${req.method} ${req.originalUrl}' does not exist on this server.`,
      fields: null
    }
  });
});

// 11. Optional Static Asset Serving (Fallback for monolithic local development)
const frontendPath = path.join(__dirname, 'frontend');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));

  app.get('/:page', (req, res, next) => {
    const page = req.params.page;
    if (page.startsWith('api')) return next();

    const candidateHtml = path.join(frontendPath, `${page}.html`);
    const candidateDirect = path.join(frontendPath, page);

    if (fs.existsSync(candidateHtml)) {
      return res.sendFile(candidateHtml);
    }
    if (fs.existsSync(candidateDirect)) {
      return res.sendFile(candidateDirect);
    }
    next();
  });

  app.get('/', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
  });
}

// 12. Global Express Error Handler
app.use((err, req, res, next) => {
  // CORS Origin Blocked
  if (err.message && err.message.startsWith('CORS blocked')) {
    return res.status(403).json({
      success: false,
      data: null,
      error: {
        code: 'CORS_FORBIDDEN',
        message: err.message,
        fields: null
      }
    });
  }

  // Multer File Upload Errors
  if (err.name === 'MulterError') {
    const maxMb = process.env.MAX_UPLOAD_MB || 5;
    return res.status(400).json({
      success: false,
      data: null,
      error: {
        code: err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR',
        message:
          err.code === 'LIMIT_FILE_SIZE'
            ? `Uploaded file exceeds the maximum allowed size of ${maxMb} MB.`
            : err.message,
        fields: { [err.field || 'documents']: err.message }
      }
    });
  }

  // Mongoose Duplicate Key Error
  if (err.code === 11000) {
    const dupKey = Object.keys(err.keyPattern || {})[0] || 'field';
    return res.status(409).json({
      success: false,
      data: null,
      error: {
        code: 'DUPLICATE_RESOURCE',
        message: `A record with this ${dupKey} already exists in the system.`,
        fields: { [dupKey]: 'Must be unique.' }
      }
    });
  }

  console.error('[UNHANDLED SERVER ERROR]', err);
  const statusCode = err.statusCode || err.status || 500;
  return res.status(statusCode).json({
    success: false,
    data: null,
    error: {
      code: err.code || 'INTERNAL_SERVER_ERROR',
      message: err.message || 'An unexpected internal server error occurred.',
      fields: err.fields || null
    }
  });
});

let serverInstance = null;

/**
 * Starts HTTP server strictly after database connection succeeds.
 */
async function startServer() {
  try {
    console.log('\n' + '='.repeat(70));
    console.log('   MUNICIPAL SERVICE PORTAL - PRODUCTION API SERVICE');
    console.log('='.repeat(70));

    // Connect to MongoDB Atlas first
    await connectDB();

    serverInstance = app.listen(PORT, HOST, () => {
      const baseUrl = `http://${HOST}:${PORT}`;
      console.log('-'.repeat(70));
      console.log(' SERVER RUNNING:');
      console.log(`   * Binding Address:       ${baseUrl}`);
      console.log(`   * Health Check:          ${baseUrl}/api/health`);
      console.log(`   * Environment:           ${process.env.NODE_ENV || 'development'}`);
      console.log(`   * Storage Backend:       ${process.env.CLOUDINARY_CLOUD_NAME ? 'Cloudinary (Cloud)' : 'Local Disk'}`);
      console.log(`   * Allowed CORS Origins:  ${allowedOrigins.join(', ')}`);
      console.log('='.repeat(70) + '\n');
    });

    return serverInstance;
  } catch (err) {
    console.error('\n[FATAL] Server startup aborted because database connection failed:');
    console.error(err.message);
    process.exit(1);
  }
}

// Graceful Shutdown
async function handleShutdown(signal) {
  console.log(`\n[-] Received ${signal}. Starting graceful shutdown...`);
  if (serverInstance) {
    serverInstance.close(async () => {
      console.log('[-] HTTP server closed.');
      await closeDB();
      process.exit(0);
    });
  } else {
    await closeDB();
    process.exit(0);
  }
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

if (require.main === module) {
  startServer();
}

module.exports = app;
