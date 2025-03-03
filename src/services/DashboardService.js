const { DashboardRepository } = require('../repositories/DashboardRepository');

class DashboardService {
  constructor() {
    this.repository = new DashboardRepository();
  }

  async getStats() {
    const [calls, agents, leads] = await this.repository.getStats();

    return {
      activeGigs: agents.filter(agent => agent.status === 'active').length,
      globalReps: agents.length,
      successRate: (calls.filter(call => call.status === 'completed').length / calls.length) * 100 || 0,
      revenue: leads.reduce((acc, lead) => acc + (lead.value || 0), 0)
    };
  }

  async getLiveCalls() {
    return this.repository.getLiveCalls();
  }

  async getTopGigs() {
    const agents = await this.repository.getTopGigs();
    return agents.map(agent => ({
      name: agent.name,
      success: agent.performance.success_rate,
      calls: agent.performance.calls_handled,
      revenue: agent.performance.customer_satisfaction
    }));
  }

  async getTopReps() {
    const agents = await this.repository.getTopReps();
    return agents.map(agent => ({
      name: agent.name,
      rating: agent.rating,
      calls: agent.performance.calls_handled,
      revenue: agent.performance.customer_satisfaction
    }));
  }
}

module.exports = { DashboardService };