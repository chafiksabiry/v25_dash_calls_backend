const jwt = require('jsonwebtoken');
const { assertCompanyAccess, ScopeError } = require('../middleware/companyScope');
const ai = require('../services/voiceMenuAi');

const SERVICE_SCOPE = 'voicemail-analyze';
const TTS_LIMIT = 20;
const TTS_WINDOW_MS = 10 * 60 * 1000;
const COMPANY_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LANGUAGE_RE = /^[a-z]{2}(-[A-Za-z]{2})?$/;

const ttsHits = new Map(); // userId -> timestamps

function fail(res, status, error, message) {
  return res.status(status).json({ success: false, error, message });
}

function handleError(res, err, label) {
  if (err instanceof ai.VoiceMenuError) return fail(res, err.status, err.code, err.message);
  if (err instanceof ScopeError) return fail(res, err.status, 'forbidden', err.message);
  console.error(`[voiceMenu] ${label} failed:`, err && err.message ? err.message : 'unknown error');
  return fail(res, 502, 'ai_failed', "Le service IA est momentanément indisponible. Réessayez.");
}

/** Contrôle d'accès à l'entreprise (JWT utilisateur déjà vérifié par authenticateUser). */
async function checkCompany(req, res, companyId) {
  if (typeof companyId !== 'string' || !COMPANY_ID_RE.test(companyId)) {
    fail(res, 400, 'invalid_company', 'companyId invalide.');
    return false;
  }
  try {
    await assertCompanyAccess(req, companyId);
    return true;
  } catch (err) {
    handleError(res, err, 'company access');
    return false;
  }
}

function takeTtsSlot(userId, now = Date.now()) {
  const recent = (ttsHits.get(userId) || []).filter((t) => now - t < TTS_WINDOW_MS);
  if (recent.length >= TTS_LIMIT) {
    ttsHits.set(userId, recent);
    return false;
  }
  recent.push(now);
  ttsHits.set(userId, recent);
  return true;
}

function resetRateLimit() {
  ttsHits.clear();
}

async function suggest(req, res) {
  const body = req.body || {};
  if (!(await checkCompany(req, res, body.companyId))) return;
  if (!ai.KINDS.includes(body.kind)) return fail(res, 400, 'invalid_kind', "Le type doit être 'greeting' ou 'voicemail'.");
  const tone = body.tone === undefined ? 'chaleureux' : body.tone;
  if (!ai.TONES.includes(tone)) return fail(res, 400, 'invalid_tone', 'Ton inconnu.');
  const language = body.language === undefined ? 'fr' : body.language;
  if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) return fail(res, 400, 'invalid_language', 'Langue invalide.');
  const optional = (v) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : undefined);
  const audience = body.audience === undefined ? 'center' : body.audience;
  if (!ai.AUDIENCES.includes(audience)) return fail(res, 400, 'invalid_audience', "L'audience doit être 'center' ou 'person'.");
  try {
    const data = await ai.suggestText({
      audience,
      personName: optional(body.personName),
      companyId: body.companyId,
      kind: body.kind,
      companyName: optional(body.companyName),
      operationName: optional(body.operationName),
      tone,
      language,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err, 'suggest');
  }
}

async function tts(req, res) {
  const body = req.body || {};
  if (!(await checkCompany(req, res, body.companyId))) return;
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (text.length < 1 || text.length > 600) return fail(res, 400, 'invalid_text', 'Le texte doit contenir entre 1 et 600 caractères.');
  if (!ai.VOICES.includes(body.voice)) return fail(res, 400, 'invalid_voice', `Voix inconnue. Voix disponibles : ${ai.VOICES.join(', ')}.`);
  const language = body.language === undefined ? 'fr' : body.language;
  if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) return fail(res, 400, 'invalid_language', 'Langue invalide.');
  if (!takeTtsSlot(req.auth.userId)) {
    return fail(res, 429, 'rate_limited', 'Trop de synthèses vocales. Réessayez dans quelques minutes.');
  }
  try {
    const { audio } = await ai.synthesizeSpeech({ companyId: body.companyId, text, voice: body.voice, language });
    res.set({ 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store', 'Content-Length': String(audio.length) });
    return res.status(200).send(audio);
  } catch (err) {
    return handleError(res, err, 'tts');
  }
}

/** Plan d'action proposé par l'IA à partir de l'analyse d'un message vocal : propositions seulement, rien n'est créé ici. */
async function actionPlan(req, res) {
  const body = req.body || {};
  if (!(await checkCompany(req, res, body.companyId))) return;
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const language = body.language === undefined ? 'fr' : body.language;
  if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) return fail(res, 400, 'invalid_language', 'Langue invalide.');
  const channel = body.channel === undefined ? 'voicemail' : body.channel;
  if (channel !== 'voicemail' && channel !== 'email') return fail(res, 400, 'invalid_channel', "Le canal doit être 'voicemail' ou 'email'.");
  const summary = text(body.summary, 2000);
  const transcript = text(body.transcript, 20000);
  if (!summary.trim() && !transcript.trim()) return fail(res, 400, 'invalid_source', "Le résumé ou la transcription du message est nécessaire pour proposer un plan d'action.");
  try {
    const data = await ai.proposeActionPlan({
      companyId: body.companyId,
      summary,
      transcript,
      intent: text(body.intent, 60),
      urgency: text(body.urgency, 10),
      callerName: text(body.callerName, 80),
      callbackNumber: text(body.callbackNumber, 30),
      language,
      channel,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err, 'action-plan');
  }
}

/** Propositions de l'IA pour un champ libre de l'annuaire (propositions seulement : rien n'est enregistré ici). */
async function directorySuggest(req, res) {
  const body = req.body || {};
  if (!(await checkCompany(req, res, body.companyId))) return;
  if (!Object.keys(ai.DIRECTORY_FIELDS).includes(body.field)) return fail(res, 400, 'invalid_field', "Le champ doit être 'routing', 'absent' ou 'priority'.");
  const language = body.language === undefined ? 'fr' : body.language;
  if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) return fail(res, 400, 'invalid_language', 'Langue invalide.');
  const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  try {
    const data = await ai.proposeDirectoryOptions({
      companyId: body.companyId,
      field: body.field,
      language,
      companyName: text(body.companyName, 120),
      personName: text(body.personName, 120),
      role: text(body.role, 120),
      kind: text(body.kind, 30),
      current: text(body.current, 400),
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err, 'directory-suggest');
  }
}

/** Jeton de service HS256 (scope voicemail-analyze, expiration obligatoire) — pas un jeton utilisateur. */
function authenticateService(req, res, next) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return fail(res, 500, 'auth_not_configured', "L'authentification n'est pas configurée.");
  const header = req.headers && req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return fail(res, 401, 'unauthorized', 'Authentification requise.');
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof decoded.exp !== 'number') throw new Error('exp required');
    if (decoded.scope !== SERVICE_SCOPE) throw new Error('bad scope');
    req.service = { scope: decoded.scope, iss: decoded.iss };
    return next();
  } catch (_err) {
    return fail(res, 401, 'unauthorized', 'Jeton de service invalide ou expiré.');
  }
}

async function analyzeVoicemail(req, res) {
  const { companyId, from, usageId } = req.query || {};
  // Langue de la société (indice de transcription, langue du résumé) ; absente : français, comme avant.
  const language = (req.query || {}).language === undefined ? 'fr' : (req.query || {}).language;
  if (typeof language !== 'string' || !LANGUAGE_RE.test(language)) return fail(res, 400, 'invalid_language', 'Langue invalide.');
  if (typeof companyId !== 'string' || !COMPANY_ID_RE.test(companyId)) return fail(res, 400, 'invalid_company', 'companyId invalide.');
  if (usageId !== undefined && (typeof usageId !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(usageId))) {
    return fail(res, 400, 'invalid_usage_id', 'usageId invalide.');
  }
  const audio = req.body;
  if (!Buffer.isBuffer(audio) || audio.length === 0) {
    return fail(res, 400, 'invalid_audio', "Corps audio manquant (envoyer les octets audio bruts, Content-Type audio/*).");
  }
  try {
    const data = await ai.analyzeVoicemail({
      companyId,
      usageId,
      audio,
      contentType: req.headers['content-type'],
      from: typeof from === 'string' ? from : undefined,
      language,
    });
    return res.json({ success: true, data });
  } catch (err) {
    return handleError(res, err, 'analyze-voicemail');
  }
}

module.exports = { suggest, tts, actionPlan, directorySuggest, authenticateService, analyzeVoicemail, resetRateLimit, SERVICE_SCOPE, TTS_LIMIT };
