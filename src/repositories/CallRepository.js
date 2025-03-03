const { BaseRepository } = require('./BaseRepository');
const { Call } = require('../models/Call');

class CallRepository extends BaseRepository {
  constructor() {
    super(Call);
  }

  async findActive() {
    return this.model.find({ status: 'active' })
      .populate('agent', 'name email')
      .populate('lead', 'name company');
  }

  async endCall(id, duration) {
    return this.model.findByIdAndUpdate(
      id,
      { 
        status: 'completed',
        duration,
        updatedAt: new Date()
      },
      { new: true }
    );
  }

  async updateQualityScore(id, score) {
    return this.model.findByIdAndUpdate(
      id,
      { quality_score: score },
      { new: true }
    );
  }
}

module.exports = { CallRepository };