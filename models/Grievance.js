/**
 * Grievance / Complaint Mongoose Model.
 * Represents civic complaints with geolocation, landmark, priority, notes, and multi-stage resolution.
 */

const mongoose = require('mongoose');

const grievanceStatusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: [
        'Submitted',
        'Pending',
        'Under Review',
        'Under Investigation',
        'Assigned',
        'In Progress',
        'Action Required',
        'Resolved',
        'Closed',
        'Rejected'
      ],
      required: true
    },
    changed_by: {
      type: String,
      default: 'System'
    },
    changed_at: {
      type: Date,
      default: Date.now
    },
    remarks: {
      type: String,
      default: ''
    }
  },
  { _id: false }
);

const grievanceSchema = new mongoose.Schema(
  {
    complaint_id: {
      type: String,
      required: [true, 'Complaint ID is required'],
      unique: true
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    citizen_name: {
      type: String,
      default: 'Citizen'
    },
    citizen_email: {
      type: String,
      default: ''
    },
    citizen_phone: {
      type: String,
      default: ''
    },
    department: {
      type: String,
      required: [true, 'Department is required'],
      index: true
    },
    category: {
      type: String,
      required: [true, 'Complaint category is required']
    },
    description: {
      type: String,
      required: [true, 'Description is required']
    },
    landmark: {
      type: String,
      default: ''
    },
    address: {
      type: String,
      default: ''
    },
    latitude: {
      type: Number,
      default: null
    },
    longitude: {
      type: Number,
      default: null
    },
    photo_url: {
      type: String,
      default: null
    },
    priority: {
      type: String,
      enum: ['Low', 'Medium', 'High', 'Urgent'],
      default: 'Medium'
    },
    status: {
      type: String,
      enum: [
        'Submitted',
        'Pending',
        'Under Review',
        'Under Investigation',
        'Assigned',
        'In Progress',
        'Action Required',
        'Resolved',
        'Closed',
        'Rejected'
      ],
      default: 'Pending',
      index: true
    },
    assigned_officer: {
      type: String,
      default: null
    },
    resolution_remarks: {
      type: String,
      default: ''
    },
    internal_notes: {
      type: [
        {
          note: String,
          created_by: String,
          created_at: { type: Date, default: Date.now }
        }
      ],
      default: []
    },
    officer_replies: {
      type: [
        {
          message: String,
          replied_by: String,
          replied_at: { type: Date, default: Date.now }
        }
      ],
      default: []
    },
    status_history: {
      type: [grievanceStatusHistorySchema],
      default: []
    },
    is_deleted: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }
  }
);

grievanceSchema.index({ department: 1, status: 1 });
grievanceSchema.index({ user_id: 1, created_at: -1 });
grievanceSchema.index({ status: 1, created_at: -1 });

module.exports = mongoose.model('Grievance', grievanceSchema, 'complaints');
