const express = require('express');
const jwt = require('jsonwebtoken');
const { createInboundSession, SessionError, activeInboundSessions } = require('../services/aiInboundService');

/**
 * API interne du pilote agent IA entrant : l'orchestrateur crée une session pour un appel Twilio entrant.
 * Jeton de service HS256 de portée `ai-inbound` (secret partagé JWT_SECRET), expiration obligatoire, jamais un jeton utilisateur.
 */
const SCOPE = 'ai-inbound';
const router = express.Router();

function authenticateAiInbound(req, res, next) {
  const secret = process.env.JWT_SECRET;
  if (!secret) return res.status(500).json({ success: false, code: 'auth_not_configured' });
  const h = req.headers && req.headers.authorization;
  const token = h && h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  try {
    const d = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof d.exp !== 'number' || d.scope !== SCOPE || d.userId || d.id) throw new Error('bad token');
    return next();
  } catch (_e) {
    return res.status(401).json({ success: false, code: 'invalid_service_token', message: 'Jeton de service invalide ou expiré.' });
  }
}

const wsBaseOf = (req) => {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto === 'http' ? 'ws' : 'wss'}://${req.get('host')}`;
};

router.use(authenticateAiInbound);

router.post('/sessions', async (req, res) => {
  try {
    const out = await createInboundSession(req.body || {}, { publicWsBase: wsBaseOf(req) });
    res.status(201).json(out);
  } catch (err) {
    if (err instanceof SessionError) return res.status(err.status).json({ success: false, code: err.code, message: err.message });
    console.error('[AiInbound] création de session :', err?.message || err);
    return res.status(503).json({ success: false, code: 'engine_unavailable', message: 'Session IA indisponible.' });
  }
});

router.get('/health', (_req, res) => res.json({ success: true, activeSessions: activeInboundSessions() }));

module.exports = router;
module.exports.authenticateAiInbound = authenticateAiInbound;
