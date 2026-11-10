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
const TOKEN_COST_ACTION_PLAN = 1000;

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

const AUDIENCES = ['center', 'person'];

/**
 * Langue des textes de l'entreprise (pays de la société, voir `languageForCountry` côté front et orchestrateur) : fr, en, es, ar ;
 * tout autre code ISO valide est accepté et nommé en anglais. Le français garde les consignes d'origine (en français) ; les autres
 * langues reçoivent des consignes en anglais qui exigent un texte écrit UNIQUEMENT dans la langue demandée.
 */
const LANGUAGE_LABELS = { fr: 'French', en: 'English', es: 'Spanish', ar: 'Arabic' };
const baseLanguage = (code) => String(code || 'fr').slice(0, 2).toLowerCase();
function languageLabel(code) {
  const base = baseLanguage(code);
  if (LANGUAGE_LABELS[base]) return base === 'ar' ? 'Arabic (Modern Standard Arabic, written in Arabic script)' : LANGUAGE_LABELS[base];
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(base) || base;
  } catch (_err) {
    return base;
  }
}
const TONE_EN = { chaleureux: 'warm and friendly', professionnel: 'professional', direct: 'direct and concise' };

/** Même consigne que `buildSuggestPrompt` pour une langue autre que le français : consignes en anglais, texte dans la langue demandée. */
function buildSuggestPromptIn({ kind, companyName, operationName, tone, language, audience = 'center', personName }) {
  const max = MAX_TEXT[kind];
  const label = languageLabel(language);
  const toneEn = TONE_EN[tone] || tone;
  const closing = `Reply only with the text to be spoken, written ONLY in ${label}, with no markdown, no quotation marks, no emojis, and punctuation suited to speech synthesis.`;
  if (audience === 'person') {
    const lines = [
      `Language: ${label}.`,
      `Tone: ${toneEn}.`,
      personName ? `Person's name: ${personName}.` : "Person's name: not provided, do not invent one.",
    ];
    const task =
      kind === 'greeting'
        ? `Write a personal telephone greeting of 1 to 3 sentences, ${max} characters maximum, in the first person. Never mention a call center, a team, advisors or a company.`
        : `Write the voicemail message of a self-employed person, ${max} characters maximum, in the first person: say that you are not available right now (something like "you have reached the voicemail of ${personName || 'the person'}" if the name is provided), ask the caller to leave their name, number and reason for calling after the beep, announce the beep and say that the message will be recorded (mandatory notice). Never mention a call center, a team, advisors or a company. Do not promise a specific callback time.`;
    return `${task}\n${lines.join('\n')}\n${closing}`;
  }
  const lines = [
    `Language: ${label}.`,
    `Tone: ${toneEn}.`,
    companyName ? `Name of the business: ${companyName}.` : 'Name of the business: not provided, do not invent one.',
    operationName ? `Operation: ${operationName}.` : '',
  ];
  const task =
    kind === 'greeting'
      ? `Write a telephone greeting of 1 to 3 sentences, ${max} characters maximum. Mention the name of the business if it is provided. Do NOT say that the conversation may be recorded (information not provided, do not invent it).`
      : `Write an invitation to leave a voice message, ${max} characters maximum: say that nobody is available, ask for the caller's name, number and reason for calling, announce the beep and say that the message will be recorded (mandatory notice).`;
  return `${task}\n${lines.filter(Boolean).join('\n')}\n${closing}`;
}

function buildSuggestPrompt({ kind, companyName, operationName, tone, language, audience = 'center', personName }) {
  if (baseLanguage(language) !== 'fr') return buildSuggestPromptIn({ kind, companyName, operationName, tone, language, audience, personName });
  const max = MAX_TEXT[kind];
  // Nomad Solo : le titulaire est une personne, pas un centre. Le message parle à la première personne et ne cite aucun centre.
  if (audience === 'person') {
    const lines = [
      `Langue: ${language}.`,
      `Ton: ${tone}.`,
      personName ? `Nom de la personne: ${personName}.` : 'Nom de la personne: non fourni, ne pas en inventer.',
    ];
    const task =
      kind === 'greeting'
        ? `Rédige un message d'accueil téléphonique personnel de 1 à 3 phrases, ${max} caractères maximum, à la première personne. Ne parle jamais de centre, d'équipe, de conseillers ni d'entreprise.`
        : `Rédige le message du répondeur personnel d'une personne indépendante, ${max} caractères maximum, à la première personne : dis que tu n'es pas disponible pour le moment (formule du type « vous êtes bien sur la messagerie de ${personName || 'la personne'} » si le nom est fourni), demande de laisser son nom, son numéro et le motif de l'appel après le bip, annonce le bip sonore et précise que le message sera enregistré (mention obligatoire). Ne parle jamais de centre, d'équipe, de conseillers ni d'entreprise. Ne promets aucun délai de rappel précis.`;
    return `${task}\n${lines.join('\n')}\nRéponds uniquement par le texte à dire, sans markdown, sans guillemets, sans émojis, avec une ponctuation adaptée à la synthèse vocale.`;
  }
  const lines = [
    `Langue: ${language}.`,
    `Ton: ${tone}.`,
    companyName ? `Nom du centre: ${companyName}.` : 'Nom du centre: non fourni, ne pas en inventer.',
    operationName ? `Opération: ${operationName}.` : '',
  ];
  const task =
    kind === 'greeting'
      ? `Rédige un message d'accueil téléphonique de 1 à 3 phrases, ${max} caractères maximum. Cite le nom du centre s'il est fourni. N'annonce PAS que la conversation peut être enregistrée (information non fournie, ne pas l'inventer).`
      : `Rédige une invitation à laisser un message vocal, ${max} caractères maximum : dis que personne n'est disponible, demande le nom, le numéro et le motif de l'appel, annonce le bip sonore et précise que le message sera enregistré (mention obligatoire).`;
  return `${task}\n${lines.filter(Boolean).join('\n')}\nRéponds uniquement par le texte à dire, sans markdown, sans guillemets, sans émojis, avec une ponctuation adaptée à la synthèse vocale.`;
}

/** Rôle donné à l'IA, dans la langue du texte à produire. */
const suggestSystem = (language) =>
  baseLanguage(language) === 'fr'
    ? 'Tu écris des textes courts prêts à être dits au téléphone par une voix de synthèse.'
    : `You write short texts ready to be spoken on the phone by a speech synthesis voice. You write only in ${languageLabel(language)}.`;

async function suggestText({ companyId, kind, companyName, operationName, tone, language, audience, personName }) {
  const openai = getOpenAI();
  await assertSufficientBalance(companyId, TOKEN_COST_SUGGEST);
  const completion = await openai.chat.completions.create({
    model: models().llm,
    temperature: 0.7,
    max_tokens: 200,
    messages: [
      { role: 'system', content: suggestSystem(language) },
      { role: 'user', content: buildSuggestPrompt({ kind, companyName, operationName, tone, language, audience, personName }) },
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

/**
 * Consigne de diction transmise à la synthèse vocale, selon la langue du texte lu. Les six voix proposées (OpenAI) sont multilingues :
 * c'est cette consigne qui fixe la langue et la prononciation (accent natif, pas de français lu avec un accent anglais).
 */
function speechInstructions(language) {
  const base = baseLanguage(language);
  if (base === 'fr') return 'Parle en français naturel, sur un ton chaleureux et professionnel, avec un débit posé adapté au téléphone.';
  const label = languageLabel(language);
  return `Speak natural ${label} with a native accent and correct local pronunciation, in a warm and professional tone, at a calm pace suited to telephone audio. Read the text exactly as written; never translate it.`;
}

async function synthesizeSpeech({ companyId, text, voice, language }) {
  const openai = getOpenAI();
  await assertSufficientBalance(companyId, TOKEN_COST_TTS);
  const speech = await openai.audio.speech.create({
    model: models().tts,
    voice,
    input: text,
    instructions: speechInstructions(language),
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

/** Texte « message inaudible » dans la langue de la société (français par défaut). */
const EMPTY_SUMMARY = { fr: 'Message inaudible ou vide.', en: 'Inaudible or empty message.', es: 'Mensaje inaudible o vacío.', ar: 'رسالة غير مسموعة أو فارغة.' };
const EMPTY_ACTION = { fr: 'Vérifier si un rappel est utile', en: 'Check whether a callback is useful', es: 'Comprobar si una llamada de vuelta es útil', ar: 'التحقق مما إذا كانت معاودة الاتصال مفيدة' };
const emptySummary = (language) => EMPTY_SUMMARY[baseLanguage(language)] || EMPTY_SUMMARY.en;

function emptyAnalysis(language = 'fr') {
  const base = baseLanguage(language);
  return {
    summary: emptySummary(base),
    intent: 'autre',
    urgency: 'low',
    sentiment: 'neutre',
    language: base,
    callerName: null,
    callbackNumber: null,
    suggestedFollowUp: { action: EMPTY_ACTION[base] || EMPTY_ACTION.en, message: '', dueInHours: 24 },
  };
}

function normalizeAnalysis(raw, language = 'fr') {
  const r = raw && typeof raw === 'object' ? raw : {};
  const f = r.suggestedFollowUp && typeof r.suggestedFollowUp === 'object' ? r.suggestedFollowUp : {};
  const hours = Math.round(Number(f.dueInHours));
  const nullable = (v, max) => {
    const s = clip(v, max);
    return s && s.toLowerCase() !== 'null' ? s : null;
  };
  return {
    summary: clip(r.summary, 280) || emptySummary(language),
    intent: pick(r.intent, INTENTS, 'autre'),
    urgency: pick(r.urgency, URGENCIES, 'low'),
    sentiment: pick(r.sentiment, SENTIMENTS, 'neutre'),
    language: clip(r.language, 10) || baseLanguage(language),
    callerName: nullable(r.callerName, 80),
    callbackNumber: nullable(r.callbackNumber, 30),
    suggestedFollowUp: {
      action: clip(f.action, 140),
      message: clip(f.message, 300),
      dueInHours: Number.isFinite(hours) ? Math.min(72, Math.max(1, hours)) : 24,
    },
  };
}

/**
 * Consigne d'analyse. Le résumé, l'action et le message de relance (texte de l'entreprise, envoyé à un tiers) sont écrits dans la langue de
 * la société ; `language` du résultat reste la langue PARLÉE par l'appelant (code ISO), lue dans la transcription. Français : consigne d'origine.
 */
function analysisSystem(language) {
  if (baseLanguage(language) === 'fr') {
    return `Tu analyses la transcription d'un message laissé sur une messagerie vocale d'un centre d'appels.
N'invente aucune information absente de la transcription. Réponds par un objet JSON unique avec exactement ces clés :
summary (français, 280 caractères max), intent (${INTENTS.join('|')}), urgency (low|medium|high), sentiment (positif|neutre|negatif), language (code ISO de la langue parlée),
callerName (string ou null), callbackNumber (numéro dit par l'appelant, sinon null),
suggestedFollowUp: { action (phrase courte à l'impératif), message (SMS ou e-mail de relance poli, prêt à envoyer, 300 caractères max), dueInHours (entier entre 1 et 72) }.`;
  }
  const label = languageLabel(language);
  return `You analyse the transcript of a message left on the voicemail of a call center.
Do not invent any information that is not in the transcript. Reply with a single JSON object with exactly these keys:
summary (written in ${label}, 280 characters max), intent (${INTENTS.join('|')}), urgency (low|medium|high), sentiment (positif|neutre|negatif), language (ISO code of the language the caller SPOKE, read from the transcript),
callerName (string or null), callbackNumber (number said by the caller, otherwise null),
suggestedFollowUp: { action (short imperative sentence, written in ${label}), message (polite follow-up SMS or e-mail, ready to send, written in ${label}, 300 characters max), dueInHours (integer between 1 and 72) }.
The values of intent, urgency and sentiment must be exactly one of the listed keywords (they are not translated).`;
}

/**
 * `language` : langue de la société (indice de transcription et langue du résumé). Absente, elle vaut 'fr' (comportement d'avant :
 * un appelant historique de ce service n'envoie pas encore la langue).
 */
async function analyzeVoicemail({ companyId, usageId, audio, contentType, from, language = 'fr' }) {
  const openai = getOpenAI();
  await assertSufficientBalance(companyId, TOKEN_COST_ANALYZE);
  const m = models();

  const file = await OpenAI.toFile(audio, `voicemail.${extensionFor(contentType)}`, { type: contentType || 'audio/mpeg' });
  const stt = await openai.audio.transcriptions.create({ file, model: m.stt, language: baseLanguage(language) });
  const transcript = String(stt?.text || '').trim();

  let analysis;
  if (transcript.replace(/[^\p{L}\p{N}]/gu, '').length < 2) {
    analysis = emptyAnalysis(language);
  } else {
    const completion = await openai.chat.completions.create({
      model: m.llm,
      temperature: 0.2,
      max_tokens: 600,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: analysisSystem(language) },
        { role: 'user', content: `Transcription du message :\n${transcript}` },
      ],
    });
    let parsed = null;
    try {
      parsed = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
    } catch (_err) {
      throw new VoiceMenuError(502, 'invalid_analysis', "L'analyse IA a renvoyé une réponse illisible. Réessayez.");
    }
    analysis = normalizeAnalysis(parsed, language);
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

// --- Plan d'action : l'IA PROPOSE 2 à 5 actions, une personne les valide avant toute création (l'IA n'agit jamais seule).
const PLAN_MODELS = ['voicemail_callback', 'missed_callback', 'appointment', 'transfer'];
const PLAN_MAX = 5;

const PLAN_SYSTEM_FR = `Tu aides le secrétariat d'un centre d'appels. À partir du résumé et de la transcription d'un message vocal laissé par un appelant, tu PROPOSES entre 2 et 5 actions concrètes, que l'équipe validera avant toute création. Tu n'exécutes rien.
N'invente aucune information absente du message (nom, numéro, date, lieu). Si une date ou un horaire n'est pas dit, laisse dueInHours à null.
Réponds par un objet JSON unique : { "actions": [ { "model", "title", "note", "contactName", "dueInHours" } ] } où :
- model vaut exactement l'un de : voicemail_callback (rappeler la personne), missed_callback (rappel à planifier à une date précise), appointment (rendez-vous à planifier), transfer (confier à un collaborateur pour traitement) ;
- title : intitulé court à l'impératif en français (90 caractères max) ;
- note : précision utile pour la personne qui traitera (280 caractères max) ;
- contactName : nom de l'appelant s'il est connu, sinon null ;
- dueInHours : entier de 1 à 336 si le message indique un délai, sinon null.
Les actions doivent être différentes les unes des autres.`;

/** Consigne du plan d'action : titres et notes dans la langue de la société (ils entrent dans l'agenda de l'entreprise). Français : d'origine. */
function planSystem(language) {
  if (baseLanguage(language) === 'fr') return PLAN_SYSTEM_FR;
  const label = languageLabel(language);
  return `You help the secretarial team of a call center. From the summary and transcript of a voice message left by a caller, you SUGGEST between 2 and 5 concrete actions, which the team will validate before anything is created. You execute nothing.
Do not invent any information that is not in the message (name, number, date, place). If a date or time is not stated, leave dueInHours as null.
Reply with a single JSON object: { "actions": [ { "model", "title", "note", "contactName", "dueInHours" } ] } where:
- model is exactly one of: voicemail_callback (call the person back), missed_callback (callback to schedule at a precise date), appointment (appointment to schedule), transfer (hand over to a colleague to handle);
- title: short imperative title written in ${label} (90 characters max);
- note: useful detail for the person who will handle it, written in ${label} (280 characters max);
- contactName: the caller's name if known, otherwise null;
- dueInHours: integer from 1 to 336 if the message states a delay, otherwise null.
The actions must differ from one another.`;
}

function normalizePlan(raw) {
  const list = Array.isArray(raw?.actions) ? raw.actions : [];
  const seen = new Set();
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object' || !PLAN_MODELS.includes(a.model)) continue;
    const title = clip(a.title, 90);
    if (!title) continue;
    const key = `${a.model}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const hours = Math.round(Number(a.dueInHours));
    const name = clip(a.contactName, 80);
    out.push({
      model: a.model,
      title,
      note: clip(a.note, 280),
      contactName: name && name.toLowerCase() !== 'null' ? name : null,
      dueInHours: a.dueInHours !== null && a.dueInHours !== undefined && Number.isFinite(hours) ? Math.min(336, Math.max(1, hours)) : null,
    });
    if (out.length === PLAN_MAX) break;
  }
  return out;
}

async function proposeActionPlan({ companyId, summary, transcript, intent, urgency, callerName, callbackNumber, language = 'fr' }) {
  const openai = getOpenAI();
  await assertSufficientBalance(companyId, TOKEN_COST_ACTION_PLAN);
  const lines = [
    `Résumé : ${clip(summary, 600) || 'non fourni'}`,
    `Motif détecté : ${clip(intent, 60) || 'non précisé'} · Urgence : ${clip(urgency, 10) || 'non précisée'}`,
    callerName ? `Appelant : ${clip(callerName, 80)}` : 'Appelant : nom non connu',
    callbackNumber ? `Numéro laissé : ${clip(callbackNumber, 30)}` : '',
    `Transcription :\n${String(transcript || '').slice(0, 6000) || '(absente)'}`,
  ].filter(Boolean);
  const completion = await openai.chat.completions.create({
    model: models().llm,
    temperature: 0.3,
    max_tokens: 700,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: planSystem(language) }, { role: 'user', content: lines.join('\n') }],
  });
  let parsed = null;
  try {
    parsed = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
  } catch (_err) {
    throw new VoiceMenuError(502, 'invalid_plan', "L'IA a renvoyé une réponse illisible. Réessayez.");
  }
  const actions = normalizePlan(parsed);
  if (actions.length === 0) throw new VoiceMenuError(502, 'empty_plan', "L'IA n'a proposé aucune action exploitable. Réessayez.");
  await chargeTokens({
    companyId,
    usageId: `action-plan-${crypto.randomUUID()}`,
    tokensUsed: TOKEN_COST_ACTION_PLAN,
    tool: 'voice-menu-action-plan',
    meta: { actions: actions.length, model: models().llm },
  });
  return { actions, tokensCharged: TOKEN_COST_ACTION_PLAN };
}

/** Champs libres d'une fiche d'annuaire pour lesquels l'IA propose des formulations. */
const DIRECTORY_FIELDS = {
  routing: 'which callers or topics the receptionist should put through to this person',
  absent: 'what the receptionist should say or do when this person is absent (take a message, suggest someone else, give a number)',
  priority: 'the call reasons that must never be kept waiting or left without follow-up for this person',
};
const DIRECTORY_MAX = 3;

const directorySystem = (language, field) =>
  `You help configure the reception desk of a company. You SUGGEST ${DIRECTORY_MAX} different short options (280 characters max each) for the following field of a directory entry: ${DIRECTORY_FIELDS[field]}.
Write in ${languageLabel(language)}, in the imperative or neutral style of an instruction given to a receptionist.
Base yourself only on the role and type given; never invent names, numbers, addresses or schedules.
Reply with a single JSON object: { "options": [ "…", "…", "…" ] }.`;

function normalizeDirectoryOptions(raw) {
  const list = Array.isArray(raw?.options) ? raw.options : [];
  const seen = new Set();
  const out = [];
  for (const o of list) {
    const text = clip(typeof o === 'string' ? o : o?.text, 280);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push(text);
    if (out.length === DIRECTORY_MAX) break;
  }
  return out;
}

async function proposeDirectoryOptions({ companyId, field, language = 'fr', companyName, personName, role, kind, current }) {
  if (!DIRECTORY_FIELDS[field]) throw new VoiceMenuError(400, 'invalid_field', 'Champ inconnu.');
  const openai = getOpenAI();
  await assertSufficientBalance(companyId, TOKEN_COST_SUGGEST);
  const lines = [
    companyName ? `Company: ${clip(companyName, 120)}` : '',
    role ? `Role of the person: ${clip(role, 120)}` : 'Role of the person: not specified',
    kind ? `Type: ${clip(kind, 30)}` : '',
    personName ? `Name: ${clip(personName, 120)}` : '',
    current ? `Text already written (improve or propose alternatives): ${clip(current, 400)}` : '',
  ].filter(Boolean);
  const completion = await openai.chat.completions.create({
    model: models().llm,
    temperature: 0.6,
    max_tokens: 500,
    response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: directorySystem(language, field) }, { role: 'user', content: lines.join('\n') }],
  });
  let parsed = null;
  try {
    parsed = JSON.parse(completion?.choices?.[0]?.message?.content || '{}');
  } catch (_err) {
    throw new VoiceMenuError(502, 'invalid_options', "L'IA a renvoyé une réponse illisible. Réessayez.");
  }
  const options = normalizeDirectoryOptions(parsed);
  if (options.length === 0) throw new VoiceMenuError(502, 'empty_options', "L'IA n'a proposé aucune formulation. Réessayez.");
  await chargeTokens({
    companyId,
    usageId: `directory-suggest-${crypto.randomUUID()}`,
    tokensUsed: TOKEN_COST_SUGGEST,
    tool: 'directory-suggest',
    meta: { field, model: models().llm },
  });
  return { options, tokensCharged: TOKEN_COST_SUGGEST };
}

module.exports = {
  DIRECTORY_FIELDS,
  normalizeDirectoryOptions,
  proposeDirectoryOptions,
  TOKEN_COST_ACTION_PLAN,
  PLAN_MODELS,
  PLAN_MAX,
  normalizePlan,
  proposeActionPlan,
  TOKEN_COST_SUGGEST,
  TOKEN_COST_TTS,
  TOKEN_COST_ANALYZE,
  VOICES,
  KINDS,
  AUDIENCES,
  buildSuggestPrompt,
  speechInstructions,
  analysisSystem,
  planSystem,
  emptyAnalysis,
  baseLanguage,
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
