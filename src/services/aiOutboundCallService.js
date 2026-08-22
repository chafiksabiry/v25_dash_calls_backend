const crypto = require('crypto');
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
const sessionsByStreamToken = new Map(); // short hex token -> ctx (Telnyx-safe URL)

function createStreamToken() {
  return crypto.randomBytes(16).toString('hex');
}

function resolveStreamToken(token) {
  const ctx = sessionsByStreamToken.get(token);
  return ctx?.callControlId || null;
}

function getSessionByStreamToken(token) {
  return sessionsByStreamToken.get(token) || null;
}

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

const KNOWLEDGEBASE_API_URL = (
  process.env.KNOWLEDGEBASE_API_URL ||
  'https://v25knowledgebasebackend-production.up.railway.app/api'
).replace(/\/$/, '');

function flattenLinearScript(scriptArr) {
  if (!Array.isArray(scriptArr) || !scriptArr.length) return '';
  return scriptArr
    .map((s) => `[${s.phase || 'phase'}] ${s.actor || 'agent'}: ${s.replica || ''}`)
    .join('\n');
}

function flattenPlaybookStages(stages) {
  if (!Array.isArray(stages) || !stages.length) return '';
  return stages
    .map((st, i) => {
      const n = st.stepNumber || i + 1;
      const label = st.label || st.typeLabel || st.type || `Étape ${n}`;
      const intro = st.introReplica || st.introTitle || '';
      const reminders = Array.isArray(st.reminders)
        ? st.reminders.map((r) => `  - ${typeof r === 'string' ? r : r.text || JSON.stringify(r)}`).join('\n')
        : '';
      const options = Array.isArray(st.options)
        ? st.options
            .map((o) => `  • ${o.label || o.text || JSON.stringify(o)}`)
            .join('\n')
        : '';
      return [`### Étape ${n}: ${label}`, intro, reminders, options].filter(Boolean).join('\n');
    })
    .join('\n\n');
}

/**
 * Load active gig call script from knowledgebase (same source as AI call scoring).
 * Returns { text, greeting, language, title } or null.
 */
async function loadGigCallScript(gigId) {
  if (!gigId) return null;
  try {
    const url = `${KNOWLEDGEBASE_API_URL}/scripts/gig/${gigId}?active=true`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn('[AiOutbound] script fetch failed', res.status, url);
      return null;
    }
    const payload = await res.json();
    const scripts = payload.data || payload.scripts || [];
    const active =
      scripts.find((s) => s.isActive) ||
      scripts[0] ||
      null;
    if (!active) return null;

    const linear = flattenLinearScript(active.script);
    const stages = flattenPlaybookStages(active.playbook?.stages);
    const dialogue = Array.isArray(active.playbook?.dialogue)
      ? active.playbook.dialogue
          .map((d) => `${d.role || 'agent'}: ${d.text || ''}`)
          .join('\n')
      : '';

    const text = [
      active.playbook?.title ? `Titre: ${active.playbook.title}` : '',
      active.targetClient ? `Cible: ${active.targetClient}` : '',
      active.details ? `Contexte mission: ${active.details}` : '',
      linear ? `\n## Script linéaire (à suivre)\n${linear}` : '',
      stages ? `\n## Playbook interactif (étapes)\n${stages}` : '',
      dialogue && !linear ? `\n## Dialogue\n${dialogue}` : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (!text.trim()) return null;

    // Opening line: first agent replica from linear script, else stage intro.
    const firstAgent =
      (Array.isArray(active.script) &&
        active.script.find((s) => String(s.actor || '').toLowerCase() === 'agent')) ||
      null;
    const firstStageIntro =
      (Array.isArray(active.playbook?.stages) &&
        active.playbook.stages.find((s) => s.introReplica)?.introReplica) ||
      null;

    console.log('[AiOutbound] script loaded', {
      gigId: String(gigId),
      scriptId: String(active._id || ''),
      linearReplicas: Array.isArray(active.script) ? active.script.length : 0,
      stages: Array.isArray(active.playbook?.stages) ? active.playbook.stages.length : 0,
    });

    return {
      text,
      greeting: (firstAgent?.replica || firstStageIntro || '').trim() || null,
      language: active.language || 'fr',
      title: active.playbook?.title || null,
    };
  } catch (err) {
    console.error('[AiOutbound] script load error', err?.message || err);
    return null;
  }
}

function buildInstructions(voiceAssistant, lead, gig, callScript) {
  const custom = voiceAssistant?.systemPrompt || voiceAssistant?.prompt || '';
  const gigHint = gig?.description ? `\nGig description:\n${gig.description}` : '';
  const leadHint = lead
    ? `\nLead: ${lead.Deal_Name || `${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim()} | phone ${lead.Phone || lead.phone || ''} | stage ${lead.Stage || 'New'}`
    : '';
  const scriptBlock = callScript?.text
    ? `\n## SCRIPT OBLIGATOIRE (cohérence)\n${callScript.text}`
    : '\n## SCRIPT\nAucun script actif trouvé pour ce gig. Reste générique et prudent; ne promets rien.';

  return [
    'You are HARX AI Voice Assistant making an outbound sales call on behalf of a company.',
    'Speak naturally. Default language: French unless the lead uses another language or the script specifies otherwise.',
    'Keep turns short. Listen for barge-in and stop speaking immediately when the lead talks.',
    '',
    '## COHÉRENCE DE SCRIPT (règles strictes)',
    '1. Follow the SCRIPT below phase by phase. Do not invent a different pitch, product, price, or company story.',
    '2. Stay on the current phase until the lead answers; then move to the matching next phase / playbook stage.',
    '3. Use the script wording as your guide — you may rephrase slightly for natural speech, but keep the same meaning, offers, and compliance.',
    '4. Never invent compliance claims, legal guarantees, or discounts not present in the script.',
    '5. If the lead refuses or asks to stop, exit politely (script closing if available) and end the call.',
    '6. Use tools (notes, callback, appointment, stage) when the script or lead intent requires it.',
    '',
    custom,
    scriptBlock,
    gigHint,
    leadHint,
  ]
    .filter((line) => line !== undefined && line !== null)
    .join('\n');
}

function resolveOpeningPrompt(voiceAssistant, callScript) {
  if (callScript?.greeting) {
    return [
      'The lead just answered the phone.',
      'Open EXACTLY with this script opening (natural spoken French, same meaning):',
      `"${callScript.greeting}"`,
      'Then continue following the SCRIPT phases. Do not use a generic HARX assistant intro.',
    ].join(' ');
  }
  if (voiceAssistant?.greeting) {
    return `The lead just answered. Open with: "${voiceAssistant.greeting}" Then follow the SCRIPT.`;
  }
  return 'The lead just answered. Open with the first agent line of the SCRIPT. Do not invent a generic intro.';
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
  const callScript = await loadGigCallScript(resolvedGigId);
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

  // Register stream session BEFORE dial so early Telnyx WSS upgrades find a ctx.
  // Do NOT attach stream_url on dial — Telnyx was connecting before answer and
  // burning the stream (90046) when the handshake raced our session setup.
  const streamToken = createStreamToken();
  const wsBase = publicWsBase(req);
  const streamUrl = `${wsBase}/ai-voice-stream/${streamToken}`;

  const ctx = {
    callMongoId: String(callDoc._id),
    leadId: String(lead._id),
    gigId: resolvedGigId,
    companyId: companyId || (lead.companyId ? String(lead.companyId) : null),
    from: line.phoneNumber,
    to: toNumber,
    callControlId: null,
    streamToken,
    streamUrl,
    voiceAssistant,
    callScript,
    gig,
    lead: lead.toObject ? lead.toObject() : lead,
    realtime: null,
    streamStarted: false,
    wsBase,
  };
  sessionsByStreamToken.set(streamToken, ctx);

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
    streamUrl,
  });

  const response = await telnyxPost('https://api.telnyx.com/v2/calls', dialBody);

  if (response.status >= 400) {
    sessionsByStreamToken.delete(streamToken);
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

  ctx.callControlId = callControlId;
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

  const streamUrl =
    ctx.streamUrl ||
    `${ctx.wsBase}/ai-voice-stream/${ctx.streamToken || createStreamToken()}`;
  console.log('[AiOutbound] preparing realtime then stream', { callControlId, streamUrl });

  // 1) OpenAI first — Telnyx may already be connecting from dial stream_url.
  const realtime = new OpenAIRealtimeService({
    voice: ctx.voiceAssistant.voice || process.env.OPENAI_VOICE || 'alloy',
    model: ctx.voiceAssistant.model || process.env.OPENAI_REALTIME_MODEL,
  });
  ctx.realtime = realtime;
  if (typeof ctx._attachBridgeWhenReady === 'function') {
    ctx._attachBridgeWhenReady(realtime);
    ctx._attachBridgeWhenReady = null;
  }

  try {
    await realtime.connect({
      instructions: buildInstructions(
        ctx.voiceAssistant,
        ctx.lead,
        ctx.gig,
        ctx.callScript
      ),
      tools: buildRealtimeTools(),
      voice: ctx.voiceAssistant.voice,
    });
  } catch (err) {
    console.error('[AiOutbound] OpenAI Realtime connect failed', err?.message || err);
    await telnyxPost(`https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`, {
      payload:
        ctx.callScript?.greeting ||
        'Bonjour, nous rencontrons un probleme technique. Nous vous rappelons.',
      voice: 'female',
      language: 'fr-FR',
    }).catch(() => null);
    return;
  }

  realtime.on('onToolCall', async ({ name, args }) =>
    executeVoiceTool(name, args, {
      defaultLeadId: ctx.leadId,
      defaultCallId: ctx.callMongoId,
    })
  );

  // 2) Fresh token for streaming_start (avoids a burned URL from an earlier attempt).
  if (!ctx.telnyxStreamWs) {
    const freshToken = createStreamToken();
    if (ctx.streamToken) sessionsByStreamToken.delete(ctx.streamToken);
    ctx.streamToken = freshToken;
    ctx.streamUrl = `${ctx.wsBase}/ai-voice-stream/${freshToken}`;
    sessionsByStreamToken.set(freshToken, ctx);

    const res = await telnyxPost(
      `https://api.telnyx.com/v2/calls/${callControlId}/actions/streaming_start`,
      {
        stream_url: ctx.streamUrl,
        stream_track: 'inbound_track',
        stream_codec: 'PCMU',
        stream_bidirectional_mode: 'rtp',
        stream_bidirectional_codec: 'PCMU',
        stream_bidirectional_target_legs: 'self',
        send_silence_when_idle: true,
      }
    );

    if (res.status >= 400) {
      console.error('[AiOutbound] streaming_start failed', res.status, res.data);
      console.error('[AiOutbound] Telnyx cannot open WSS to', ctx.streamUrl);
      // Wait briefly — upgrade may still land after 422 in some edge cases.
      await new Promise((r) => setTimeout(r, 1500));
      if (!ctx.telnyxStreamWs) {
        await telnyxPost(`https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`, {
          payload:
            ctx.callScript?.greeting ||
            ctx.voiceAssistant?.greeting ||
            'Bonjour, un instant s il vous plait.',
          voice: 'female',
          language: 'fr-FR',
        }).catch(() => null);
        return;
      }
      console.log('[AiOutbound] stream connected after 422 race — continuing', callControlId);
    } else {
      console.log('[AiOutbound] streaming_start ok', callControlId, ctx.streamUrl);
    }
  } else {
    console.log('[AiOutbound] Telnyx stream already connected', callControlId);
  }

  // 3) Kick off with script opening
  realtime.send({
    type: 'conversation.item.create',
    item: {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: resolveOpeningPrompt(ctx.voiceAssistant, ctx.callScript),
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
    if (ctx?.streamToken) sessionsByStreamToken.delete(ctx.streamToken);
    activeSessions.delete(callControlId);
  }

  return { ok: true };
}

function getActiveSession(callControlId) {
  return activeSessions.get(callControlId) || null;
}

/**
 * Hang up an active AI outbound Telnyx Call Control leg and clean local session.
 * Body key: callControlId (Telnyx call_control_id returned by startAiOutboundCall).
 */
async function hangupAiOutboundCall({ callControlId, callId }) {
  let resolvedControlId = callControlId ? String(callControlId) : null;

  if (!resolvedControlId && callId && mongoose.Types.ObjectId.isValid(callId)) {
    const callDoc = await Call.findById(callId).lean();
    if (callDoc?.sid && String(callDoc.sid).startsWith('pending-ai-') === false) {
      resolvedControlId = String(callDoc.sid);
    }
  }

  if (!resolvedControlId) {
    const err = new Error('callControlId is required');
    err.status = 400;
    throw err;
  }

  const ctx = activeSessions.get(resolvedControlId);
  console.log('[AiOutbound] hangup requested', {
    callControlId: resolvedControlId,
    hasSession: Boolean(ctx),
  });

  const response = await telnyxPost(
    `https://api.telnyx.com/v2/calls/${resolvedControlId}/actions/hangup`,
    {}
  );

  // 422 / not found can mean already hung up — still clean local state.
  if (response.status >= 400 && response.status !== 404 && response.status !== 422) {
    const detail =
      response.data?.errors?.[0]?.detail ||
      JSON.stringify(response.data?.errors || response.data) ||
      'Telnyx hangup failed';
    const err = new Error(detail);
    err.status = 502;
    throw err;
  }

  if (ctx?.realtime) {
    try {
      ctx.realtime.close();
    } catch {
      /* ignore */
    }
  }
  if (ctx?.callMongoId) {
    await Call.findByIdAndUpdate(ctx.callMongoId, {
      status: 'completed',
      endTime: new Date(),
    });
  } else if (callId && mongoose.Types.ObjectId.isValid(callId)) {
    await Call.findByIdAndUpdate(callId, {
      status: 'completed',
      endTime: new Date(),
    });
  }
  if (ctx?.streamToken) sessionsByStreamToken.delete(ctx.streamToken);
  activeSessions.delete(resolvedControlId);

  return {
    success: true,
    callControlId: resolvedControlId,
    alreadyEnded: response.status === 404 || response.status === 422,
  };
}

module.exports = {
  startAiOutboundCall,
  hangupAiOutboundCall,
  handleAiOutboundWebhook,
  getActiveSession,
  getSessionByStreamToken,
  resolveStreamToken,
  activeSessions,
};
