/**
 * Indicateurs de pilotage d'une opération calculés à partir des appels (pur, testable sans base).
 * `facts` vient de l'agrégation de `analytics/operation-measures` ; chaque valeur est null quand l'échantillon ne permet pas de la calculer.
 */
const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const ratio = (a, b, k = 1) => (b > 0 ? a / b * k : null);

function computeOperationMeasures(facts, days) {
  const f = facts || {};
  const d = Math.max(1, Number(days) || 1);
  const total = f.total || 0;
  const answered = f.answered || 0;
  const agentHours = f.agentHours || 0;
  const agents = Array.isArray(f.agents) ? f.agents : [];
  const agentMeans = agents.filter((a) => a.qualityN > 0).map((a) => a.qualitySum / a.qualityN);

  return {
    calls_per_day: round(total / d),
    calls_per_agent_hour: round(ratio(total, agentHours)),
    leads_per_day: round((f.leads || 0) / d),
    occupancy_rate: agentHours > 0 ? round(Math.min(100, ((f.sumDuration || 0) / 3600 / agentHours) * 100)) : null,
    avg_handle_time: round(ratio(f.sumAnsweredDuration || 0, f.answeredWithDuration || 0, 1 / 60)),
    callback_rate: round(ratio(f.callbacks || 0, answered, 100)),
    contact_rate: round(ratio(answered, total, 100)),
    conversion_rate: round(ratio(f.transactions || 0, answered, 100)),
    transactions_per_day: round((f.transactions || 0) / d),
    appointments_per_day: round((f.appointments || 0) / d),
    interest_rate: round(ratio(f.interested || 0, answered, 100)),
    refusal_rate: round(ratio(f.refused || 0, answered, 100)),
    quality_score: round(ratio(f.qualitySum || 0, f.qualityN || 0)),
    script_compliance: round(ratio(f.scriptSum || 0, f.scriptN || 0)),
    calls_reviewed: round(ratio(f.scored || 0, answered, 100)),
    fraud_rate: round(ratio(f.fraud || 0, total, 100), 2),
    voicemail_rate: round(ratio(f.voicemail || 0, total, 100)),
    invalid_numbers: round(ratio(f.wrongNumber || 0, total, 100)),
    attempts_per_contact: round(ratio(f.attempts || 0, f.leads || 0), 2),
    qualified_leads: f.leads ? f.qualifiedLeads || 0 : null,
    minutes_consumed: total ? f.billedMinutes || 0 : null,
    active_agents: agents.length || null,
    agent_score: agentMeans.length ? round(agentMeans.reduce((s, x) => s + x, 0) / agentMeans.length) : null,
    agent_productivity: agents.length ? round((f.transactions || 0) / agents.length / d, 2) : null,
  };
}

module.exports = { computeOperationMeasures };
