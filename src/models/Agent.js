const mongoose = require('mongoose');

const agentSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: [true, 'Please add a name']
  },
  email: {
    type: String,
    required: [true, 'Please add an email'],
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please add a valid email']
  },
  phone: String,
  status: {
    type: String,
    enum: ['active', 'inactive', 'busy'],
    default: 'active'
  },
  skills: [{
    type: String
  }],
  languages: [{
    type: String
  }],
  rating: {
    type: Number,
    min: 0,
    max: 5,
    default: 0
  },
  availability: {
    schedule: [{
      day: {
        type: String,
        enum: ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday']
      },
      start: String,
      end: String
    }],
    timezone: String
  },
  performance: {
    calls_handled: {
      type: Number,
      default: 0
    },
    avg_duration: {
      type: Number,
      default: 0
    },
    success_rate: {
      type: Number,
      default: 0
    },
    customer_satisfaction: {
      type: Number,
      default: 0
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

agentSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Agent = mongoose.model('Agent', agentSchema);

module.exports = { Agent };