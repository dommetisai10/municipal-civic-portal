/**
 * Diagnostic Health Check Script (`npm run db:check`).
 * 
 * Prints PASS/FAIL for:
 * 1. Environment variables loaded
 * 2. MongoDB Atlas connection
 * 3. Database ping and latency
 * 4. Required core collections
 * 5. Admin user exists
 * 6. Services count (official 12 municipal services)
 * 7. Collection indexes
 */

const dotenv = require('dotenv');
dotenv.config();

const mongoose = require('mongoose');
const { connectDB, checkDbHealth, closeDB, sanitizeUri } = require('../config/db');
const User = require('../models/User');
const Service = require('../models/Service');
const Application = require('../models/Application');
const Grievance = require('../models/Grievance');

async function runCheck() {
  console.log('\n' + '='.repeat(72));
  console.log('   MUNICIPAL SERVICE PORTAL - MONGODB ATLAS DIAGNOSTIC VERIFICATION');
  console.log('='.repeat(72));

  const checks = [];

  // Check 1: Environment Variables Loaded
  const requiredEnv = ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_EMAIL', 'ADMIN_PASSWORD'];
  const missingEnv = requiredEnv.filter((k) => !process.env[k]);
  if (missingEnv.length === 0) {
    checks.push({
      name: 'Environment Variables Loaded',
      status: 'PASS',
      detail: `All required variables present (${requiredEnv.join(', ')})`
    });
  } else {
    checks.push({
      name: 'Environment Variables Loaded',
      status: 'FAIL',
      detail: `Missing: ${missingEnv.join(', ')}`
    });
  }

  // Check 2 & 3: Connection & Ping
  let conn = null;
  let latencyMs = null;
  try {
    conn = await connectDB(1, 1500);
    const health = await checkDbHealth();
    latencyMs = health.latency_ms;

    checks.push({
      name: 'MongoDB Atlas Connection',
      status: 'PASS',
      detail: `Connected to ${conn.name} (${conn.host})`
    });

    checks.push({
      name: 'Database Ping & Latency',
      status: latencyMs !== null && latencyMs < 3000 ? 'PASS' : 'WARN',
      detail: `${latencyMs !== null ? latencyMs + ' ms' : 'N/A'} round-trip latency`
    });
  } catch (err) {
    checks.push({
      name: 'MongoDB Atlas Connection',
      status: 'FAIL',
      detail: err.message
    });
    checks.push({
      name: 'Database Ping & Latency',
      status: 'FAIL',
      detail: 'Could not ping unestablished connection'
    });
    printSummary(checks);
    process.exit(1);
  }

  // Check 4: Required Core Collections
  const requiredCols = ['users', 'services', 'applications', 'complaints'];
  try {
    const collections = await mongoose.connection.db.listCollections().toArray();
    const colNames = collections.map((c) => c.name);
    const missingCols = requiredCols.filter((c) => !colNames.includes(c));

    if (missingCols.length === 0) {
      checks.push({
        name: 'Required Core Collections',
        status: 'PASS',
        detail: `All 4 core collections present (${requiredCols.join(', ')})`
      });
    } else {
      checks.push({
        name: 'Required Core Collections',
        status: 'FAIL',
        detail: `Missing collections: ${missingCols.join(', ')} (run npm run seed)`
      });
    }
  } catch (err) {
    checks.push({
      name: 'Required Core Collections',
      status: 'FAIL',
      detail: err.message
    });
  }

  // Check 5: Admin User Exists
  try {
    const adminUser = await User.findOne({
      role: { $in: ['super_admin', 'admin'] },
      is_deleted: { $ne: true }
    });

    if (adminUser) {
      checks.push({
        name: 'Admin User Exists',
        status: 'PASS',
        detail: `${adminUser.email} (Role: ${adminUser.role}, Status: ${adminUser.status})`
      });
    } else {
      checks.push({
        name: 'Admin User Exists',
        status: 'FAIL',
        detail: 'No active super_admin or admin found. Run "npm run seed" to initialize.'
      });
    }
  } catch (err) {
    checks.push({
      name: 'Admin User Exists',
      status: 'FAIL',
      detail: err.message
    });
  }

  // Check 6: Services Count
  try {
    const srvCount = await Service.countDocuments({ is_deleted: { $ne: true } });
    if (srvCount >= 12) {
      checks.push({
        name: 'Services Count',
        status: 'PASS',
        detail: `Found ${srvCount} official services in catalog (Expected: >= 12)`
      });
    } else if (srvCount > 0) {
      checks.push({
        name: 'Services Count',
        status: 'WARN',
        detail: `Found ${srvCount} services (Partial catalog; run "npm run seed" for full 12)`
      });
    } else {
      checks.push({
        name: 'Services Count',
        status: 'FAIL',
        detail: 'Catalog empty (0 services). Run "npm run seed" to populate.'
      });
    }
  } catch (err) {
    checks.push({
      name: 'Services Count',
      status: 'FAIL',
      detail: err.message
    });
  }

  // Check 7: Collection Indexes
  try {
    const userIndexes = await User.collection.indexes();
    const serviceIndexes = await Service.collection.indexes();
    const appIndexes = await Application.collection.indexes();
    const cmpIndexes = await Grievance.collection.indexes();

    const hasUserEmailIndex = userIndexes.some((idx) => idx.key && idx.key.email);
    const hasServiceSlugIndex = serviceIndexes.some((idx) => idx.key && idx.key.slug);
    const hasAppIdIndex = appIndexes.some((idx) => idx.key && idx.key.application_id);
    const hasCmpIdIndex = cmpIndexes.some((idx) => idx.key && idx.key.complaint_id);

    if (hasUserEmailIndex && hasServiceSlugIndex && hasAppIdIndex && hasCmpIdIndex) {
      checks.push({
        name: 'Collection Indexes Verified',
        status: 'PASS',
        detail: `Unique and lookup indexes active across users, services, apps, and grievances`
      });
    } else {
      checks.push({
        name: 'Collection Indexes Verified',
        status: 'WARN',
        detail: 'Some indexes pending creation'
      });
    }
  } catch (err) {
    checks.push({
      name: 'Collection Indexes Verified',
      status: 'FAIL',
      detail: err.message
    });
  }

  printSummary(checks);
  await closeDB();
}

function printSummary(checks) {
  console.log('\n' + '-'.repeat(72));
  console.log('   SYSTEM DIAGNOSTIC RESULTS');
  console.log('-'.repeat(72));

  let passCount = 0;
  for (const c of checks) {
    const symbol = c.status === 'PASS' ? '✓' : c.status === 'WARN' ? '⚠' : '✗';
    console.log(` [${symbol}] ${c.name.padEnd(32)} : [${c.status}] ${c.detail}`);
    if (c.status === 'PASS') passCount++;
  }

  console.log('-'.repeat(72));
  console.log(` RESULT: ${passCount}/${checks.length} checks PASSED.`);
  console.log('='.repeat(72) + '\n');
}

runCheck().catch((err) => {
  console.error('\n[!] Diagnostic execution error:', err.message);
  process.exit(1);
});
