const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

/**
 * Signale à l'orchestrateur qu'un appel vient de se terminer (journal CRM du centre, webhooks sortants).
 * Jamais bloquant : appelé sans `await`, ne lève jamais, délai court. Si le centre n'a ni CRM ni webhook (ou pas le
 * forfait), l'orchestrateur ne fait rien.
 */
const SCOPE = 'call-ended';

function orchestratorBase(env = process.env) {
  const raw = String(env.COMPORCHESTRATOR_API_URL || 'https://v25comporchestratorback-production.up.railway.app/api').replace(/\/+$/, '');
  return /\/api$/i.test(raw) ? raw : `${raw}/api`;
}

const id = (v) => (v && mongoose.Types.ObjectId.isValid(String(v)) ? String(v) : null);

/** Corps envoyé à l'orchestrateur, ou null si l'appel n'appartient à aucun centre. `lead` : fiche prospect facultative. */
function buildCallEndedPayload(call, lead = null) {
  const c = call && typeof call.toObject === 'function' ? call.toObject() : call || {};
  const companyId = id(c.companyId);
  if (!companyId || !c.sid) return null;
  const name = (lead && (lead.name || '')) || '';
  const [first, ...rest] = String(name).split(' ');
  return {
    companyId,
    call: {
      sid: String(c.sid),
      direction: c.direction || 'outbound',
      status: c.status || 'completed',
      from: c.from || null,
      to: c.to || null,
      duration: Number(c.duration) || 0,
      startTime: c.startTime ? new Date(c.startTime).toISOString() : null,
      endTime: c.endTime ? new Date(c.endTime).toISOString() : null,
      gigId: id(c.gigId),
      isTest: c.isTest === true,
      handledByName: (c.handledBy && c.handledBy.name) || null,
      contact: lead ? {
        firstName: lead.First_Name || first || '',
        lastName: lead.Last_Name || rest.join(' ') || '',
        email: lead.Email_1 || lead.email || '',
        phone: lead.Phone || lead.phone || '',
      } : undefined,
    },
  };
}

async function notifyCallEnded(call, { fetchImpl = global.fetch, env = process.env, findLead } = {}) {
  try {
    if (!env.JWT_SECRET || typeof fetchImpl !== 'function') return false;
    const c = call && typeof call.toObject === 'function' ? call.toObject() : call || {};
    if (c.isTest || c.status === 'no-answer') return false;
    let lead = null;
    const leadId = id(c.lead);
    if (leadId && findLead) lead = await findLead(leadId).catch(() => null);
    const body = buildCallEndedPayload(c, lead);
    if (!body) return false;
    const token = jwt.sign({ scope: SCOPE }, env.JWT_SECRET, { algorithm: 'HS256', issuer: 'dash-calls', expiresIn: 120 });
    const res = await fetchImpl(`${orchestratorBase(env)}/internal/call-ended`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    return res.ok;
  } catch (e) {
    console.warn('[call-ended] orchestrateur non prévenu:', e.message);
    return false;
  }
}

/** Version branchée sur la collection des prospects. */
function notifyCallEndedInBackground(call) {
  const { Lead } = require('../models/Lead');
  notifyCallEnded(call, { findLead: (leadId) => Lead.findById(leadId).lean() }).catch(() => {});
}

module.exports = { notifyCallEnded, notifyCallEndedInBackground, buildCallEndedPayload, SCOPE };
