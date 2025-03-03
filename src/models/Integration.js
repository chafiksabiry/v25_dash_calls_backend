const mongoose = require('mongoose');

const integrationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a name'],
    unique: true
  },
  description: {
    type: String,
    required: [true, 'Please add a description']
  },
  category: {
    type: String,
    required: [true, 'Please add a category'],
    enum: ['crm', 'chat', 'communication', 'phone', 'email', 'ticketing', 'authentication']
  },
  status: {
    type: String,
    enum: ['connected', 'error', 'pending'],
    default: 'pending'
  },
  icon_url: String,
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

integrationSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Integration = mongoose.model('Integration', integrationSchema);

module.exports = { Integration };