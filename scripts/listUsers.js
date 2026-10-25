/**
 * List Users CLI Utility.
 * 
 * Usage:
 *   npm run list-users
 * 
 * Safely displays registered accounts from MongoDB Atlas (email, role, status, isVerified, isDeleted).
 * NEVER reveals password hashes.
 */

const dotenv = require('dotenv');
dotenv.config();

const { connectDB, closeDB } = require('../config/db');
const User = require('../models/User');

async function listUsers() {
  console.log('\n' + '='.repeat(85));
  console.log('   MUNICIPAL SERVICE PORTAL - REGISTERED USERS IN MONGODB ATLAS');
  console.log('='.repeat(85));

  await connectDB();

  const users = await User.find({})
    .select('email full_name role admin_role status is_active is_verified is_deleted created_at')
    .sort({ created_at: -1 });

  if (!users || users.length === 0) {
    console.log('\n[!] No users found in database. Run "npm run seed" to initialize the Super Admin.\n');
    await closeDB();
    return;
  }

  console.log('\n' + '-'.repeat(85));
  console.log(
    ' ' +
    '#'.padEnd(4) +
    'Email'.padEnd(32) +
    'Role'.padEnd(14) +
    'Status'.padEnd(10) +
    'Verified'.padEnd(11) +
    'Deleted'.padEnd(10) +
    'Created At'
  );
  console.log('-'.repeat(85));

  let citizenCount = 0;
  let adminCount = 0;

  users.forEach((u, idx) => {
    const isVerified = u.is_verified ? 'Yes' : 'No';
    const isDeleted = u.is_deleted ? 'YES (soft)' : 'No';
    const roleDisplay = u.role === 'super_admin' ? 'super_admin' : u.role;
    const createdAt = u.created_at ? new Date(u.created_at).toISOString().split('T')[0] : 'N/A';

    if (u.role === 'citizen') citizenCount++;
    if (['super_admin', 'admin', 'officer'].includes(u.role)) adminCount++;

    console.log(
      ' ' +
      String(idx + 1).padEnd(4) +
      (u.email || '').padEnd(32) +
      roleDisplay.padEnd(14) +
      (u.status || 'active').padEnd(10) +
      isVerified.padEnd(11) +
      isDeleted.padEnd(10) +
      createdAt
    );
  });

  console.log('-'.repeat(85));
  console.log(` Summary: ${users.length} total users (${citizenCount} citizens, ${adminCount} administrators/staff)`);
  console.log(' Note: Password hashes are strictly omitted for security.');
  console.log('='.repeat(85) + '\n');

  await closeDB();
}

listUsers().catch((err) => {
  console.error('\n[!] Failed to list users:', err.message);
  process.exit(1);
});
