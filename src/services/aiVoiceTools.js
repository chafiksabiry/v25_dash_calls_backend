const mongoose = require('mongoose');
const { Lead } = require('../models/Lead');
const { Call } = require('../models/Call');

/**
 * Tool definitions for the company AI outbound voice worker
 * (OpenAI Realtime or Gemini Live functionDeclarations).
 * Business logic reuses existing Mongo models (no duplicated CRM services).
 */
function buildRealtimeTools() {
  return [
    {
      type: 'function',
      name: 'search_knowledge',
      description:
        "Search the company's knowledge base (offers, prices, conditions, objection handling, legal mentions) for the gig of this call. " +
        'Call it BEFORE answering any factual question about the product, price, conditions or rules. If nothing is found, say you will have an advisor call back — never invent.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "The lead's question, in the lead's words (short)" },
        },
        required: ['query'],
      },
    },
    {
      type: 'function',
      name: 'lookup_lead',
      description: 'Lookup the current lead profile by leadId (phone, email, stage, notes).',
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string', description: 'Mongo lead id' },
        },
        required: ['leadId'],
      },
    },
    {
      type: 'function',
      name: 'add_call_note',
      description: 'Append a note on the active call record.',
      parameters: {
        type: 'object',
        properties: {
          callId: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['callId', 'note'],
      },
    },
    {
      type: 'function',
      name: 'schedule_callback',
      description: 'Schedule a callback datetime on the call (ISO 8601).',
      parameters: {
        type: 'object',
        properties: {
          callId: { type: 'string' },
          callbackAt: { type: 'string', description: 'ISO datetime' },
        },
        required: ['callId', 'callbackAt'],
      },
    },
    {
      type: 'function',
      name: 'schedule_appointment',
      description: 'Schedule an appointment datetime on the call (ISO 8601).',
      parameters: {
        type: 'object',
        properties: {
          callId: { type: 'string' },
          appointmentAt: { type: 'string', description: 'ISO datetime' },
        },
        required: ['callId', 'appointmentAt'],
      },
    },
    {
      type: 'function',
      name: 'update_lead_stage',
      description: 'Update the lead pipeline Stage (e.g. New, RDV, Callback).',
      parameters: {
        type: 'object',
        properties: {
          leadId: { type: 'string' },
          stage: { type: 'string' },
        },
        required: ['leadId', 'stage'],
      },
    },
  ];
}

const KNOWLEDGEBASE_API_URL = (
  process.env.KNOWLEDGEBASE_API_URL ||
  'https://v25knowledgebasebackend-production.up.railway.app/api'
).replace(/\/$/, '');
/** A live call cannot wait: beyond this the agent answers without the knowledge base. */
const KNOWLEDGE_SEARCH_TIMEOUT_MS = 4000;

async function searchKnowledge(query, { gigId, companyId }) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: 'query required' };
  if (!companyId) return { ok: false, error: 'no company context for this call' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), KNOWLEDGE_SEARCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${KNOWLEDGEBASE_API_URL}/rag/agent-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companyId: String(companyId), gigId: gigId ? String(gigId) : undefined, query: q, topK: 3 }),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, error: `knowledge base unavailable (${res.status})` };
    const payload = await res.json();
    const passages = (payload?.data?.passages || []).map((p) => ({ source: p.title, text: p.content }));
    if (passages.length === 0) {
      return { ok: true, found: false, note: 'Nothing in the knowledge base about this. Do not answer from memory: offer an advisor callback.' };
    }
    return { ok: true, found: true, passages, note: 'Answer only from these passages, in one or two short sentences.' };
  } catch (err) {
    return { ok: false, error: err?.name === 'AbortError' ? 'knowledge base timeout' : String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

async function executeVoiceTool(name, args, { defaultLeadId, defaultCallId, gigId, companyId } = {}) {
  switch (name) {
    case 'search_knowledge':
      return searchKnowledge(args && args.query, { gigId, companyId });
    case 'lookup_lead': {
      const leadId = args.leadId || defaultLeadId;
      if (!leadId || !mongoose.Types.ObjectId.isValid(leadId)) {
        return { ok: false, error: 'invalid leadId' };
      }
      const lead = await Lead.findById(leadId).lean();
      if (!lead) return { ok: false, error: 'lead not found' };
      return {
        ok: true,
        lead: {
          id: String(lead._id),
          name: lead.Deal_Name || `${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim(),
          phone: lead.Phone || lead.phone,
          email: lead.Email_1 || lead.email,
          stage: lead.Stage,
          pipeline: lead.Pipeline,
          notes: lead.notes || null,
          gigId: lead.gigId ? String(lead.gigId) : null,
        },
      };
    }
    case 'add_call_note': {
      const callId = args.callId || defaultCallId;
      if (!callId) return { ok: false, error: 'callId required' };
      const call = await Call.findById(callId);
      if (!call) return { ok: false, error: 'call not found' };
      const prev = call.notes ? `${call.notes}\n` : '';
      call.notes = `${prev}${args.note || ''}`.trim();
      await call.save();
      return { ok: true };
    }
    case 'schedule_callback': {
      const callId = args.callId || defaultCallId;
      const call = await Call.findById(callId);
      if (!call) return { ok: false, error: 'call not found' };
      call.callbackAt = new Date(args.callbackAt);
      await call.save();
      return { ok: true, callbackAt: call.callbackAt };
    }
    case 'schedule_appointment': {
      const callId = args.callId || defaultCallId;
      const call = await Call.findById(callId);
      if (!call) return { ok: false, error: 'call not found' };
      call.appointmentAt = new Date(args.appointmentAt);
      await call.save();
      return { ok: true, appointmentAt: call.appointmentAt };
    }
    case 'update_lead_stage': {
      const leadId = args.leadId || defaultLeadId;
      if (!leadId || !mongoose.Types.ObjectId.isValid(leadId)) {
        return { ok: false, error: 'invalid leadId' };
      }
      await Lead.findByIdAndUpdate(leadId, { Stage: args.stage });
      return { ok: true, stage: args.stage };
    }
    default:
      return { ok: false, error: `unknown tool ${name}` };
  }
}

module.exports = { buildRealtimeTools, executeVoiceTool };
