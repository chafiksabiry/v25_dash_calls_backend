const { BaseRepository } = require('./BaseRepository');
const { Lead } = require('../models/Lead');

class LeadRepository extends BaseRepository {
  constructor() {
    super(Lead);
  }

  async findByStatus(status) {
    return this.model.find({ status }).populate('assignedTo');
  }

  async updateAIAnalysis(id, analysis) {
    return this.model.findByIdAndUpdate(
      id,
      { 'metadata.ai_analysis': analysis },
      { new: true }
    );
  }
}

module.exports = { LeadRepository };