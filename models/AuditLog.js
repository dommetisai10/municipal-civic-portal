/**
 * AuditLog Mongoose Model (Immutable).
 * Records tamper-evident administrative activities and state changes.
 */

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actor_id: {
      type: String,
      default: 'system',
      index: true
    },
    actor_role: {
      type: String,
      default: 'admin'
    },
    action: {
      type: String,
      required: true,
      index: true
    },
    target_collection: {
      type: String,
      default: ''
    },
    target_id: {
      type: String,
      default: ''
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    ip_address: {
      type: String,
      default: '127.0.0.1'
    },
    created_at: {
      type: Date,
      default: Date.now,
      immutable: true,
      index: true
    }
  },
  {
    timestamps: false,
    versionKey: false
  }
);

auditLogSchema.index({ created_at: -1 });
auditLogSchema.index({ action: 1, created_at: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema, 'audit_logs');
