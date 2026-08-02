/** Detect voicemail / non-productive calls from AI summary feedback. */
const VOICEMAIL_REGEX =
  /messagerie|messagerie\s+(vocale|automatique)|r[ée]pondeur|laissez\s+(votre|un)\s+message|bo[îi]te\s+vocale|voicemail|answering\s+machine|leave\s+(a|your)\s+message|after\s+(the\s+)?(tone|beep)|appel\s+non\s+productif|non\s+productif|aucun(?:e)?\s+(?:interaction|[ée]change)|aucun\s+(?:él|el)[ée]ment\s+exploitable|n['']?est\s+pas\s+disponible|votre\s+correspondant|tombe?\s+(?:imm[ée]diatement\s+)?sur\s+la?\s?messagerie|redirig[ée]\s+vers\s+la?\s?messagerie/i;

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

function isCallVoicemail(call) {
  if (!call || typeof call !== 'object') return false;
  if (call.callOutcome === 'voicemail') return true;
  return isVoicemailFromFeedback(extractOverallFeedback(call));
}

module.exports = {
  VOICEMAIL_REGEX,
  extractOverallFeedback,
  isVoicemailFromFeedback,
  isCallVoicemail,
};
