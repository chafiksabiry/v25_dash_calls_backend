const mongoose = require('mongoose');
const { readFraudScore } = require('./selfCallVoice');

function isEnglishLanguage(language) {
  return String(language || '').toLowerCase().startsWith('en');
}

function isCallFraudDetected(call) {
  if (!call || typeof call !== 'object') return false;
  if (call.flags?.fraud === true || call.flags?.selfCall === true) return true;
  if (call.callOutcome === 'fraud') return true;
  const fraudScore = readFraudScore(call.ai_call_score);
  return typeof fraudScore === 'number' && fraudScore < 50;
}

function resolveAgentId(call) {
  const agent = call?.agent;
  if (agent && typeof agent === 'object') {
    const raw = agent._id ?? agent.id;
    if (raw && typeof raw === 'object' && raw.$oid) return String(raw.$oid);
    if (raw) return String(raw);
  }
  if (typeof agent === 'string' || typeof agent === 'number') return String(agent);
  return '';
}

function resolveAgentName(call) {
  const agent = call?.agent;
  if (agent && typeof agent === 'object') {
    const name =
      `${agent.firstName || agent.first_name || ''} ${agent.lastName || agent.last_name || ''}`.trim() ||
      agent.personalInfo?.name ||
      agent.name ||
      agent.email ||
      '';
    if (name) return name;
  }
  if (typeof agent === 'string' && agent.length < 40) return agent;
  return 'Agent';
}

function getFraudDetectedCountLabel(count, language = 'fr') {
  const n = Math.max(0, Math.round(count));
  if (isEnglishLanguage(language)) {
    return n === 1 ? '1 fraud detected' : `${n} frauds detected`;
  }
  return n === 1 ? '1 fraude détectée' : `${n} fraudes détectées`;
}

function getFraudCommissionNotice(language = 'fr') {
  return isEnglishLanguage(language)
    ? 'Fraud detected — no call or transaction commission is due on this recording.'
    : 'Fraude détectée — aucune commission appel ni transaction n\'est due sur cet enregistrement.';
}

function getRepFraudBlacklistWarning(language = 'fr') {
  return isEnglishLanguage(language)
    ? 'Warning: if fraudulent calls continue, you may be blacklisted. The company can make this decision at any time.'
    : 'Attention : en cas de fraudes répétées, vous pourriez être blacklisté. L\'entreprise peut prendre cette décision à tout moment.';
}

function getCompanyFraudGlobalWarning(count, language = 'fr') {
  const n = Math.max(0, Math.round(count));
  if (isEnglishLanguage(language)) {
    return n === 1
      ? '1 fraud detected on your calls. Monitor the agents involved — you may blacklist them at any time.'
      : `${n} frauds detected on your calls. Monitor the agents involved — you may blacklist them at any time.`;
  }
  return n === 1
    ? '1 fraude détectée sur vos appels. Surveillez les agents concernés — vous pouvez les blacklister à tout moment.'
    : `${n} fraudes détectées sur vos appels. Surveillez les agents concernés — vous pouvez les blacklister à tout moment.`;
}

function getCompanyAgentFraudCountLabel(count, language = 'fr') {
  const n = Math.max(0, Math.round(count));
  if (isEnglishLanguage(language)) {
    return n === 1 ? '1 fraud' : `${n} frauds`;
  }
  return n === 1 ? '1 fraude' : `${n} fraudes`;
}

function getCompanyAgentFraudWarning(count, language = 'fr') {
  const n = Math.max(0, Math.round(count));
  if (isEnglishLanguage(language)) {
    return n === 1
      ? '1 fraud detected for this agent. You may blacklist them at any time if fraud continues.'
      : `${n} frauds detected for this agent. You may blacklist them at any time if fraud continues.`;
  }
  return n === 1
    ? '1 fraude détectée pour cet agent. Vous pouvez le blacklister à tout moment si les fraudes se poursuivent.'
    : `${n} fraudes détectées pour cet agent. Vous pouvez le blacklister à tout moment si les fraudes se poursuivent.`;
}

function buildCompanyWarnings(totalFraudCount) {
  return {
    global: {
      fr: getCompanyFraudGlobalWarning(totalFraudCount, 'fr'),
      en: getCompanyFraudGlobalWarning(totalFraudCount, 'en'),
    },
    countLabel: {
      fr: getFraudDetectedCountLabel(totalFraudCount, 'fr'),
      en: getFraudDetectedCountLabel(totalFraudCount, 'en'),
    },
    commissionNotice: {
      fr: getFraudCommissionNotice('fr'),
      en: getFraudCommissionNotice('en'),
    },
  };
}

function buildAgentRowWarnings(agentFraudCount) {
  return {
    agent: {
      fr: getCompanyAgentFraudWarning(agentFraudCount, 'fr'),
      en: getCompanyAgentFraudWarning(agentFraudCount, 'en'),
    },
    agentCountLabel: {
      fr: getCompanyAgentFraudCountLabel(agentFraudCount, 'fr'),
      en: getCompanyAgentFraudCountLabel(agentFraudCount, 'en'),
    },
    commissionNotice: {
      fr: getFraudCommissionNotice('fr'),
      en: getFraudCommissionNotice('en'),
    },
  };
}

function buildRepWarnings(totalFraudCount) {
  return {
    repBlacklist: {
      fr: getRepFraudBlacklistWarning('fr'),
      en: getRepFraudBlacklistWarning('en'),
    },
    countLabel: {
      fr: getFraudDetectedCountLabel(totalFraudCount, 'fr'),
      en: getFraudDetectedCountLabel(totalFraudCount, 'en'),
    },
    commissionNotice: {
      fr: getFraudCommissionNotice('fr'),
      en: getFraudCommissionNotice('en'),
    },
  };
}

function buildWarningsBundle({ totalFraudCount = 0, agentFraudCount = 0, audience = 'company' } = {}) {
  if (audience === 'rep') return buildRepWarnings(totalFraudCount);
  if (audience === 'agent-row') return buildAgentRowWarnings(agentFraudCount);
  return buildCompanyWarnings(totalFraudCount);
}

function computeAgentFraudStatsFromCalls(calls) {
  const map = new Map();

  for (const call of calls) {
    if (!isCallFraudDetected(call)) continue;
    const agentId = resolveAgentId(call) || resolveAgentName(call);
    const agentName = resolveAgentName(call);
    const existing = map.get(agentId);
    if (existing) {
      existing.fraudCount += 1;
    } else {
      map.set(agentId, { agentId, agentName, fraudCount: 1 });
    }
  }

  return Array.from(map.values())
    .map((row) => ({
      ...row,
      warnings: buildWarningsBundle({ agentFraudCount: row.fraudCount, audience: 'agent-row' }),
    }))
    .sort((a, b) => b.fraudCount - a.fraudCount || a.agentName.localeCompare(b.agentName));
}

function buildCompanyFraudStatsFromCalls(calls) {
  const fraudCalls = calls.filter(isCallFraudDetected);
  const agentStats = computeAgentFraudStatsFromCalls(calls);
  const totalFraudCount = fraudCalls.length;

  return {
    totalFraudCount,
    agentStats,
    warnings: buildWarningsBundle({ totalFraudCount, audience: 'company' }),
  };
}

function buildAgentFraudStatsFromCalls(calls, agentId) {
  const fraudCalls = calls.filter(isCallFraudDetected);
  const totalFraudCount = fraudCalls.length;

  return {
    agentId: String(agentId),
    fraudCount: totalFraudCount,
    warnings: buildWarningsBundle({ totalFraudCount, audience: 'rep' }),
  };
}

function buildFraudOrConditions() {
  return [
    { 'flags.fraud': true },
    { 'flags.selfCall': true },
    { callOutcome: 'fraud' },
    { 'ai_call_score.Fraud detection.score': { $lt: 50 } },
  ];
}

function buildCompanyFraudMatchQuery(companyId) {
  const companyFilter = mongoose.Types.ObjectId.isValid(String(companyId))
    ? new mongoose.Types.ObjectId(String(companyId))
    : String(companyId);

  return {
    companyId: companyFilter,
    $or: buildFraudOrConditions(),
  };
}

function buildAgentFraudMatchQuery(agentId) {
  const agentFilter = mongoose.Types.ObjectId.isValid(String(agentId))
    ? new mongoose.Types.ObjectId(String(agentId))
    : String(agentId);

  return {
    agent: agentFilter,
    $or: buildFraudOrConditions(),
  };
}

module.exports = {
  isCallFraudDetected,
  resolveAgentId,
  resolveAgentName,
  buildCompanyFraudStatsFromCalls,
  buildAgentFraudStatsFromCalls,
  buildCompanyFraudMatchQuery,
  buildAgentFraudMatchQuery,
  buildFraudOrConditions,
  getFraudDetectedCountLabel,
  getFraudCommissionNotice,
  getRepFraudBlacklistWarning,
  getCompanyFraudGlobalWarning,
  getCompanyAgentFraudWarning,
  getCompanyAgentFraudCountLabel,
};
