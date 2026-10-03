const mongoose = require('mongoose');
const { Lead } = require('../models/Lead');

/**
 * HARX prospect ladder (9 statuses):
 *   to_call | called_unreachable | called_voicemail | called_wrong_number |
 *   called_callback | called_rdv | not_argumented | argued_rdv | argued_declined | argued_done
 *
 * Twilio → HARX (telephony):
 *   AMD AnsweredBy=machine_* / fax          → called_voicemail  (Appelé – Répondeur / Called – Voicemail)
 *   CallStatus=busy                        → called_unreachable (Appelé – Injoignable / Called – Unreachable)
 *   CallStatus=no-answer / canceled        → called_unreachable
 *   CallStatus=failed                      → called_wrong_number
 *   callOutcome=voicemail                  → called_voicemail
 *   callOutcome=busy / no_answer           → called_unreachable
 *   callOutcome=not_argumented             → not_argumented (Non argumenté / Not argumented)
 */

const RANK = {
  to_call: 0,
  called_unreachable: 1,
  called_voicemail: 1,
  called_wrong_number: 1,
  not_argumented: 1,
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

  // 1) Twilio AMD (Answering Machine Detection) → Appelé – Répondeur
  if (answered.startsWith('machine') || answered === 'fax' || outcome === 'voicemail') {
    return 'called_voicemail';
  }

  // 2) Invalid / unreachable number → Appelé – Numéro non attribué
  if (outcome === 'wrong_number' || twilioStatus === 'failed') {
    return 'called_wrong_number';
  }

  // 3) Busy / no-answer / canceled → Appelé – Injoignable
  if (
    outcome === 'no_answer' ||
    outcome === 'busy' ||
    ['busy', 'no-answer', 'noanswer', 'canceled', 'cancelled'].includes(twilioStatus)
  ) {
    return 'called_unreachable';
  }

  // 4) Commercial outcomes (AI / REP)
  if (outcome === 'callback_requested') return 'called_callback';
  if (outcome === 'appointment') return 'called_rdv';
  if (outcome === 'not_argumented') return 'not_argumented';
  if (outcome === 'argued_interested') return 'argued_rdv';
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

module.exports = { dispositionFromCallSignals, syncLeadDisposition, RANK };
