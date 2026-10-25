/**
 * Notification Mongoose Model.
 * Represents in-app real-time status notifications for citizens.
 */

const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema(
  {
    recipient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    title: {
      type: String,
      required: true,
      trim: true
    },
    message: {
      type: String,
      required: true
    },
    reference_id: {
      type: String,
      default: null,
      index: true
    },
    reference_type: {
      type: String,
      enum: ['application', 'complaint', 'system', 'announcement'],
      default: 'system'
    },
    is_read: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
  }
);

notificationSchema.index({ recipient: 1, is_read: 1, created_at: -1 });

module.exports = mongoose.model('Notification', notificationSchema, 'notifications');
