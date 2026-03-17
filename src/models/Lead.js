const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  name: String,
  company: String,
  email: String,
  phone: String,
  
  // Zoho fields used in dashboard backend
  First_Name: String,
  Last_Name: String,
  Email_1: String,
  Phone: String,
  Deal_Name: String,
  
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
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig'
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

leadSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  next();
});

const Lead = mongoose.model('Lead', leadSchema);

module.exports = { Lead };