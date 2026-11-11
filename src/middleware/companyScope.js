const jwt = require('jsonwebtoken');

/**
 * Authentication + company scoping for the company-facing routes.
 *
 *  - authenticateUser: requires a valid JWT issued by v25_registration_backend (claim `userId`).
 *    JWT_SECRET must be set: there is deliberately no fallback secret.
 *  - assertCompanyAccess: the caller must belong to the company they act on. The company of a user (owner or
 *    team member) is resolved by v25_registration_backend (`GET /api/company-members/me`), the source of truth.
 *
 * COMPANY_SCOPE_MODE=log turns the company check into a warning (escape hatch if the lookup misbehaves);
 * authentication stays enforced. Default: enforce.
 */

const LOOKUP_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 60 * 1000;
const companyByUser = new Map();

class ScopeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function registrationOrigin() {
  const explicit = process.env.REGISTRATION_BACKEND_URL;
  const railway = process.env.RAILWAY_SERVICE_V25_REGISTRATION_BACKEND_URL;
  const raw = explicit || (railway ? (/^https?:\/\//i.test(railway) ? railway : `https://${railway}`) : '');
  return raw.replace(/\/+$/, '').replace(/\/api$/, '');
}

function bearerToken(req) {
  const header = req.headers && req.headers.authorization;
  return header && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function authenticateUser(req, res, next) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    console.error('[companyScope] JWT_SECRET is not set: refusing every protected request');
    return res.status(500).json({ success: false, message: 'Authentication is not configured' });
  }
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });
  try {
    const decoded = jwt.verify(token, secret);
    const userId = decoded.userId || decoded.id;
    if (!userId) throw new Error('no user in token');
    req.auth = { userId: String(userId), token };
    return next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Authentication failed' });
  }
}

async function callerCompanyId(auth) {
  const cached = companyByUser.get(auth.userId);
  if (cached && cached.expires > Date.now()) return cached.companyId;

  const origin = registrationOrigin();
  if (!origin) throw new ScopeError(503, 'Company lookup is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/company-members/me?userId=${encodeURIComponent(auth.userId)}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new ScopeError(503, 'Company lookup failed');
    const payload = await res.json();
    const companyId = payload && payload.data && payload.data.companyId ? String(payload.data.companyId) : null;
    companyByUser.set(auth.userId, { companyId, expires: Date.now() + CACHE_TTL_MS });
    return companyId;
  } catch (error) {
    if (error instanceof ScopeError) throw error;
    throw new ScopeError(503, 'Company lookup failed');
  } finally {
    clearTimeout(timer);
  }
}

/** Throws a ScopeError unless the authenticated caller belongs to `companyId`. */
async function assertCompanyAccess(req, companyId) {
  if (!req.auth) throw new ScopeError(401, 'Authentication required');
  const mine = await callerCompanyId(req.auth);
  if (mine && companyId && String(mine) === String(companyId)) return;
  if (String(process.env.COMPANY_SCOPE_MODE || '').toLowerCase() === 'log') {
    console.warn(`[companyScope] would deny user ${req.auth.userId} (company ${mine}) on company ${companyId}`);
    return;
  }
  throw new ScopeError(403, 'Not allowed for this company');
}

function clearCompanyCache() {
  companyByUser.clear();
}

/**
 * Portée d'un contact client (portail en lecture seule). Lue chez le service d'inscription (source de vérité) avec le
 * jeton de la personne, à chaque requête, sans cache : un accès retiré cesse de fonctionner aussitôt. Fermé par défaut :
 * tout ce qui n'est pas explicitement un accès client actif renvoie 403. L'identité vient du jeton, jamais de la requête.
 */
async function clientScope(auth) {
  const origin = registrationOrigin();
  if (!origin) throw new ScopeError(503, 'Client lookup is not configured');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetch(`${origin}/api/company-members/me?userId=${encodeURIComponent(auth.userId)}`, {
      headers: { Authorization: `Bearer ${auth.token}` },
      signal: controller.signal,
    });
    if (!res.ok) throw new ScopeError(503, 'Client lookup failed');
    const payload = await res.json();
    const data = payload && payload.data;
    const client = data && data.isClient === true && data.isOwner !== true ? data.client : null;
    if (!client || !client.id || !Array.isArray(client.gigIds)) throw new ScopeError(403, 'Not a client portal account');
    return {
      clientId: String(client.id),
      clientName: String(client.name || ''),
      gigIds: client.gigIds.map(String).filter((id) => /^[a-f0-9]{24}$/i.test(id)),
      allowRecordings: client.allowRecordings === true && data.permissions && data.permissions['calls.listen'] === true,
      branding: client.branding || null,
    };
  } catch (error) {
    if (error instanceof ScopeError) throw error;
    throw new ScopeError(503, 'Client lookup failed');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { authenticateUser, assertCompanyAccess, callerCompanyId, clientScope, ScopeError, clearCompanyCache };
