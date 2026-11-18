const { Call } = require('../models/Call');
const { Agent } = require('../models/Agent');
const { Lead } = require('../models/Lead');
const { companyAgents } = require('./AnalyticsRepository');

/** Lectures cantonnées à l'entreprise de l'appelant (voir callsAccess.requireCallerCompany). */
class DashboardRepository {
  async getStats(companyId) {
    return Promise.all([
      Call.find({ companyId }),
      companyAgents(companyId),
      Lead.find({ companyId })
    ]);
  }

  async getLiveCalls(companyId) {
    return Call.find({ companyId, status: 'active' })
      .populate('agent', 'name')
      .populate('lead', 'name company');
  }

  async getTopGigs(companyId) {
    const ids = await Call.distinct('agent', { companyId, agent: { $ne: null } });
    return Agent.find({ _id: { $in: ids } })
      .sort({ 'performance.success_rate': -1 })
      .limit(5);
  }

  async getTopReps(companyId) {
    const ids = await Call.distinct('agent', { companyId, agent: { $ne: null } });
    return Agent.find({ _id: { $in: ids } })
      .sort({ rating: -1 })
      .limit(5);
  }
}

module.exports = { DashboardRepository };
