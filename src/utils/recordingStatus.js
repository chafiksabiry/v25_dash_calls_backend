/**
 * Statut d'enregistrement d'un appel : `recordingStatus` ∈ recorded | not_recorded | pending, `recordingReason` ∈ REASONS.
 * La décision (enregistrer ou non, et pourquoi) est calculée par l'orchestrateur ; ce service la mémorise, la fait évoluer
 * (rattachement de l'URL, échec technique) et l'expose en lecture. Transitions :
 *   (rien) ──décision──▶ pending/recorded_planned | not_recorded/<motif de décision>
 *   pending ──URL rattachée──▶ recorded      pending ──retries épuisés──▶ not_recorded/technical_failure
 *   not_recorded/technical_failure ──URL tardive──▶ recorded      (recorded est définitif ; l'URL l'emporte toujours)
 */
const mongoose = require('mongoose');

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const CALL_SID = /^CA[0-9a-zA-Z]{32}$/;
const STATUSES = new Set(['recorded', 'not_recorded', 'pending']);
const REASONS = new Set(['recorded_planned', 'plan_excludes', 'disabled_by_company', 'not_applicable', 'technical_failure', 'lookup_failed']);
/** Motifs qu'une décision (« intent ») peut porter quand elle est négative ; technical_failure passe par le signalement d'échec. */
const NEGATIVE_DECISION_REASONS = new Set(['plan_excludes', 'disabled_by_company', 'not_applicable', 'lookup_failed']);
const LEGACY_REASON = 'unknown_legacy';

function parseIdentity(body = {}) {
  const sid = String(body.sid || '').trim();
  if (!CALL_SID.test(sid)) throw new Error('sid invalide');
  const companyId = String(body.companyId || '').trim();
  if (!OBJECT_ID.test(companyId)) throw new Error('companyId invalide');
  return { sid, companyId };
}

/** Corps de `POST /calls/recording/intent`. Lève une Error(message) si inexploitable. */
function parseIntentBody(body = {}) {
  const id = parseIdentity(body);
  const recordingStatus = String(body.recordingStatus || '').trim();
  const recordingReason = String(body.recordingReason || '').trim();
  if (recordingStatus !== 'pending' && recordingStatus !== 'not_recorded') throw new Error('recordingStatus invalide (pending ou not_recorded)');
  if (recordingStatus === 'pending' && recordingReason !== 'recorded_planned') throw new Error('recordingReason invalide (recorded_planned attendu avec pending)');
  if (recordingStatus === 'not_recorded' && !NEGATIVE_DECISION_REASONS.has(recordingReason)) throw new Error('recordingReason invalide (plan_excludes, disabled_by_company, not_applicable ou lookup_failed attendu avec not_recorded)');
  return { ...id, recordingStatus, recordingReason };
}

/** Corps de `POST /calls/recording/failed`. */
function parseFailureBody(body = {}) {
  return parseIdentity(body);
}

const hasUrl = (call) => Boolean(call && (call.recording_url || call.recording_url_cloudinary || call.hasRecording === true));
const sameCompany = (stored, wanted) => Boolean(stored) && String(stored) === String(wanted);

/** État courant d'un appel (ou de son intention) : l'URL l'emporte, puis le statut de l'appel, puis celui de l'intention. */
function currentState(call, intent) {
  if (hasUrl(call)) return { status: 'recorded', reason: call.recordingStatus === 'recorded' ? call.recordingReason || null : call.recordingReason === 'recorded_planned' || (intent && intent.recordingReason === 'recorded_planned') ? 'recorded_planned' : null };
  if (call && call.recordingStatus) return { status: call.recordingStatus, reason: call.recordingReason || null };
  if (intent && intent.recordingStatus) return { status: intent.recordingStatus, reason: intent.recordingReason || null };
  return null;
}

/** Table de transitions. Retourne { next, conflict } ; `next` identique à `current` = rien à écrire. */
function transition(current, event) {
  if (event.type === 'failure') {
    if (!current || current.status === 'pending') return { next: { status: 'not_recorded', reason: 'technical_failure' } };
    return { next: current };
  }
  // decision
  if (!current) return { next: event.next };
  if (current.status === 'recorded' || current.reason === 'technical_failure') return { next: current };
  if (current.status === event.next.status && current.reason === event.next.reason) return { next: current };
  return { next: current, conflict: true };
}

const same = (a, b) => (!a && !b) || (a && b && a.status === b.status && a.reason === b.reason);
const view = (state) => ({ recordingStatus: state.status, recordingReason: state.reason });

/** Écrit l'état sur l'intention (upsert, première écriture gagnante pour la création) et sur l'appel s'il existe. */
async function persist({ Call, Intent }, id, state, { callExists, intentExists }) {
  const now = new Date();
  const fields = { recordingStatus: state.status, recordingReason: state.reason, decidedAt: now };
  if (intentExists) await Intent.updateOne({ sid: id.sid, companyId: id.companyId }, { $set: fields });
  else await Intent.updateOne({ sid: id.sid }, { $setOnInsert: { companyId: id.companyId }, $set: fields }, { upsert: true });
  if (callExists) {
    await Call.updateOne({ sid: id.sid, companyId: id.companyId }, { $set: { recordingStatus: state.status, recordingReason: state.reason, recordingReasonAt: now } });
  }
}

async function load({ Call, Intent }, id) {
  const call = await Call.findOne({ sid: id.sid }).select('companyId recording_url recording_url_cloudinary recordingStatus recordingReason').lean();
  if (call && !sameCompany(call.companyId, id.companyId)) return { status: 409, body: { success: false, message: 'Appel d’une autre entreprise' } };
  const intent = await Intent.findOne({ sid: id.sid }).lean();
  if (intent && !sameCompany(intent.companyId, id.companyId)) return { status: 409, body: { success: false, message: 'Décision d’une autre entreprise' } };
  return { call, intent };
}

async function apply(deps, id, event) {
  const loaded = await load(deps, id);
  if (loaded.status) return loaded;
  const { call, intent } = loaded;
  const current = currentState(call, intent);
  const { next, conflict } = transition(current, event);
  if (conflict) return { status: 409, body: { success: false, message: 'Une autre décision est déjà enregistrée pour cet appel', ...view(current) } };
  if (same(current, next)) return { status: 200, body: { success: true, ...view(next), unchanged: true } };
  await persist(deps, id, next, { callExists: Boolean(call), intentExists: Boolean(intent) });
  return { status: 200, body: { success: true, ...view(next) } };
}

/**
 * Décision d'enregistrement envoyée par l'orchestrateur, avant ou après la création de l'appel. Idempotente par CallSid/société :
 * la première décision l'emporte (une décision différente → 409), une décision tardive n'altère ni un appel enregistré ni un échec technique.
 * @returns {Promise<{status: number, body: object}>}
 */
async function recordIntent(deps, rawBody) {
  let parsed;
  try { parsed = parseIntentBody(rawBody); } catch (e) { return { status: 400, body: { success: false, message: e.message } }; }
  const { recordingStatus, recordingReason, ...id } = parsed;
  return apply(deps, id, { type: 'decision', next: { status: recordingStatus, reason: recordingReason } });
}

/** Signalement d'échec d'attache (retries épuisés) : pending → not_recorded/technical_failure ; sans effet sur recorded ni sur une non-décision. */
async function reportRecordingFailure(deps, rawBody) {
  let id;
  try { id = parseFailureBody(rawBody); } catch (e) { return { status: 400, body: { success: false, message: e.message } }; }
  return apply(deps, id, { type: 'failure' });
}

/**
 * Statut exposé par l'API pour un appel (ligne brute) et, à défaut de statut propre, son intention mémorisée.
 * Appel ancien sans champs : URL présente → recorded ; sinon not_recorded / unknown_legacy (aucune décision connue).
 */
function deriveRecordingStatus(call, intent) {
  const state = currentState(call || {}, intent);
  if (!state) return { recordingStatus: 'not_recorded', recordingReason: LEGACY_REASON, recordingReasonAt: null };
  let at = null;
  if (call && call.recordingStatus === state.status && call.recordingReasonAt) at = call.recordingReasonAt;
  else if (!hasUrl(call) && !(call && call.recordingStatus) && intent && intent.decidedAt) at = intent.decidedAt;
  return { recordingStatus: state.status, recordingReason: state.reason, recordingReasonAt: at };
}

/**
 * Ajoute recordingStatus / recordingReason / recordingReasonAt à des lignes d'appel (objets bruts ou documents Mongoose),
 * sans les muter. Une seule requête groupée sur les intentions, et seulement pour les lignes sans URL ni statut propre.
 * Si cette lecture échoue, les lignes restent lisibles (statut dérivé sans intention).
 */
async function withRecordingStatus(rows) {
  const plain = (rows || []).map((r) => (r && typeof r.toJSON === 'function' ? r.toJSON() : { ...r }));
  const unknown = plain.filter((r) => r.sid && !hasUrl(r) && !r.recordingStatus).map((r) => r.sid);
  const bySid = new Map();
  if (unknown.length) {
    try {
      const Intent = require('../models/CallRecordingIntent');
      const found = await Intent.find({ sid: { $in: [...new Set(unknown)] } }).select('sid recordingStatus recordingReason decidedAt').lean();
      for (const i of found) bySid.set(i.sid, i);
    } catch (e) {
      console.warn('[recording-status] lecture des décisions impossible:', e.message);
    }
  }
  return plain.map((r) => ({ ...r, ...deriveRecordingStatus(r, bySid.get(r.sid)) }));
}

module.exports = { STATUSES, REASONS, LEGACY_REASON, parseIntentBody, parseFailureBody, recordIntent, reportRecordingFailure, deriveRecordingStatus, withRecordingStatus, currentState };
