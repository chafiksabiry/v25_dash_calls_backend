const { AgentRepository } = require('../repositories/AgentRepository');

class AgentService {
  constructor() {
    this.repository = new AgentRepository();
  }

  async getAllAgents() {
    return this.repository.findAll({});
  }

  async getAgentById(id) {
    return this.repository.findById(id);
  }

  async getAgentByUserId(userId) {
    return this.repository.findByUserId(userId);
  }

  async createAgent(userId, data) {
    const agentData = {
      ...data,
      user: userId
    };
    return this.repository.create(agentData);
  }

  async updateAgent(id, data) {
    return this.repository.update(id, data);
  }

  async deleteAgent(id) {
    return this.repository.delete(id);
  }

  async updateAvailability(id, availability) {
    return this.repository.updateAvailability(id, availability);
  }

  async updateSkills(id, skills) {
    return this.repository.updateSkills(id, skills);
  }
}

module.exports = { AgentService };