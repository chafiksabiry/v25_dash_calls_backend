const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  call: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Call',
    required: true,
    unique: true,
  },
  agent: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Agent',
    required: true,
  },
  lead: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lead',
    required: true,
  },
  gigId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Gig',
    required: false,
  },
  companyId: {
    type: mongoose.Schema.Types.ObjectId,
    required: false,
  },
  validByAI: {
    type: Boolean,
    default: null,
  },
  validByCompany: {
    type: Boolean,
    default: null,
  },
  valid: {
    type: Boolean,
    default: null,
  },
  argumentation_score: {
    type: Number,
    default: 0,
  },
  transaction_score: {
    type: Number,
    default: 0,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  }
});

transactionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  // Now valid is strictly determined by AI decision
  this.valid = this.validByAI;
  next();
});

transactionSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update) {
    if (update.$set) {
      update.$set.updatedAt = new Date();
      if (update.$set.validByAI !== undefined) {
        update.$set.valid = update.$set.validByAI;
      }
    } else {
      update.updatedAt = new Date();
      if (update.validByAI !== undefined) {
        update.valid = update.validByAI;
      }
    }
  }
  next();
});


module.exports = mongoose.model('Transaction', transactionSchema);
