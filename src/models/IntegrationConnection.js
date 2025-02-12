const mongoose = require('mongoose');

const integrationConnectionSchema = new mongoose.Schema({
  integration: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Integration',
    required: true
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'error', 'pending'],
    default: 'pending'
  },
  config: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update the updatedAt timestamp before saving
integrationConnectionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const IntegrationConnection = mongoose.model('IntegrationConnection', integrationConnectionSchema);

module.exports = { IntegrationConnection };