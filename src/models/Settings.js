const mongoose = require('mongoose');

const settingsSchema = new mongoose.Schema({
  company: {
    name: String,
    logo: String,
    website: String,
    phone: String,
    email: String,
    address: {
      street: String,
      city: String,
      state: String,
      country: String,
      postal_code: String
    }
  },
  system: {
    timezone: String,
    language: String,
    date_format: String,
    time_format: String
  },
  notifications: {
    email: Boolean,
    desktop: Boolean,
    mobile: Boolean
  },
  security: {
    two_factor: Boolean,
    session_timeout: Number,
    password_policy: {
      min_length: Number,
      require_numbers: Boolean,
      require_special: Boolean,
      require_uppercase: Boolean
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

settingsSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

const Settings = mongoose.model('Settings', settingsSchema);

module.exports = { Settings };