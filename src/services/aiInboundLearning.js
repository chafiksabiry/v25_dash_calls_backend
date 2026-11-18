/**
 * Apprentissage de l'agent IA validé par un humain (étude, section 7) : AUCUN entraînement de modèle.
 * Après chaque appel IA, UNE analyse de la transcription par un modèle texte économique (Vertex Gemini Flash-Lite par défaut,
 * AI_LEARNING_MODEL) produit des « propositions d'apprentissage », envoyées à l'orchestrateur qui les regroupe et les soumet au
 * titulaire. Rien n'est utilisé par l'agent avant validation. Coût borné : un appel au modèle par appel téléphonique, entrée tronquée,
 * sortie limitée. Désactivable (réglage de l'entreprise, ou AI_LEARNING_ENABLED=false). Aucune donnée Google (Gmail, Agenda).
 */
const MAX_TRANSCRIPT_CHARS = 8000;
const MAX_OUTPUT_TOKENS = 600;
const ANALYSIS_TIMEOUT_MS = 8000;
const KINDS = ['unanswered', 'transfer_unknown', 'caller_correction', 'recurring'];
const truthyOff = (v) => ['0', 'false', 'no', 'off'].includes(String(v ?? '').trim().toLowerCase());

/** Anonymisation (même règle que l'orchestrateur, qui la réapplique) : e-mails, numéros, noms connus et annoncés. */
function anonymize(text, names = []) {
  let t = String(text ?? '');
  t = t.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[e-mail]');
  t = t.replace(/\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){2,7}\b/g, '[numéro]');
  t = t.replace(/(?:\+|00)?\d[\d\s.\-()]{5,}\d/g, '[numéro]');
  for (const raw of names) {
    for (const part of String(raw || '').split(/\s+/).filter((p) => p.length >= 2)) {
      t = t.replace(new RegExp(`\\b${part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '[nom]');
    }
  }
  t = t.replace(/\b(je m'appelle|je suis|mon nom est|my name is|this is)\s+([A-ZÀ-Ý][\p{L}'-]+(?:\s+[A-ZÀ-Ý][\p{L}'-]+)?)/giu, (m, a) => `${a} [nom]`);
  t = t.replace(/\b(Monsieur|Madame|Mademoiselle|M\.|Mme|Mlle|Mr\.?|Mrs\.?|Ms\.?|Dr\.?)\s+[A-ZÀ-Ý][\p{L}'-]+/gu, (m, a) => `${a} [nom]`);
  return t.replace(/\s+/g, ' ').trim();
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

/** Modèle texte par défaut : Vertex Gemini Flash-Lite, sortie JSON, température basse, sortie bornée. */
async function defaultGenerate(prompt, env = process.env) {
  // eslint-disable-next-line global-require
  const vertex = require('./vertexai.service');
  const ai = await vertex.getVertexAI();
  const model = ai.getGenerativeModel({
    model: env.AI_LEARNING_MODEL || 'gemini-2.5-flash-lite',
    generation_config: { max_output_tokens: MAX_OUTPUT_TOKENS, temperature: 0.1, response_mime_type: 'application/json' },
  });
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
      question: anonymize(p && p.question, names).slice(0, 300),
      proposedAnswer: anonymize(p && (p.proposedAnswer || p.answer), names).slice(0, 1000),
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
  if (rules.length) parts.push(`## Consignes apprises validées par l'entreprise\n${rules.map((x) => `- ${String(x.answer).slice(0, 1000)}`).join('\n')}`);
  return parts.join('\n\n');
}

module.exports = { analyzeCall, postLearning, learnedBlock, anonymize, buildPrompt, MAX_OUTPUT_TOKENS, MAX_TRANSCRIPT_CHARS };
