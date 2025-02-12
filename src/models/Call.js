const mongoose = require('mongoose');

const callSchema = new mongoose.Schema({
  agent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true
  },
  lead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lead'
  },
  phone_number: {
    type: String,
    required: [true, 'Please add a phone number']
  },
  direction: {
    type: String,
    enum: ['inbound', 'outbound'],
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'missed', 'failed'],
    default: 'active'
  },
  duration: {
    type: Number,
    default: 0
  },
  recording_url: String,
  notes: String,
  tags: [{
    type: String
  }],
  quality_score: {
    type: Number,
    min: 0,
    max: 100
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

callSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Call = mongoose.model('Call', callSchema);

module.exports = { Call };