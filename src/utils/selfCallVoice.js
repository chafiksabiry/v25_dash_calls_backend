/** Minimum call length before Gemini voice fraud check runs. */
const MIN_DURATION_VOICE_AI_SEC = 45;

/** Confidence threshold when sameSpeakerSuspected is true. */
const SELF_CALL_CONFIDENCE_THRESHOLD = 75;

const FRAUD_FEEDBACK = {
  same_voice_ai: {
    feedback_fr: 'Fraude détectée : la voix Agent et Client semble être la même personne (auto-appel simulé).',
    feedback_en: 'Fraud detected: Agent and Customer voices appear to be the same person (simulated self-call).',
  },
  single_speaker_ai: {
    feedback_fr: 'Fraude détectée : une seule voix humaine identifiée sur un appel qui devrait impliquer deux interlocuteurs.',
    feedback_en: 'Fraud detected: only one human voice identified on a call that should involve two parties.',
  },
  transcript_no_customer: {
    feedback_fr: 'Fraude suspectée : aucun tour de parole Client dans le transcript sur un appel long.',
    feedback_en: 'Suspected fraud: no Customer turns in the transcript on a long call.',
  },
  transcript_customer_absent: {
    feedback_fr: 'Fraude suspectée : le Client est quasi absent du dialogue (< 8 % des mots).',
    feedback_en: 'Suspected fraud: the Customer is nearly absent from the dialogue (< 8% of words).',
  },
};

function normalizeVoiceAnalysis(raw) {
  if (!raw || typeof raw !== 'object' || raw.raw_response) return null;
  const distinctVoices =
    typeof raw.distinctVoices === 'number' ? Math.max(0, Math.round(raw.distinctVoices)) : null;
  const confidence =
    typeof raw.confidence === 'number'
      ? Math.max(0, Math.min(100, Math.round(raw.confidence)))
      : 0;
  return {
    distinctVoices,
    sameSpeakerSuspected: raw.sameSpeakerSuspected === true,
    isVoicemail: raw.isVoicemail === true,
    confidence,
    reason_fr: String(raw.reason_fr || '').trim(),
    reason_en: String(raw.reason_en || '').trim(),
  };
}

function isCustomerSpeaker(label) {
  return /customer|client|prospect|lead|appel[ée]|destinataire/i.test(String(label || ''));
}

function isAgentSpeaker(label) {
  return /agent|rep|commercial|vendeur|conseiller|seller|harx/i.test(String(label || ''));
}

function assessSelfCallFromTranscript(transcript, durationSec) {
  if (!Array.isArray(transcript) || durationSec < MIN_DURATION_VOICE_AI_SEC) return null;

  const turns = transcript.filter((t) => t && String(t.text || '').trim());
  if (turns.length === 0) return null;

  const customerTurns = turns.filter((t) => isCustomerSpeaker(t.speaker));
  const agentTurns = turns.filter((t) => isAgentSpeaker(t.speaker));

  const wordCount = (rows) =>
    rows.reduce((sum, t) => sum + String(t.text || '').trim().split(/\s+/).filter(Boolean).length, 0);

  const totalWords = wordCount(turns);
  const customerWords = wordCount(customerTurns);

  if (customerTurns.length === 0 && agentTurns.length >= 2 && durationSec >= 60) {
    return buildFraudResult('transcript_no_customer', 72, {
      distinctVoices: 1,
      sameSpeakerSuspected: true,
      source: 'transcript',
    });
  }

  if (totalWords > 20 && customerWords / totalWords < 0.08 && durationSec >= 60) {
    return buildFraudResult('transcript_customer_absent', 70, {
      distinctVoices: 1,
      sameSpeakerSuspected: true,
      source: 'transcript',
    });
  }

  return null;
}

function buildFraudResult(reason, confidence, voiceAnalysisExtra = {}) {
  const copy = FRAUD_FEEDBACK[reason] || FRAUD_FEEDBACK.same_voice_ai;
  return {
    isFraud: true,
    reason,
    confidence,
    feedback_fr: copy.feedback_fr,
    feedback_en: copy.feedback_en,
    voiceAnalysis: {
      ...voiceAnalysisExtra,
      fraudReason: reason,
      confidence,
    },
  };
}

function isSelfCallFraudFromVoice(voiceAnalysis, durationSec) {
  if (!voiceAnalysis || voiceAnalysis.isVoicemail) return null;
  if (durationSec < MIN_DURATION_VOICE_AI_SEC) return null;

  if (voiceAnalysis.distinctVoices === 1) {
    return buildFraudResult('single_speaker_ai', Math.max(voiceAnalysis.confidence, 80), {
      ...voiceAnalysis,
      source: 'audio',
    });
  }

  if (
    voiceAnalysis.sameSpeakerSuspected &&
    voiceAnalysis.confidence >= SELF_CALL_CONFIDENCE_THRESHOLD
  ) {
    return buildFraudResult('same_voice_ai', voiceAnalysis.confidence, {
      ...voiceAnalysis,
      source: 'audio',
    });
  }

  return null;
}

function resolveSelfCallFraud({ voiceAnalysis, transcript, durationSec }) {
  if (voiceAnalysis?.isVoicemail) {
    return { isFraud: false, voiceAnalysis };
  }

  const fromVoice = isSelfCallFraudFromVoice(voiceAnalysis, durationSec);
  if (fromVoice) return fromVoice;

  const fromTranscript = assessSelfCallFromTranscript(transcript, durationSec);
  if (fromTranscript) return fromTranscript;

  return { isFraud: false, voiceAnalysis: voiceAnalysis || null };
}

/** Relabel inferred Customer turns when audio fraud proves a single speaker. */
function correctTranscriptForSelfCallFraud(transcript, fraudResult) {
  if (!fraudResult?.isFraud || !Array.isArray(transcript)) return transcript;

  return transcript.map((turn) => {
    if (!turn || typeof turn !== 'object') return turn;
    const label = String(turn.speaker || '');
    if (isAgentSpeaker(label)) return turn;

    return {
      ...turn,
      originalSpeaker: label,
      speaker: 'Voix simulée',
      simulated: true,
    };
  });
}

function applySelfCallFraudToScores(scores, fraudResult) {
  if (!fraudResult?.isFraud || !scores || typeof scores !== 'object') return scores;

  const voiceAnalysis = fraudResult.voiceAnalysis || {};
  scores['Fraud detection'] = {
    ...(scores['Fraud detection'] && typeof scores['Fraud detection'] === 'object'
      ? scores['Fraud detection']
      : {}),
    score: 0,
    feedback: fraudResult.feedback_fr,
    feedback_fr: fraudResult.feedback_fr,
    feedback_en: fraudResult.feedback_en,
    passed: false,
    voiceAnalysis,
  };

  scores.transaction_detected = false;
  scores.refusal_detected = false;

  const TX_RUBRIC_KEYS = [
    'Transaction analysis',
    'PAS INTÉRESSÉS',
    'PAS AU COURANT',
    'DÉJÀ ÉQUIPÉS',
    'RDV',
    'A plus tard',
  ];
  for (const key of TX_RUBRIC_KEYS) {
    if (scores[key] && typeof scores[key] === 'object') {
      scores[key].passed = false;
    }
  }

  if (scores.overall && typeof scores.overall === 'object') {
    scores.overall.score = 0;
    scores.overall.feedback_fr = `Fraude (auto-appel) : ${fraudResult.feedback_fr}`;
    scores.overall.feedback_en = `Fraud (self-call): ${fraudResult.feedback_en}`;
    scores.overall.feedback = scores.overall.feedback_fr;
    scores.overall.passed = false;
  }

  return scores;
}

/** Fraud rubric uses 0–100 where higher = cleaner. Never use `|| 100` (0 is valid). */
function readFraudScore(scores) {
  const raw = scores?.['Fraud detection']?.score;
  return typeof raw === 'number' ? raw : 100;
}

function isFraudFromScores(scores, selfCallFraud) {
  if (selfCallFraud?.isFraud) return true;
  return readFraudScore(scores) < 50;
}

module.exports = {
  MIN_DURATION_VOICE_AI_SEC,
  SELF_CALL_CONFIDENCE_THRESHOLD,
  normalizeVoiceAnalysis,
  resolveSelfCallFraud,
  correctTranscriptForSelfCallFraud,
  applySelfCallFraudToScores,
  readFraudScore,
  isFraudFromScores,
};
