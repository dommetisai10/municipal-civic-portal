/**
 * User Mongoose Model.
 * Supports Citizens, Officers, and Administrators with role-based access.
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema(
  {
    full_name: {
      type: String,
      required: [true, 'Full name is required'],
      trim: true
    },
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      match: [/^\S+@\S+\.\S+$/, 'Invalid email address format']
    },
    mobile: {
      type: String,
      trim: true,
      default: ''
    },
    address: {
      type: String,
      trim: true,
      default: ''
    },
    password_hash: {
      type: String,
      required: [true, 'Password hash is required'],
      select: true
    },
    role: {
      type: String,
      enum: ['citizen', 'super_admin', 'admin', 'officer', 'viewer'],
      default: 'citizen',
      index: true
    },
    admin_role: {
      type: String,
      default: null
    },
    department: {
      type: String,
      default: 'Municipal Administration'
    },
    status: {
      type: String,
      enum: ['active', 'suspended', 'pending'],
      default: 'active',
      index: true
    },
    is_active: {
      type: Boolean,
      default: true
    },
    is_verified: {
      type: Boolean,
      default: true
    },
    is_deleted: {
      type: Boolean,
      default: false,
      index: true
    },
    failed_login_attempts: {
      type: Number,
      default: 0
    },
    locked_until: {
      type: Date,
      default: null
    },
    last_login_at: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
  }
);

// Compound and query indexes
userSchema.index({ role: 1, is_deleted: 1 });
userSchema.index({ created_at: -1 });

// Helper to compare password against stored hash safely
userSchema.methods.comparePassword = async function (candidatePassword) {
  if (!candidatePassword || !this.password_hash) {
    return false;
  }
  return bcrypt.compare(candidatePassword, this.password_hash);
};

// Static helper to hash password exactly once (safeguards against double-hashing)
userSchema.statics.hashPassword = async function (password) {
  if (!password) {
    throw new Error('Password cannot be empty');
  }
  // If already a bcrypt hash, return as is
  if (
    typeof password === 'string' &&
    (password.startsWith('$2a$') || password.startsWith('$2b$') || password.startsWith('$2y$'))
  ) {
    return password;
  }
  const salt = await bcrypt.genSalt(10);
  return bcrypt.hash(password, salt);
};

module.exports = mongoose.model('User', userSchema, 'users');
