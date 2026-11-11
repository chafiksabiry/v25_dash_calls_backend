const crypto = require('node:crypto');

/**
 * Pushes a company notification (fraud detected on a call…) to comporchestrator_back for the header bell.
 * Fire-and-forget: it must never break the call analysis.
 */
const COMPORCHESTRATOR_API_URL = (
  process.env.COMPORCHESTRATOR_API_URL || 'https://v25comporchestratorback-production.up.railway.app/api'
).replace(/\/$/, '');

const b64url = (input) => Buffer.from(input).toString('base64url');

/** Short-lived HS256 JWT (scope `company-notify`) signed with the secret shared by all services. */
function signServiceToken(secret = process.env.JWT_SECRET) {
  if (!secret) return null;
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(JSON.stringify({ scope: 'company-notify', iss: 'dash-calls-backend', iat: now, exp: now + 120 }));
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/**
 * Id of a value that may be a string, an ObjectId or a populated document. An ObjectId must be read with
 * toHexString(): Mongoose gives it an `_id` getter that returns itself, so following `_id` never ends.
 */
const idOf = (value, depth = 0) => {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (value.$oid) return String(value.$oid);
  const inner = value._id ?? value.id;
  return inner && inner !== value && depth < 3 ? idOf(inner, depth + 1) : '';
};

/** @param {{ call: object, callId: string, fraudScore?: number }} input */
async function notifyCompanyOfFraud({ call, callId, fraudScore }) {
  try {
    const companyId = idOf(call?.companyId) || idOf(call?.lead?.gigId?.companyId) || idOf(call?.lead?.companyId);
    const gigId = idOf(call?.gigId) || idOf(call?.lead?.gigId);
    const token = signServiceToken();
    if (!companyId || !callId || !token) {
      console.warn(`[CompanyNotification] fraud skipped (companyId=${companyId || 'none'}, callId=${callId || 'none'}, token=${token ? 'ok' : 'missing JWT_SECRET'})`);
      return null;
    }
    const res = await fetch(`${COMPORCHESTRATOR_API_URL}/internal/company-notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        companyId,
        key: `fraud-call-${callId}`,
        kind: 'fraud',
        title: 'Fraude détectée sur un appel',
        message: `L'analyse IA a signalé un appel comme frauduleux${
          Number.isFinite(fraudScore) ? ` (score de confiance ${Math.round(fraudScore)}/100)` : ''
        }. Aucune commission n'est versée pour cet appel.`,
        gigId: gigId || undefined,
        actionPath: '/dashboard/calls',
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error(`[CompanyNotification] fraud rejected by the orchestrator: HTTP ${res.status}`);
    return res.ok;
  } catch (err) {
    console.error('[CompanyNotification] fraud push failed', err?.message || err);
    return null;
  }
}

module.exports = { notifyCompanyOfFraud, signServiceToken };
