const crypto = require('node:crypto');
const OpenAI = require('openai');

/**
 * IA du menu vocal (message d'accueil, messagerie vocale, synthèse vocale, analyse de messages).
 * Chaque appel IA est facturé en jetons à l'entreprise via l'orchestrateur (aucune gratuité).
 */

// PROPOSITION de coûts forfaitaires (en jetons IA), à confirmer par le produit.
const TOKEN_COST_SUGGEST = 1000;
const TOKEN_COST_TTS = 600;
const TOKEN_COST_ANALYZE = 3000;

const VOICES = ['nova', 'shimmer', 'coral', 'onyx', 'echo', 'ash'];
const KINDS = ['greeting', 'voicemail'];
const TONES = ['chaleureux', 'professionnel', 'direct'];
const INTENTS = ['demande_information', 'reclamation', 'rendez_vous', 'rappel', 'commande', 'support', 'autre'];
const URGENCIES = ['low', 'medium', 'high'];
const SENTIMENTS = ['positif', 'neutre', 'negatif'];
const MAX_TEXT = { greeting: 280, voicemail: 220 };

const INSUFFICIENT_MESSAGE = 'Solde de jetons IA insuffisant. Achetez des jetons pour continuer.';

class VoiceMenuError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const models = () => ({
  llm: process.env.VOICE_MENU_LLM_MODEL || 'gpt-4o-mini',
  tts: process.env.VOICE_MENU_TTS_MODEL || 'gpt-4o-mini-tts',
  stt: process.env.VOICE_MENU_STT_MODEL || 'gpt-4o-transcribe',
});

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new VoiceMenuError(503, 'ai_not_configured', "Le service IA n'est pas configuré (clé OpenAI absente).");
  }
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

/** Origine de l'orchestrateur, sans slash final ni `/api` (pour ne jamais le doubler). */
function orchestratorOrigin() {
  return (process.env.COMPORCHESTRATOR_API_URL || 'https://v25comporchestratorback-production.up.railway.app/api')
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
}

/**
 * Solde connu ? Route ajoutée côté orchestrateur par ailleurs : 404 / injoignable / réponse inattendue => null
 * (on ne bloque pas, le débit après génération fait foi).
 */
async function fetchTokenBalance(companyId) {
  try {
    const res = await fetch(
      `${orchestratorOrigin()}/api/internal/companies/${encodeURIComponent(companyId)}/tokens-balance`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const payload = await res.json();
    return payload && payload.success && Number.isFinite(Number(payload.tokens)) ? Number(payload.tokens) : null;
  } catch (_err) {
    return null;
  }
}

/** Lève 402 si le solde est connu et ne couvre pas le coût. */
async function assertSufficientBalance(companyId, cost) {
  const balance = await fetchTokenBalance(companyId);
  if (balance !== null && balance < cost) {
    throw new VoiceMenuError(402, 'insufficient_tokens', INSUFFICIENT_MESSAGE);
  }
}

/** Débit idempotent (usageId) des jetons de l'entreprise. */
async function chargeTokens({ companyId, usageId, tokensUsed, tool, meta }) {
  let res;
  try {
    res = await fetch(`${orchestratorOrigin()}/api/tokens-company/charge-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId, usageId, tokensUsed, tool, meta: meta || {} }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (_err) {
    throw new VoiceMenuError(503, 'billing_unavailable', 'Facturation des jetons indisponible. Réessayez plus tard.');
  }
  if (res.status === 402) throw new VoiceMenuError(402, 'insufficient_tokens', INSUFFICIENT_MESSAGE);
  if (!res.ok) {
    console.error(`[voiceMenu] charge-usage refused: HTTP ${res.status}`);
    throw new VoiceMenuError(503, 'billing_unavailable', 'Facturation des jetons indisponible. Réessayez plus tard.');
  }
  return true;
}

/** Nettoie un texte destiné à la synthèse vocale : pas de markdown, guillemets ni émojis. */
function cleanSpokenText(text, max) {
  let out = String(text || '')
    .replace(/[*_`#>~]+/g, '')
    .replace(/["“”«»]/g, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (out.length > max) {
    const cut = out.slice(0, max);
    const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
    out = lastStop > max * 0.5 ? cut.slice(0, lastStop + 1) : cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : max).trim();
  }
  return out;
}

function buildSuggestPrompt({ kind, companyName, operationName, tone, language }) {
  const max = MAX_TEXT[kind];
  const lines = [
    `Langue: ${language}.`,
    `Ton: ${tone}.`,
    companyName ? `Nom du centre: ${companyName}.` : 'Nom du centre: non fourni, ne pas en inventer.',
    operationName ? `Opération: ${operationName}.` : '',
  ];
  const task =
    kind === 'greeting'
      ? `Rédige un message d'accueil téléphonique de 1 à 3 phrases, ${max} caractères maximum. Cite le nom du centre s'il est fourni. N'annonce PAS que la conversation peut être enregistrée (information non fournie, ne pas l'inventer).`
      : `Rédige une invitation à laisser un message vocal, ${max} caractères maximum : dis que personne n'est disponible, demande le nom, le numéro et le motif de l'appel, et annonce le bip sonore.`;
  return `${task}\n${lines.filter(Boolean).join('\n')}\nRéponds uniquement par le texte à dire, sans markdown, sans guillemets, sans émojis, avec une ponctuation adaptée à la synthèse vocale.`;
}

async function suggestText({ companyId, kind, companyName, operationName, tone, language }) {
  const openai = getOpenAI();
  await assertSufficientBalance(companyId, TOKEN_COST_SUGGEST);
  const completion = await openai.chat.completions.create({
    model: models().llm,
    temperature: 0.7,
    max_tokens: 200,
    messages: [
      { role: 'system', content: 'Tu écris des textes courts prêts à être dits au téléphone par une voix de synthèse.' },
      { role: 'user', content: buildSuggestPrompt({ kind, companyName, operationName, tone, language }) },
    ],
  });
  const text = cleanSpokenText(completion?.choices?.[0]?.message?.content, MAX_TEXT[kind]);
  if (!text) throw new VoiceMenuError(502, 'empty_generation', "L'IA n'a pas produit de texte. Réessayez.");
  await chargeTokens({
    companyId,
    usageId: `voice-suggest-${crypto.randomUUID()}`,
    tokensUsed: TOKEN_COST_SUGGEST,
    tool: 'voice-menu-suggest',
    meta: { kind, model: models().llm },
  });
  return { text, tokensCharged: TOKEN_COST_SUGGEST };
}

async function synthesizeSpeech({ companyId, text, voice, language }) {
  const openai = getOpenAI();
  await assertSufficientBalance(companyId, TOKEN_COST_TTS);
  const speech = await openai.audio.speech.create({
    model: models().tts,
    voice,
    input: text,
    instructions:
      language === 'fr'
        ? 'Parle en français naturel, sur un ton chaleureux et professionnel, avec un débit posé adapté au téléphone.'
        : `Speak natural ${language}, in a warm and professional tone, at a calm pace suited to telephone audio.`,
    response_format: 'mp3',
  });
  const audio = Buffer.from(await speech.arrayBuffer());
  await chargeTokens({
    companyId,
    usageId: `voice-tts-${crypto.randomUUID()}`,
    tokensUsed: TOKEN_COST_TTS,
    tool: 'voice-menu-tts',
    meta: { voice, characters: text.length, model: models().tts },
  });
  return { audio, tokensCharged: TOKEN_COST_TTS };
}

const AUDIO_EXT = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a' };
const extensionFor = (contentType) => AUDIO_EXT[String(contentType || '').split(';')[0].trim().toLowerCase()] || 'mp3';

const clip = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
const pick = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);

function emptyAnalysis() {
  return {
    summary: 'Message inaudible ou vide.',
    intent: 'autre',
    urgency: 'low',
    sentiment: 'neutre',
    language: 'fr',
    callerName: null,
    callbackNumber: null,
    suggestedFollowUp: { action: 'Vérifier si un rappel est utile', message: '', dueInHours: 24 },
  };
}

function normalizeAnalysis(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const f = r.suggestedFollowUp && typeof r.suggestedFollowUp === 'object' ? r.suggestedFollowUp : {};
  const hours = Math.round(Number(f.dueInHours));
  const nullable = (v, max) => {
    const s = clip(v, max);
    return s && s.toLowerCase() !== 'null' ? s : null;
  };
  return {
    summary: clip(r.summary, 280) || 'Message inaudible ou vide.',
    intent: pick(r.intent, INTENTS, 'autre'),
    urgency: pick(r.urgency, URGENCIES, 'low'),
    sentiment: pick(r.sentiment, SENTIMENTS, 'neutre'),
    language: clip(r.language, 10) || 'fr',
    callerName: nullable(r.callerName, 80),
    callbackNumber: nullable(r.callbackNumber, 30),
    suggestedFollowUp: {
      action: clip(f.action, 140),
      message: clip(f.message, 300),
      dueInHours: Number.isFinite(hours) ? Math.min(72, Math.max(1, hours)) : 24,
    },
  };
}

const ANALYSIS_SYSTEM = `Tu analyses la transcription d'un message laissé sur une messagerie vocale d'un centre d'appels.
N'invente aucune information absente de la transcription. Réponds par un objet JSON unique avec exactement ces clés :
summary (français, 280 caractères max), intent (${INTENTS.join('|')}), urgency (low|medium|high), sentiment (positif|neutre|negatif), language (code ISO de la langue parlée),
callerName (string ou null), callbackNumber (numéro dit par l'appelant, sinon null),
suggestedFollowUp: { action (phrase courte à l'impératif), message (SMS ou e-mail de relance poli, prêt à envoyer, 300 caractères max), dueInHours (entier entre 1 et 72) }.`;

async function analyzeVoicemail({ companyId, usageId, audio, contentType, from }) {
  const openai = getOpenAI();
  await assertSufficientBalance(companyId, TOKEN_COST_ANALYZE);
  const m = models();

  const file = await OpenAI.toFile(audio, `voicemail.${extensionFor(contentType)}`, { type: contentType || 'audio/mpeg' });
  const stt = await openai.audio.transcriptions.create({ file, model: m.stt, language: 'fr' });
  const transcript = String(stt?.text || '').trim();

  let analysis;
  if (transcript.replace(/[^\p{L}\p{N}]/gu, '').length < 2) {
    analysis = emptyAnalysis();
  } else {
    const completion = await openai.chat.completions.create({
      model: m.llm,
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: ANALYSIS_SYSTEM },
        { role: 'user', content: `Transcription du message :\n${transcript}` },
      ],
    });
    let parsed = null;
    try {
      parsed = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
    } catch (_err) {
      throw new VoiceMenuError(502, 'invalid_analysis', "L'analyse IA a renvoyé une réponse illisible. Réessayez.");
    }
    analysis = normalizeAnalysis(parsed);
  }

  await chargeTokens({
    companyId,
    usageId: usageId || `voice-analyze-${crypto.randomUUID()}`,
    tokensUsed: TOKEN_COST_ANALYZE,
    tool: 'voice-menu-analyze-voicemail',
    meta: { from: from ? clip(from, 30) : undefined, audioBytes: audio.length, sttModel: m.stt, llmModel: m.llm },
  });
  return { transcript: transcript || '', ...analysis, tokensCharged: TOKEN_COST_ANALYZE };
}

module.exports = {
  TOKEN_COST_SUGGEST,
  TOKEN_COST_TTS,
  TOKEN_COST_ANALYZE,
  VOICES,
  KINDS,
  TONES,
  MAX_TEXT,
  INSUFFICIENT_MESSAGE,
  VoiceMenuError,
  suggestText,
  synthesizeSpeech,
  analyzeVoicemail,
  cleanSpokenText,
  normalizeAnalysis,
  orchestratorOrigin,
};
