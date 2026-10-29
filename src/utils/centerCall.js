const mongoose = require('mongoose');

const STATUSES = new Set(['completed', 'no-answer', 'busy', 'failed', 'canceled', 'rejected']);
const ROLES = new Set(['member', 'agent']);

const objectId = (v) => (v && mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null);
const dateOr = (v, fallback) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : fallback;
};

/**
 * Appel géré depuis le portail du centre (un membre ou un agent qui décroche dans son navigateur) ou appel de test :
 * valide le corps reçu et le met au format de la collection `calls`. Lève une Error(message) si le corps est inexploitable.
 */
function buildCenterCall(body = {}) {
  const sid = String(body.sid || '').trim();
  if (!sid) throw new Error('sid requis');
  const companyId = objectId(body.companyId);
  if (!companyId) throw new Error('companyId invalide');
  const isTest = body.isTest === true;
  const handler = body.handledBy || {};
  const handlerId = objectId(handler.userId);
  const handlerName = String(handler.name || '').trim();
  if (!handlerId || !handlerName) throw new Error('handledBy (userId, name) requis');
  const direction = String(body.direction || '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
  const status = STATUSES.has(String(body.status)) ? String(body.status) : 'completed';
  const endTime = dateOr(body.endTime, new Date());
  const startTime = dateOr(body.startTime, endTime);
  const duration = Math.max(0, Math.round(Number(body.duration) || 0));

  const doc = {
    sid,
    provider: 'twilio',
    direction,
    from: body.from ? String(body.from) : null,
    to: body.to ? String(body.to) : null,
    status,
    duration,
    startTime,
    endTime,
    companyId,
    gigId: objectId(body.gigId) || undefined,
    userId: handlerId,
    handledBy: { userId: handlerId, name: handlerName, role: ROLES.has(handler.role) ? handler.role : 'member' },
    isTest,
    source: 'center_portal',
  };
  if (status !== 'completed' || duration === 0) {
    doc.callOutcome = 'no_answer';
    doc.callOutcomeSource = 'system';
  }
  return doc;
}

module.exports = { buildCenterCall };
