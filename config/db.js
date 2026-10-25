/**
 * Centralized MongoDB Atlas Connection Module using Mongoose.
 * 
 * Implements:
 * - Environment variable validation with fail-fast startup checks.
 * - Connection retry with exponential backoff.
 * - Connection pool management and timeouts.
 * - Masked credential logging (never prints passwords).
 * - Real ping health checks with latency and uptime.
 * - Graceful shutdown hooks (SIGINT / SIGTERM).
 */

const mongoose = require('mongoose');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

const START_TIME = Date.now();

/**
 * Validates required environment variables before attempting connection.
 */
function validateConfig() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
  if (!uri) {
    throw new Error(
      'Startup Error: MONGODB_URI environment variable is missing. ' +
      'Please configure MONGODB_URI in your .env file.'
    );
  }
  return {
    uri,
    dbName: process.env.MONGODB_DB_NAME || process.env.MONGO_DB_NAME || 'municipal_civic_portal'
  };
}

/**
 * Masks user credentials in connection string for safe console logging.
 */
function sanitizeUri(uri) {
  if (!uri) return '';
  return uri.replace(/:([^@/]+)@/, ':****@');
}

/**
 * Extracts cluster hostname from MongoDB connection string.
 */
function getClusterHost(uri) {
  try {
    const match = uri.match(/@([^/?]+)/);
    return match ? match[1] : 'MongoDB Cluster';
  } catch {
    return 'MongoDB Cluster';
  }
}

/**
 * Connects to MongoDB Atlas with exponential backoff retry.
 */
async function connectDB(maxRetries = 5, initialDelayMs = 1500) {
  const { uri, dbName } = validateConfig();
  const clusterHost = getClusterHost(uri);
  let delay = initialDelayMs;

  // Modern Mongoose options
  const mongooseOptions = {
    dbName: dbName,
    serverSelectionTimeoutMS: 8000,
    socketTimeoutMS: 45000,
    maxPoolSize: 50,
    minPoolSize: 5,
    retryWrites: true,
    w: 'majority'
  };

  // Connection Event Listeners
  mongoose.connection.on('connected', () => {
    console.log(`[+] MongoDB Atlas connected: ${clusterHost}/${dbName}`);
  });

  mongoose.connection.on('error', (err) => {
    console.error(`[!] MongoDB Connection Error: ${err.message}`);
  });

  mongoose.connection.on('disconnected', () => {
    console.warn('[-] MongoDB disconnected. Awaiting reconnection...');
  });

  mongoose.connection.on('reconnected', () => {
    console.log('[+] MongoDB Atlas reconnected successfully.');
  });

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[i] Connecting to MongoDB Atlas (attempt ${attempt}/${maxRetries})...`);
      await mongoose.connect(uri, mongooseOptions);
      return mongoose.connection;
    } catch (error) {
      console.error(`[!] Connection attempt ${attempt} failed: ${error.message}`);
      if (attempt === maxRetries) {
        throw new Error(
          `Failed to connect to MongoDB Atlas after ${maxRetries} attempts.\n` +
          `Target: ${sanitizeUri(uri)}\n` +
          `Error Details: ${error.message}\n` +
          `Troubleshooting Tip: If using Atlas, ensure your current IP is whitelisted under Network Access in MongoDB Atlas.`
        );
      }
      console.log(`[i] Retrying in ${(delay / 1000).toFixed(1)}s (exponential backoff)...`);
      await new Promise((res) => setTimeout(res, delay));
      delay *= 2;
    }
  }
}

/**
 * Runs a live ping against MongoDB to measure latency and return health diagnostics.
 */
async function checkDbHealth() {
  const uptimeSeconds = Math.round((Date.now() - START_TIME) / 1000);
  if (mongoose.connection.readyState !== 1) {
    return {
      status: 'degraded',
      database: 'disconnected',
      latency_ms: null,
      uptime_seconds: uptimeSeconds,
      collections_count: 0,
      message: 'MongoDB is disconnected (readyState: ' + mongoose.connection.readyState + ')'
    };
  }

  const startPing = Date.now();
  try {
    const adminDb = mongoose.connection.db.admin();
    await adminDb.ping();
    const latencyMs = Date.now() - startPing;
    const collections = await mongoose.connection.db.listCollections().toArray();

    return {
      status: 'healthy',
      database: 'connected',
      latency_ms: latencyMs,
      uptime_seconds: uptimeSeconds,
      collections_count: collections.length,
      database_name: mongoose.connection.name,
      message: `MongoDB Atlas responsive (${latencyMs} ms)`
    };
  } catch (err) {
    return {
      status: 'degraded',
      database: 'disconnected',
      latency_ms: Date.now() - startPing,
      uptime_seconds: uptimeSeconds,
      collections_count: 0,
      message: `Ping failed: ${err.message}`
    };
  }
}

/**
 * Graceful shutdown handler closing Mongoose connection pool.
 */
async function closeDB() {
  if (mongoose.connection.readyState !== 0) {
    try {
      await mongoose.connection.close(false);
      console.log('[-] Closed MongoDB Atlas connection pool gracefully.');
    } catch (err) {
      console.error('[!] Error closing MongoDB connection:', err);
    }
  }
}

// Register process termination handlers
process.on('SIGINT', async () => {
  await closeDB();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await closeDB();
  process.exit(0);
});

module.exports = {
  connectDB,
  checkDbHealth,
  closeDB,
  sanitizeUri
};
