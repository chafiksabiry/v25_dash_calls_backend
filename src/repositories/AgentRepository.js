const { BaseRepository } = require('./BaseRepository');
const { Agent } = require('../models/Agent');

class AgentRepository extends BaseRepository {
  constructor() {
    super(Agent);
  }

  async findAvailable() {
    return this.model.find({ status: 'active' }).populate('user', 'name email');
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