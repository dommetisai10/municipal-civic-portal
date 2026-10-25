/**
 * Safe Password Reset Utility CLI.
 * 
 * Usage:
 *   npm run reset-password -- --email=<email> --password=<newpassword>
 * or:
 *   node scripts/resetPassword.js --email=citizen@example.com --password=NewPassword@123
 */

const dotenv = require('dotenv');
dotenv.config();

const { connectDB, closeDB } = require('../config/db');
const User = require('../models/User');

function parseArgs() {
  const args = process.argv.slice(2);
  let email = null;
  let password = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--email=')) {
      email = arg.split('=')[1];
    } else if (arg === '--email' && i + 1 < args.length) {
      email = args[++i];
    } else if (arg.startsWith('--password=')) {
      password = arg.split('=')[1];
    } else if (arg === '--password' && i + 1 < args.length) {
      password = args[++i];
    }
  }

  return { email, password };
}

async function runReset() {
  const { email, password } = parseArgs();

  console.log('\n' + '='.repeat(68));
  console.log('   MUNICIPAL SERVICE PORTAL - USER PASSWORD RESET UTILITY');
  console.log('='.repeat(68));

  if (!email || !password) {
    console.error('\n[✗] ERROR: Missing required arguments.\n');
    console.log('Usage:');
    console.log('  npm run reset-password -- --email=<email> --password=<newpassword>\n');
    console.log('Example:');
    console.log('  npm run reset-password -- --email=admin@municipal.gov --password=Admin@12345\n');
    process.exit(1);
  }

  if (password.length < 6) {
    console.error('\n[✗] ERROR: Password must be at least 6 characters long.\n');
    process.exit(1);
  }

  await connectDB();

  const normEmail = email.toLowerCase().trim();
  console.log(`[i] Looking up user: ${normEmail}...`);

  // Case-insensitive email query
  const user = await User.findOne({
    email: normEmail,
    is_deleted: { $ne: true }
  });

  if (!user) {
    console.error(`\n[✗] ERROR: User with email "${normEmail}" was not found in MongoDB Atlas.`);
    console.log('Tip: Run "npm run list-users" to see all existing registered accounts.\n');
    await closeDB();
    process.exit(1);
  }

  // Hash password exactly once
  const newHash = await User.hashPassword(password);
  user.password_hash = newHash;
  user.failed_login_attempts = 0;
  user.locked_until = null;
  user.is_active = true;
  user.status = 'active';

  await user.save();

  console.log('\n' + '-'.repeat(68));
  console.log(`[✓] SUCCESS: Password reset successfully!`);
  console.log(`    User Email : ${user.email}`);
  console.log(`    Full Name  : ${user.full_name}`);
  console.log(`    Role       : ${user.role} ${user.admin_role ? '(' + user.admin_role + ')' : ''}`);
  console.log(`    Status     : ${user.status} (Active: ${user.is_active})`);
  console.log('-'.repeat(68));
  console.log('[i] You may now log in immediately with the new password.\n');

  await closeDB();
}

runReset().catch((err) => {
  console.error('\n[!] Password reset failed:', err.message);
  process.exit(1);
});
