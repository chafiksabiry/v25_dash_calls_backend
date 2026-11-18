const { AnalyticsRepository } = require('../repositories/AnalyticsRepository');

class AnalyticsService {
  constructor() {
    this.repository = new AnalyticsRepository();
  }

  async getOverview(companyId) {
    const { calls, agents, leads } = await this.repository.getOverviewData(companyId);

    return {
      calls: {
        total: calls.length,
        answered: calls.filter(call => call.status === 'completed').length,
        missed: calls.filter(call => call.status === 'missed').length,
        avg_duration: calls.reduce((acc, call) => acc + call.duration, 0) / calls.length || 0
      },
      agents: {
        total: agents.length,
        active: agents.filter(agent => agent.status === 'active').length,
        performance: agents.map(agent => ({
          agent_id: agent._id,
          calls_handled: agent.performance.calls_handled,
          avg_duration: agent.performance.avg_duration,
          success_rate: agent.performance.success_rate
        }))
      },
      leads: {
        total: leads.length,
        new: leads.filter(lead => lead.status === 'new').length,
        converted: leads.filter(lead => lead.status === 'won').length,
        conversion_rate: (leads.filter(lead => lead.status === 'won').length / leads.length) * 100 || 0
      }
    };
  }

  async getCallMetrics(companyId) {
    return this.repository.getCallMetrics(companyId);
  }

  async getAgentMetrics(companyId) {
    return this.repository.getAgentMetrics(companyId);
  }

  async getQualityMetrics(companyId) {
    const calls = await this.repository.getQualityMetrics(companyId);
    
    return {
      avg_score: calls.reduce((acc, call) => acc + (call.quality_score || 0), 0) / calls.length || 0,
      total_evaluated: calls.filter(call => call.quality_score != null).length,
      score_distribution: {
        excellent: calls.filter(call => call.quality_score >= 90).length,
        good: calls.filter(call => call.quality_score >= 70 && call.quality_score < 90).length,
        average: calls.filter(call => call.quality_score >= 50 && call.quality_score < 70).length,
        poor: calls.filter(call => call.quality_score < 50).length
      }
    };
  }
}

module.exports = { AnalyticsService };