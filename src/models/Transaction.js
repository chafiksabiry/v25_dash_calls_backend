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
  repTransactionCommission: {
    type: Number,
    default: 0,
  },
  platformTransactionCommission: {
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

function resolveTransactionValid(validByAI, validByCompany) {
  if (validByAI === false || validByCompany === false) return false;
  if (validByAI === true && validByCompany === true) return true;
  return null;
}

transactionSchema.pre('save', function (next) {
  this.updatedAt = new Date();
  this.valid = resolveTransactionValid(this.validByAI, this.validByCompany);
  next();
});

transactionSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update) {
    const applyValid = (target) => {
      if (target.validByAI !== undefined || target.validByCompany !== undefined) {
        const aiVal = target.validByAI !== undefined ? target.validByAI : null;
        const companyVal = target.validByCompany !== undefined ? target.validByCompany : null;
        target.valid = resolveTransactionValid(aiVal, companyVal);
      }
    };
    if (update.$set) {
      update.$set.updatedAt = new Date();
      applyValid(update.$set);
    } else {
      update.updatedAt = new Date();
      applyValid(update);
    }
  }
  next();
});


module.exports = mongoose.model('Transaction', transactionSchema);
