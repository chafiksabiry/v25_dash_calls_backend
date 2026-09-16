/** Minimum call length before Gemini voice fraud check runs. */
const MIN_DURATION_VOICE_AI_SEC = 45;

/** Confidence threshold for audio-based self-call fraud. */
const SELF_CALL_CONFIDENCE_THRESHOLD = 75;

/**
 * Transcript-only heuristics are a weak signal (STT often labels everyone as Agent).
 * Require a long call + strong imbalance, and never override a clear 2-voice audio result.
 */
const MIN_DURATION_TRANSCRIPT_FRAUD_SEC = 180;
const MIN_AGENT_TURNS_TRANSCRIPT_FRAUD = 5;
const MIN_TOTAL_WORDS_TRANSCRIPT_FRAUD = 50;
const CUSTOMER_WORD_RATIO_MAX = 0.05;

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
    feedback_fr: 'Fraude suspectée : le Client est quasi absent du dialogue (< 5 % des mots).',
    feedback_en: 'Suspected fraud: the Customer is nearly absent from the dialogue (< 5% of words).',
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
  return /customer|client|prospect|lead|appel[ée]|destinataire|voix simul/i.test(
    String(label || '')
  );
}

function isAgentSpeaker(label) {
  return /agent|rep|commercial|vendeur|conseiller|seller|harx/i.test(String(label || ''));
}

function isSimulatedSpeakerLabel(label) {
  return /voix simul|simulated/i.test(String(label || ''));
}

/**
 * Restore Customer labels before re-analysis when a prior self-call pass
 * rewrote them to "Voix simulée" (otherwise re-runs stay poisoned).
 */
function sanitizeTranscriptForReanalysis(transcript) {
  if (!Array.isArray(transcript)) return [];
  return transcript.map((turn) => {
    if (!turn || typeof turn !== 'object') return turn;
    const speaker = String(turn.speaker || '');
    if (turn.originalSpeaker && (turn.simulated || isSimulatedSpeakerLabel(speaker))) {
      const { simulated, ...rest } = turn;
      return { ...rest, speaker: turn.originalSpeaker };
    }
    if (isSimulatedSpeakerLabel(speaker)) {
      const { simulated, ...rest } = turn;
      return { ...rest, speaker: 'Customer' };
    }
    return turn;
  });
}

/**
 * True when transcript content looks like a real two-party sales dialogue
 * (lots of back-and-forth with substantial "customer" speech), even if audio
 * mono/diarization is unreliable.
 */
function transcriptSuggestsRealTwoPartyDialogue(transcript) {
  const turns = sanitizeTranscriptForReanalysis(transcript).filter(
    (t) => t && String(t.text || '').trim()
  );
  if (turns.length < 16) return false;

  const customerTurns = turns.filter((t) => isCustomerSpeaker(t.speaker));
  const agentTurns = turns.filter((t) => isAgentSpeaker(t.speaker));
  if (customerTurns.length < 8 || agentTurns.length < 8) return false;

  const customerWords = customerTurns.reduce(
    (sum, t) => sum + String(t.text || '').trim().split(/\s+/).filter(Boolean).length,
    0
  );
  return customerWords >= 80;
}

/**
 * True when the scoring LLM already saw a two-party interaction
 * (refusal / transaction / clean fraud rubric) — do not convict on transcript alone.
 */
function scoringSuggestsTwoPartyDialogue(scores) {
  if (!scores || typeof scores !== 'object') return false;
  if (scores.refusal_detected === true) return true;
  if (scores.transaction_detected === true) return true;
  const fraudScore = scores['Fraud detection']?.score;
  if (typeof fraudScore === 'number' && fraudScore >= 60) return true;
  return false;
}

function assessSelfCallFromTranscript(transcript, durationSec) {
  if (!Array.isArray(transcript) || durationSec < MIN_DURATION_TRANSCRIPT_FRAUD_SEC) return null;

  const turns = sanitizeTranscriptForReanalysis(transcript).filter(
    (t) => t && String(t.text || '').trim()
  );
  if (turns.length === 0) return null;

  // Rich two-party dialogue → never convict from transcript heuristics alone.
  if (transcriptSuggestsRealTwoPartyDialogue(turns)) return null;

  const customerTurns = turns.filter((t) => isCustomerSpeaker(t.speaker));
  const agentTurns = turns.filter((t) => isAgentSpeaker(t.speaker));

  const wordCount = (rows) =>
    rows.reduce((sum, t) => sum + String(t.text || '').trim().split(/\s+/).filter(Boolean).length, 0);

  const totalWords = wordCount(turns);
  const customerWords = wordCount(customerTurns);

  // Weak STT diarization often marks every turn as Agent — do not treat that as fraud lightly.
  if (
    customerTurns.length === 0 &&
    agentTurns.length >= MIN_AGENT_TURNS_TRANSCRIPT_FRAUD &&
    totalWords >= MIN_TOTAL_WORDS_TRANSCRIPT_FRAUD &&
    durationSec >= MIN_DURATION_TRANSCRIPT_FRAUD_SEC
  ) {
    return buildFraudResult('transcript_no_customer', 68, {
      distinctVoices: 1,
      sameSpeakerSuspected: true,
      source: 'transcript',
    });
  }

  if (
    totalWords >= MIN_TOTAL_WORDS_TRANSCRIPT_FRAUD &&
    customerWords / totalWords < CUSTOMER_WORD_RATIO_MAX &&
    durationSec >= MIN_DURATION_TRANSCRIPT_FRAUD_SEC &&
    agentTurns.length >= MIN_AGENT_TURNS_TRANSCRIPT_FRAUD
  ) {
    return buildFraudResult('transcript_customer_absent', 68, {
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

  const confidence =
    typeof voiceAnalysis.confidence === 'number' ? voiceAnalysis.confidence : 0;

  // Require high confidence — low-confidence "1 voice" is often quiet/far customer or mono mix.
  if (
    voiceAnalysis.distinctVoices === 1 &&
    confidence >= SELF_CALL_CONFIDENCE_THRESHOLD
  ) {
    return buildFraudResult('single_speaker_ai', confidence, {
      ...voiceAnalysis,
      source: 'audio',
    });
  }

  if (
    voiceAnalysis.sameSpeakerSuspected &&
    confidence >= SELF_CALL_CONFIDENCE_THRESHOLD
  ) {
    return buildFraudResult('same_voice_ai', confidence, {
      ...voiceAnalysis,
      source: 'audio',
    });
  }

  return null;
}

/**
 * Resolve self-call fraud.
 * Priority: clear audio signal > transcript heuristics (conservative).
 * Never override a clear 2-voice audio result with transcript.
 * Never use transcript alone when scoring already saw a real refusal/transaction.
 */
function resolveSelfCallFraud({ voiceAnalysis, transcript, durationSec, scores } = {}) {
  if (voiceAnalysis?.isVoicemail) {
    return { isFraud: false, voiceAnalysis };
  }

  const cleanTranscript = sanitizeTranscriptForReanalysis(transcript);
  const twoPartyContent = transcriptSuggestsRealTwoPartyDialogue(cleanTranscript);

  const fromVoice = isSelfCallFraudFromVoice(voiceAnalysis, durationSec);
  if (fromVoice) {
    // Audio "1 voice" on mono/compressed recordings often false-positives when
    // the transcript already shows a long real Agent↔Customer exchange.
    if (
      fromVoice.reason === 'single_speaker_ai' &&
      twoPartyContent &&
      voiceAnalysis?.sameSpeakerSuspected !== true
    ) {
      console.warn(
        '⚠️ [selfCallVoice] Suppressing single_speaker_ai — transcript looks like real two-party dialogue'
      );
      return {
        isFraud: false,
        voiceAnalysis: {
          ...(voiceAnalysis || {}),
          suppressedReason: 'transcript_two_party_override',
        },
      };
    }
    return fromVoice;
  }

  // Audio heard two distinct voices → trust that over STT speaker labels.
  if (typeof voiceAnalysis?.distinctVoices === 'number' && voiceAnalysis.distinctVoices >= 2) {
    return { isFraud: false, voiceAnalysis };
  }

  // Scoring LLM already modeled a two-party outcome → do not convict on transcript alone.
  if (scoringSuggestsTwoPartyDialogue(scores) || twoPartyContent) {
    return { isFraud: false, voiceAnalysis: voiceAnalysis || null };
  }

  const fromTranscript = assessSelfCallFromTranscript(cleanTranscript, durationSec);
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
  MIN_DURATION_TRANSCRIPT_FRAUD_SEC,
  normalizeVoiceAnalysis,
  sanitizeTranscriptForReanalysis,
  transcriptSuggestsRealTwoPartyDialogue,
  resolveSelfCallFraud,
  correctTranscriptForSelfCallFraud,
  applySelfCallFraudToScores,
  readFraudScore,
  isFraudFromScores,
};
