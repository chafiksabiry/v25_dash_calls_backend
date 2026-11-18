jest.mock('../models/Lead', () => ({ Lead: {} }));
jest.mock('../models/Call', () => ({ Call: { findByIdAndUpdate: jest.fn(async () => null) } }));
jest.mock('../models/Gig', () => ({}));
jest.mock('../services/aiVoiceTools', () => ({ buildRealtimeTools: () => [], executeVoiceTool: jest.fn() }));
jest.mock('../services/integrations/telnyxService', () => ({ startCallRecording: jest.fn(async () => ({ ok: true })) }));
jest.mock('../services/integrations/geminiLiveService', () => {
  class FakeLive {
    constructor(cfg) { this.cfg = cfg; this.sent = []; this.handlers = {}; FakeLive.instances.push(this); }
    on(e, f) { this.handlers[e] = f; return this; }
    async connect(args) { this.args = args; this.connected = true; }
    send(p) { this.sent.push(p); }
    createResponse() { this.sent.push({ type: 'response.create' }); }
    close() { this.connected = false; }
    texts() { return this.sent.filter((p) => p.type === 'conversation.item.create').map((p) => p.item.content[0].text); }
  }
  FakeLive.instances = [];
  return { GeminiLiveService: FakeLive, defaultModelForBackend: () => 'gemini-live-test', resolveLiveBackend: () => 'vertex' };
});

process.env.TELNYX_API_KEY = 'test-key';
const fetchCalls = [];
let fetchStatus = 200;
global.fetch = jest.fn(async (url, init) => {
  fetchCalls.push({ url, body: JSON.parse(init?.body || '{}') });
  return { status: url.includes('/actions/speak') ? fetchStatus : 200, json: async () => ({ data: {} }) };
});

const telnyxService = require('../services/integrations/telnyxService');
const { GeminiLiveService } = require('../services/integrations/geminiLiveService');
const notice = require('../services/aiOutboundRecordingNotice');
const svc = require('../services/aiOutboundCallService');

const baseCtx = (over = {}) => ({
  callMongoId: '64b0000000000000000000c1',
  leadId: '64b0000000000000000000d1',
  gigId: '64b0000000000000000000e1',
  voiceAssistant: { enabled: true },
  callScript: { text: 'Script', greeting: 'Bonjour, ici HARX.', language: 'fr' },
  gig: {},
  lead: {},
  wsBase: 'wss://dash.test',
  streamUrl: 'wss://dash.test/ai-voice-stream/tok',
  streamToken: 'tok',
  ...over,
});

beforeEach(() => {
  fetchCalls.length = 0;
  fetchStatus = 200;
  GeminiLiveService.instances.length = 0;
  telnyxService.startCallRecording.mockClear();
  svc.activeSessions.clear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });

describe('Annonce d\'enregistrement : textes et langue', () => {
  test('textes exacts par langue', () => {
    expect(notice.getRecordingNotice('fr').text).toBe('Cet appel est enregistré.');
    expect(notice.getRecordingNotice('en').text).toBe('This call is recorded.');
    expect(notice.getRecordingNotice('es').text).toBe('Esta llamada está siendo grabada.');
    expect(notice.getRecordingNotice('ar').text).toBe('هذه المكالمة مسجلة.');
  });

  test('langue normalisée, français par défaut', () => {
    expect(notice.normalizeNoticeLanguage('en-GB')).toBe('en');
    expect(notice.normalizeNoticeLanguage('es_ES')).toBe('es');
    expect(notice.normalizeNoticeLanguage('arb')).toBe('ar');
    expect(notice.normalizeNoticeLanguage('ar-MA')).toBe('ar');
    expect(notice.normalizeNoticeLanguage('English')).toBe('en');
    expect(notice.normalizeNoticeLanguage('de')).toBe('fr');
    expect(notice.normalizeNoticeLanguage(undefined)).toBe('fr');
  });

  test('langue de l\'appel : script, puis assistant, puis gig', () => {
    expect(notice.resolveCallLanguage({ callScript: { language: 'es' }, voiceAssistant: { language: 'en' } })).toBe('es');
    expect(notice.resolveCallLanguage({ callScript: null, voiceAssistant: { language: 'en-US' } })).toBe('en');
    expect(notice.resolveCallLanguage({ gig: { language: 'ar' } })).toBe('ar');
    expect(notice.resolveCallLanguage({})).toBe('fr');
  });
});

describe('Twilio : <Say> avant <Connect><Stream>', () => {
  const run = async (ctxOver) => {
    const ctx = baseCtx({ telephonyProvider: 'twilio', ...ctxOver });
    svc.registerStreamSession('tok', ctx);
    const xml = await svc.handleTwilioAiOutboundVoice({ query: { streamToken: 'tok' }, body: { CallSid: 'CA1' } });
    svc.unregisterStreamSession('tok');
    return { xml, ctx, live: GeminiLiveService.instances[0] };
  };

  test('annonce française jouée avant le flux ; l\'IA ne parle qu\'au démarrage du flux', async () => {
    const { xml, ctx, live } = await run();
    expect(xml).toContain('<Say language="fr-FR" voice="Polly.Lea">Cet appel est enregistré.</Say>');
    expect(xml.indexOf('<Say')).toBeLessThan(xml.indexOf('<Connect>'));
    expect(xml).toContain('<Stream url="wss://dash.test/ai-voice-stream/tok"');
    expect(live.texts()).toHaveLength(0);
    ctx.onStreamStart('MZ1');
    expect(live.texts()).toHaveLength(1);
    expect(live.texts()[0]).toContain('Bonjour, ici HARX.');
    expect(live.texts()[0]).not.toContain('Cet appel est enregistré');
  });

  test('langue de l\'appel respectée (anglais, arabe)', async () => {
    const en = await run({ callScript: { text: 'S', greeting: 'Hi', language: 'en' } });
    expect(en.xml).toContain('<Say language="en-US" voice="Polly.Joanna">This call is recorded.</Say>');
    GeminiLiveService.instances.length = 0;
    const ar = await run({ callScript: { text: 'S', greeting: 'مرحبا', language: 'ar' } });
    expect(ar.xml).toContain('voice="Polly.Zeina"');
    expect(ar.xml).toContain('هذه المكالمة مسجلة.');
  });
});

describe('Telnyx : enregistrement + annonce au décroché, flux IA ensuite', () => {
  const answer = async (ctxOver) => {
    const ctx = baseCtx({ telephonyProvider: 'telnyx', callControlId: 'v3:abc', ...ctxOver });
    svc.activeSessions.set('v3:abc', ctx);
    await svc.handleAiOutboundWebhook({ event_type: 'call.answered', payload: { call_control_id: 'v3:abc' } });
    return ctx;
  };

  test('enregistrement démarré puis annonce jouée ; aucune IA avant call.speak.ended', async () => {
    const ctx = await answer({ callScript: { text: 'S', greeting: 'Hola', language: 'es' } });
    expect(telnyxService.startCallRecording).toHaveBeenCalledWith('v3:abc');
    const speak = fetchCalls.find((c) => c.url.endsWith('/actions/speak'));
    expect(speak.body).toEqual({ payload: 'Esta llamada está siendo grabada.', voice: 'female', language: 'es-ES' });
    expect(GeminiLiveService.instances).toHaveLength(0);
    expect(fetchCalls.some((c) => c.url.endsWith('/streaming_start'))).toBe(false);

    await svc.handleAiOutboundWebhook({ event_type: 'call.speak.ended', payload: { call_control_id: 'v3:abc', status: 'completed' } });
    expect(fetchCalls.some((c) => c.url.endsWith('/streaming_start'))).toBe(true);
    const live = GeminiLiveService.instances[0];
    expect(live.texts()).toHaveLength(1);
    expect(live.texts()[0]).not.toContain('grabada');
    expect(ctx.noticePending).toBe(false);
    svc.activeSessions.delete('v3:abc');
  });

  test('raccroché pendant l\'annonce : pas de flux IA', async () => {
    await answer();
    await svc.handleAiOutboundWebhook({ event_type: 'call.speak.ended', payload: { call_control_id: 'v3:abc', status: 'call_hangup' } });
    expect(GeminiLiveService.instances).toHaveLength(0);
    await svc.handleAiOutboundWebhook({ event_type: 'call.hangup', payload: { call_control_id: 'v3:abc' } }).catch(() => null);
  });

  test('annonce impossible : l\'IA dit l\'annonce en tout premier (repli)', async () => {
    fetchStatus = 422;
    await answer();
    const live = GeminiLiveService.instances[0];
    expect(live.texts()).toHaveLength(1);
    expect(live.texts()[0]).toMatch(/^FIRST, before anything else, say EXACTLY these words, word for word: "Cet appel est enregistré\."/);
    svc.activeSessions.delete('v3:abc');
  });

  test('call.speak.ended non reçu : flux ouvert après le délai', async () => {
    jest.useFakeTimers();
    await answer();
    expect(GeminiLiveService.instances).toHaveLength(0);
    jest.advanceTimersByTime(svc.NOTICE_SPEAK_TIMEOUT_MS + 10);
    jest.useRealTimers();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(GeminiLiveService.instances).toHaveLength(1);
    svc.activeSessions.delete('v3:abc');
  });
});
