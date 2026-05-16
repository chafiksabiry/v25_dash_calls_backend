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
  if (this.validByAI === false || this.validByCompany === false) {
    this.valid = false;
  } else if (this.validByAI === true && this.validByCompany === true) {
    this.valid = true;
  } else {
    this.valid = null;
  }
  next();
});

transactionSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update) {
    if (update.$set) {
      update.$set.updatedAt = new Date();
      if (update.$set.validByAI !== undefined || update.$set.validByCompany !== undefined) {
        const aiVal = update.$set.validByAI !== undefined ? update.$set.validByAI : null;
        const companyVal = update.$set.validByCompany !== undefined ? update.$set.validByCompany : null;
        if (aiVal === false || companyVal === false) {
          update.$set.valid = false;
        } else if (aiVal === true && companyVal === true) {
          update.$set.valid = true;
        } else {
          update.$set.valid = null;
        }
      }
    } else {
      update.updatedAt = new Date();
      if (update.validByAI !== undefined || update.validByCompany !== undefined) {
        const aiVal = update.validByAI !== undefined ? update.validByAI : null;
        const companyVal = update.validByCompany !== undefined ? update.validByCompany : null;
        if (aiVal === false || companyVal === false) {
          update.valid = false;
        } else if (aiVal === true && companyVal === true) {
          update.valid = true;
        } else {
          update.valid = null;
        }
      }
    }
  }
  next();
});

module.exports = mongoose.model('Transaction', transactionSchema);
