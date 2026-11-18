const { Call } = require('../models/Call');
const { Agent } = require('../models/Agent');
const { Lead } = require('../models/Lead');

/**
 * Toutes les lectures sont cantonnées à UNE entreprise (celle de l'appelant, vérifiée par callsAccess.requireCallerCompany).
 * Les agents n'ont pas de champ entreprise : ce sont ceux qui ont pris des appels de l'entreprise.
 */
async function companyAgents(companyId) {
  const ids = await Call.distinct('agent', { companyId, agent: { $ne: null } });
  return Agent.find({ _id: { $in: ids } });
}

class AnalyticsRepository {
  async getOverviewData(companyId) {
    const [calls, agents, leads] = await Promise.all([
      Call.find({ companyId }),
      companyAgents(companyId),
      Lead.find({ companyId })
    ]);

    return { calls, agents, leads };
  }

  async getCallMetrics(companyId) {
    return Call.find({ companyId })
      .populate('agent', 'name')
      .populate('lead', 'name company');
  }

  async getAgentMetrics(companyId) {
    const ids = await Call.distinct('agent', { companyId, agent: { $ne: null } });
    return Agent.find({ _id: { $in: ids } }).populate('userId', 'name email');
  }

  async getQualityMetrics(companyId) {
    return Call.find({ companyId }).select('quality_score');
  }
}

module.exports = { AnalyticsRepository, companyAgents };
