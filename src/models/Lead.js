const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Please add a name']
  },
  company: {
    type: String,
    required: [true, 'Please add a company name']
  },
  email: {
    type: String,
    required: [true, 'Please add an email'],
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email']
  },
  phone: {
    type: String,
    required: [true, 'Please add a phone number']
  },
  status: {
    type: String,
    enum: ['new', 'contacted', 'qualified', 'proposal', 'won', 'lost'],
    default: 'new'
  },
  value: {
    type: Number,
    default: 0
  },
  probability: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  source: String,
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent'
  },
  lastContact: Date,
  nextAction: {
    type: String,
    enum: ['call', 'email', 'meeting', 'follow-up'],
  },
  notes: String,
  metadata: {
    ai_analysis: {
      score: Number,
      sentiment: String
    }
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

leadSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Lead = mongoose.model('Lead', leadSchema);

module.exports = { Lead };