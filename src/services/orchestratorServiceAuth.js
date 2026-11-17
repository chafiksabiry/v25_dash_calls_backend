const jwt = require('jsonwebtoken');

/**
 * Identité de service pour les appels serveur à serveur vers comporchestrator_back.
 *
 *  - Routes /api/escrow/* (rapprochement, évènements d'analyse) : JWT HS256 court (120 s) signé avec le secret partagé JWT_SECRET,
 *    portant une `scope` et aucun `userId` (même modèle que /internal/call-ended et /internal/company-notifications).
 *  - POST /api/tokens-company/charge-usage : clé de service dans l'en-tête `x-service-key` (TOKENS_SERVICE_KEY).
 *
 * Sans secret configuré, aucun en-tête n'est ajouté (jamais de secret par défaut) : l'appel part comme avant. Tant que
 * l'orchestrateur n'exige pas ces identités, les envoyer est sans effet.
 */
const ESCROW_RECONCILE_SCOPE = 'escrow-reconcile';
const CALL_ANALYSIS_NOTIFY_SCOPE = 'call-analysis-notify';

/** @returns {string|null} un JWT de service de la portée donnée, ou null si JWT_SECRET est absent. */
function signServiceToken(scope, secret = process.env.JWT_SECRET) {
  if (!secret || !scope) return null;
  return jwt.sign({ scope }, secret, { algorithm: 'HS256', expiresIn: 120 });
}

/** En-têtes `extra` complétés de `Authorization: Bearer <jwt de service>` quand le secret est configuré. */
function serviceAuthHeaders(scope, extra = {}, env = process.env) {
  const token = signServiceToken(scope, env.JWT_SECRET);
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

/** En-têtes `extra` complétés de `x-service-key` quand TOKENS_SERVICE_KEY est configurée. */
function tokensServiceHeaders(extra = {}, env = process.env) {
  const key = env.TOKENS_SERVICE_KEY;
  return key ? { ...extra, 'x-service-key': key } : { ...extra };
}

module.exports = {
  ESCROW_RECONCILE_SCOPE,
  CALL_ANALYSIS_NOTIFY_SCOPE,
  signServiceToken,
  serviceAuthHeaders,
  tokensServiceHeaders,
};
