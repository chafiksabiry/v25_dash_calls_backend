const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { authenticateUser, assertCompanyAccess, callerCompanyId } = require('./companyScope');

/**
 * Contrôle d'accès des routes d'appels (/api/calls, /api/rep-transactions).
 *
 * Deux groupes de routes, deux niveaux d'exigence (voir README de la PR) :
 *
 *  - groupe STRICT (`strictAuth`) : toutes les applications qui appellent la route envoient déjà le jeton de connexion.
 *    Jeton exigé tant que CALLS_REQUIRE_AUTH n'est pas explicitement `false` (défaut : exigé).
 *  - groupe COMPATIBILITÉ (`compatAuth`) : des applications non migrées (application entreprise, espace agent) appellent
 *    encore sans jeton. Avec un jeton, le contrôle est complet (401 jeton invalide, 403 autre centre). Sans jeton, la
 *    requête n'est tolérée QUE si CALLS_LEGACY_ANON n'est pas `false` (défaut : toléré) ET si elle nomme un périmètre
 *    (companyId, userId ou agentId) : le vidage global (aucun filtre) est refusé dans tous les cas, même en mode secours.
 *
 * CALLS_REQUIRE_AUTH=false : retour de secours au comportement historique (aucun jeton exigé) hors vidage global.
 * L'en-tête `x-user-id` n'est JAMAIS une preuve d'identité : il est forgeable et aucune vérification serveur n'est possible
 * sans jeton ; il est ignoré ici.
 */

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const SERVICE_SCOPES = ['voicemail-analyze', 'center-data'];

function flag(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  return !/^(false|0|off|no)$/i.test(String(raw).trim());
}
const requireAuth = () => flag('CALLS_REQUIRE_AUTH', true);
const legacyAnon = () => flag('CALLS_LEGACY_ANON', true);

const hasBearer = (req) => /^Bearer\s+\S+/.test((req.headers && req.headers.authorization) || '');

function deny(res, status, message) {
  return res.status(status).json({ success: false, message });
}

function sendScopeError(res, error) {
  if (error && error.status) return deny(res, error.status, error.message);
  console.error('[callsAccess]', error && error.message);
  return deny(res, 500, 'Access check failed');
}

/** Routes dont tous les appelants connus envoient le jeton. */
function strictAuth(req, res, next) {
  if (!requireAuth()) {
    req.callsLegacy = true;
    return next();
  }
  return authenticateUser(req, res, next);
}

/** Routes encore appelées sans jeton par certaines applications. Jeton présent = contrôle complet. */
function compatAuth(req, res, next) {
  if (hasBearer(req)) return authenticateUser(req, res, next);
  if (requireAuth() && !legacyAnon()) return deny(res, 401, 'Authentication required');
  req.callsLegacy = true;
  console.warn(`[calls-auth] requête sans jeton tolérée (compat) ${req.method} ${req.originalUrl.split('?')[0]}`);
  return next();
}

/** Jeton utilisateur OU jeton de service (scope connu) : écriture d'un appel de centre. */
function userOrServiceAuth(req, res, next) {
  if (!requireAuth()) {
    req.callsLegacy = true;
    return next();
  }
  const secret = process.env.JWT_SECRET;
  if (!secret) return deny(res, 500, 'Authentication is not configured');
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return deny(res, 401, 'Authentication required');
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (decoded.scope) {
      if (typeof decoded.exp !== 'number' || !SERVICE_SCOPES.includes(decoded.scope)) throw new Error('bad scope');
      req.callsService = { scope: decoded.scope, iss: decoded.iss };
      return next();
    }
    const userId = decoded.userId || decoded.id;
    if (!userId) throw new Error('no user in token');
    req.auth = { userId: String(userId), token };
    return next();
  } catch (error) {
    return deny(res, 401, 'Authentication failed');
  }
}

/**
 * Jeton de SERVICE uniquement, scope `call-recording` : rattachement de l'enregistrement d'un appel (orchestrateur).
 * Toujours exigé, même si CALLS_REQUIRE_AUTH=false : cette route écrit sur un appel et n'a aucun appelant historique anonyme.
 */
function callRecordingServiceAuth(req, res, next) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return deny(res, 500, 'Authentication is not configured');
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return deny(res, 401, 'Authentication required');
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (decoded.scope !== 'call-recording' || typeof decoded.exp !== 'number') throw new Error('bad scope');
    req.callsService = { scope: decoded.scope, iss: decoded.iss };
    return next();
  } catch (error) {
    return deny(res, 401, 'Authentication failed');
  }
}

/** Le profil agent du porteur du jeton (le jeton de l'agent porte l'identifiant utilisateur). */
async function ownAgentId(req) {
  if (!req.auth) return null;
  if (req.auth.agentId !== undefined) return req.auth.agentId;
  let id = null;
  try {
    const Agent = require('../models/Agent');
    if (mongoose.Types.ObjectId.isValid(req.auth.userId)) {
      const row = await Agent.findOne({ userId: req.auth.userId }).select('_id').lean();
      id = row ? String(row._id) : null;
    }
  } catch (error) {
    id = null;
  }
  req.auth.agentId = id;
  return id;
}

/** Vrai si le porteur du jeton appartient à ce centre (sinon faux ; l'indisponibilité de la recherche remonte en 503). */
async function belongsToCompany(req, companyId) {
  if (!companyId || !OBJECT_ID.test(String(companyId))) return false;
  try {
    await assertCompanyAccess(req, companyId);
    return true;
  } catch (error) {
    if (error && error.status === 403) return false;
    throw error;
  }
}

/** Périmètre du centre de l'appelant (null si aucun rattachement). */
const callerCompany = (req) => callerCompanyId(req.auth);

/** :companyId dans l'URL (analytics, fraud-stats, rep-transactions) : l'appelant doit appartenir à ce centre. */
function guardCompanyParam(param = 'companyId') {
  return async (req, res, next) => {
    const companyId = req.params[param];
    if (!OBJECT_ID.test(String(companyId || ''))) return deny(res, 400, 'Valid companyId is required');
    if (!req.auth) return next(); // compat sans jeton : voir compatAuth
    try {
      await assertCompanyAccess(req, companyId);
      return next();
    } catch (error) {
      return sendScopeError(res, error);
    }
  };
}

/** GET /calls : jamais de vidage global ; le centre demandé doit être celui de l'appelant. */
async function guardCallsList(req, res, next) {
  const q = req.query || {};
  const scoped = ['companyId', 'userId', 'agentId'].some((k) => typeof q[k] === 'string' && q[k]);
  if (!req.auth) {
    if (!scoped) return deny(res, 401, 'Authentication required');
    for (const k of ['companyId', 'userId', 'agentId']) {
      if (q[k] !== undefined && !OBJECT_ID.test(String(q[k]))) return deny(res, 400, `Invalid ${k}`);
    }
    return next();
  }
  try {
    if (q.companyId) {
      await assertCompanyAccess(req, q.companyId);
      return next();
    }
    if (q.userId && String(q.userId) === req.auth.userId) return next();
    if (q.agentId && String(q.agentId) === (await ownAgentId(req))) return next();
    // Aucun périmètre valable demandé : on cantonne au centre de l'appelant (jamais à tous les centres).
    const mine = await callerCompany(req);
    if (!mine) return deny(res, 403, 'Not allowed for this company');
    req.query = { ...q, companyId: mine };
    return next();
  } catch (error) {
    return sendScopeError(res, error);
  }
}

/** /agent/:agentId : le profil de l'appelant, ou à défaut un membre d'un centre (limité aux appels de son centre). */
function guardAgentParam(options = {}) {
  return async (req, res, next) => {
    const agentId = req.params.agentId;
    if (!OBJECT_ID.test(String(agentId || ''))) return deny(res, 400, 'Valid agentId is required');
    if (!req.auth) return next();
    try {
      if (String(agentId) === (await ownAgentId(req))) return next();
      const mine = await callerCompany(req);
      if (!mine) return deny(res, 403, 'Not allowed for this agent');
      if (options.restrictToCompany) req.callsCompanyScope = mine;
      return next();
    } catch (error) {
      return sendScopeError(res, error);
    }
  };
}

/** /:id : l'appel doit appartenir au centre de l'appelant, ou avoir été pris par son profil agent. */
function guardCallId(options = {}) {
  return async (req, res, next) => {
    const id = req.params.id;
    if (!OBJECT_ID.test(String(id || ''))) return deny(res, 400, 'Valid call id is required');
    if (!req.auth) return next();
    try {
      const { Call } = require('../models/Call');
      const call = await Call.findById(id).select('companyId agent').lean();
      if (!call) return deny(res, 404, 'Call not found');
      if (call.companyId && (await belongsToCompany(req, call.companyId))) return next();
      const mine = await ownAgentId(req);
      if (mine && call.agent && String(call.agent._id || call.agent) === mine && !options.companyOnly) return next();
      return deny(res, 403, 'Not allowed for this call');
    } catch (error) {
      return sendScopeError(res, error);
    }
  };
}

/**
 * Lectures agrégées (/api/analytics, /api/dashboard) : l'entreprise est celle de l'appelant (service d'inscription),
 * jamais un paramètre de la requête. Sans entreprise rattachée : 403.
 */
async function requireCallerCompany(req, res, next) {
  if (!req.auth) return deny(res, 401, 'Authentication required');
  try {
    const mine = await callerCompany(req);
    if (!mine || !OBJECT_ID.test(String(mine))) return deny(res, 403, 'Not allowed for this company');
    req.callerCompanyId = String(mine);
    return next();
  } catch (error) {
    return sendScopeError(res, error);
  }
}

const TWILIO_RECORDING_PATH = /^\/2010-04-01\/Accounts\/(AC[0-9a-f]{32})\/Recordings\/(RE[0-9a-f]{32})(?:\.(?:mp3|wav))?$/i;

/**
 * URL d'un enregistrement Twilio DU compte de la plateforme (https://api.twilio.com/2010-04-01/Accounts/<TWILIO_ACCOUNT_SID>/
 * Recordings/RE…[.mp3|.wav]), sans identifiants, port, requête ni fragment. Renvoie le SID d'enregistrement, ou null.
 * Les identifiants Twilio de la plateforme ne partent ainsi jamais vers un autre hôte ni vers un autre compte.
 */
function twilioRecordingSid(raw) {
  const account = String(process.env.TWILIO_ACCOUNT_SID || '').trim();
  if (!account || typeof raw !== 'string') return null;
  let url;
  try {
    url = new URL(raw);
  } catch (error) {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com' || url.port || url.username || url.password || url.search || url.hash) return null;
  const m = TWILIO_RECORDING_PATH.exec(url.pathname);
  if (!m || m[1] !== account) return null;
  return m[2];
}

/**
 * POST /fetch-recording : l'URL doit être un enregistrement Twilio du compte (400 sinon). Avec un jeton, si un appel connu
 * porte cet enregistrement, l'appelant doit appartenir à son entreprise ou l'avoir pris (403 sinon). Un enregistrement
 * encore sans appel en base (l'espace de travail l'envoie avant /store-call) est admis : son SID n'est pas devinable.
 */
async function guardFetchRecording(req, res, next) {
  const recordingSid = twilioRecordingSid(req.body && req.body.recordingUrl);
  if (!recordingSid) return deny(res, 400, 'recordingUrl must be a Twilio recording of this account');
  if (!req.auth) return next();
  try {
    const { Call } = require('../models/Call');
    const base = `https://api.twilio.com/2010-04-01/Accounts/${String(process.env.TWILIO_ACCOUNT_SID).trim()}/Recordings/${recordingSid}`;
    const call = await Call.findOne({ recording_url: { $in: [base, `${base}.mp3`, `${base}.wav`] } }).select('companyId agent').lean();
    if (!call) return next();
    if (call.companyId && (await belongsToCompany(req, call.companyId))) return next();
    const mine = await ownAgentId(req);
    if (mine && call.agent && String(call.agent._id || call.agent) === mine) return next();
    return deny(res, 403, 'Not allowed for this recording');
  } catch (error) {
    return sendScopeError(res, error);
  }
}

/** Écriture d'un appel de centre : jeton de service, ou utilisateur membre du centre du corps. */
async function guardCenterCallBody(req, res, next) {
  if (req.callsLegacy || req.callsService) return next();
  const companyId = req.body && req.body.companyId;
  try {
    await assertCompanyAccess(req, companyId);
    return next();
  } catch (error) {
    return sendScopeError(res, error);
  }
}

/** POST /calls : le corps ne peut viser qu'un centre de l'appelant (centre par défaut = le sien). */
async function guardCreateCall(req, res, next) {
  if (!req.auth) {
    const companyId = req.body && req.body.companyId;
    if (!companyId || !OBJECT_ID.test(String(companyId))) return deny(res, 401, 'Authentication required');
    return next();
  }
  try {
    req.body = req.body || {};
    if (!req.body.companyId) {
      const mine = await callerCompany(req);
      if (!mine) return deny(res, 403, 'Not allowed for this company');
      req.body.companyId = mine;
    } else {
      await assertCompanyAccess(req, req.body.companyId);
    }
    return next();
  } catch (error) {
    return sendScopeError(res, error);
  }
}


/** Recherche brute par identifiant (chaîne ou ObjectId, comme le reste du service). */
async function findRaw(collection, id, projection) {
  const raw = String(id || '');
  if (!raw) return null;
  const or = [{ _id: raw }];
  if (mongoose.Types.ObjectId.isValid(raw)) or.push({ _id: new mongoose.Types.ObjectId(raw) });
  return mongoose.connection.db.collection(collection).findOne({ $or: or }, { projection });
}

const idOf = (v) => (v && (v.$oid || v._id || v)) ? String(v.$oid || v._id || v) : null;

/** Entreprise d'un gig (champ companyId du gig). null si gig ou entreprise inconnus. */
async function companyOfGig(gigId) {
  const gig = await findRaw('gigs', gigId, { companyId: 1 });
  return gig ? idOf(gig.companyId) : null;
}

/** Entreprise d'un prospect : son companyId, à défaut celui de son gig. `undefined` si le prospect n'existe pas. */
async function companyOfLead(leadId) {
  const lead = await findRaw('leads', leadId, { companyId: 1, gigId: 1 });
  if (!lead) return undefined;
  return idOf(lead.companyId) || (lead.gigId ? await companyOfGig(idOf(lead.gigId)) : null);
}

/**
 * Prospect d'une entreprise (appel IA sortant) : avec un jeton, l'appelant doit appartenir à l'entreprise du prospect ;
 * l'entreprise vérifiée remplace alors celle du corps ou de l'en-tête x-company-id (forgeables).
 * Prospect inconnu : la suite (contrôleur) répond 404.
 */
function guardLeadCompany(pick = (req) => (req.body && req.body.leadId) || req.params.leadId) {
  return async (req, res, next) => {
    if (!req.auth) return next(); // compat sans jeton : voir compatAuth
    const leadId = pick(req);
    if (!leadId) return deny(res, 400, 'leadId is required');
    try {
      const companyId = await companyOfLead(leadId);
      if (companyId === undefined) return next();
      if (!companyId) return deny(res, 403, 'Not allowed for this lead');
      await assertCompanyAccess(req, companyId);
      if (req.body && typeof req.body === 'object') req.body.companyId = companyId;
      req.verifiedCompanyId = companyId;
      return next();
    } catch (error) {
      return sendScopeError(res, error);
    }
  };
}

/** Gig d'une entreprise (:id dans l'URL) : avec un jeton, l'appelant doit appartenir à l'entreprise du gig. */
function guardGigCompany(param = 'id') {
  return async (req, res, next) => {
    if (!req.auth) return next();
    const gigId = req.params[param];
    if (!gigId) return deny(res, 400, 'gigId is required');
    try {
      const gig = await findRaw('gigs', gigId, { companyId: 1 });
      if (!gig) return deny(res, 404, 'Gig not found');
      const companyId = idOf(gig.companyId);
      if (!companyId) return deny(res, 403, 'Not allowed for this gig');
      await assertCompanyAccess(req, companyId);
      return next();
    } catch (error) {
      return sendScopeError(res, error);
    }
  };
}

/**
 * Raccrochage d'un appel IA sortant : avec un jeton, l'appel (callId, ou SID / call_control_id) doit être connu (404 sinon)
 * et appartenir à l'entreprise de l'appelant.
 */
async function guardAiOutboundCall(req, res, next) {
  if (!req.auth) return next();
  const { callId, callControlId } = req.body || {};
  try {
    const { Call } = require('../models/Call');
    let call = null;
    if (callId && OBJECT_ID.test(String(callId))) call = await Call.findById(callId).select('companyId').lean();
    if (!call && callControlId) {
      call = await Call.findOne({ $or: [{ sid: String(callControlId) }, { call_id: String(callControlId) }] }).select('companyId').lean();
    }
    if (!call) return deny(res, 404, 'Call not found');
    if (call.companyId && (await belongsToCompany(req, call.companyId))) return next();
    return deny(res, 403, 'Not allowed for this call');
  } catch (error) {
    return sendScopeError(res, error);
  }
}

const ENROLL_TTL_MS = 60 * 1000;
const enrollCache = new Map();

function matchingOrigin() {
  const explicit = process.env.MATCHING_API_URL;
  const railway = process.env.RAILWAY_SERVICE_V25_MATCHING_BACKEND_URL;
  const raw = (explicit || (railway ? (/^https?:\/\//i.test(railway) ? railway : `https://${railway}`) : '')).replace(/\/+$/, '');
  return raw && !/\/api$/.test(raw) ? `${raw}/api` : raw;
}

/** Le profil rep est-il inscrit (enrolled) au gig ? Même source que l'éligibilité des appels (service de matching). */
async function agentEnrolledInGig(agentId, gigId) {
  const key = `${agentId}:${gigId}`;
  const cached = enrollCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.ok;
  const origin = matchingOrigin();
  if (!origin) {
    console.warn('[callsAccess] MATCHING_API_URL absent : inscription du rep au gig non vérifiable, accès admis');
    return true;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const r = await fetch(`${origin}/gig-agents/agents/${encodeURIComponent(agentId)}/gigs?status=enrolled`, { signal: controller.signal });
    if (!r.ok) throw Object.assign(new Error('Enrollment lookup failed'), { status: 503 });
    const payload = await r.json();
    const gigs = Array.isArray(payload && payload.gigs) ? payload.gigs : [];
    const ok = gigs.some((row) => String((row && row.gig && (row.gig._id || row.gig.$oid)) || (row && row.gigId) || '') === String(gigId));
    enrollCache.set(key, { ok, expires: Date.now() + ENROLL_TTL_MS });
    return ok;
  } catch (error) {
    if (error.status) throw error;
    throw Object.assign(new Error('Enrollment lookup failed'), { status: 503 });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ressource d'une entreprise désignée par la requête (prospect, gig, entreprise, appel) : avec un jeton, l'appelant doit être
 * membre de l'entreprise, ou rep inscrit au gig concerné (pour un appel : le rep qui l'a pris).
 * Sans ressource identifiable dans la requête, ou ressource inconnue (créée ensuite par la route), la requête continue.
 *
 * options : leadId(req), gigId(req), companyId(req), callControlId(req) -> valeurs extraites de la requête.
 */
function guardResourceCompany(options = {}) {
  const pick = (fn, req) => (typeof fn === 'function' ? fn(req) : null);
  return async (req, res, next) => {
    if (!req.auth) return next();
    try {
      const leadId = pick(options.leadId, req);
      let gigId = pick(options.gigId, req);
      let companyId = pick(options.companyId, req);
      if (leadId) {
        const lead = await findRaw('leads', leadId, { companyId: 1, gigId: 1 });
        if (lead) {
          gigId = idOf(lead.gigId) || gigId;
          companyId = idOf(lead.companyId) || (gigId ? await companyOfGig(gigId) : null);
          if (!companyId) return deny(res, 403, 'Not allowed for this lead');
        }
      }
      if (gigId && !companyId) companyId = await companyOfGig(gigId);
      const callControlId = pick(options.callControlId, req);
      if (!companyId && callControlId) {
        const { Call } = require('../models/Call');
        const call = await Call.findOne({ $or: [{ sid: String(callControlId) }, { call_id: String(callControlId) }] })
          .select('companyId agent gigId')
          .lean();
        if (call) {
          if (call.companyId && (await belongsToCompany(req, call.companyId))) return next();
          const mine = await ownAgentId(req);
          if (mine && call.agent && String(call.agent._id || call.agent) === mine) return next();
          return deny(res, 403, 'Not allowed for this call');
        }
      }
      if (!companyId) return next();
      if (await belongsToCompany(req, companyId)) return next();
      const agentId = await ownAgentId(req);
      if (agentId && gigId && (await agentEnrolledInGig(agentId, gigId))) return next();
      // Rep sans gig identifiable : l'entreprise seule ne permet pas de vérifier son inscription (admis, journalisé).
      if (agentId && !gigId) {
        console.warn(`[callsAccess] rep ${agentId} sur l'entreprise ${companyId} sans gig : inscription non vérifiable`);
        return next();
      }
      return deny(res, 403, 'Not allowed for this company');
    } catch (error) {
      return sendScopeError(res, error);
    }
  };
}

function clearEnrollCache() {
  enrollCache.clear();
}

module.exports = {
  strictAuth,
  compatAuth,
  userOrServiceAuth,
  callRecordingServiceAuth,
  guardCompanyParam,
  guardCallsList,
  guardAgentParam,
  guardCallId,
  guardCenterCallBody,
  requireCallerCompany,
  guardFetchRecording,
  twilioRecordingSid,
  guardCreateCall,
  guardLeadCompany,
  guardGigCompany,
  guardAiOutboundCall,
  guardResourceCompany,
  clearEnrollCache,
  companyOfLead,
  companyOfGig,
  requireAuth,
  legacyAnon,
};
