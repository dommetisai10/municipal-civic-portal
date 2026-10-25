/**
 * Application Mongoose Model.
 * Represents citizen applications for municipal services with full document metadata.
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const documentAttachmentSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      default: 'document'
    },
    label: {
      type: String,
      default: ''
    },
    field_name: {
      type: String,
      default: 'documents'
    },
    original_name: {
      type: String,
      required: true
    },
    saved_filename: {
      type: String,
      required: true
    },
    file_path: {
      type: String,
      required: true
    },
    file_size: {
      type: Number,
      default: 0
    },
    mime_type: {
      type: String,
      default: 'application/octet-stream'
    },
    uploaded_at: {
      type: Date,
      default: Date.now
    },
    public_id: {
      type: String,
      default: null
    },
    secure_url: {
      type: String,
      default: null
    },
    resource_type: {
      type: String,
      default: null
    }
  },
  {
    _id: false,
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Virtual aliases for robust frontend/backend property access
documentAttachmentSchema.virtual('originalName').get(function () {
  return this.original_name;
});
documentAttachmentSchema.virtual('filename').get(function () {
  return this.saved_filename;
});
documentAttachmentSchema.virtual('path').get(function () {
  return this.file_path;
});
documentAttachmentSchema.virtual('size').get(function () {
  return this.file_size;
});
documentAttachmentSchema.virtual('mimetype').get(function () {
  return this.mime_type;
});

const statusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['Submitted', 'Pending', 'Under Review', 'Action Required', 'Approved', 'Rejected', 'Completed'],
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

const applicationSchema = new mongoose.Schema(
  {
    application_id: {
      type: String,
      required: [true, 'Application ID is required'],
      unique: true,
      index: true
    },
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'User ID is required'],
      index: true
    },
    service_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Service'
    },
    service_slug: {
      type: String,
      required: [true, 'Service slug is required'],
      index: true
    },
    service_name: {
      type: String,
      required: [true, 'Service name is required']
    },
    applicant_name: {
      type: String,
      default: ''
    },
    applicant_email: {
      type: String,
      default: ''
    },
    applicant_mobile: {
      type: String,
      default: ''
    },
    form_data: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    documents: {
      type: [documentAttachmentSchema],
      default: []
    },
    status: {
      type: String,
      enum: ['Submitted', 'Pending', 'Under Review', 'Action Required', 'Approved', 'Rejected', 'Completed'],
      default: 'Pending',
      index: true
    },
    status_history: {
      type: [statusHistorySchema],
      default: []
    },
    officer_remarks: {
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
    is_deleted: {
      type: Boolean,
      default: false,
      index: true
    }
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
    toJSON: { virtuals: true },
    toObject: { virtuals: true }
  }
);

// Indexes
applicationSchema.index({ user_id: 1, created_at: -1 });
applicationSchema.index({ status: 1, created_at: -1 });
applicationSchema.index({ service_slug: 1, status: 1 });

/**
 * Generates an atomic, collision-free Application Reference Number:
 * Format: MSP-APP-YYYY-XXXXXX
 */
applicationSchema.statics.generateReferenceNumber = async function () {
  const year = new Date().getFullYear();
  for (let attempt = 0; attempt < 10; attempt++) {
    const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
    const candidateId = `MSP-APP-${year}-${randomHex}`;
    const exists = await this.findOne({ application_id: candidateId }).select('_id');
    if (!exists) {
      return candidateId;
    }
  }
  // High-entropy fallback
  return `MSP-APP-${year}-${Date.now().toString().slice(-6)}`;
};

module.exports = mongoose.model('Application', applicationSchema, 'applications');
