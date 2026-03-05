const { BaseRepository } = require('./BaseRepository');
const { Agent } = require('../models/Agent');

class AgentRepository extends BaseRepository {
  constructor() {
    super(Agent);
  }

  async findAvailable() {
    return this.model.find({ status: 'active' }).populate('userId', 'name email');
  }

  async findByUserId(userId, populate) {
    return this.model.findOne({ userId }).populate(populate || []);
  }

  async updateAvailability(id, availability) {
    return this.model.findByIdAndUpdate(
      id,
      { availability },
      { new: true }
    );
  }

  async updateSkills(id, skills) {
    return this.model.findByIdAndUpdate(
      id,
      { skills },
      { new: true }
    );
  }
}

module.exports = { AgentRepository };