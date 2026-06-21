/** Shared copy for voicemail notices (rep + company UIs). */
const VOICEMAIL_SUMMARY_FR =
  "Messagerie — aucun échange avec le prospect. Aucune commission n'est due.";
const VOICEMAIL_SUMMARY_EN =
  'Voicemail — no exchange with the prospect. No commission is due.';

/** Rubric keys stripped from persisted ai_call_score for non-evaluable calls. */
const ANALYSIS_RUBRIC_KEYS = [
  'Agent fluency',
  'Sentiment analysis',
  'Fraud detection',
  'Script coherence',
  'Argumentation',
  'Script adherence',
  'Transaction analysis',
  'PAS INTÉRESSÉS',
  'PAS AU COURANT',
  'DÉJÀ ÉQUIPÉS',
  'RDV',
  'A plus tard',
];

function stripAnalysisRubrics(scores) {
  if (!scores || typeof scores !== 'object') return scores;
  for (const key of ANALYSIS_RUBRIC_KEYS) {
    delete scores[key];
  }
  scores.transaction_detected = false;
  scores.refusal_detected = false;
  return scores;
}

/** Voicemail: no per-rubric payload — only a zero overall score + short summary. */
function applyVoicemailAnalysisShape(scores) {
  if (!scores || typeof scores !== 'object') return scores;
  stripAnalysisRubrics(scores);
  scores.overall = {
    score: 0,
    passed: false,
    feedback: VOICEMAIL_SUMMARY_FR,
    feedback_fr: VOICEMAIL_SUMMARY_FR,
    feedback_en: VOICEMAIL_SUMMARY_EN,
  };
  return scores;
}

/** Fraud: no per-rubric payload — preserve fraud overall text when present. */
function applyFraudAnalysisShape(scores) {
  if (!scores || typeof scores !== 'object') return scores;
  const existing =
    scores.overall && typeof scores.overall === 'object' ? { ...scores.overall } : {};
  stripAnalysisRubrics(scores);
  scores.overall = {
    ...existing,
    score: 0,
    passed: false,
    feedback: existing.feedback_fr || existing.feedback || existing.feedback_en || '',
    feedback_fr: existing.feedback_fr || existing.feedback || '',
    feedback_en: existing.feedback_en || '',
  };
  return scores;
}

function getVoicemailSummary(language = 'fr') {
  return String(language || '').toLowerCase().startsWith('en')
    ? VOICEMAIL_SUMMARY_EN
    : VOICEMAIL_SUMMARY_FR;
}

module.exports = {
  VOICEMAIL_SUMMARY_FR,
  VOICEMAIL_SUMMARY_EN,
  ANALYSIS_RUBRIC_KEYS,
  stripAnalysisRubrics,
  applyVoicemailAnalysisShape,
  applyFraudAnalysisShape,
  getVoicemailSummary,
};
