/**
 * Service Mongoose Model.
 * Single source of truth for the municipal civic services catalog and document requirements.
 */

const mongoose = require('mongoose');

const requiredDocSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      required: true,
      trim: true
    },
    label: {
      type: String,
      required: true,
      trim: true
    },
    required: {
      type: Boolean,
      default: true
    },
    allowedTypes: {
      type: [String],
      default: ['pdf', 'jpg', 'jpeg', 'png']
    },
    maxSizeMB: {
      type: Number,
      default: 5
    }
  },
  { _id: false }
);

const serviceSchema = new mongoose.Schema(
  {
    slug: {
      type: String,
      required: [true, 'Service slug is required'],
      unique: true,
      lowercase: true,
      trim: true
    },
    name: {
      type: String,
      required: [true, 'Service name is required'],
      trim: true
    },
    category: {
      type: String,
      required: [true, 'Category is required'],
      trim: true,
      index: true
    },
    description: {
      type: String,
      default: ''
    },
    availability: {
      type: String,
      enum: ['Available', 'Unavailable', 'Maintenance', 'Suspended'],
      default: 'Available',
      index: true
    },
    sla_days: {
      type: Number,
      default: 7
    },
    fee: {
      type: Number,
      default: 0
    },
    // Structured document requirements (Single Source of Truth)
    requiredDocuments: {
      type: [requiredDocSchema],
      default: []
    },
    // Legacy array of document names for backward compatibility
    required_documents: {
      type: [String],
      default: []
    },
    form_schema: {
      type: [mongoose.Schema.Types.Mixed],
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
serviceSchema.index({ availability: 1, is_deleted: 1 });
serviceSchema.index({ category: 1, availability: 1 });

// Synchronize legacy required_documents with structured requiredDocuments on save
serviceSchema.pre('save', function (next) {
  if (Array.isArray(this.requiredDocuments) && this.requiredDocuments.length > 0) {
    if (!this.required_documents || this.required_documents.length === 0) {
      this.required_documents = this.requiredDocuments
        .filter((doc) => doc.required !== false)
        .map((doc) => doc.label);
    }
  } else if (Array.isArray(this.required_documents) && this.required_documents.length > 0) {
    if (!this.requiredDocuments || this.requiredDocuments.length === 0) {
      this.requiredDocuments = this.required_documents.map((label) => ({
        key: label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''),
        label: label,
        required: true,
        allowedTypes: ['pdf', 'jpg', 'jpeg', 'png'],
        maxSizeMB: 5
      }));
    }
  }
  next();
});

module.exports = mongoose.model('Service', serviceSchema, 'services');
