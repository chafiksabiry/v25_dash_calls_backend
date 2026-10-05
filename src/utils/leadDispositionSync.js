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

const MAX_FOLLOW_UP_DAYS = 90;

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

/**
 * Parse AI/REP schedule datetime. Returns null if invalid, past, or > 90 days out.
 */
function parseFollowUpAt(raw, nowMs = Date.now()) {
  if (raw == null || raw === '' || raw === 'null') return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  const ms = d.getTime();
  // Allow slight past (clock skew / "in a few minutes" race) — 5 min.
  if (ms < nowMs - 5 * 60 * 1000) return null;
  if (ms > nowMs + MAX_FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000) return null;
  return d;
}

/**
 * Infer schedule type from AI fields + disposition when schedule_type is missing.
 */
function resolveFollowUpType({ scheduleType, suggestedDisposition, appointmentAt, callbackAt } = {}) {
  const t = String(scheduleType || '').toLowerCase();
  if (t === 'appointment' || t === 'callback') return t;
  if (appointmentAt) return 'appointment';
  if (callbackAt) return 'callback';
  const disp = String(suggestedDisposition || '').toLowerCase();
  if (disp === 'called_rdv' || disp === 'argued_rdv') return 'appointment';
  if (disp === 'called_callback') return 'callback';
  return null;
}

/**
 * Persist next RDV/callback on the lead for Workspace reminders.
 * REP source always wins over AI. AI does not overwrite an existing REP date.
 */
async function syncLeadFollowUp(leadId, { at, type, source } = {}) {
  if (!leadId || !type || !['appointment', 'callback'].includes(type)) return;
  if (!mongoose.Types.ObjectId.isValid(String(leadId))) return;
  const when = at instanceof Date ? at : parseFollowUpAt(at);
  if (!when) return;

  const _id = new mongoose.Types.ObjectId(String(leadId));
  const lead = await Lead.collection.findOne(
    { _id },
    { projection: { nextFollowUpAt: 1, nextFollowUpSource: 1, nextFollowUpType: 1 } }
  );
  if (!lead) return;

  const src = source === 'rep' ? 'rep' : 'ai';
  if (src === 'ai' && lead.nextFollowUpSource === 'rep' && lead.nextFollowUpAt) {
    return;
  }

  await Lead.collection.updateOne(
    { _id },
    {
      $set: {
        nextFollowUpAt: when,
        nextFollowUpType: type,
        nextFollowUpSource: src,
        nextFollowUpNotifiedAt: null,
        updatedAt: new Date(),
      },
    }
  );
}

/**
 * Apply AI schedule extraction onto a Call mongoose doc (mutates, does not save).
 * Respects existing REP-set appointmentAt/callbackAt.
 */
function applyAiScheduleToCall(call, scores = {}) {
  if (!call || !scores || typeof scores !== 'object') {
    return { applied: false, at: null, type: null };
  }

  const suggestedDisposition = scores.suggested_disposition || call.suggestedDisposition || null;
  let scheduleType = resolveFollowUpType({
    scheduleType: scores.schedule_type,
    suggestedDisposition,
  });

  const parsedAt = parseFollowUpAt(scores.scheduled_at);
  if (!parsedAt || !scheduleType) {
    return { applied: false, at: null, type: scheduleType };
  }

  const repLocked =
    call.callOutcomeSource === 'rep' && (call.appointmentAt || call.callbackAt);

  if (repLocked) {
    return {
      applied: false,
      at: call.appointmentAt || call.callbackAt,
      type: call.appointmentAt ? 'appointment' : 'callback',
    };
  }

  if (scheduleType === 'appointment') {
    if (!call.appointmentAt) {
      call.appointmentAt = parsedAt;
      if (!call.callOutcome || call.callOutcomeSource === 'ai') {
        call.callOutcome = call.callOutcome === 'argued_interested' ? 'argued_interested' : 'appointment';
        if (!call.callOutcomeSource) call.callOutcomeSource = 'ai';
      }
    }
  } else if (scheduleType === 'callback') {
    if (!call.callbackAt) {
      call.callbackAt = parsedAt;
      if (!call.callOutcome || call.callOutcomeSource === 'ai') {
        call.callOutcome = 'callback_requested';
        if (!call.callOutcomeSource) call.callOutcomeSource = 'ai';
      }
    }
  }

  return { applied: true, at: parsedAt, type: scheduleType, raw: scores.scheduled_at_raw || null };
}

module.exports = {
  dispositionFromCallSignals,
  syncLeadDisposition,
  syncLeadFollowUp,
  parseFollowUpAt,
  resolveFollowUpType,
  applyAiScheduleToCall,
  RANK,
};
