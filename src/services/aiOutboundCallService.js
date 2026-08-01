const mongoose = require('mongoose');
// Prefer native fetch (Node 18+); fall back to node-fetch when present in Docker image.
const fetch =
  global.fetch ||
  ((...args) => {
    // eslint-disable-next-line global-require
    return require('node-fetch')(...args);
  });
const { Lead } = require('../models/Lead');
const { Call } = require('../models/Call');
const Gig = require('../models/Gig');
const { resolveActiveLineForGig } = require('../utils/resolveGigPhoneLine');
const { OpenAIRealtimeService } = require('./integrations/openaiRealtimeService');
const { buildRealtimeTools, executeVoiceTool } = require('./aiVoiceTools');

const activeSessions = new Map(); // callControlId -> session ctx

function telnyxHeaders() {
  const apiKey = process.env.TELNYX_API_KEY;
  if (!apiKey) throw new Error('TELNYX_API_KEY is not configured');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function telnyxPost(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: telnyxHeaders(),
    body: JSON.stringify(body || {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return { status: res.status, data };
}

function publicBaseUrl(req) {
  const fromEnv = process.env.PUBLIC_BASE_URL || process.env.BASE_URL;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto}://${req.get('host')}`.replace(/\/$/, '');
}

function publicWsBase(req) {
  const httpBase = publicBaseUrl(req);
  return httpBase.replace(/^http/, 'ws');
}

async function loadGigVoiceAssistant(gigId) {
  if (!gigId) return null;
  const gigIdStr = String(gigId);
  const orId = [{ _id: gigIdStr }];
  if (mongoose.Types.ObjectId.isValid(gigIdStr)) {
    orId.push({ _id: new mongoose.Types.ObjectId(gigIdStr) });
  }

  // Prefer raw collection — dash_calls may only store a stub gig for voice config.
  const raw = await mongoose.connection.db.collection('gigs').findOne({ $or: orId });
  if (raw?.voiceAssistant) return raw.voiceAssistant;

  const cfg = await mongoose.connection.db
    .collection('gig_voice_assistants')
    .findOne({ gigId: gigIdStr });
  if (cfg) return cfg;

  const gig = await Gig.findById(gigIdStr).lean();
  return gig?.voiceAssistant || null;
}

function buildInstructions(voiceAssistant, lead, gig) {
  const custom = voiceAssistant?.systemPrompt || voiceAssistant?.prompt || '';
  const scriptHint = gig?.description ? `\nGig context:\n${gig.description}` : '';
  const leadHint = lead
    ? `\nLead: ${lead.Deal_Name || `${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim()} | phone ${lead.Phone || lead.phone || ''} | stage ${lead.Stage || 'New'}`
    : '';
  return [
    'You are HARX AI Voice Assistant making an outbound sales call on behalf of a company.',
    'Speak naturally in French by default. Keep turns short. Listen for barge-in.',
    'Use tools when you need lead details, notes, callbacks or appointments.',
    'Never invent compliance claims. If the lead refuses, politely end the call.',
    custom,
    scriptHint,
    leadHint,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Start an AI outbound Telnyx Call Control call for one lead.
 * Media bridge attaches after call.answered via streaming_start.
 */
async function startAiOutboundCall({ leadId, gigId, companyId, req }) {
  if (!leadId || !mongoose.Types.ObjectId.isValid(leadId)) {
    const err = new Error('leadId is required');
    err.status = 400;
    throw err;
  }

  // Prefer raw leads collection (dashboard / company fields) then mongoose model.
  let lead = null;
  if (mongoose.Types.ObjectId.isValid(leadId)) {
    lead = await mongoose.connection.db.collection('leads').findOne({
      _id: new mongoose.Types.ObjectId(leadId),
    });
  }
  if (!lead) {
    lead = await Lead.findById(leadId).lean();
  }
  if (!lead) {
    const err = new Error('Lead not found');
    err.status = 404;
    throw err;
  }

  // Lead's gig is source of truth — never let a stale cookie gigId override it.
  const leadGigId = lead.gigId
    ? String(lead.gigId?.$oid || lead.gigId)
    : null;
  const resolvedGigId = leadGigId || (gigId ? String(gigId) : null);
  if (!resolvedGigId) {
    const err = new Error('Lead has no gigId');
    err.status = 400;
    throw err;
  }

  const voiceAssistant = await loadGigVoiceAssistant(resolvedGigId);
  console.log('[AiOutbound] voiceAssistant check', {
    leadId: String(leadId),
    leadGigId,
    bodyGigId: gigId || null,
    resolvedGigId,
    enabled: Boolean(voiceAssistant?.enabled),
  });
  if (!voiceAssistant?.enabled) {
    const err = new Error(
      `Gig ${resolvedGigId} has no enabled voice assistant. Open Telephony → select this gig → Activer l'assistant.`
    );
    err.status = 400;
    throw err;
  }

  // AI outbound requires Telnyx Call Control + media stream (not Twilio Client).
  const line = await resolveActiveLineForGig(resolvedGigId, { preferProvider: 'telnyx' });
  if (!line || line.provider !== 'telnyx' || !line.phoneNumber) {
    const err = new Error('No active Telnyx phone number for this gig');
    err.status = 400;
    throw err;
  }

  const toNumber = lead.Phone || lead.phone;
  if (!toNumber) {
    const err = new Error('Lead has no phone number');
    err.status = 400;
    throw err;
  }

  // Call Control App ID (Mission Control → Call Control Applications).
  // Do NOT reuse the WebRTC Credential Connection id here — Telnyx rejects it.
  const connectionId =
    process.env.TELNYX_CALL_CONTROL_APP_ID ||
    process.env.TELNYX_APPLICATION_ID ||
    process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) {
    const err = new Error(
      'TELNYX_CALL_CONTROL_APP_ID is not configured (Call Control Application with webhook URL)'
    );
    err.status = 500;
    throw err;
  }

  const gig = await Gig.findById(resolvedGigId).lean();
  const base = publicBaseUrl(req);
  const webhookUrl = `${base}/api/calls/webhooks/telnyx/ai-outbound`;

  // Placeholder agent: AI system caller (Call.agent is required in schema).
  // Prefer company-scoped sentinel ObjectId from env, else zeros-padded companyId hash.
  const aiAgentId =
    process.env.AI_VOICE_AGENT_ID && mongoose.Types.ObjectId.isValid(process.env.AI_VOICE_AGENT_ID)
      ? process.env.AI_VOICE_AGENT_ID
      : new mongoose.Types.ObjectId();

  const callDoc = await Call.create({
    agent: aiAgentId,
    lead: lead._id,
    gigId: resolvedGigId,
    companyId: companyId || lead.companyId || null,
    sid: `pending-ai-${Date.now()}`,
    direction: 'outbound-api',
    from: line.phoneNumber,
    to: toNumber,
    provider: 'telnyx',
    startTime: new Date(),
    status: 'initiated',
    aiVoice: {
      enabled: true,
      voice: voiceAssistant.voice || process.env.OPENAI_VOICE || 'alloy',
      model: voiceAssistant.model || process.env.OPENAI_REALTIME_MODEL,
    },
  });

  const dialBody = {
    connection_id: connectionId,
    to: toNumber,
    from: line.phoneNumber,
    webhook_url: webhookUrl,
    webhook_url_method: 'POST',
    answering_machine_detection: 'disabled',
  };

  console.log('[AiOutbound] dialing', {
    from: line.phoneNumber,
    to: toNumber,
    gigId: resolvedGigId,
    leadId: String(lead._id),
    callId: String(callDoc._id),
  });

  const response = await telnyxPost('https://api.telnyx.com/v2/calls', dialBody);

  if (response.status >= 400) {
    callDoc.status = 'failed';
    await callDoc.save();
    const detail =
      response.data?.errors?.[0]?.detail ||
      JSON.stringify(response.data?.errors || response.data) ||
      'Telnyx dial failed';
    const err = new Error(detail);
    err.status = 502;
    throw err;
  }

  const callControlId =
    response.data?.data?.call_control_id ||
    response.data?.data?.id ||
    response.data?.call_control_id;
  const callSessionId = response.data?.data?.call_session_id;

  callDoc.sid = callControlId || callDoc.sid;
  callDoc.call_id = callSessionId || callDoc.call_id;
  callDoc.status = 'ringing';
  await callDoc.save();

  const ctx = {
    callMongoId: String(callDoc._id),
    leadId: String(lead._id),
    gigId: resolvedGigId,
    companyId: companyId || (lead.companyId ? String(lead.companyId) : null),
    from: line.phoneNumber,
    to: toNumber,
    callControlId,
    voiceAssistant,
    gig,
    lead: lead.toObject ? lead.toObject() : lead,
    realtime: null,
    streamStarted: false,
    wsBase: publicWsBase(req),
  };
  if (callControlId) activeSessions.set(callControlId, ctx);

  return {
    success: true,
    callId: String(callDoc._id),
    callControlId,
    from: line.phoneNumber,
    to: toNumber,
    provider: 'telnyx',
    voiceAssistant: {
      enabled: true,
      voice: ctx.voiceAssistant.voice,
      name: ctx.voiceAssistant.name || 'HARX AI Voice',
    },
  };
}

async function startMediaStream(callControlId) {
  const ctx = activeSessions.get(callControlId);
  if (!ctx || ctx.streamStarted) return;
  ctx.streamStarted = true;

  const streamUrl = `${ctx.wsBase}/ai-voice-stream?callControlId=${encodeURIComponent(callControlId)}`;
  console.log('[AiOutbound] streaming_start', { callControlId, streamUrl });

  const res = await telnyxPost(
    `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
    {
      stream_url: streamUrl,
      stream_track: 'inbound_track',
      stream_bidirectional_mode: 'rtp',
      stream_bidirectional_codec: 'PCMU',
    }
  );

  if (res.status >= 400) {
    console.error('[AiOutbound] streaming_start failed', res.status, res.data);
    // Fallback: greet with speak so the call is not silent
    await telnyxPost(`https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`, {
      payload:
        ctx.voiceAssistant?.greeting ||
        'Bonjour, je suis l assistant vocal HARX. Un instant s il vous plait.',
      voice: 'female',
      language: 'fr-FR',
    }).catch(() => null);
    return;
  }

  // Prepare OpenAI session (audio bridge attaches when Telnyx WS connects)
  const realtime = new OpenAIRealtimeService({
    voice: ctx.voiceAssistant.voice || process.env.OPENAI_VOICE || 'alloy',
    model: ctx.voiceAssistant.model || process.env.OPENAI_REALTIME_MODEL,
  });
  ctx.realtime = realtime;

  await realtime.connect({
    instructions: buildInstructions(ctx.voiceAssistant, ctx.lead, ctx.gig),
    tools: buildRealtimeTools(),
    voice: ctx.voiceAssistant.voice,
  });

  realtime.on('onToolCall', async ({ name, args }) =>
    executeVoiceTool(name, args, {
      defaultLeadId: ctx.leadId,
      defaultCallId: ctx.callMongoId,
    })
  );

  // Kick off the assistant greeting
  realtime.send({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text:
            ctx.voiceAssistant.greeting ||
            'The lead just answered. Greet them briefly and introduce the purpose of the call.',
        },
      ],
    },
  });
  realtime.createResponse();

  await Call.findByIdAndUpdate(ctx.callMongoId, { status: 'in-progress' });
}

async function handleAiOutboundWebhook(event) {
  const type = event?.event_type;
  const payload = event?.payload || {};
  const callControlId = payload.call_control_id;
  if (!callControlId) return { ok: true };

  console.log('[AiOutbound] webhook', type, callControlId);

  if (type === 'call.answered') {
    await startMediaStream(callControlId);
    return { ok: true };
  }

  if (
    type === 'call.hangup' ||
    type === 'call.ended' ||
    type === 'streaming.stopped'
  ) {
    const ctx = activeSessions.get(callControlId);
    if (ctx?.realtime) ctx.realtime.close();
    if (ctx?.callMongoId) {
      await Call.findByIdAndUpdate(ctx.callMongoId, {
        status: 'completed',
        endTime: new Date(),
      });
    }
    activeSessions.delete(callControlId);
  }

  return { ok: true };
}

function getActiveSession(callControlId) {
  return activeSessions.get(callControlId) || null;
}

module.exports = {
  startAiOutboundCall,
  handleAiOutboundWebhook,
  getActiveSession,
  activeSessions,
};
