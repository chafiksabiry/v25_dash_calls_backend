const { LeadRepository } = require('../repositories/LeadRepository');

class LeadService {
  constructor() {
    this.repository = new LeadRepository();
  }

  async getAllLeads() {
    return this.repository.findAll({}, 'assignedTo');
  }

  async getLeadById(id) {
    return this.repository.findById(id, 'assignedTo');
  }

  async createLead(data) {
    return this.repository.create(data);
  }

  async updateLead(id, data) {
    return this.repository.update(id, data);
  }

  async deleteLead(id) {
    return this.repository.delete(id);
  }

  async analyzeLead(id) {
    const lead = await this.repository.findById(id);
    if (!lead) throw new Error('Lead not found');

    // Simulated AI analysis
    const analysis = {
      score: Math.floor(Math.random() * 30) + 70,
      sentiment: Math.random() > 0.5 ? 'Positive' : 'Neutral'
    };

    return this.repository.updateAIAnalysis(id, analysis);
  }

  async generateScript(id, type) {
    const lead = await this.repository.findById(id);
    if (!lead) throw new Error('Lead not found');

    // Simulated script generation
    return {
      script: `Hello ${lead.name}, this is a ${type} script for ${lead.company}...`,
      type
    };
  }
}

module.exports = { LeadService };

export { LeadService }