process.env.JWT_SECRET = 'test-secret';
process.env.OPENAI_API_KEY = 'sk-test-not-real';
process.env.COMPORCHESTRATOR_API_URL = 'https://orch.example/api';

const mockChat = jest.fn();
const mockSpeech = jest.fn();
const mockTranscribe = jest.fn();
jest.mock('openai', () => {
  const OpenAI = jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockChat } },
    audio: { speech: { create: mockSpeech }, transcriptions: { create: mockTranscribe } },
  }));
  OpenAI.toFile = jest.fn(async (buf, name) => ({ name, size: buf.length }));
  return OpenAI;
});

const mockAssertAccess = jest.fn();
jest.mock('../middleware/companyScope', () => {
  const actual = jest.requireActual('../middleware/companyScope');
  return { ...actual, assertCompanyAccess: (...a) => mockAssertAccess(...a) };
});

const jwt = require('jsonwebtoken');
const { authenticateUser, ScopeError } = require('../middleware/companyScope');
const controller = require('../controllers/voiceMenu');

const makeRes = () => {
  const res = { statusCode: 200, headers: {} };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  res.set = jest.fn((h) => { Object.assign(res.headers, h); return res; });
  res.send = jest.fn((b) => { res.sent = b; return res; });
  return res;
};
const userReq = (body) => ({ body, headers: {}, auth: { userId: 'u1' } });

/** fetch mock: balance (status/tokens) + charge (status) */
function mockFetch({ balance = { status: 200, tokens: 100000 }, charge = 200 } = {}) {
  global.fetch = jest.fn(async (url) => {
    if (String(url).includes('tokens-balance')) {
      return { ok: balance.status < 400, status: balance.status, json: async () => ({ success: true, tokens: balance.tokens }) };
    }
    return { ok: charge < 400, status: charge, json: async () => ({}) };
  });
}
const chargeCalls = () => global.fetch.mock.calls.filter(([u]) => String(u).includes('charge-usage'));

beforeEach(() => {
  jest.clearAllMocks();
  controller.resetRateLimit();
  mockAssertAccess.mockResolvedValue(undefined);
  mockFetch();
  mockChat.mockResolvedValue({ choices: [{ message: { content: 'Bonjour, bienvenue chez Acme. Comment puis-je vous aider ?' } }] });
  mockSpeech.mockResolvedValue({ arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer });
});
afterEach(() => { delete global.fetch; });

describe('authenticateUser (routes front)', () => {
  test('refuse sans JWT', () => {
    const res = makeRes();
    const next = jest.fn();
    authenticateUser({ headers: {} }, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('POST /suggest', () => {
  test('génère, puis débite avec un usageId voice-suggest-', async () => {
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'greeting', companyName: 'Acme' }), res);
    expect(res.body).toEqual({ success: true, data: { text: expect.stringContaining('Acme'), tokensCharged: 1000 } });
    const [url, init] = chargeCalls()[0];
    expect(url).toBe('https://orch.example/api/tokens-company/charge-usage');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ companyId: 'c1', tokensUsed: 1000 });
    expect(body.usageId).toMatch(/^voice-suggest-/);
  });

  test('audience personne (Nomad Solo) : message personnel, sans centre', async () => {
    const res = makeRes();
    mockChat.mockClear();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'voicemail', audience: 'person', personName: 'Chafik Sabiry', companyName: 'Chafik Sabiry' }), res);
    expect(res.statusCode).toBe(200);
    const prompt = mockChat.mock.calls[0][0].messages[1].content;
    expect(prompt).toMatch(/première personne/);
    expect(prompt).toMatch(/Nom de la personne: Chafik Sabiry/);
    expect(prompt).toMatch(/Ne parle jamais de centre/);
    expect(prompt).not.toMatch(/Nom du centre/);
  });

  test('audience inconnue : 400', async () => {
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'voicemail', audience: 'robot' }), res);
    expect(res.statusCode).toBe(400);
  });

  test('nettoie markdown, guillemets, émojis et tronque', async () => {
    mockChat.mockResolvedValue({ choices: [{ message: { content: '**"Bonjour"** 😀 ' + 'mot '.repeat(100) } }] });
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'voicemail' }), res);
    expect(res.body.data.text).not.toMatch(/[*"😀]/);
    expect(res.body.data.text.length).toBeLessThanOrEqual(220);
  });

  test('type invalide => 400', async () => {
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'autre' }), res);
    expect(res.statusCode).toBe(400);
  });

  test('accès entreprise refusé => 403 sans appel OpenAI', async () => {
    mockAssertAccess.mockRejectedValue(new ScopeError(403, 'Not allowed for this company'));
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'greeting' }), res);
    expect(res.statusCode).toBe(403);
    expect(mockChat).not.toHaveBeenCalled();
  });

  test('solde insuffisant => 402 sans appel OpenAI ni débit', async () => {
    mockFetch({ balance: { status: 200, tokens: 10 } });
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'greeting' }), res);
    expect(res.statusCode).toBe(402);
    expect(res.body).toEqual({ success: false, error: 'insufficient_tokens', message: 'Solde de jetons IA insuffisant. Achetez des jetons pour continuer.' });
    expect(mockChat).not.toHaveBeenCalled();
    expect(chargeCalls()).toHaveLength(0);
  });

  test('route de solde en 404 => on ne bloque pas, le débit suit la génération', async () => {
    mockFetch({ balance: { status: 404 } });
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'greeting' }), res);
    expect(res.body.success).toBe(true);
    expect(chargeCalls()).toHaveLength(1);
  });

  test('débit refusé en 402 après génération => 402, pas de texte livré', async () => {
    mockFetch({ balance: { status: 404 }, charge: 402 });
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'greeting' }), res);
    expect(res.statusCode).toBe(402);
    expect(res.body.data).toBeUndefined();
  });

  test('OPENAI_API_KEY absent => 503', async () => {
    const key = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'greeting' }), res);
    process.env.OPENAI_API_KEY = key;
    expect(res.statusCode).toBe(503);
  });
});

describe('POST /tts', () => {
  const ok = { companyId: 'c1', text: 'Bonjour', voice: 'nova' };

  test('renvoie du MP3 brut, no-store, et débite voice-tts-', async () => {
    const res = makeRes();
    await controller.tts(userReq(ok), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('audio/mpeg');
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(Buffer.isBuffer(res.sent)).toBe(true);
    expect(mockSpeech).toHaveBeenCalledWith(expect.objectContaining({ voice: 'nova', response_format: 'mp3', model: 'gpt-4o-mini-tts' }));
    expect(JSON.parse(chargeCalls()[0][1].body)).toMatchObject({ tokensUsed: 600, usageId: expect.stringMatching(/^voice-tts-/) });
  });

  test.each([
    ['voix inconnue', { ...ok, voice: 'alloy' }],
    ['texte vide', { ...ok, text: '   ' }],
    ['texte trop long', { ...ok, text: 'a'.repeat(601) }],
  ])('%s => 400 sans OpenAI', async (_n, body) => {
    const res = makeRes();
    await controller.tts(userReq(body), res);
    expect(res.statusCode).toBe(400);
    expect(mockSpeech).not.toHaveBeenCalled();
  });

  test('solde insuffisant => 402 sans appel OpenAI', async () => {
    mockFetch({ balance: { status: 200, tokens: 0 } });
    const res = makeRes();
    await controller.tts(userReq(ok), res);
    expect(res.statusCode).toBe(402);
    expect(mockSpeech).not.toHaveBeenCalled();
  });

  test('limite de débit : 21e synthèse en 10 min => 429', async () => {
    for (let i = 0; i < controller.TTS_LIMIT; i += 1) {
      const r = makeRes();
      await controller.tts(userReq(ok), r);
      expect(r.statusCode).toBe(200);
    }
    const res = makeRes();
    await controller.tts(userReq(ok), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.message).toMatch(/Trop de synth/);
    const other = makeRes();
    await controller.tts({ ...userReq(ok), auth: { userId: 'u2' } }, other);
    expect(other.statusCode).toBe(200);
  });
});

describe('authenticateService (analyze-voicemail)', () => {
  const run = (token) => {
    const res = makeRes();
    const next = jest.fn();
    controller.authenticateService({ headers: token ? { authorization: `Bearer ${token}` } : {} }, res, next);
    return { res, next };
  };
  const sign = (claims, opts = {}) => jwt.sign(claims, 'test-secret', { algorithm: 'HS256', ...opts });

  test('jeton valide accepté', () => {
    const { next } = run(sign({ scope: 'voicemail-analyze' }, { expiresIn: 60 }));
    expect(next).toHaveBeenCalled();
  });
  test.each([
    ['sans jeton', null],
    ['mauvais scope', sign({ scope: 'company-notify' }, { expiresIn: 60 })],
    ['jeton utilisateur', sign({ userId: 'u1' }, { expiresIn: 60 })],
    ['expiré', sign({ scope: 'voicemail-analyze' }, { expiresIn: -10 })],
    ['sans expiration', sign({ scope: 'voicemail-analyze' })],
    ['mauvaise signature', jwt.sign({ scope: 'voicemail-analyze' }, 'autre', { expiresIn: 60 })],
  ])('%s => 401', (_n, token) => {
    const { res, next } = run(token);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('POST /analyze-voicemail', () => {
  const req = (over = {}) => ({
    query: { companyId: 'c1', from: '+33600000000', usageId: 'vm-123' },
    headers: { 'content-type': 'audio/mpeg' },
    body: Buffer.from('fake-audio'),
    ...over,
  });

  test('transcrit, analyse, normalise et débite avec le usageId reçu', async () => {
    mockTranscribe.mockResolvedValue({ text: 'Bonjour, je suis Marie, rappelez-moi au 0612345678 pour mon colis.' });
    mockChat.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({
        summary: 'Marie demande un rappel au sujet de son colis.', intent: 'rappel', urgency: 'extreme', sentiment: 'neutre',
        language: 'fr', callerName: 'Marie', callbackNumber: '0612345678',
        suggestedFollowUp: { action: 'Rappeler Marie', message: 'Bonjour Marie, nous vous rappelons.', dueInHours: 500 },
      }) } }],
    });
    const res = makeRes();
    await controller.analyzeVoicemail(req(), res);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      transcript: expect.stringContaining('Marie'), intent: 'rappel', urgency: 'low', callerName: 'Marie',
      callbackNumber: '0612345678', tokensCharged: 3000, suggestedFollowUp: { dueInHours: 72 },
    });
    expect(mockTranscribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'fr', model: 'gpt-4o-transcribe' }));
    expect(JSON.parse(chargeCalls()[0][1].body)).toMatchObject({ usageId: 'vm-123', tokensUsed: 3000, companyId: 'c1' });
  });

  test('transcription vide => analyse prudente, sans appel LLM, et débit quand même', async () => {
    mockTranscribe.mockResolvedValue({ text: '  ' });
    const res = makeRes();
    await controller.analyzeVoicemail(req(), res);
    expect(res.body.data).toMatchObject({ transcript: '', summary: 'Message inaudible ou vide.', urgency: 'low', callerName: null, callbackNumber: null });
    expect(mockChat).not.toHaveBeenCalled();
    expect(chargeCalls()).toHaveLength(1);
  });

  test('solde insuffisant => 402 sans OpenAI', async () => {
    mockFetch({ balance: { status: 200, tokens: 5 } });
    const res = makeRes();
    await controller.analyzeVoicemail(req(), res);
    expect(res.statusCode).toBe(402);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  test('corps audio vide => 400', async () => {
    const res = makeRes();
    await controller.analyzeVoicemail(req({ body: {} }), res);
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /action-plan', () => {
  const plan = { actions: [
    { model: 'voicemail_callback', title: 'Rappeler Mme Durand', note: 'Elle attend une réponse sur son devis.', contactName: 'Mme Durand', dueInHours: 4 },
    { model: 'appointment', title: 'Planifier un rendez-vous', note: '', contactName: null, dueInHours: null },
    { model: 'appointment', title: 'Planifier un rendez-vous', note: 'doublon', contactName: null, dueInHours: null },
    { model: 'envoyer_un_email', title: 'Modèle inconnu écarté', note: '', contactName: null, dueInHours: null },
  ] };
  const body = { companyId: 'c1', summary: 'Mme Durand demande un rendez-vous pour son devis.', transcript: 'Bonjour, c’est Mme Durand…', intent: 'rendez_vous', urgency: 'medium' };
  beforeEach(() => mockChat.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(plan) } }] }));

  test('propose des actions validées (modèles connus, sans doublon) et débite action-plan-', async () => {
    const res = makeRes();
    await controller.actionPlan(userReq(body), res);
    expect(res.body.success).toBe(true);
    expect(res.body.data.actions).toHaveLength(2);
    expect(res.body.data.actions[0]).toEqual({ model: 'voicemail_callback', title: 'Rappeler Mme Durand', note: 'Elle attend une réponse sur son devis.', contactName: 'Mme Durand', dueInHours: 4 });
    expect(res.body.data.actions[1].dueInHours).toBeNull();
    const [, init] = chargeCalls()[0];
    expect(JSON.parse(init.body)).toMatchObject({ companyId: 'c1', tokensUsed: 1000, tool: 'voice-menu-action-plan' });
  });

  test('au plus 5 actions', async () => {
    const many = { actions: Array.from({ length: 9 }, (_, i) => ({ model: 'transfer', title: `Action ${i}`, note: '', contactName: null, dueInHours: 999 })) };
    mockChat.mockResolvedValue({ choices: [{ message: { content: JSON.stringify(many) } }] });
    const res = makeRes();
    await controller.actionPlan(userReq(body), res);
    expect(res.body.data.actions).toHaveLength(5);
    expect(res.body.data.actions[0].dueInHours).toBe(336);
  });

  test('sans résumé ni transcription => 400, sans appel IA', async () => {
    const res = makeRes();
    await controller.actionPlan(userReq({ companyId: 'c1' }), res);
    expect(res.statusCode).toBe(400);
    expect(mockChat).not.toHaveBeenCalled();
  });

  test('solde insuffisant => 402 sans appel IA ni débit', async () => {
    mockFetch({ balance: { status: 200, tokens: 10 } });
    const res = makeRes();
    await controller.actionPlan(userReq(body), res);
    expect(res.statusCode).toBe(402);
    expect(mockChat).not.toHaveBeenCalled();
    expect(chargeCalls()).toHaveLength(0);
  });

  test('réponse sans action exploitable => 502 et aucun débit', async () => {
    mockChat.mockResolvedValue({ choices: [{ message: { content: '{"actions":[{"model":"x","title":"y"}]}' } }] });
    const res = makeRes();
    await controller.actionPlan(userReq(body), res);
    expect(res.statusCode).toBe(502);
    expect(chargeCalls()).toHaveLength(0);
  });

  test('accès à l’entreprise refusé => 403', async () => {
    mockAssertAccess.mockRejectedValue(new ScopeError(403, 'Not allowed for this company'));
    const res = makeRes();
    await controller.actionPlan(userReq(body), res);
    expect(res.statusCode).toBe(403);
    expect(mockChat).not.toHaveBeenCalled();
  });
});

describe('langue des textes de l’entreprise (fr, en, es, ar)', () => {
  const FRENCH_META = /Rédige|Réponds|Langue:|Tu écris|Nom du centre/;

  test.each([['en', 'English'], ['es', 'Spanish'], ['ar', 'Arabic']])('suggest %s : consignes dans la langue demandée, aucune consigne française', async (language, label) => {
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'greeting', companyName: 'Acme', language }), res);
    expect(res.statusCode).toBe(200);
    const [system, user] = mockChat.mock.calls[0][0].messages;
    expect(system.content).toContain(label);
    expect(system.content).not.toMatch(FRENCH_META);
    expect(user.content).toContain(`written ONLY in ${label}`);
    expect(user.content).toContain('Name of the business: Acme.');
    expect(user.content).not.toMatch(FRENCH_META);
  });

  test('suggest fr : consignes françaises d’origine inchangées', async () => {
    const res = makeRes();
    await controller.suggest(userReq({ companyId: 'c1', kind: 'voicemail', companyName: 'Acme', language: 'fr' }), res);
    const [system, user] = mockChat.mock.calls[0][0].messages;
    expect(system.content).toMatch(/Tu écris des textes courts/);
    expect(user.content).toMatch(/Langue: fr\./);
    expect(user.content).toMatch(/message sera enregistré/);
  });

  test.each([['greeting', 'center'], ['voicemail', 'center'], ['greeting', 'person'], ['voicemail', 'person']])('prompt anglais (%s, %s) : bip, enregistrement, ton, pas d’invention', (kind, audience) => {
    const { buildSuggestPrompt } = require('../services/voiceMenuAi');
    const p = buildSuggestPrompt({ kind, audience, tone: 'professionnel', language: 'en', personName: 'Sam Lee', companyName: 'Acme' });
    expect(p).toMatch(/Tone: professional\./);
    if (kind === 'voicemail') { expect(p).toMatch(/beep/); expect(p).toMatch(/will be recorded/); }
    if (audience === 'person') { expect(p).toMatch(/first person/); expect(p).toMatch(/Never mention a call center/); expect(p).not.toMatch(/Name of the business/); }
  });

  test.each([['en', /English/], ['es', /Spanish/], ['ar', /Arabic/], ['fr', /en français naturel/]])('tts %s : instruction de diction dans la langue', async (language, re) => {
    const res = makeRes();
    await controller.tts(userReq({ companyId: 'c1', text: 'Hello', voice: 'coral', language }), res);
    expect(res.statusCode).toBe(200);
    expect(mockSpeech.mock.calls[0][0].instructions).toMatch(re);
    expect(mockSpeech.mock.calls[0][0].instructions).not.toMatch(language === 'fr' ? /never translate/ : /Parle en/);
  });

  test('tts : langue invalide => 400', async () => {
    const res = makeRes();
    await controller.tts(userReq({ companyId: 'c1', text: 'Hello', voice: 'nova', language: 'English' }), res);
    expect(res.statusCode).toBe(400);
  });

  const analyzeReq = (query) => ({ query: { companyId: 'c1', usageId: 'vm-9', ...query }, headers: { 'content-type': 'audio/mpeg' }, body: Buffer.from('x') });

  test('analyse : sans langue, indice de transcription « fr » et consigne française (comportement d’avant)', async () => {
    mockTranscribe.mockResolvedValue({ text: 'Bonjour, rappelez-moi.' });
    mockChat.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ summary: 'Demande de rappel.', intent: 'rappel', language: 'fr' }) } }] });
    const res = makeRes();
    await controller.analyzeVoicemail(analyzeReq({}), res);
    expect(mockTranscribe).toHaveBeenCalledWith(expect.objectContaining({ language: 'fr' }));
    expect(mockChat.mock.calls[0][0].messages[0].content).toMatch(/summary \(français/);
  });

  test.each([['en', 'English'], ['es', 'Spanish'], ['ar', 'Arabic']])('analyse %s : transcription et résumé suivent la langue de la société', async (language, label) => {
    mockTranscribe.mockResolvedValue({ text: 'Hello, please call me back about my order.' });
    mockChat.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ summary: 'Callback request.', intent: 'rappel', language: 'en', suggestedFollowUp: { action: 'Call back', message: 'We will call you back.', dueInHours: 4 } }) } }] });
    const res = makeRes();
    await controller.analyzeVoicemail(analyzeReq({ language }), res);
    expect(res.statusCode).toBe(200);
    expect(mockTranscribe).toHaveBeenCalledWith(expect.objectContaining({ language }));
    const system = mockChat.mock.calls[0][0].messages[0].content;
    expect(system).toContain(`summary (written in ${label}`);
    expect(system).not.toMatch(/français/);
    expect(res.body.data.language).toBe('en');
  });

  test('analyse : message vide dans la langue de la société, langue reprise comme valeur par défaut', async () => {
    mockTranscribe.mockResolvedValue({ text: ' ' });
    const res = makeRes();
    await controller.analyzeVoicemail(analyzeReq({ language: 'en' }), res);
    expect(res.body.data).toMatchObject({ summary: 'Inaudible or empty message.', language: 'en' });
    expect(res.body.data.suggestedFollowUp.action).toBe('Check whether a callback is useful');
    expect(mockChat).not.toHaveBeenCalled();
  });

  test('analyse : langue invalide => 400 sans OpenAI', async () => {
    const res = makeRes();
    await controller.analyzeVoicemail(analyzeReq({ language: 'english' }), res);
    expect(res.statusCode).toBe(400);
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  test('plan d’action : titres et notes dans la langue de la société', async () => {
    mockChat.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ actions: [{ model: 'transfer', title: 'Hand over to Sam', note: '', contactName: null, dueInHours: null }] }) } }] });
    const res = makeRes();
    await controller.actionPlan(userReq({ companyId: 'c1', summary: 'Needs a quote.', language: 'en' }), res);
    expect(res.statusCode).toBe(200);
    expect(mockChat.mock.calls[0][0].messages[0].content).toMatch(/title: short imperative title written in English/);
    const fr = makeRes();
    await controller.actionPlan(userReq({ companyId: 'c1', summary: 'Needs a quote.' }), fr);
    expect(mockChat.mock.calls[1][0].messages[0].content).toMatch(/intitulé court à l'impératif en français/);
    const bad = makeRes();
    await controller.actionPlan(userReq({ companyId: 'c1', summary: 'x', language: 'xx-yyy' }), bad);
    expect(bad.statusCode).toBe(400);
  });
});

describe('POST /directory-suggest', () => {
  const body = { companyId: 'c1', field: 'absent', role: 'Avocate associée', kind: 'colleague', language: 'fr' };
  beforeEach(() => {
    mockFetch();
    mockChat.mockResolvedValue({ choices: [{ message: { content: JSON.stringify({ options: ['Prendre un message.', 'Prendre un message.', 'Proposer un collègue.', { text: 'Donner son mobile.' }, 'Quatrième écartée'] }) } }] });
  });

  test('propose jusqu’à 3 formulations distinctes et débite directory-suggest-', async () => {
    const res = makeRes();
    await controller.directorySuggest(userReq(body), res);
    expect(res.body.success).toBe(true);
    expect(res.body.data.options).toEqual(['Prendre un message.', 'Proposer un collègue.', 'Donner son mobile.']);
    expect(JSON.parse(chargeCalls()[0][1].body)).toMatchObject({ companyId: 'c1', tool: 'directory-suggest' });
  });

  test('champ inconnu refusé, sans appel à l’IA', async () => {
    const res = makeRes();
    await controller.directorySuggest(userReq({ ...body, field: 'autre' }), res);
    expect(res.statusCode).toBe(400);
    expect(mockChat).not.toHaveBeenCalled();
  });
});
