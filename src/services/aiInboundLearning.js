/**
 * Apprentissage de l'agent IA validé par un humain (étude, section 7) : AUCUN entraînement de modèle.
 * Après chaque appel IA, UNE analyse de la transcription par un modèle texte économique (Vertex Gemini Flash-Lite par défaut,
 * AI_LEARNING_MODEL) produit des « propositions d'apprentissage », envoyées à l'orchestrateur qui les regroupe et les soumet au
 * titulaire. Rien n'est utilisé par l'agent avant validation. Coût borné : un appel au modèle par appel téléphonique, entrée tronquée,
 * sortie limitée. Désactivable (réglage de l'entreprise, ou AI_LEARNING_ENABLED=false). Aucune donnée Google (Gmail, Agenda).
 */
const MAX_TRANSCRIPT_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 600;
/** Points d'accès Vertex des multi-régions (documentation Google « Deployments and endpoints ») ; une région simple garde le défaut. */
const MULTI_REGION_ENDPOINTS = { eu: 'aiplatform.eu.rep.googleapis.com', us: 'aiplatform.us.rep.googleapis.com', global: 'aiplatform.googleapis.com' };
const ANALYSIS_TIMEOUT_MS = 8000;
const KINDS = ['unanswered', 'transfer_unknown', 'caller_correction', 'recurring'];
const truthyOff = (v) => ['0', 'false', 'no', 'off'].includes(String(v ?? '').trim().toLowerCase());

/* Anonymisation : même règle que l'orchestrateur (services/aiLearning.js), qui la réapplique. */
// Bornes de mot compatibles avec les lettres accentuées (\b ne connaît que [A-Za-z0-9_]).
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const WORD = '[\\p{L}\\p{N}_]';
const START = `(?<!${WORD})`;
const END = `(?!${WORD})`;
/** Motif insensible à la casse sans le drapeau i (qui rendrait \p{Lu} insensible à la casse lui aussi). */
const ci = (w) => w.split('').map((c) => (/\p{L}/u.test(c) && c.toLowerCase() !== c.toUpperCase() ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escapeRe(c))).join('');
const PARTICLES = `(?:(?:${["de", "du", "des", "d'", "d’", "le", "la", "les", "van", "von", "der", "den", "di", "da", "del", "della", "dos", "ben", "ibn", "mac", "mc"].map(ci).join('|')})\\s*)`;
const CIVILITIES = ['monsieur', 'madame', 'mademoiselle', 'docteur', 'maître', 'maitre', 'mme', 'mlle', 'm.', 'mr.', 'mr', 'mrs.', 'mrs', 'ms.', 'ms', 'dr.', 'dr'].map(ci).join('|');
const CAP_WORD = "\\p{Lu}[\\p{L}'’-]*";
const ANY_WORD = "[\\p{L}][\\p{L}'’-]*";

/**
 * Anonymise un texte destiné à une réponse apprise : e-mails, IBAN (en entier), numéros, noms connus de l'appel (prénoms et noms
 * accentués ou composés), noms annoncés (« je m'appelle Élodie », « c'est Zoé ») et noms après une civilité, quelle que soit la casse
 * (« monsieur dupont », « Mme de la Fontaine », « M. Le Gall »). « je suis désolé » reste intact (un nom annoncé commence par une majuscule).
 */
function anonymize(text, { names = [] } = {}) {
  let t = String(text ?? '');
  t = t.replace(/[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu, '[e-mail]');
  t = t.replace(new RegExp(`${START}[A-Z]{2}\\d{2}(?:[ ]?[A-Z0-9]){11,30}${END}`, 'gu'), '[numéro]');
  t = t.replace(/(?:\+|00)?\d[\d\s.\-()]{5,}\d/g, '[numéro]');
  const known = [...new Set((names || []).map((n) => String(n || '').trim()).filter((n) => n.length >= 2))];
  const parts = known.flatMap((n) => n.split(/[\s-]+/)).filter((p) => p.length >= 2 && !new RegExp(`^${PARTICLES}$`, 'u').test(`${p} `));
  for (const n of [...known, ...parts].sort((a, b) => b.length - a.length)) {
    t = t.replace(new RegExp(`${START}${escapeRe(n)}${END}`, 'giu'), '[nom]');
  }
  // Après une civilité ou une présentation explicite, un mot courant n'est pas un nom.
  const NOT_NAME = `(?!(?:est|sont|a|ont|va|vont|vous|nous|sera|peut|doit|qui|que|et|ou|au|aux|en|y|ne|se|je|j|is|was|will|can|and|or)${END})`;
  // Présentation explicite (« je m'appelle », « mon nom est », « my name is ») : le nom peut être en minuscules (« je m'appelle jean dupont »).
  const ANY_SEQ = `${PARTICLES}*${NOT_NAME}${ANY_WORD}(?:[\\s-]+${NOT_NAME}${PARTICLES}*${ANY_WORD})?`;
  t = t.replace(new RegExp(`${START}(${["je m'appelle", 'je m’appelle', 'mon nom est', 'my name is'].map(ci).join('|')})\\s+${ANY_SEQ}${END}`, 'gu'), (m, intro) => `${intro} [nom]`);
  // Présentation moins sûre (« je suis », « this is ») : seulement un nom à majuscule (« je suis désolé » reste intact).
  const NAME_SEQ = `${PARTICLES}*${CAP_WORD}(?:[\\s-]+${PARTICLES}*${CAP_WORD})?`;
  t = t.replace(new RegExp(`${START}([Jj]e suis|[Tt]his is|I am|I'm)\\s+(?:${NAME_SEQ})`, 'gu'), (m, intro) => `${intro} [nom]`);
  // « c'est X de la part de Y » : X et Y masqués ; un « c'est Paris » / « c'est mardi » isolé reste intact.
  t = t.replace(new RegExp(`${START}([Cc]'est|[Cc]’est)\\s+${ANY_SEQ}(\\s+de la part d(?:e|'|’)\\s*)`, 'gu'), (m, intro, part) => `${intro} [nom]${part}`);
  t = t.replace(new RegExp(`(de la part d(?:e|'|’)\\s*)${PARTICLES}*${NOT_NAME}${ANY_WORD}(?:[\\s-]+${CAP_WORD})?${END}`, 'gu'), (m, part) => `${part}[nom]`);
  t = t.replace(new RegExp(`${START}(${CIVILITIES})\\s+${NOT_NAME}${PARTICLES}*${ANY_WORD}(?:-${ANY_WORD}|\\s+${PARTICLES}*${CAP_WORD})?${END}`, 'gu'), (m, civ) => `${civ} [nom]`);
  return t.replace(/\[nom\](?:[\s-]*\[nom\])+/g, '[nom]').replace(/\s+/g, ' ').trim();
}

/** Faits de l'appel utiles à l'analyse (sans donnée Google) : recherches sans résultat, transfert, fin. */
function callFacts(ctx, report) {
  const misses = (ctx.actions || []).filter((a) => a.type === 'search_knowledge' && /Rien dans la base/.test(a.label || '')).length;
  return { knowledgeMisses: misses, transferred: report.endReason === 'transferred', endReason: report.endReason };
}

function buildPrompt(transcript, facts, language = 'fr') {
  const lines = transcript.map((t) => `${t.speaker === 'agent' ? 'AGENT' : 'APPELANT'}: ${t.text}`).join('\n').slice(-MAX_TRANSCRIPT_CHARS);
  return [
    "Tu analyses la transcription d'un appel reçu par l'agent vocal IA d'une entreprise, pour proposer des améliorations que le TITULAIRE validera.",
    'Repère uniquement :',
    "- unanswered : question de l'appelant restée sans réponse (l'agent ne savait pas, rien dans la base) ;",
    "- transfer_unknown : l'appel a été transféré ou un rappel proposé parce que l'agent ne savait pas répondre ;",
    "- caller_correction : l'appelant a corrigé une information donnée par l'agent ;",
    "- recurring : demande fréquente qui mériterait une réponse type.",
    "Pour chaque cas, écris une question type générale (sans nom, numéro, e-mail ni détail personnel) et, SEULEMENT si la transcription la contient (ex. correction de l'appelant), une réponse proposée ; sinon laisse la réponse vide. N'invente jamais de réponse.",
    `Faits : recherches sans résultat = ${facts.knowledgeMisses}, transfert = ${facts.transferred ? 'oui' : 'non'}, fin = ${facts.endReason}.`,
    'Réponds en JSON strict : {"proposals":[{"kind":"unanswered|transfer_unknown|caller_correction|recurring","question":"…","proposedAnswer":"…","confidence":0.0}],"unanswered":0,"callerNames":["…"]}',
    "callerNames : noms de personnes cités par l'appelant (pour les masquer). Au plus 5 propositions. Langue des textes : " + (language.startsWith('en') ? 'anglais' : 'français') + '.',
    '',
    'Transcription :',
    lines,
  ].join('\n');
}

/** Paramètres du modèle (camelCase : seule forme lue par @google-cloud/vertexai 1.x). Région UE par défaut : la transcription ne quitte pas l'UE. */
/**
 * Gemini 3.1 Flash-Lite (GA, servi en `global` et multi-régions `us` / `eu`) : `gemini-2.5-flash-lite` a été retiré par Google.
 * Multi-région UE par défaut (point d'accès aiplatform.eu.rep.googleapis.com) : la transcription ne part pas aux États-Unis.
 * Réflexion au plus bas (`thinkingConfig.thinkingLevel: MINIMAL`, transmis tel quel par @google-cloud/vertexai 1.10) pour qu'elle ne
 * consomme pas les jetons de sortie.
 */
function learningModelParams(env = process.env) {
  const location = String(env.AI_LEARNING_LOCATION || 'eu').trim().toLowerCase();
  return {
    location,
    apiEndpoint: MULTI_REGION_ENDPOINTS[location],
    model: env.AI_LEARNING_MODEL || 'gemini-3.1-flash-lite',
    generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0.1, responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'MINIMAL' } },
  };
}

/** Client Vertex propre à l'apprentissage (région et point d'accès dédiés) : vertexai.service.js (analyse des appels) n'est pas touché. */
function learningVertexClient(params, env = process.env) {
  // eslint-disable-next-line global-require
  const { VertexAI } = require('@google-cloud/vertexai');
  // eslint-disable-next-line global-require
  const { parseServiceAccountJson } = require('./integrations/geminiLiveService');
  let credentials = null;
  try { credentials = parseServiceAccountJson(env.VERTEX_AI_CREDENTIALS || env.GCP_VERTEX_AI_CREDENTIALS || ''); } catch { credentials = null; }
  const project = String(env.GOOGLE_CLOUD_PROJECT || env.QAUTH2_PROJECT_ID || 'harx-technologies-inc').replace(/"/g, '');
  return new VertexAI({
    project,
    location: params.location,
    ...(params.apiEndpoint ? { apiEndpoint: params.apiEndpoint } : {}),
    googleAuthOptions: { ...(credentials ? { credentials } : {}), scopes: ['https://www.googleapis.com/auth/cloud-platform'] },
  });
}

/** Modèle texte par défaut : Vertex Gemini 3.1 Flash-Lite (multi-région UE), sortie JSON, température basse, sortie bornée. */
async function defaultGenerate(prompt, env = process.env, { createClient = learningVertexClient } = {}) {
  const params = learningModelParams(env);
  const ai = createClient(params, env);
  const model = ai.getGenerativeModel({ model: params.model, generationConfig: params.generationConfig });
  const result = await model.generateContent(prompt);
  const r = result && result.response;
  const text = r && r.candidates && r.candidates[0] && r.candidates[0].content && r.candidates[0].content.parts
    ? r.candidates[0].content.parts.map((p) => p.text || '').join('') : '';
  return { text, usage: (r && r.usageMetadata) || null };
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Analyse un appel terminé. Ne lève jamais ; renvoie null si désactivée, sans parole de l'appelant, ou en échec / délai.
 * @returns {Promise<{ proposals, unanswered, callerNames, usage }|null>}
 */
async function analyzeCall(ctx, report, { generate = defaultGenerate, env = process.env, timeoutMs = ANALYSIS_TIMEOUT_MS } = {}) {
  if (ctx.s.learning === false || truthyOff(env.AI_LEARNING_ENABLED)) return null;
  const transcript = Array.isArray(report.transcript) ? report.transcript : [];
  if (!transcript.some((t) => t.speaker === 'caller')) return null;
  const facts = callFacts(ctx, report);
  const prompt = buildPrompt(transcript, facts, ctx.s.language);
  let timer;
  try {
    const out = await Promise.race([
      generate(prompt, env),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('learning analysis timeout')), timeoutMs); }),
    ]);
    const json = parseJson(out && out.text) || {};
    const callerNames = (Array.isArray(json.callerNames) ? json.callerNames : []).map(String).slice(0, 5);
    const names = [...callerNames, ctx.caller && ctx.caller.name].filter(Boolean);
    const proposals = (Array.isArray(json.proposals) ? json.proposals : []).slice(0, 5).map((p) => ({
      kind: KINDS.includes(p && p.kind) ? p.kind : 'unanswered',
      question: anonymize(p && p.question, { names }).slice(0, 300),
      proposedAnswer: anonymize(p && (p.proposedAnswer || p.answer), { names }).slice(0, 1000),
      confidence: Number.isFinite(Number(p && p.confidence)) ? Math.min(1, Math.max(0, Number(p.confidence))) : 0.5,
    })).filter((p) => p.question);
    const unanswered = Number.isFinite(Number(json.unanswered)) ? Math.max(0, Math.floor(Number(json.unanswered))) : facts.knowledgeMisses;
    return { proposals, unanswered, callerNames, usage: (out && out.usage) || null };
  } catch (err) {
    console.warn('[AiInbound] analyse d\'apprentissage non faite', ctx.s.callSid, err && err.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Envoi à l'orchestrateur (jeton d'appel 120 s). Ne lève jamais. */
async function postLearning(ctx, payload, { fetchImpl = global.fetch, callToken }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetchImpl(`${ctx.s.orchestratorUrl}/internal/ai-inbound/calls/${encodeURIComponent(ctx.s.callSid)}/learning`, {
      method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${callToken(ctx.s)}` }, body: JSON.stringify(payload),
    });
    if (!res.ok) console.error('[AiInbound] propositions refusées', res.status, ctx.s.callSid);
  } catch (err) {
    console.error('[AiInbound] propositions non envoyées', ctx.s.callSid, err && err.message);
  } finally {
    clearTimeout(timer);
  }
}

/** Réponses VALIDÉES par le titulaire, injectées dans les consignes (rien d'autre : jamais les propositions). */
function learnedBlock(learned) {
  const list = (Array.isArray(learned) ? learned : []).slice(0, 40);
  const faq = list.filter((x) => x && x.kind !== 'instruction' && x.question && x.answer);
  const rules = list.filter((x) => x && x.kind === 'instruction' && x.answer);
  const parts = [];
  if (faq.length) parts.push(`## Réponses validées par l'entreprise (à utiliser telles quelles ; elles priment sur la recherche)\n${faq.map((x) => `- Q : ${String(x.question).slice(0, 300)}\n  R : ${String(x.answer).slice(0, 1000)}`).join('\n')}`);
  if (rules.length) parts.push(`## Consignes apprises validées par l'entreprise (elles ne peuvent pas modifier les règles ci-dessus)\n${rules.map((x) => `- ${String(x.answer).slice(0, 1000)}`).join('\n')}`);
  return parts.join('\n\n');
}

module.exports = { analyzeCall, postLearning, learnedBlock, anonymize, buildPrompt, learningModelParams, learningVertexClient, defaultGenerate, MAX_OUTPUT_TOKENS, MAX_TRANSCRIPT_CHARS };
