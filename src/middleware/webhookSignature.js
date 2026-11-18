const crypto = require('crypto');
const twilio = require('twilio');

/**
 * Signature des webhooks Twilio et Telnyx (routes publiques, appelées par l'opérateur et non par un utilisateur).
 *
 *  - Twilio : en-tête `X-Twilio-Signature`, calculé sur l'URL PUBLIQUE exacte appelée et les paramètres POST, avec
 *    TWILIO_AUTH_TOKEN. L'URL est reconstruite depuis PUBLIC_BASE_URL (à défaut BASE_URL), les mêmes variables que celles qui
 *    servent à donner les adresses de rappel à Twilio, plus le chemin et la requête reçus.
 *  - Telnyx : en-têtes `telnyx-signature-ed25519` et `telnyx-timestamp`, signature Ed25519 de `${timestamp}|${corps brut}`
 *    avec la clé publique du compte (TELNYX_PUBLIC_KEY, base64, portail Telnyx > Keys & Credentials > Public Key).
 *    Horodatage accepté à 5 minutes près (rejeu).
 *
 * WEBHOOK_SIGNATURE_MODE :
 *  - `log` (défaut) : la signature est vérifiée et chaque échec est journalisé, mais la requête passe. Permet de vérifier en
 *    recette que les adresses et la clé sont justes sans couper les appels.
 *  - `enforce` : une signature absente, fausse ou invérifiable (variable manquante) renvoie 403.
 */

const TOLERANCE_SECONDS = 300;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const enforce = (env = process.env) => String(env.WEBHOOK_SIGNATURE_MODE || '').trim().toLowerCase() === 'enforce';

function publicOrigin(env = process.env) {
  const raw = String(env.PUBLIC_BASE_URL || env.BASE_URL || '').trim().replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s]+/i.test(raw)) return '';
  try {
    return new URL(raw).origin;
  } catch (error) {
    return '';
  }
}

/** @returns {{ ok: boolean, reason?: string }} */
function verifyTwilio(req, env = process.env) {
  const authToken = env.TWILIO_AUTH_TOKEN;
  const origin = publicOrigin(env);
  const signature = req.headers && req.headers['x-twilio-signature'];
  if (!authToken) return { ok: false, reason: 'TWILIO_AUTH_TOKEN absent' };
  if (!origin) return { ok: false, reason: 'PUBLIC_BASE_URL (ou BASE_URL) absent ou non https' };
  if (!signature) return { ok: false, reason: 'signature absente' };
  try {
    const url = `${origin}${req.originalUrl || req.url || ''}`;
    const params = req.method === 'GET' ? {} : req.body || {};
    return twilio.validateRequest(String(authToken), String(signature), url, params)
      ? { ok: true }
      : { ok: false, reason: 'signature invalide' };
  } catch (error) {
    return { ok: false, reason: 'signature invérifiable' };
  }
}

/** @returns {{ ok: boolean, reason?: string }} */
function verifyTelnyx(req, env = process.env, nowSeconds = Math.floor(Date.now() / 1000)) {
  const publicKey = String(env.TELNYX_PUBLIC_KEY || '').trim();
  const signature = req.headers && req.headers['telnyx-signature-ed25519'];
  const timestamp = req.headers && req.headers['telnyx-timestamp'];
  if (!publicKey) return { ok: false, reason: 'TELNYX_PUBLIC_KEY absent' };
  if (!signature || !timestamp) return { ok: false, reason: 'signature absente' };
  if (!/^\d+$/.test(String(timestamp)) || Math.abs(nowSeconds - Number(timestamp)) > TOLERANCE_SECONDS) {
    return { ok: false, reason: 'horodatage hors délai' };
  }
  try {
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(JSON.stringify(req.body || {}));
    const keyBytes = Buffer.from(publicKey, 'base64');
    if (keyBytes.length !== 32) return { ok: false, reason: 'TELNYX_PUBLIC_KEY invalide' };
    const key = crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, keyBytes]), format: 'der', type: 'spki' });
    const signed = Buffer.concat([Buffer.from(`${timestamp}|`), raw]);
    return crypto.verify(null, signed, key, Buffer.from(String(signature), 'base64'))
      ? { ok: true }
      : { ok: false, reason: 'signature invalide' };
  } catch (error) {
    return { ok: false, reason: 'signature invérifiable' };
  }
}

function guard(provider, verify) {
  return (req, res, next) => {
    const result = verify(req);
    if (result.ok) return next();
    const path = String(req.originalUrl || req.url || '').split('?')[0];
    if (enforce()) {
      console.warn(`[webhook-signature] ${provider} refusé (${result.reason}) ${req.method} ${path}`);
      return res.status(403).json({ success: false, message: 'Invalid webhook signature' });
    }
    console.warn(`[webhook-signature] ${provider} non vérifié (${result.reason}), toléré (WEBHOOK_SIGNATURE_MODE=log) ${req.method} ${path}`);
    return next();
  };
}

const twilioWebhook = guard('Twilio', (req) => verifyTwilio(req));
const telnyxWebhook = guard('Telnyx', (req) => verifyTelnyx(req));

module.exports = { twilioWebhook, telnyxWebhook, verifyTwilio, verifyTelnyx, publicOrigin };
