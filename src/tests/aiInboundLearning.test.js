jest.mock('../models/Lead', () => ({ Lead: {} }));
jest.mock('../models/Call', () => ({ Call: {} }));
jest.mock('../models/Gig', () => ({}));

process.env.JWT_SECRET = 'test-secret';
const jwt = require('jsonwebtoken');
const svc = require('../services/aiInboundService');
const L = require('../services/aiInboundLearning');

const A = '64b0000000000000000000a1';
const SID = `CA${'3'.repeat(32)}`;
const ENV = { AI_INBOUND_ENABLED: 'true', AI_INBOUND_COMPANY_IDS: A, PUBLIC_BASE_URL: 'https://dash.test' };
const ANN = "Bonjour. Je suis l'assistante virtuelle de l'entreprise, une intelligence artificielle. Notre échange est transcrit pour traiter votre demande. Vous pouvez demander à parler à une personne à tout moment.";
const body = (over = {}) => ({
  callSid: SID, companyId: A, from: '+33612345678', to: '+33140000000', language: 'fr-FR', languages: ['fr-FR'], voice: 'female', companyName: 'Cabinet',
  knowledgeBase: { enabled: true }, actions: { request: true }, transferTargets: [], maxCallSeconds: 480, announcement: { mode: 'engine', text: ANN },
  orchestratorUrl: 'https://orch.test/api', timeZone: 'Europe/Paris', ...over,
});
class FakeEngine {
  constructor(cfg) { this.cfg = cfg; this.handlers = {}; }
  on(e, f) { (this.handlers[e] = this.handlers[e] || []).push(f); return this; }
  emit(e, ...a) { return (this.handlers[e] || []).map((f) => f(...a)); }
  async connect(args) { this.args = args; this.connected = true; }
  send() {} createResponse() {} close() { this.closed = true; }
}
const okFetch = (calls) => jest.fn(async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ data: {} }) }; });
const make = async ({ over = {}, generate, calls = [], env = ENV } = {}) => {
  let engine;
  const out = await svc.createInboundSession(body(over), { env, fetchImpl: okFetch(calls), createEngine: (cfg) => { engine = new FakeEngine(cfg); return engine; }, learningGenerate: generate });
  return { ctx: svc.sessions.get(out.sessionId), engine, calls };
};

beforeEach(() => { jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

describe('apprentissage : réponses validées injectées, analyse après appel', () => {
  test('seules les réponses VALIDÉES reçues de l’orchestrateur sont dans les consignes (FAQ et consignes apprises)', async () => {
    const { engine } = await make({ over: { learnedAnswers: [{ kind: 'faq', question: 'Ouvert le samedi ?', answer: 'Oui, de 9 h à 12 h.' }, { kind: 'instruction', answer: 'Toujours proposer le mardi.' }] } });
    expect(engine.args.instructions).toMatch(/Réponses validées par l'entreprise[\s\S]*Ouvert le samedi \?[\s\S]*Oui, de 9 h à 12 h\./);
    expect(engine.args.instructions).toMatch(/Consignes apprises validées[\s\S]*Toujours proposer le mardi\./);
    const { engine: e2 } = await make();
    expect(e2.args.instructions).not.toMatch(/Réponses validées/);
  });

  test('après l’appel : UN appel au modèle texte, propositions anonymisées envoyées avec le jeton d’appel, APRÈS le compte rendu', async () => {
    const generate = jest.fn(async () => ({ text: JSON.stringify({ proposals: [{ kind: 'caller_correction', question: 'Horaires du samedi pour Jeanne Dupont ?', proposedAnswer: 'Ouvert jusqu’à 13 h, rappeler au 06 12 34 56 78', confidence: 0.8 }], unanswered: 1, callerNames: ['Jeanne Dupont'] }) }));
    const { ctx, calls } = await make({ generate });
    ctx.onStreamStart('MZ');
    ctx.transcript.push({ speaker: 'caller', text: 'Vous fermez à 13 h le samedi, pas à 12 h.', at: new Date().toISOString() });
    await svc.finishSession(ctx, 'caller_hangup');
    await ctx.learningRun;
    expect(generate).toHaveBeenCalledTimes(1);
    const urls = calls.map((c) => c.url);
    const iReport = urls.findIndex((u) => u.endsWith('/report')); const iLearn = urls.findIndex((u) => u.endsWith('/learning'));
    expect(iReport).toBeGreaterThanOrEqual(0); expect(iLearn).toBeGreaterThan(iReport);
    const sent = JSON.parse(calls[iLearn].init.body);
    expect(JSON.stringify(sent.proposals)).not.toMatch(/Jeanne|Dupont|06 12/);
    expect(sent.proposals[0]).toMatchObject({ kind: 'caller_correction', confidence: 0.8 });
    expect(sent.unanswered).toBe(1);
    const tok = jwt.verify(calls[iLearn].init.headers.Authorization.replace('Bearer ', ''), 'test-secret');
    expect(tok).toMatchObject({ scope: 'ai-inbound-call', companyId: A, callSid: SID });
    await svc.finishSession(ctx, 'caller_hangup');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('désactivable (réglage ou variable), sans parole de l’appelant : aucun appel au modèle', async () => {
    const generate = jest.fn(async () => ({ text: '{}' }));
    const a = await make({ generate, over: { learning: false } });
    a.ctx.onStreamStart('MZ'); a.ctx.transcript.push({ speaker: 'caller', text: 'Bonjour' });
    await svc.finishSession(a.ctx, 'caller_hangup'); await a.ctx.learningRun;
    const b = await make({ generate, env: { ...ENV, AI_LEARNING_ENABLED: 'false' } });
    b.ctx.onStreamStart('MZ'); b.ctx.transcript.push({ speaker: 'caller', text: 'Bonjour' });
    await svc.finishSession(b.ctx, 'caller_hangup'); await b.ctx.learningRun;
    const c = await make({ generate });
    c.ctx.onStreamStart('MZ');
    await svc.finishSession(c.ctx, 'caller_hangup'); await c.ctx.learningRun;
    expect(generate).not.toHaveBeenCalled();
  });

  test('modèle en échec ou trop lent : rien n’est envoyé, jamais d’exception', async () => {
    const calls = [];
    const ctx = { s: { learning: true, language: 'fr-FR', callSid: SID }, actions: [] };
    expect(await L.analyzeCall(ctx, { transcript: [{ speaker: 'caller', text: 'x' }], endReason: 'caller_hangup' }, { generate: async () => { throw new Error('down'); } })).toBeNull();
    expect(await L.analyzeCall(ctx, { transcript: [{ speaker: 'caller', text: 'x' }] }, { generate: () => new Promise(() => {}), timeoutMs: 20 })).toBeNull();
    expect(await L.analyzeCall(ctx, { transcript: [{ speaker: 'caller', text: 'x' }] }, { generate: async () => ({ text: 'pas du json' }) })).toMatchObject({ proposals: [] });
    expect(calls).toHaveLength(0);
  });

  test('coût borné : transcription tronquée, sortie limitée, aucune donnée Google demandée', () => {
    const long = Array.from({ length: 2000 }, (_, i) => ({ speaker: 'caller', text: `phrase ${i}` }));
    const p = L.buildPrompt(long, { knowledgeMisses: 0, transferred: false, endReason: 'x' });
    expect(p.length).toBeLessThan(L.MAX_TRANSCRIPT_CHARS + 3000);
    expect(L.MAX_OUTPUT_TOKENS).toBeLessThanOrEqual(600);
    expect(p).not.toMatch(/Gmail|Agenda Google|calendar/i);
    expect(p).toMatch(/N'invente jamais de réponse/);
  });

  test('anonymisation : noms, numéros, e-mails', () => {
    const t = L.anonymize("Je m'appelle Paul Leroy, mon mail paul@ex.fr, tél +33 6 12 34 56 78, Mme Durand", ['Paul Leroy']);
    expect(t).not.toMatch(/Paul|Leroy|paul@|12 34|Durand/);
  });
});
