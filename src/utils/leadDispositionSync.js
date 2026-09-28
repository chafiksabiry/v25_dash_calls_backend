const mongoose = require('mongoose');
const { Lead } = require('../models/Lead');

const RANK = {
  to_call: 0,
  called_unreachable: 1,
  called_voicemail: 1,
  called_wrong_number: 1,
  called_callback: 2,
  called_rdv: 3,
  argued_rdv: 4,
  argued_declined: 4,
  argued_done: 5,
};

function dispositionFromCallSignals({ callOutcome, status, answeredBy } = {}) {
  const answered = String(answeredBy || '').toLowerCase();
  const outcome = String(callOutcome || '').toLowerCase();
  const twilioStatus = String(status || '').toLowerCase();
  if (answered.startsWith('machine') || answered === 'fax' || outcome === 'voicemail') return 'called_voicemail';
  if (outcome === 'wrong_number' || twilioStatus === 'failed') return 'called_wrong_number';
  if (
    outcome === 'no_answer' ||
    outcome === 'busy' ||
    ['busy', 'no-answer', 'noanswer', 'canceled', 'cancelled'].includes(twilioStatus)
  ) {
    return 'called_unreachable';
  }
  if (outcome === 'callback_requested') return 'called_callback';
  if (outcome === 'appointment') return 'called_rdv';
  if (outcome === 'transaction') return 'argued_done';
  if (['refusal', 'not_interested', 'already_equipped'].includes(outcome)) return 'argued_declined';
  return null;
}

/** Write the HARX ladder onto the lead. A REP choice of a higher rank is kept. */
async function syncLeadDisposition(leadId, disposition) {
  if (!leadId || !disposition || !RANK.hasOwnProperty(disposition) || disposition === 'to_call') return;
  if (!mongoose.Types.ObjectId.isValid(String(leadId))) return;
  const _id = new mongoose.Types.ObjectId(String(leadId));
  const lead = await Lead.collection.findOne({ _id }, { projection: { repDisposition: 1 } });
  if (!lead) return;
  const current = lead.repDisposition || null;
  const currentRank = current && RANK.hasOwnProperty(current) ? RANK[current] : -1;
  if (current && currentRank > RANK[disposition]) return;
  if (current === disposition) return;
  await Lead.collection.updateOne(
    { _id },
    { $set: { repDisposition: disposition, repDispositionAt: new Date() } }
  );
}

module.exports = { dispositionFromCallSignals, syncLeadDisposition };
