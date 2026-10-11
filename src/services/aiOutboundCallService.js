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
const { GeminiLiveService } = require('./integrations/geminiLiveService');
const telnyxService = require('./integrations/telnyxService');
const { buildRealtimeTools, executeVoiceTool } = require('./aiVoiceTools');

/** gemini (default) | openai — override with AI_VOICE_PROVIDER */
function resolveVoiceProvider() {
  const p = String(process.env.AI_VOICE_PROVIDER || 'gemini').toLowerCase().trim();
  return p === 'openai' ? 'openai' : 'gemini';
}

function resolveVoiceModel(voiceAssistant) {
  if (voiceAssistant?.model) return voiceAssistant.model;
  if (resolveVoiceProvider() === 'openai') {
    return process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime';
  }
  const { defaultModelForBackend, resolveLiveBackend } = require('./integrations/geminiLiveService');
  return defaultModelForBackend(resolveLiveBackend());
}

function resolveVoiceName(voiceAssistant) {
  if (voiceAssistant?.voice) return voiceAssistant.voice;
  if (resolveVoiceProvider() === 'openai') {
    return process.env.OPENAI_VOICE || 'alloy';
  }
  return process.env.GEMINI_LIVE_VOICE || 'Kore';
}

function createRealtimeService(voiceAssistant) {
  const voice = resolveVoiceName(voiceAssistant);
  const model = resolveVoiceModel(voiceAssistant);
  if (resolveVoiceProvider() === 'openai') {
    return new OpenAIRealtimeService({ voice, model });
  }
  return new GeminiLiveService({ voice, model });
}

const activeSessions = new Map(); // callControlId -> session ctx
const sessionsByStreamToken = new Map(); // short hex token -> ctx (Telnyx-safe URL)
/** Prevent double-scheduling analysis when hangup webhook + hangup API both fire. */
const analysisScheduled = new Set();

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

function normalizeScriptActor(actor) {
  const a = String(actor || 'agent').toLowerCase().trim();
  if (
    a === 'lead' ||
    a === 'prospect' ||
    a === 'client' ||
    a === 'customer' ||
    a === 'interlocuteur' ||
    a === 'user'
  ) {
    return 'LEAD';
  }
  return 'AGENT';
}

/**
 * Format linear script as a turn-taking playbook.
 * LEAD lines are expected replies — never spoken by the voicebot.
 */
function flattenLinearScript(scriptArr) {
  if (!Array.isArray(scriptArr) || !scriptArr.length) return '';
  return scriptArr
    .map((s, i) => {
      const role = normalizeScriptActor(s.actor);
      const phase = s.phase || 'phase';
      const text = String(s.replica || '').trim();
      if (role === 'LEAD') {
        return `${i + 1}. [${phase}] LEAD (possible reply — DO NOT speak): ${text}`;
      }
      return `${i + 1}. [${phase}] AGENT (say this, then STOP & LISTEN): ${text}`;
    })
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
          .map((d, i) => {
            const role = normalizeScriptActor(d.role || d.actor);
            const text = String(d.text || d.replica || '').trim();
            if (role === 'LEAD') {
              return `${i + 1}. LEAD (possible reply — DO NOT speak): ${text}`;
            }
            return `${i + 1}. AGENT (say this, then STOP & LISTEN): ${text}`;
          })
          .join('\n')
      : '';

    const text = [
      active.playbook?.title ? `Titre: ${active.playbook.title}` : '',
      active.targetClient ? `Cible: ${active.targetClient}` : '',
      active.details ? `Contexte mission: ${active.details}` : '',
      linear ? `\n## Script linéaire (DIALOGUE — une réplique AGENT à la fois)\n${linear}` : '',
      stages ? `\n## Playbook interactif (étapes — avancer après la réponse du lead)\n${stages}` : '',
      dialogue && !linear
        ? `\n## Dialogue modèle (DIALOGUE — une réplique AGENT à la fois)\n${dialogue}`
        : '',
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
    ? `\n## SCRIPT / PLAYBOOK (guide de conversation — PAS un texte à lire d'un trait)\n${callScript.text}`
    : '\n## SCRIPT\nAucun script actif trouvé pour ce gig. Reste générique et prudent; ne promets rien. Fais quand même un vrai dialogue: salue, présente-toi brièvement, pose UNE question, puis écoute.';

  return [
    'You are HARX AI Voice Assistant on a LIVE outbound phone call with a human lead.',
    'This is a real DIALOGUE (échange de parole), NOT a script reading / monologue.',
    'Default language: French unless the lead uses another language or the script says otherwise.',
    '',
    '## RÈGLES DE DIALOGUE (prioritaires)',
    '1. Speak ONLY as the AGENT. Never read LEAD / prospect lines out loud.',
    '2. One short turn at a time (1–3 sentences max). Then STOP and LISTEN for the lead.',
    '3. After the lead speaks, answer based on what they actually said, then take the next AGENT step from the playbook.',
    '4. Do NOT dump several script phases in one breath. Do NOT recite the whole script.',
    '5. If the lead interrupts, stop immediately and react to them (barge-in).',
    '6. If the lead is silent after ~2s of your turn ending, ask a short clarifying question — do not keep reading the script.',
    '',
    '## COHÉRENCE DE SCRIPT',
    '1. Use the SCRIPT as a playbook for what to say next — same meaning, offers, product, price, compliance.',
    '2. You may rephrase slightly for natural spoken French, but do not invent a different pitch or company story.',
    '3. Never invent compliance claims, legal guarantees, or discounts not in the script.',
    '4. If the lead refuses or asks to stop, close politely and end.',
    '5. Use tools (notes, callback, appointment, stage) when the lead intent or script requires it.',
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
      'The lead just answered the phone. Start a LIVE dialogue.',
      'Say ONLY this opening (natural spoken French, same meaning), then STOP and wait for the lead to reply:',
      `"${callScript.greeting}"`,
      'Do not continue to the next script phase until the lead speaks. Do not invent a generic HARX intro.',
    ].join(' ');
  }
  if (voiceAssistant?.greeting) {
    return `The lead just answered. Say ONLY: "${voiceAssistant.greeting}" Then STOP and listen. Do not continue the script until they reply.`;
  }
  return 'The lead just answered. Say ONLY the first AGENT line of the SCRIPT, then STOP and listen for their reply. Do not recite further lines yet.';
}

/**
 * Start an AI outbound call for one lead (Telnyx Call Control or Twilio Media Streams).
 * Uses any active gig voice line (Twilio or Telnyx).
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

  // Any active voice line (Twilio or Telnyx) — no provider lock-in.
  const line = await resolveActiveLineForGig(resolvedGigId);
  if (!line || !line.phoneNumber) {
    const err = new Error(
      'No active Telnyx or Twilio phone number for this gig. Assign a voice line in Telephony.'
    );
    err.status = 400;
    throw err;
  }

  const toNumber = lead.Phone || lead.phone;
  if (!toNumber) {
    const err = new Error('Lead has no phone number');
    err.status = 400;
    throw err;
  }

  const gig = await Gig.findById(resolvedGigId).lean();
  const callScript = await loadGigCallScript(resolvedGigId);
  const base = publicBaseUrl(req);

  const aiAgentId =
    process.env.AI_VOICE_AGENT_ID && mongoose.Types.ObjectId.isValid(process.env.AI_VOICE_AGENT_ID)
      ? process.env.AI_VOICE_AGENT_ID
      : new mongoose.Types.ObjectId();

  const telephonyProvider = line.provider === 'twilio' ? 'twilio' : 'telnyx';

  const callDoc = await Call.create({
    agent: aiAgentId,
    lead: lead._id,
    gigId: resolvedGigId,
    companyId: companyId || lead.companyId || null,
    sid: `pending-ai-${Date.now()}`,
    direction: 'outbound-api',
    from: line.phoneNumber,
    to: toNumber,
    provider: telephonyProvider,
    startTime: new Date(),
    status: 'initiated',
    aiVoice: {
      enabled: true,
      source: 'voicebot',
      provider: resolveVoiceProvider(),
      voice: resolveVoiceName(voiceAssistant),
      model: resolveVoiceModel(voiceAssistant),
    },
  });

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
    telephonyProvider,
  };
  sessionsByStreamToken.set(streamToken, ctx);

  console.log('[AiOutbound] dialing', {
    telephonyProvider,
    from: line.phoneNumber,
    to: toNumber,
    gigId: resolvedGigId,
    leadId: String(lead._id),
    callId: String(callDoc._id),
    streamUrl,
  });

  if (telephonyProvider === 'twilio') {
    return startTwilioDial({ ctx, callDoc, line, toNumber, base, streamToken });
  }
  return startTelnyxDial({ ctx, callDoc, line, toNumber, base });
}

async function startTelnyxDial({ ctx, callDoc, line, toNumber, base }) {
  const connectionId =
    process.env.TELNYX_CALL_CONTROL_APP_ID ||
    process.env.TELNYX_APPLICATION_ID ||
    process.env.TELNYX_CONNECTION_ID;
  if (!connectionId) {
    sessionsByStreamToken.delete(ctx.streamToken);
    callDoc.status = 'failed';
    await callDoc.save();
    const err = new Error(
      'TELNYX_CALL_CONTROL_APP_ID is not configured (Call Control Application with webhook URL)'
    );
    err.status = 500;
    throw err;
  }

  const webhookUrl = `${base}/api/calls/webhooks/telnyx/ai-outbound`;
  const dialBody = {
    connection_id: connectionId,
    to: toNumber,
    from: line.phoneNumber,
    webhook_url: webhookUrl,
    webhook_url_method: 'POST',
    answering_machine_detection: 'disabled',
  };

  const response = await telnyxPost('https://api.telnyx.com/v2/calls', dialBody);

  if (response.status >= 400) {
    sessionsByStreamToken.delete(ctx.streamToken);
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

async function startTwilioDial({ ctx, callDoc, line, toNumber, base, streamToken }) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    sessionsByStreamToken.delete(ctx.streamToken);
    callDoc.status = 'failed';
    await callDoc.save();
    const err = new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not configured');
    err.status = 500;
    throw err;
  }

  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  const client = twilio(accountSid, authToken);

  const voiceUrl = `${base}/api/calls/webhooks/twilio/ai-outbound/voice?streamToken=${encodeURIComponent(streamToken)}`;
  const statusUrl = `${base}/api/calls/webhooks/twilio/ai-outbound/status?streamToken=${encodeURIComponent(streamToken)}`;
  const recordingUrl = `${base}/api/calls/webhooks/twilio/ai-outbound/recording?streamToken=${encodeURIComponent(streamToken)}`;

  let call;
  try {
    call = await client.calls.create({
      to: toNumber,
      from: line.phoneNumber,
      url: voiceUrl,
      method: 'POST',
      statusCallback: statusUrl,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: recordingUrl,
      recordingStatusCallbackMethod: 'POST',
      recordingChannels: 'dual',
    });
  } catch (dialErr) {
    sessionsByStreamToken.delete(ctx.streamToken);
    callDoc.status = 'failed';
    await callDoc.save();
    const err = new Error(dialErr?.message || 'Twilio dial failed');
    err.status = 502;
    throw err;
  }

  callDoc.sid = call.sid;
  callDoc.status = 'ringing';
  await callDoc.save();

  ctx.callControlId = call.sid;
  activeSessions.set(call.sid, ctx);

  return {
    success: true,
    callId: String(callDoc._id),
    callControlId: call.sid,
    from: line.phoneNumber,
    to: toNumber,
    provider: 'twilio',
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
  const provider = resolveVoiceProvider();
  const telephony = ctx.telephonyProvider || 'telnyx';
  console.log('[AiOutbound] preparing realtime then stream', {
    callControlId,
    streamUrl,
    provider,
    telephony,
    model: resolveVoiceModel(ctx.voiceAssistant),
  });

  // 1) Live model first — carrier stream may already be connecting.
  const realtime = createRealtimeService(ctx.voiceAssistant);
  ctx.realtime = realtime;
  ctx.voiceProvider = provider;
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
      voice: resolveVoiceName(ctx.voiceAssistant),
    });
  } catch (err) {
    console.error('[AiOutbound] Live voice connect failed', provider, err?.message || err);
    ctx.streamStarted = false;
    ctx.realtime = null;
    if (telephony === 'telnyx') {
      await telnyxPost(`https://api.telnyx.com/v2/calls/${callControlId}/actions/speak`, {
        payload:
          ctx.callScript?.greeting ||
          'Bonjour, nous rencontrons un probleme technique. Nous vous rappelons.',
        voice: 'female',
        language: 'fr-FR',
      }).catch(() => null);
    }
    throw err;
  }

  realtime.on('onToolCall', async ({ name, args }) =>
    executeVoiceTool(name, args, {
      defaultLeadId: ctx.leadId,
      defaultCallId: ctx.callMongoId,
    })
  );

  // Persist live dialogue turns so analysis / UI show voicebot ↔ lead exchange.
  ctx.liveTranscript = Array.isArray(ctx.liveTranscript) ? ctx.liveTranscript : [];
  const pushTranscript = async (speaker, text) => {
    const clean = String(text || '').trim();
    if (!clean || !ctx.callMongoId) return;
    ctx.liveTranscript.push({
      speaker,
      text: clean,
      timestamp: new Date().toISOString(),
    });
    try {
      await Call.findByIdAndUpdate(ctx.callMongoId, {
        $push: { transcript: { speaker, text: clean, timestamp: new Date().toISOString() } },
      });
    } catch (err) {
      console.warn('[AiOutbound] transcript persist failed', err?.message || err);
    }
  };

  let agentUtterance = '';
  realtime.on('onTranscript', (event) => {
    if (event?.type === 'conversation.item.input_audio_transcription.completed') {
      pushTranscript('lead', event.transcript || event.text || '');
      return;
    }
    // Gemini Live often sends cumulative output transcription per turn.
    if (event?.type === 'gemini.output_transcription' || event?.cumulative) {
      agentUtterance = String(event.text || event.delta || '').trim();
      return;
    }
    const delta = event?.delta || event?.transcript || '';
    if (!delta) return;
    agentUtterance += delta;
    if (/[.!?…]\s*$/.test(agentUtterance) || agentUtterance.length > 280) {
      const chunk = agentUtterance.trim();
      agentUtterance = '';
      if (chunk) pushTranscript('agent', chunk);
    }
  });

  // Flush remaining agent text when lead starts speaking (end of bot turn).
  realtime.on('onSpeechStarted', () => {
    const chunk = agentUtterance.trim();
    agentUtterance = '';
    if (chunk) pushTranscript('agent', chunk);
  });

  realtime.on('onSpeechStopped', () => {
    const chunk = agentUtterance.trim();
    agentUtterance = '';
    if (chunk) pushTranscript('agent', chunk);
  });

  // 2) Telnyx: start bidirectional media stream. Twilio: TwiML <Connect><Stream> already opens WSS.
  const streamAlreadyUp = Boolean(ctx.telnyxStreamWs || ctx.mediaStreamWs);
  if (telephony === 'telnyx' && !streamAlreadyUp) {
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
      await new Promise((r) => setTimeout(r, 1500));
      if (!ctx.telnyxStreamWs && !ctx.mediaStreamWs) {
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
  } else if (streamAlreadyUp) {
    console.log('[AiOutbound] media stream already connected', callControlId, telephony);
  } else {
    console.log('[AiOutbound] Twilio stream will connect via TwiML', callControlId, ctx.streamUrl);
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

  // Recording: Telnyx explicit start; Twilio uses record:true on dial.
  if (telephony === 'telnyx') {
    try {
      await telnyxService.startCallRecording(callControlId);
      console.log('[AiOutbound] record_start ok', callControlId);
    } catch (err) {
      console.warn('[AiOutbound] record_start failed:', err?.message || err);
    }
  }
}

async function findAiOutboundCallDoc(callControlId, callMongoId) {
  if (callMongoId && mongoose.Types.ObjectId.isValid(callMongoId)) {
    const byId = await Call.findById(callMongoId);
    if (byId) return byId;
  }
  if (!callControlId) return null;
  return Call.findOne({
    $or: [{ sid: callControlId }, { call_id: callControlId }],
  });
}

async function markAiOutboundCompleted(callMongoId, callControlId) {
  const callDoc = await findAiOutboundCallDoc(callControlId, callMongoId);
  if (!callDoc) return null;

  const endTime = new Date();
  callDoc.status = 'completed';
  callDoc.endTime = endTime;
  if (callDoc.startTime) {
    callDoc.duration = Math.max(
      0,
      Math.round((endTime.getTime() - new Date(callDoc.startTime).getTime()) / 1000)
    );
  }
  await callDoc.save();
  return callDoc;
}

async function persistAiOutboundRecording(callControlId, payload) {
  const publicMp3 =
    payload?.public_recording_urls?.mp3 ||
    payload?.recording_urls?.mp3 ||
    payload?.download_urls?.mp3 ||
    null;
  if (!publicMp3) {
    console.warn('[AiOutbound] recording.saved without public mp3', callControlId);
    return;
  }

  const ctx = activeSessions.get(callControlId);
  const callDoc = await findAiOutboundCallDoc(callControlId, ctx?.callMongoId);
  if (!callDoc) {
    console.warn('[AiOutbound] recording.saved for unknown call', callControlId);
    return;
  }

  callDoc.recording_url = publicMp3;
  try {
    const cloudUrl = await telnyxService.archivePublicRecording(publicMp3);
    if (cloudUrl) callDoc.recording_url_cloudinary = cloudUrl;
  } catch (err) {
    console.warn('[AiOutbound] Cloudinary archive failed:', err?.message || err);
  }
  await callDoc.save();
  console.log('[AiOutbound] recording archived', String(callDoc._id));
}

/**
 * Wait for Telnyx recording.saved (or poll recordings API), then run the same
 * Vertex analysis pipeline used for REP calls.
 */
function scheduleAiOutboundFinalize(callMongoId, callControlId) {
  if (!callMongoId) return;
  const key = String(callMongoId);
  if (analysisScheduled.has(key)) return;
  analysisScheduled.add(key);

  console.log('[AiOutbound] scheduling finalize + analysis', key);
  setTimeout(async () => {
    try {
      const callDoc = await Call.findById(callMongoId);
      if (!callDoc) {
        console.warn('[AiOutbound] finalize: call not found', callMongoId);
        return;
      }

      if (!callDoc.recording_url_cloudinary) {
        let url = callDoc.recording_url || null;
        if (!url && callControlId && !String(callControlId).startsWith('CA')) {
          try {
            url = await telnyxService.findRecordingUrl(callControlId);
          } catch (err) {
            console.warn('[AiOutbound] findRecordingUrl failed:', err?.message || err);
          }
        }
        if (!url && callControlId && String(callControlId).startsWith('CA')) {
          try {
            // eslint-disable-next-line global-require
            const twilio = require('twilio');
            const client = twilio(
              process.env.TWILIO_ACCOUNT_SID,
              process.env.TWILIO_AUTH_TOKEN
            );
            const recordings = await client.calls(callControlId).recordings.list({ limit: 1 });
            if (recordings[0]?.sid) {
              url = `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Recordings/${recordings[0].sid}.mp3`;
            }
          } catch (err) {
            console.warn('[AiOutbound] Twilio recordings list failed:', err?.message || err);
          }
        }
        if (url) {
          callDoc.recording_url = url;
          try {
            if (String(callControlId || '').startsWith('CA') || callDoc.provider === 'twilio') {
              // eslint-disable-next-line global-require
              const twilioService = require('./integrations/twilio');
              const cloudUrl = await twilioService.fetchTwilioRecording(url, null);
              if (cloudUrl) callDoc.recording_url_cloudinary = cloudUrl;
            } else {
              const cloudUrl = await telnyxService.archivePublicRecording(url);
              if (cloudUrl) callDoc.recording_url_cloudinary = cloudUrl;
            }
          } catch (err) {
            console.warn('[AiOutbound] finalize Cloudinary failed:', err?.message || err);
          }
          await callDoc.save();
        }
      }

      if (!callDoc.recording_url && !callDoc.recording_url_cloudinary) {
        console.warn(
          '[AiOutbound] no recording yet — analysis may fail or wait; still scheduling',
          callMongoId
        );
      }

      // Lazy require avoids circular dependency with controllers/calls.js
      // eslint-disable-next-line global-require
      const { runAnalysisInBackground } = require('../controllers/calls');
      if (typeof runAnalysisInBackground === 'function') {
        runAnalysisInBackground(callMongoId);
      } else {
        console.error('[AiOutbound] runAnalysisInBackground not exported');
      }
    } catch (err) {
      console.error('[AiOutbound] finalize failed:', err?.message || err);
    } finally {
      analysisScheduled.delete(key);
    }
  }, 8000);
}

function cleanupAiOutboundSession(callControlId) {
  const ctx = activeSessions.get(callControlId);
  if (ctx?.realtime) {
    try {
      ctx.realtime.close();
    } catch {
      /* ignore */
    }
  }
  if (ctx?.streamToken) sessionsByStreamToken.delete(ctx.streamToken);
  activeSessions.delete(callControlId);
  return ctx;
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

  if (type === 'call.recording.saved') {
    await persistAiOutboundRecording(callControlId, payload);
    return { ok: true };
  }

  if (type === 'streaming.stopped') {
    // Media stream ended; keep Call Control session until hangup so recording can finish.
    const ctx = activeSessions.get(callControlId);
    if (ctx?.realtime) {
      try {
        ctx.realtime.close();
      } catch {
        /* ignore */
      }
      ctx.realtime = null;
    }
    return { ok: true };
  }

  if (type === 'call.hangup' || type === 'call.ended') {
    const ctx = cleanupAiOutboundSession(callControlId);
    const callMongoId = ctx?.callMongoId || null;
    await markAiOutboundCompleted(callMongoId, callControlId);
    scheduleAiOutboundFinalize(callMongoId, callControlId);
  }

  return { ok: true };
}

function getActiveSession(callControlId) {
  return activeSessions.get(callControlId) || null;
}

/**
 * Hang up an active AI outbound leg (Telnyx Call Control id or Twilio Call SID).
 * Body key: callControlId (returned by startAiOutboundCall) or callId.
 */
async function hangupAiOutboundCall({ callControlId, callId }) {
  let resolvedControlId = callControlId ? String(callControlId) : null;
  let callDoc = null;

  if (!resolvedControlId && callId && mongoose.Types.ObjectId.isValid(callId)) {
    callDoc = await Call.findById(callId).lean();
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
  const telephony =
    ctx?.telephonyProvider ||
    callDoc?.provider ||
    (resolvedControlId.startsWith('CA') ? 'twilio' : 'telnyx');

  console.log('[AiOutbound] hangup requested', {
    callControlId: resolvedControlId,
    telephony,
    hasSession: Boolean(ctx),
  });

  let alreadyEnded = false;

  if (telephony === 'twilio') {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    if (!accountSid || !authToken) {
      const err = new Error('TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not configured');
      err.status = 500;
      throw err;
    }
    // eslint-disable-next-line global-require
    const twilio = require('twilio');
    const client = twilio(accountSid, authToken);
    try {
      await client.calls(resolvedControlId).update({ status: 'completed' });
    } catch (err) {
      const msg = String(err?.message || '');
      alreadyEnded =
        msg.includes('not in-progress') ||
        msg.includes('completed') ||
        err?.status === 404;
      if (!alreadyEnded) {
        const e = new Error(msg || 'Twilio hangup failed');
        e.status = 502;
        throw e;
      }
    }
  } else {
    const response = await telnyxPost(
      `https://api.telnyx.com/v2/calls/${resolvedControlId}/actions/hangup`,
      {}
    );
    alreadyEnded = response.status === 404 || response.status === 422;
    if (response.status >= 400 && !alreadyEnded) {
      const detail =
        response.data?.errors?.[0]?.detail ||
        JSON.stringify(response.data?.errors || response.data) ||
        'Telnyx hangup failed';
      const err = new Error(detail);
      err.status = 502;
      throw err;
    }
  }

  const cleaned = cleanupAiOutboundSession(resolvedControlId);
  const callMongoId =
    cleaned?.callMongoId ||
    (callId && mongoose.Types.ObjectId.isValid(callId) ? String(callId) : null);
  await markAiOutboundCompleted(callMongoId, resolvedControlId);
  scheduleAiOutboundFinalize(callMongoId, resolvedControlId);

  return {
    success: true,
    callControlId: resolvedControlId,
    provider: telephony,
    alreadyEnded,
  };
}

/**
 * Twilio voice webhook — return <Connect><Stream> TwiML and prepare Gemini/OpenAI.
 */
async function handleTwilioAiOutboundVoice(req) {
  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  const vr = new twilio.twiml.VoiceResponse();

  const streamToken =
    req.query?.streamToken || req.body?.streamToken || req.body?.StreamToken;
  const callSid = req.body?.CallSid;
  const ctx = streamToken ? getSessionByStreamToken(String(streamToken)) : null;

  if (!ctx) {
    console.error('[AiOutbound] Twilio voice: no session', { streamToken, callSid });
    vr.say(
      { language: 'fr-FR', voice: 'Polly.Lea' },
      'Bonjour, nous rencontrons un probleme technique. Au revoir.'
    );
    return vr.toString();
  }

  if (callSid) {
    ctx.callControlId = callSid;
    ctx.telephonyProvider = 'twilio';
    activeSessions.set(callSid, ctx);
    if (ctx.callMongoId) {
      await Call.findByIdAndUpdate(ctx.callMongoId, {
        sid: callSid,
        status: 'in-progress',
      }).catch(() => null);
    }
  }

  try {
    await startMediaStream(callSid || ctx.callControlId);
  } catch (err) {
    console.error('[AiOutbound] Twilio realtime prepare failed', err?.message || err);
    vr.say(
      { language: 'fr-FR', voice: 'Polly.Lea' },
      ctx.callScript?.greeting ||
        'Bonjour, nous rencontrons un probleme technique. Nous vous rappelons.'
    );
    return vr.toString();
  }

  const connect = vr.connect();
  connect.stream({
    url: ctx.streamUrl,
  });
  console.log('[AiOutbound] Twilio TwiML stream', {
    callSid,
    streamUrl: ctx.streamUrl,
  });
  return vr.toString();
}

async function handleTwilioAiOutboundStatus(req) {
  const callSid = req.body?.CallSid;
  const status = String(req.body?.CallStatus || '').toLowerCase();
  const streamToken = req.query?.streamToken || req.body?.streamToken;
  console.log('[AiOutbound] Twilio status', { callSid, status });

  const ctx =
    (callSid && activeSessions.get(callSid)) ||
    (streamToken ? getSessionByStreamToken(String(streamToken)) : null);

  if (callSid && ctx && !ctx.callControlId) {
    ctx.callControlId = callSid;
    activeSessions.set(callSid, ctx);
  }

  if (['completed', 'busy', 'failed', 'no-answer', 'canceled'].includes(status)) {
    const cleaned = cleanupAiOutboundSession(callSid || ctx?.callControlId);
    const callMongoId = cleaned?.callMongoId || ctx?.callMongoId || null;
    await markAiOutboundCompleted(callMongoId, callSid);
    scheduleAiOutboundFinalize(callMongoId, callSid);
  }
  return { ok: true };
}

async function handleTwilioAiOutboundRecording(req) {
  const callSid = req.body?.CallSid;
  let recordingUrl = req.body?.RecordingUrl || null;
  if (recordingUrl && !recordingUrl.endsWith('.mp3')) {
    recordingUrl = `${recordingUrl}.mp3`;
  }
  console.log('[AiOutbound] Twilio recording', { callSid, recordingUrl });

  const ctx = callSid ? activeSessions.get(callSid) : null;
  const callDoc = await findAiOutboundCallDoc(callSid, ctx?.callMongoId);
  if (!callDoc || !recordingUrl) return { ok: true };

  callDoc.recording_url = recordingUrl;
  try {
    // eslint-disable-next-line global-require
    const twilioService = require('./integrations/twilio');
    const cloudUrl = await twilioService.fetchTwilioRecording(recordingUrl, null);
    if (cloudUrl) callDoc.recording_url_cloudinary = cloudUrl;
  } catch (err) {
    console.warn('[AiOutbound] Twilio Cloudinary archive failed:', err?.message || err);
    try {
      const cloudUrl = await telnyxService.archivePublicRecording(recordingUrl);
      if (cloudUrl) callDoc.recording_url_cloudinary = cloudUrl;
    } catch {
      /* ignore */
    }
  }
  await callDoc.save();
  return { ok: true };
}

module.exports = {
  startAiOutboundCall,
  hangupAiOutboundCall,
  handleAiOutboundWebhook,
  handleTwilioAiOutboundVoice,
  handleTwilioAiOutboundStatus,
  handleTwilioAiOutboundRecording,
  getActiveSession,
  getSessionByStreamToken,
  resolveStreamToken,
  activeSessions,
};
