jest.mock('../models/Lead', () => ({ Lead: {} }));
jest.mock('../models/Call', () => ({ Call: {} }));
jest.mock('../models/Gig', () => ({}));

process.env.JWT_SECRET = 'test-secret';
const EventEmitter = require('events');
const jwt = require('jsonwebtoken');
const svc = require('../services/aiInboundService');
const tools = require('../services/aiInboundTools');
const { TurnLatencyMeter } = require('../utils/turnLatency');
const { emptyUsage, addOpenAiUsage, addGeminiUsage, estimateCost } = require('../services/aiUsageCost');
const { linearToMulaw } = require('../utils/telephonyAudioCodec');
const { OpenAIRealtimeService, DEFAULT_MODEL, CURRENT_REALTIME_MODEL } = require('../services/integrations/openaiRealtimeService');
const { GeminiLiveService } = require('../services/integrations/geminiLiveService');
const { getSessionByStreamToken } = require('../services/aiOutboundCallService');
const setupAiVoiceBridge = require('../websocket/aiVoiceBridge');
const { authenticateAiInbound } = require('../routes/aiInbound');

const A = '64b0000000000000000000a1';
const SID = `CA${'1'.repeat(32)}`;
const ENV = { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: A, PUBLIC_BASE_URL: 'https://dash.test', AI_INBOUND_END_DRAIN_MS: '10' };
const ANN = "Bonjour, vous êtes bien chez Cabinet Martin. Je suis l'assistante virtuelle de l'entreprise, une intelligence artificielle. Notre échange est transcrit pour traiter votre demande. Vous pouvez demander à parler à une personne à tout moment.";
const body = (over = {}) => ({
  callSid: SID, companyId: A, from: '+33612345678', to: '+33140000000', level: 'partial', trigger: 'outside_hours', language: 'fr-FR', languages: ['fr-FR', 'en-GB'],
  voice: 'female', addressForm: 'vous', tone: 'professional', companyName: 'Cabinet Martin', instructions: 'Nous sommes un cabinet de kinésithérapie.',
  knowledgeBase: { enabled: true, gigId: null }, actions: { appointment: true, request: true, transfer: true }, transferTargets: [{ id: 'e1', name: 'Mme Martin' }],
  maxCallSeconds: 480, announcement: { mode: 'engine', text: ANN }, orchestratorUrl: 'https://orch.test/api', timeZone: 'Europe/Paris', ...over,
});

class FakeEngine {
  constructor(cfg, behaviour = {}) { this.cfg = cfg; this.behaviour = behaviour; this.handlers = {}; this.sent = []; this.audio = []; this.connected = false; }
  on(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); return this; }
  emit(e, ...a) { return (this.handlers[e] || []).map((f) => f(...a)); }
  async connect(args) { if (this.behaviour.fail) throw new Error('engine down'); this.args = args; this.connected = true; }
  send(p) { this.sent.push(p); }
  createResponse() { this.sent.push({ type: 'response.create' }); }
  appendInputAudio(p) { this.audio.push(p); }
  close() { this.closed = true; this.connected = false; }
  texts() { return this.sent.filter((p) => p.type === 'conversation.item.create').map((p) => p.item.content[0].text); }
}

const okFetch = (calls = []) => jest.fn(async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ success: true, data: url.includes('lookup_caller') ? { known: true, name: 'Jeanne Dupont' } : {} }) }; });
let clock;
const make = async ({ fail = [], env = ENV, over = {}, fetchImpl = okFetch() } = {}) => {
  const engines = [];
  const out = await svc.createInboundSession(body(over), {
    env, fetchImpl, now: () => clock, learningGenerate: async () => ({ text: '{}' }),
    createEngine: (cfg) => { const e = new FakeEngine(cfg, { fail: fail.includes(cfg.provider) }); engines.push(e); return e; },
  });
  const ctx = svc.sessions.get(out.sessionId);
  return { out, ctx, engines, engine: engines[engines.length - 1], fetchImpl };
};

beforeEach(() => { clock = Date.parse('2026-11-03T19:00:00Z'); jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(async () => { for (const ctx of [...svc.sessions.values()]) await svc.finishSession(ctx, 'caller_hangup'); jest.restoreAllMocks(); jest.useRealTimers(); });

describe('API interne : jeton de service ai-inbound', () => {
  const run = (authorization) => { const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } }; const next = jest.fn(); authenticateAiInbound({ headers: { authorization } }, res, next); return { res, next }; };
  test('refuse sans jeton, jeton utilisateur, mauvaise portée, sans expiration ; accepte ai-inbound', () => {
    expect(run(undefined).res.code).toBe(401);
    expect(run(`Bearer ${jwt.sign({ userId: 'u', scope: 'ai-inbound' }, 'test-secret', { expiresIn: 60 })}`).res.code).toBe(401);
    expect(run(`Bearer ${jwt.sign({ scope: 'center-data' }, 'test-secret', { expiresIn: 60 })}`).res.code).toBe(401);
    expect(run(`Bearer ${jwt.sign({ scope: 'ai-inbound' }, 'test-secret')}`).res.code).toBe(401);
    expect(run(`Bearer ${jwt.sign({ scope: 'ai-inbound' }, 'autre', { expiresIn: 60 })}`).res.code).toBe(401);
    expect(run(`Bearer ${jwt.sign({ scope: 'ai-inbound' }, 'test-secret', { expiresIn: 60 })}`).next).toHaveBeenCalled();
    expect(run(`Bearer ${jwt.sign({ scope: 'ai-inbound' }, 'test-secret', { expiresIn: 600 })}`).res.code).toBe(401);
    const old = Math.floor(Date.now() / 1000) - 300;
    expect(run(`Bearer ${jwt.sign({ scope: 'ai-inbound', iat: old, exp: old + 100 + 300 }, 'test-secret')}`).res.code).toBe(401);
  });
});

describe('activation limitée à la recette', () => {
  test('désactivée par défaut, drapeau ET liste blanche requis', async () => {
    expect(svc.inboundAllowed(A, {})).toBe(false);
    expect(svc.inboundAllowed(A, { AI_INBOUND_ENABLED: 'true' })).toBe(false);
    expect(svc.inboundAllowed(A, { AI_INBOUND_COMPANY_IDS: A })).toBe(false);
    expect(svc.inboundAllowed(A, ENV)).toBe(true);
    await expect(make({ env: { ...ENV, AI_INBOUND_ENABLED: 'false' } })).rejects.toMatchObject({ status: 403, code: 'ai_inbound_disabled' });
  });
  test('requête invalide (annonce sans mention IA, durée hors bornes) : 400', async () => {
    await expect(make({ over: { announcement: { mode: 'engine', text: 'Bonjour.' } } })).rejects.toMatchObject({ status: 400 });
    await expect(make({ over: { maxCallSeconds: 3600 } })).rejects.toMatchObject({ status: 400 });
  });
});

describe('moteur : Gemini principal, OpenAI en repli', () => {
  test('Gemini connecté avant la réponse (session ouverte dès la sonnerie), voix native, VAD réglée, 8 kHz sans rééchantillonnage', async () => {
    const { out, engine, ctx } = await make();
    expect(out).toMatchObject({ provider: 'gemini', fallbackUsed: false });
    expect(out.streamUrl).toMatch(/^wss:\/\/dash\.test\/ai-voice-stream\/[0-9a-f]{32}$/);
    expect(engine.connected).toBe(true);
    expect(engine.cfg).toMatchObject({ voice: 'Aoede', inputSampleRate: 8000, languageCode: 'fr-FR' });
    expect(engine.args.vad).toMatchObject({ silenceDurationMs: 500 });
    expect(getSessionByStreamToken(out.streamUrl.split('/').pop())).toBe(ctx);
    expect(engine.maxReconnects).toBe(0);
  });
  test('Gemini en échec : repli OpenAI gpt-realtime-2.1-mini, voix masculine native', async () => {
    const { out, engine } = await make({ fail: ['gemini'], over: { voice: 'male' } });
    expect(out).toMatchObject({ provider: 'openai', model: 'gpt-realtime-2.1-mini', fallbackUsed: true });
    expect(engine.cfg.voice).toBe('cedar');
    expect(engine.args.turnDetection).toMatchObject({ type: 'server_vad', silence_duration_ms: 500, interrupt_response: true });
  });
  test('aucun moteur : 503 (l’orchestrateur passe au flux classique)', async () => {
    await expect(make({ fail: ['gemini', 'openai'] })).rejects.toMatchObject({ status: 503, code: 'engine_unavailable' });
    await expect(make({ fail: ['gemini'], env: { ...ENV, AI_INBOUND_FALLBACK_PROVIDER: 'none' } })).rejects.toMatchObject({ status: 503 });
  });
  test('banc d’écoute : moteur imposé', async () => {
    expect((await make({ over: { provider: 'openai' } })).out.provider).toBe('openai');
  });
  test('gpt-realtime déprécié remplacé par l’identifiant courant (appels sortants compris)', () => {
    expect(CURRENT_REALTIME_MODEL).toBe('gpt-realtime-2.1');
    if (!process.env.OPENAI_REALTIME_MODEL) expect(DEFAULT_MODEL).toBe('gpt-realtime-2.1');
  });
});

describe('consignes d’accueil et voix naturelle', () => {
  const ins = (over = {}) => svc.buildInboundInstructions({ ...body(over), maxCallSeconds: 480 }, { caller: { known: true, name: 'Jeanne Dupont' } });
  test('accueil de l’entreprise, jamais le script commercial sortant', () => {
    const t = ins();
    expect(t).toMatch(/assistante virtuelle de Cabinet Martin/);
    expect(t).not.toMatch(/outbound|lead/i);
    expect(t).toMatch(/Jeanne Dupont/);
    expect(t.indexOf("## Consignes de l'entreprise")).toBeGreaterThan(t.indexOf('## Identité'));
  });
  test('identité : ne prétend jamais être humain', () => { expect(ins()).toMatch(/Ne prétends JAMAIS être une personne/); });
  test('style oral : phrases courtes, pas de liste, reformulation, marques d’écoute, pas de répétition, barge-in', () => {
    const t = ins();
    for (const re of [/Phrases courtes et orales/, /Jamais de liste lue/, /Reformule/, /marques d'écoute/, /Ne répète jamais mécaniquement/, /arrête-toi immédiatement/]) expect(t).toMatch(re);
  });
  test('phrase d’attente avant un outil lent', () => { expect(ins()).toMatch(/Je regarde ça pour vous/); });
  test('déclencheur « tous occupés » (appel simultané dans la capacité de la ligne) : consigne adaptée', () => {
    expect(ins({ trigger: 'all_busy' })).toMatch(/l'équipe est déjà en ligne/);
    expect(ins()).not.toMatch(/l'équipe est déjà en ligne/);
  });
  test('vouvoiement par défaut, tutoiement réglable, langues et accent', () => {
    expect(ins()).toMatch(/Vouvoie toujours/);
    expect(ins({ addressForm: 'tu' })).toMatch(/Tutoie l'appelant/);
    expect(ins()).toMatch(/français de France.*anglais britannique/s);
  });
  test('pas de promesse hors base ; humain toujours possible (transfert ou rappel)', () => {
    expect(ins()).toMatch(/UNIQUEMENT à partir de ce qu'il renvoie/);
    expect(ins()).toMatch(/Ne promets jamais un prix/);
    expect(ins()).toMatch(/transfer_to_human.*Mme Martin/s);
    expect(ins({ actions: { request: false, transfer: false } })).toMatch(/humanCallback=true/);
  });
  test('ouverture : annonce IA mot pour mot, voix naturelle', () => {
    expect(svc.openingPrompt(body())).toContain(`« ${ANN} »`);
    expect(svc.openingPrompt(body())).toMatch(/sans ton robotique/);
    expect(svc.openingPrompt(body({ announcement: { mode: 'twiml', text: ANN } }))).not.toContain(ANN);
  });
});

describe('annonce IA obligatoire (AI Act art. 50)', () => {
  test('dite dès le début du flux, voix de l’appelant retenue jusqu’à la fin de l’annonce, puis vérifiée', async () => {
    const { ctx, engine } = await make();
    expect(ctx.holdInput).toBe(true);
    ctx.onStreamStart('MZ1');
    expect(engine.texts()[0]).toContain(ANN);
    engine.emit('onTranscript', { type: 'gemini.output_transcription', cumulative: true, text: "Bonjour, vous êtes bien chez Cabinet Martin. Je suis l'assistante virtuelle de l'entreprise, une intelligence artificielle." });
    engine.emit('onSpeechStopped');
    expect(ctx.announcement.verified).toBe(true);
    expect(ctx.holdInput).toBe(false);
  });
  test('annonce oubliée : redemandée une fois, puis l’appel quitte l’IA (répondeur)', async () => {
    const calls = [];
    const { ctx, engine } = await make({ fetchImpl: okFetch(calls) });
    ctx.onStreamStart('MZ1');
    engine.emit('onTranscript', { type: 'gemini.output_transcription', cumulative: true, text: 'Bonjour, que puis-je faire pour vous ?' });
    engine.emit('onSpeechStopped');
    expect(engine.texts()[1]).toMatch(/Tu n'as pas dit l'annonce obligatoire/);
    engine.emit('onTranscript', { type: 'gemini.output_transcription', cumulative: true, text: 'Comment puis-je vous aider ?' });
    engine.emit('onSpeechStopped');
    await new Promise((r) => setImmediate(r));
    const report = calls.find((c) => c.url.endsWith(`/calls/${SID}/report`));
    expect(JSON.parse(report.init.body)).toMatchObject({ endReason: 'engine_error', announcement: { verified: false } });
    expect(engine.closed).toBe(true);
  });
});

describe('pont audio : barge-in et retenue pendant l’annonce', () => {
  test('audio de l’appelant non transmis pendant l’annonce, transmis ensuite ; l’appelant parle → « clear » envoyé à Twilio', async () => {
    const { ctx, engine, out } = await make();
    const server = new EventEmitter();
    const wss = setupAiVoiceBridge(server);
    const ws = new EventEmitter(); ws.readyState = 1; ws.sent = []; ws.send = (x) => ws.sent.push(JSON.parse(x)); ws.close = jest.fn();
    wss.emit('connection', ws, { url: `/ai-voice-stream/${out.streamUrl.split('/').pop()}` });
    ws.emit('message', JSON.stringify({ event: 'start', start: { streamSid: 'MZ1', callSid: SID, accountSid: 'AC' } }));
    expect(engine.texts()[0]).toContain(ANN);
    ws.emit('message', JSON.stringify({ event: 'media', media: { payload: 'AAAA' } }));
    expect(engine.audio).toHaveLength(0);
    ctx.holdInput = false;
    ws.emit('message', JSON.stringify({ event: 'media', media: { payload: 'AAAA' } }));
    expect(engine.audio).toEqual(['AAAA']);
    engine.emit('onSpeechStarted');
    expect(ws.sent).toContainEqual({ event: 'clear', streamSid: 'MZ1' });
    engine.emit('onAudioDelta', 'BBBB');
    expect(ws.sent).toContainEqual({ event: 'media', media: { payload: 'BBBB' }, streamSid: 'MZ1' });
  });
});

describe('latence par tour', () => {
  const loud = Buffer.alloc(160, linearToMulaw(8000)).toString('base64');
  const quiet = Buffer.alloc(160, linearToMulaw(0)).toString('base64');
  test('fin de parole de l’appelant → premier son de l’IA', () => {
    let t = 0;
    const m = new TurnLatencyMeter({ now: () => t });
    for (let i = 0; i < 10; i += 1) { t += 20; m.onInbound(loud); }
    const end = t;
    for (let i = 0; i < 30; i += 1) { t += 20; m.onInbound(quiet); }
    t = end + 640; m.onOutbound(); t += 20; m.onOutbound();
    m.onAgentTurnEnd();
    for (let i = 0; i < 5; i += 1) { t += 20; m.onInbound(loud); }
    const end2 = t; t = end2 + 910; m.onOutbound();
    expect(m.stats()).toMatchObject({ turns: [640, 910], medianMs: 775, p95Ms: 910 });
  });
  test('bruit bref (clic) ignoré', () => {
    let t = 0; const m = new TurnLatencyMeter({ now: () => t });
    m.onInbound(loud); m.onInbound(quiet); t = 500; m.onOutbound();
    expect(m.stats().turns).toEqual([]);
  });
});

describe('outils : entreprise de la session uniquement, délais courts, phrase d’attente', () => {
  test('outil orch : jeton d’appel, companyId du modèle supprimé', async () => {
    const calls = [];
    const out = await tools.executeInboundTool('create_request', { reason: 'x', companyId: 'autre' }, { orchestratorUrl: 'https://orch.test/api', companyId: A, callSid: SID }, { fetchImpl: okFetch(calls) });
    expect(out.ok).toBe(true);
    expect(calls[0].url).toBe('https://orch.test/api/internal/ai-inbound/tools/create_request');
    const t = jwt.verify(calls[0].init.headers.Authorization.replace('Bearer ', ''), 'test-secret');
    expect(t).toMatchObject({ scope: 'ai-inbound-call', companyId: A, callSid: SID });
    expect(t.exp - t.iat).toBeLessThanOrEqual(120);
    expect(JSON.parse(calls[0].init.body)).toEqual({ reason: 'x' });
  });
  test('délai dépassé : réponse de repli, jamais d’exception', async () => {
    const slow = jest.fn((url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))));
    const out = await tools.executeInboundTool('find_slots', {}, { orchestratorUrl: 'https://o/api', companyId: A, callSid: SID }, { fetchImpl: slow, timeoutMs: 20 });
    expect(out).toMatchObject({ ok: false, error: 'timeout' });
    expect(out.fallback).toMatch(/propose de faire rappeler/);
  });
  test('recherche de connaissances : companyId de la session, jamais un argument du modèle', async () => {
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { passages: [] } }) }));
    await tools.executeInboundTool('search_knowledge', { query: 'tarif', companyId: 'autre' }, { companyId: A, knowledgeBase: { enabled: true, gigId: null } });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).companyId).toBe(A);
    delete global.fetch;
  });
  test('déclarations selon les actions autorisées', () => {
    const names = (s) => tools.buildInboundTools(s).map((t) => t.name);
    expect(names({ actions: { appointment: false, transfer: false }, knowledgeBase: { enabled: false } })).toEqual(['lookup_caller', 'create_request', 'end_call']);
    expect(names({ actions: { appointment: true, transfer: true }, transferTargets: [{ id: 'e1', name: 'X' }] })).toEqual(['search_knowledge', 'lookup_caller', 'create_request', 'find_slots', 'book_appointment', 'transfer_to_human', 'end_call']);
  });
  test('outil lent sans phrase d’attente juste avant : compté dans la fiche', async () => {
    const fetchImpl = jest.fn(async () => { clock += 900; return { ok: true, status: 200, json: async () => ({ data: { slots: [] } }) }; });
    const { ctx, engine } = await make({ fetchImpl });
    ctx.lastOutboundAt = 0;
    await engine.handlers.onToolCall[0]({ name: 'find_slots', args: {} });
    expect(ctx.toolFillerMissed).toBe(1);
    ctx.onOutboundMedia();
    await engine.handlers.onToolCall[0]({ name: 'find_slots', args: {} });
    expect(ctx.toolFillerMissed).toBe(1);
  });
});

describe('garde-fous de durée et fin d’appel', () => {
  test('60 s avant la fin : consigne de résumé et de rappel ; à la fin : compte rendu max_duration puis fermeture du flux', async () => {
    jest.useFakeTimers();
    const calls = [];
    const { ctx, engine } = await make({ fetchImpl: okFetch(calls) });
    ctx.mediaStreamWs = { readyState: 1, close: jest.fn() };
    ctx.onStreamStart('MZ');
    jest.advanceTimersByTime(419000);
    expect(engine.texts().some((t) => /Il reste une minute/.test(t))).toBe(false);
    jest.advanceTimersByTime(1000);
    expect(engine.texts().some((t) => /Il reste une minute.*propose un rappel/.test(t))).toBe(true);
    jest.advanceTimersByTime(60000);
    await Promise.resolve(); await Promise.resolve();
    const report = calls.find((c) => c.url.includes('/report'));
    expect(JSON.parse(report.init.body).endReason).toBe('max_duration');
    await Promise.resolve();
    expect(ctx.mediaStreamWs.close).toHaveBeenCalled();
  });
  test('end_call : résumé de l’IA, compte rendu AVANT la fermeture du flux', async () => {
    const order = [];
    const fetchImpl = jest.fn(async (url) => { order.push(url.includes('/report') ? 'report' : 'tool'); return { ok: true, status: 200, json: async () => ({ data: {} }) }; });
    const { ctx, engine } = await make({ fetchImpl });
    ctx.mediaStreamWs = { readyState: 1, close: jest.fn(() => order.push('close')) };
    ctx.onStreamStart('MZ');
    await engine.handlers.onToolCall[0]({ name: 'end_call', args: { summary: 'RDV pris jeudi 10 h.' } });
    await new Promise((r) => setTimeout(r, 40));
    expect(order.slice(-2)).toEqual(['report', 'close']);
    expect(ctx.lastReport.summary).toBe('RDV pris jeudi 10 h.');
    expect(ctx.lastReport.endReason).toBe('agent_end');
  });
  test('coupure du moteur en cours d’appel : compte rendu engine_error (l’orchestrateur passe au répondeur)', async () => {
    const calls = [];
    const { ctx, engine } = await make({ fetchImpl: okFetch(calls) });
    ctx.onStreamStart('MZ');
    engine.emit('onClose', { code: 1011 });
    await new Promise((r) => setImmediate(r));
    expect(JSON.parse(calls.find((c) => c.url.includes('/report')).init.body).endReason).toBe('engine_error');
  });
  test('appelant raccroche / transfert : compte rendu adapté', async () => {
    const { ctx, engine } = await make();
    ctx.onStreamStart('MZ');
    engine.handlers.onToolCall[0]; ctx.transferring = true;
    await ctx.onStreamStop('stop');
    expect(ctx.lastReport.endReason).toBe('transferred');
  });
});

describe('mesure du coût réel', () => {
  test('OpenAI : usage de response.done (audio, texte, cache)', () => {
    const svc2 = new OpenAIRealtimeService({ apiKey: 'k', logger: { log() {}, warn() {}, error() {} } });
    const seen = [];
    svc2.on('onUsage', (u) => seen.push(u));
    svc2._onMessage(JSON.stringify({ type: 'response.done', response: { usage: { input_tokens: 300, output_tokens: 420, input_token_details: { audio_tokens: 240, text_tokens: 60, cached_tokens: 50, cached_tokens_details: { text_tokens: 50 } }, output_token_details: { audio_tokens: 420 } } } }));
    const u = addOpenAiUsage(emptyUsage('openai', 'gpt-realtime-2.1-mini'), seen[0]);
    expect(u).toMatchObject({ inputAudioTokens: 240, inputTextTokens: 60, cachedTokens: 50, outputAudioTokens: 420 });
    const c = estimateCost(u, { durationSeconds: 60, env: {} });
    expect(c.priceKey).toBe('openai-mini');
    expect(c.usd).toBeCloseTo((240 * 10 + 10 * 0.6 + 50 * 0.3 + 420 * 20) / 1e6, 6);
  });
  test('Gemini : usageMetadata (Vertex snake_case) et part de contexte', () => {
    const g = new GeminiLiveService({ backend: 'vertex', logger: { log() {}, warn() {}, error() {} } });
    const seen = [];
    g.on('onUsage', (u) => seen.push(u));
    g._onMessage(JSON.stringify({ usage_metadata: { prompt_token_count: 4000, response_token_count: 525, prompt_tokens_details: [{ modality: 'AUDIO', token_count: 1500 }, { modality: 'TEXT', token_count: 2500 }], response_tokens_details: [{ modality: 'AUDIO', token_count: 525 }] } }));
    const u = addGeminiUsage(emptyUsage('gemini', 'm'), seen[0]);
    const c = estimateCost(u, { durationSeconds: 60, env: {} });
    expect(c.contextTokens).toBe(2500);
    expect(c.contextShare).toBe(0.625);
    expect(c.usd).toBeCloseTo((1500 * 3 + 2500 * 0.75 + 525 * 12) / 1e6, 6);
  });
  test('compte rendu : usage, coût et latences envoyés à l’orchestrateur', async () => {
    const calls = [];
    const { ctx, engine } = await make({ fetchImpl: okFetch(calls) });
    ctx.onStreamStart('MZ');
    engine.emit('onUsage', { promptTokenCount: 100, responseTokenCount: 50 });
    clock += 30000;
    await svc.finishSession(ctx, 'caller_hangup');
    const r = JSON.parse(calls.find((c) => c.url.includes('/report')).init.body);
    expect(r.usage).toMatchObject({ provider: 'gemini', inputTokens: 100, outputTokens: 50, turns: 1 });
    expect(r.cost).toHaveProperty('usd');
    expect(r.latency).toHaveProperty('turns');
    expect(new Date(r.endedAt) - new Date(r.startedAt)).toBe(30000);
  });
});

describe('revue : transfert, banc d’écoute, Gemini goAway, latence, OpenAI', () => {
  test('transfert : délai de l’outil couvrant la pause et la bascule Twilio (8 s)', async () => {
    expect(tools.TRANSFER_TIMEOUT_MS).toBeGreaterThanOrEqual(8000);
    let signalAborted = null;
    const fetchImpl = jest.fn((url, init) => new Promise((resolve) => setTimeout(() => { signalAborted = init.signal.aborted; resolve({ ok: true, status: 200, json: async () => ({ data: { transferring: true } }) }); }, 3500)));
    const out = await tools.executeInboundTool('transfer_to_human', { entryId: 'e1', reason: 'x' }, { orchestratorUrl: 'https://o/api', companyId: A, callSid: SID }, { fetchImpl });
    expect(signalAborted).toBe(false); expect(out).toMatchObject({ ok: true, transferring: true });
  }, 10000);
  test('flux arrêté pendant la bascule : compte rendu « transferred », jamais « caller_hangup »', async () => {
    let release;
    const fetchImpl = jest.fn((url) => (url.includes('transfer_to_human') ? new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => ({ data: { transferring: true } }) }); }) : okFetch()(url)));
    const { ctx, engine } = await make({ fetchImpl });
    ctx.onStreamStart('MZ');
    const pending = engine.handlers.onToolCall[0]({ name: 'transfer_to_human', args: { entryId: 'e1', reason: 'x' } });
    await ctx.onStreamStop('stop');
    expect(ctx.lastReport.endReason).toBe('transferred');
    release(); await pending;
  });
  test('le modèle ne peut pas déclencher l’enregistrement du banc', async () => {
    const { engine } = await make();
    expect(await engine.handlers.onToolCall[0]({ name: 'start_bench_recording', args: {} })).toMatchObject({ ok: false });
  });
  test('banc d’écoute : enregistrement demandé à l’orchestrateur seulement APRÈS l’annonce (consentement)', async () => {
    const calls = [];
    const { ctx, engine } = await make({ fetchImpl: okFetch(calls), over: { record: true } });
    ctx.onStreamStart('MZ');
    expect(calls.some((c) => c.url.endsWith('/start_bench_recording'))).toBe(false);
    engine.emit('onTranscript', { type: 'gemini.output_transcription', cumulative: true, text: ANN });
    engine.emit('onSpeechStopped');
    await new Promise((r) => setImmediate(r));
    expect(calls.filter((c) => c.url.endsWith('/start_bench_recording'))).toHaveLength(1);
  });
  test('Gemini : appel plafonné sous la durée de connexion (~10 min) ; goAway → conclusion anticipée', async () => {
    jest.useFakeTimers();
    const calls = [];
    const { out, ctx, engine } = await make({ fetchImpl: okFetch(calls), over: { maxCallSeconds: 900 } });
    expect(out.maxCallSeconds).toBe(540);
    ctx.onStreamStart('MZ');
    engine.emit('onGoAway', { timeLeft: '10s' });
    expect(engine.texts().some((t) => /se terminer dans quelques secondes/.test(t))).toBe(true);
    jest.advanceTimersByTime(8000);
    await Promise.resolve(); await Promise.resolve();
    expect(JSON.parse(calls.find((c) => c.url.includes('/report')).init.body).endReason).toBe('max_duration');
  });
  test('OpenAI repli : pas de plafond Gemini', async () => {
    expect((await make({ fail: ['gemini'], over: { maxCallSeconds: 900 } })).out.maxCallSeconds).toBe(900);
  });
  test('latence : tour ignoré quand l’appelant a parlé pendant que l’IA parlait', () => {
    const loud = Buffer.alloc(160, linearToMulaw(8000)).toString('base64');
    let t = 0; const m = new TurnLatencyMeter({ now: () => t });
    t = 100; m.onOutbound(); // l'IA parle
    for (let i = 0; i < 5; i += 1) { t += 20; m.onInbound(loud); } // l'appelant parle par-dessus
    t += 700; m.onOutbound();
    m.onAgentTurnEnd();
    for (let i = 0; i < 5; i += 1) { t += 20; m.onInbound(loud); }
    t += 650; m.onOutbound();
    expect(m.stats()).toMatchObject({ turns: [650], skippedOverlaps: 1 });
  });
  test('OpenAI gpt-realtime-2.x : effort de raisonnement minimal par défaut ; prix texte de sortie 24 $', () => {
    const o = new OpenAIRealtimeService({ apiKey: 'k', model: 'gpt-realtime-2.1', logger: { log() {}, warn() {}, error() {} } });
    const sent = []; o.send = (p) => sent.push(p);
    o._configureSession({ instructions: 'x', tools: [], voice: 'marin' });
    expect(sent[0].session.reasoning).toEqual({ effort: 'minimal' });
    const old = new OpenAIRealtimeService({ apiKey: 'k', model: 'gpt-4o-realtime-preview', logger: { log() {} } }); const s2 = []; old.send = (p) => s2.push(p);
    old._configureSession({ instructions: 'x', tools: [], voice: 'alloy' });
    expect(s2[0].session.reasoning).toBeUndefined();
    expect(require('../services/aiUsageCost').priceTable({}).openai.textOut).toBe(24);
  });
});
