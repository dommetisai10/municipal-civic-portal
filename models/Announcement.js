/**
 * Announcement Mongoose Model.
 * Represents public announcements, news, and urgent alerts on the civic portal.
 */

const mongoose = require('mongoose');

const announcementSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: [true, 'Announcement title is required'],
      trim: true
    },
    content: {
      type: String,
      required: [true, 'Announcement content is required']
    },
    category: {
      type: String,
      default: 'General'
    },
    priority: {
      type: String,
      enum: ['normal', 'high', 'urgent'],
      default: 'normal'
    },
    is_active: {
      type: Boolean,
      default: true,
      index: true
    },
    expires_at: {
      type: Date,
      default: null
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
  }
);

announcementSchema.index({ is_active: 1, created_at: -1 });

module.exports = mongoose.model('Announcement', announcementSchema, 'announcements');
