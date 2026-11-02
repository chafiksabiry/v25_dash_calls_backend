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

module.exports = {
  strictAuth,
  compatAuth,
  userOrServiceAuth,
  guardCompanyParam,
  guardCallsList,
  guardAgentParam,
  guardCallId,
  guardCenterCallBody,
  guardCreateCall,
  requireAuth,
  legacyAnon,
};
