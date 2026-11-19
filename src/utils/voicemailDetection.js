/** Detect voicemail / non-productive calls from AI summary feedback.
 *  "n'est pas disponible" is intentionally absent: a real sales call often
 *  says the prospect is unavailable later, and that is not a voicemail.
 */
const VOICEMAIL_REGEX =
  /messagerie|messagerie\s+(vocale|automatique)|r[ée]pondeur|laissez\s+(votre|un)\s+message|bo[îi]te\s+vocale|voicemail|answering\s+machine|leave\s+(a|your)\s+message|after\s+(the\s+)?(tone|beep)|appel\s+non\s+productif|non\s+productif|aucun(?:e)?\s+(?:interaction|[ée]change)|aucun\s+(?:él|el)[ée]ment\s+exploitable|votre\s+correspondant|tombe?\s+(?:imm[ée]diatement\s+)?sur\s+la?\s?messagerie|redirig[ée]\s+vers\s+la?\s?messagerie/i;

/** Below this talk time, AMD "machine" is trusted. Longer calls are transcribed. */
const MIN_HUMAN_EXCHANGE_SECONDS = 60;

function extractOverallFeedback(call) {
  if (!call || typeof call !== 'object') return '';
  return String(
    call.ai_summary_fr ||
      call.ai_summary ||
      call.ai_call_score?.overall?.feedback_fr ||
      call.ai_call_score?.overall?.feedback ||
      call.ai_call_score?.overall?.feedback_en ||
      ''
  );
}

function isVoicemailFromFeedback(feedback) {
  return VOICEMAIL_REGEX.test(String(feedback || '').toLowerCase());
}

function prospectSpeech(call) {
  const transcript = call?.transcript;
  if (!Array.isArray(transcript)) return '';
  return transcript
    .filter((turn) => {
      if (!turn || turn.simulated) return false;
      const speaker = String(turn.speaker || '');
      if (!speaker) return false;
      if (/agent|rep|commercial|vendeur|conseiller|seller|harx|r[ée]pondeur|voicemail|messagerie|machine/i.test(speaker)) {
        return false;
      }
      return true;
    })
    .map((turn) => String(turn.text || '').trim())
    .join(' ');
}

/** True when a long recording contains a real second speaker (the prospect). */
function hasRealProspectExchange(call) {
  const duration = Number(call?.duration) || 0;
  if (duration < MIN_HUMAN_EXCHANGE_SECONDS) return false;
  return prospectSpeech(call).length >= 24;
}

function isCallVoicemail(call) {
  if (!call || typeof call !== 'object') return false;
  if (hasRealProspectExchange(call)) return false;
  const duration = Number(call.duration) || 0;
  const feedback = extractOverallFeedback(call);
  const feedbackSaysVoicemail = isVoicemailFromFeedback(feedback);
  if (duration >= MIN_HUMAN_EXCHANGE_SECONDS && String(feedback).trim() && !feedbackSaysVoicemail) {
    return false;
  }
  if (call.callOutcome === 'voicemail') return true;
  return feedbackSaysVoicemail;
}

module.exports = {
  VOICEMAIL_REGEX,
  MIN_HUMAN_EXCHANGE_SECONDS,
  extractOverallFeedback,
  isVoicemailFromFeedback,
  hasRealProspectExchange,
  isCallVoicemail,
};
