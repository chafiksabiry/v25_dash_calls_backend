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
  validByReps: {
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
  this.valid = (this.validByReps === true && this.validByCompany === true);
  next();
});

transactionSchema.pre('findOneAndUpdate', function (next) {
  const update = this.getUpdate();
  if (update) {
    if (update.$set) {
      update.$set.updatedAt = new Date();
      if (update.$set.validByReps !== undefined || update.$set.validByCompany !== undefined) {
        const repsVal = update.$set.validByReps !== undefined ? update.$set.validByReps : null;
        const companyVal = update.$set.validByCompany !== undefined ? update.$set.validByCompany : null;
        update.$set.valid = (repsVal === true && companyVal === true);
      }
    } else {
      update.updatedAt = new Date();
      if (update.validByReps !== undefined || update.validByCompany !== undefined) {
        const repsVal = update.validByReps !== undefined ? update.validByReps : null;
        const companyVal = update.validByCompany !== undefined ? update.validByCompany : null;
        update.valid = (repsVal === true && companyVal === true);
      }
    }
  }
  next();
});

module.exports = mongoose.model('Transaction', transactionSchema);
