const crypto = require('crypto');

/**
 * Vérification de signature des webhooks opérateurs (agent vocal IA sortant).
 *
 *  - Twilio : en-tête `X-Twilio-Signature` (HMAC-SHA1 de l'URL complète + paramètres POST), clé = TWILIO_AUTH_TOKEN.
 *  - Telnyx : en-têtes `telnyx-signature-ed25519` + `telnyx-timestamp`, signature Ed25519 de `${timestamp}|${corps brut}`,
 *    clé publique du compte = TELNYX_PUBLIC_KEY (base64, portail Telnyx > Keys & Credentials > Public Key).
 *    Horodatage accepté à ±5 min (anti-rejeu).
 *
 * WEBHOOK_SIGNATURE_MODE=log : la signature invalide est journalisée mais tolérée (secours le temps de configurer les clés).
 * Défaut : appliqué. Clé absente en mode appliqué => 503 (fermé par défaut).
 */

const TELNYX_TOLERANCE_S = 300;
// Préfixe DER SubjectPublicKeyInfo d'une clé Ed25519 brute de 32 octets.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const logOnly = () => String(process.env.WEBHOOK_SIGNATURE_MODE || '').trim().toLowerCase() === 'log';

/** À passer à express.json({ verify }) : conserve le corps brut, nécessaire à la vérification Telnyx. */
function captureRawBody(req, _res, buf) {
  req.rawBody = buf;
}

function reject(req, res, next, provider, reason, status = 403) {
  if (logOnly()) {
    console.warn(`[webhookSignature] ${provider} ${reason} on ${req.originalUrl.split('?')[0]} (tolerated: WEBHOOK_SIGNATURE_MODE=log)`);
    return next();
  }
  console.warn(`[webhookSignature] ${provider} ${reason} on ${req.originalUrl.split('?')[0]}: rejected`);
  return res.status(status).json({ success: false, message: 'Invalid webhook signature' });
}

/** URL publique telle que Twilio l'a appelée (même base que celle utilisée pour construire les callbacks). */
function publicUrl(req) {
  const fromEnv = process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
  const base = fromEnv
    ? fromEnv.replace(/\/$/, '')
    : `${req.get('x-forwarded-proto') || req.protocol || 'https'}://${req.get('host')}`;
  return `${base}${req.originalUrl}`;
}

function verifyTwilioSignature(req, res, next) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return reject(req, res, next, 'twilio', 'TWILIO_AUTH_TOKEN not configured', 503);
  const signature = req.get('x-twilio-signature');
  if (!signature) return reject(req, res, next, 'twilio', 'missing signature');
  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  const ok = twilio.validateRequest(authToken, signature, publicUrl(req), req.body || {});
  if (!ok) return reject(req, res, next, 'twilio', 'bad signature');
  return next();
}

function telnyxPublicKey() {
  const raw = String(process.env.TELNYX_PUBLIC_KEY || '').trim();
  if (!raw) return null;
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.length !== 32) return null;
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, bytes]), format: 'der', type: 'spki' });
}

function verifyTelnyxSignature(req, res, next) {
  let key;
  try { key = telnyxPublicKey(); } catch (_e) { key = null; }
  if (!key) return reject(req, res, next, 'telnyx', 'TELNYX_PUBLIC_KEY missing or invalid', 503);
  const signature = req.get('telnyx-signature-ed25519');
  const timestamp = req.get('telnyx-timestamp');
  if (!signature || !timestamp || !Buffer.isBuffer(req.rawBody)) return reject(req, res, next, 'telnyx', 'missing signature');
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > TELNYX_TOLERANCE_S) {
    return reject(req, res, next, 'telnyx', 'stale timestamp');
  }
  let ok = false;
  try {
    const payload = Buffer.concat([Buffer.from(`${timestamp}|`), req.rawBody]);
    ok = crypto.verify(null, payload, key, Buffer.from(signature, 'base64'));
  } catch (_e) {
    ok = false;
  }
  if (!ok) return reject(req, res, next, 'telnyx', 'bad signature');
  return next();
}

module.exports = { captureRawBody, verifyTwilioSignature, verifyTelnyxSignature };
