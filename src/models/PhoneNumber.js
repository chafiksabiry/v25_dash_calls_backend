const mongoose = require('mongoose');

const phoneNumberSchema = new mongoose.Schema({
  phoneNumber: {
    type: String,
    required: true
  },
  telnyxId: String,
  provider: {
    type: String,
    enum: ['twilio', 'telnyx'],
    required: true
  },
  orderId: String,
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true,
    index: true
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'success', 'failed'],
    default: 'pending'
  },
  features: {
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

phoneNumberSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// Utiliser le nom de collection 'phonenumbers' pour correspondre à MongoDB
const PhoneNumber = mongoose.model('PhoneNumber', phoneNumberSchema, 'phonenumbers');

module.exports = { PhoneNumber };

