const assert = require('node:assert/strict');
const { computeOperationMeasures } = require('../services/operationMeasures');

test('calcule les indicateurs d\'une opération à partir des appels', () => {
const m = computeOperationMeasures(
  {
    total: 100, answered: 60, transactions: 6, appointments: 9, callbacks: 3, interested: 24, refused: 18,
    voicemail: 10, wrongNumber: 5, fraud: 1, scored: 45, sumAnsweredDuration: 7200, answeredWithDuration: 60,
    sumDuration: 7200, qualitySum: 3200, qualityN: 40, scriptSum: 2800, scriptN: 40, agentHours: 20,
    leads: 80, attempts: 100, qualifiedLeads: 20, billedMinutes: 190,
    agents: [{ qualitySum: 1600, qualityN: 20, transactions: 4 }, { qualitySum: 1600, qualityN: 20, transactions: 2 }],
  },
  10
);
assert.equal(m.calls_per_day, 10);
assert.equal(m.calls_per_agent_hour, 5);
assert.equal(m.leads_per_day, 8);
assert.equal(m.occupancy_rate, 10); // 2 h de conversation / 20 h d'activité
assert.equal(m.avg_handle_time, 2); // 120 s
assert.equal(m.contact_rate, 60);
assert.equal(m.conversion_rate, 10);
assert.equal(m.transactions_per_day, 0.6);
assert.equal(m.appointments_per_day, 0.9);
assert.equal(m.interest_rate, 40);
assert.equal(m.refusal_rate, 30);
assert.equal(m.callback_rate, 5);
assert.equal(m.quality_score, 80);
assert.equal(m.script_compliance, 70);
assert.equal(m.calls_reviewed, 75);
assert.equal(m.fraud_rate, 1);
assert.equal(m.voicemail_rate, 10);
assert.equal(m.invalid_numbers, 5);
assert.equal(m.attempts_per_contact, 1.25);
assert.equal(m.qualified_leads, 20);
assert.equal(m.minutes_consumed, 190);
assert.equal(m.active_agents, 2);
assert.equal(m.agent_score, 80);
assert.equal(m.agent_productivity, 0.3);

// aucun appel : rien n'est inventé
const none = computeOperationMeasures({}, 30);
assert.equal(none.contact_rate, null);
assert.equal(none.calls_per_day, 0);
assert.equal(none.qualified_leads, null);
assert.equal(none.active_agents, null);
});
