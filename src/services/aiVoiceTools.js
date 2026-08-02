const mongoose = require('mongoose');
const { Lead } = require('../models/Lead');
const { Call } = require('../models/Call');

/**
 * Tool definitions exposed to OpenAI Realtime for company AI outbound calls.
 * Business logic reuses existing Mongo models (no duplicated CRM services).
 */
function buildRealtimeTools() {
  return [
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

async function executeVoiceTool(name, args, { defaultLeadId, defaultCallId } = {}) {
  switch (name) {
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
