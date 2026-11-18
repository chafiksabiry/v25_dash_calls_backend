process.env.JWT_SECRET = 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://reg.example';

process.env.TWILIO_ACCOUNT_SID = `AC${'1'.repeat(32)}`;

const mockCall = { find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn(), distinct: jest.fn() };
const mockIntent = { find: jest.fn() };
const mockTwilio = { fetchTwilioRecording: jest.fn() };
const mockQalqul = { storeCallsInDBatEndingCall: jest.fn() };
const mockAgentModel = { find: jest.fn() };
const mockLeadModel = { find: jest.fn() };
jest.mock('../models/Call', () => ({ Call: mockCall }));
jest.mock('../models/Agent', () => ({ Agent: mockAgentModel, findOne: () => ({ select: () => ({ lean: async () => null }) }) }));
jest.mock('../models/Lead', () => ({ Lead: mockLeadModel }));
jest.mock('../models/CallRecordingIntent', () => mockIntent);
jest.mock('../services/vertexai.service', () => ({}));
jest.mock('../services/integrations/twilio', () => mockTwilio);
jest.mock('../services/integrations/telnyxService', () => ({}));
jest.mock('../services/integrations/qaqlulService', () => mockQalqul);
jest.mock('../services/integrations/ovh', () => ({}));
jest.mock('../services/CallService', () => ({ CallService: function CallService() {} }));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { clearCompanyCache } = require('../middleware/companyScope');
const { canListenRecordings, applyRecordingAccess, stripRecording } = require('../utils/recordingAccess');

const COMPANY = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const CALL_ID = 'cccccccccccccccccccccca1';
const TWILIO = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1';
const CLOUD = 'https://res.cloudinary.com/demo/video/upload/V25_Call_Records/a.mp3';

// Sessions renvoyées par le service d'inscription (GET /api/company-members/me), par utilisateur.
const SESSIONS = {
  owner: { isOwner: true, companyId: COMPANY, permissions: { 'calls.view': true, 'calls.listen': true } },
  // Titulaire prouvé dont les droits ne listent pas calls.listen : isOwner suffit.
  'owner-bare': { isOwner: true, companyId: COMPANY, permissions: {} },
  listener: { isOwner: false, isAgent: false, companyId: COMPANY, permissions: { 'calls.view': true, 'calls.listen': true } },
  secretary: { isOwner: false, isAgent: false, companyId: COMPANY, preset: 'custom', permissions: { 'calls.view': true, 'calls.listen': false } },
  // « Rôle owner » sans preuve : isOwner absent ou non booléen, pas de calls.listen.
  'owner-unproven': { companyId: COMPANY, preset: 'owner', permissions: { 'calls.view': true } },
  'owner-string': { isOwner: 'true', companyId: COMPANY, permissions: {} },
  // Un agent n'est jamais « titulaire » même si isOwner était renvoyé par erreur.
  'agent-flagged-owner': { isOwner: true, isAgent: true, companyId: COMPANY, permissions: { 'calls.listen': false } },
  // Rep freelance / ancien compte : /me dit isOwner + tous les droits, mais aucune entreprise.
  freelance: { isOwner: true, companyId: null, permissions: { 'calls.listen': true } },
  other: { isOwner: true, companyId: 'bbbbbbbbbbbbbbbbbbbbbbb2', permissions: { 'calls.listen': true } },
};

const token = (userId) => jwt.sign({ userId }, 'test-secret');
const reqFor = (userId, extra = {}) => ({ auth: { userId, token: token(userId) }, params: {}, query: {}, ...extra });
const makeRes = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  return res;
};
const doc = (o = {}) => ({ toJSON: () => ({ _id: CALL_ID, companyId: COMPANY, sid: 'CA1', recording_url: TWILIO, recording_url_cloudinary: CLOUD, ...o }) });
const thenableDoc = (d) => { const p = { populate: () => p, then: (ok) => ok(d) }; return p; };
const listChain = (rows) => { const p = { populate: () => p, sort: async () => rows }; return p; };

let realFetch;
beforeAll(() => { realFetch = global.fetch; });
beforeEach(() => {
  clearCompanyCache();
  Object.values(mockCall).forEach((f) => f.mockReset());
  [mockTwilio.fetchTwilioRecording, mockQalqul.storeCallsInDBatEndingCall, mockAgentModel.find, mockLeadModel.find].forEach((f) => f.mockReset());
  mockIntent.find.mockReset();
  mockIntent.find.mockImplementation(() => ({ select: () => ({ lean: async () => [] }) }));
  global.fetch = jest.fn(async (url) => {
    const userId = new URL(url).searchParams.get('userId');
    return { ok: true, json: async () => ({ success: true, data: SESSIONS[userId] || { companyId: null } }) };
  });
});
afterEach(() => { global.fetch = realFetch; });

describe('règle d’écoute (canListenRecordings)', () => {
  test('titulaire prouvé ou calls.listen === true : oui', () => {
    expect(canListenRecordings(SESSIONS.owner)).toBe(true);
    expect(canListenRecordings(SESSIONS['owner-bare'])).toBe(true);
    expect(canListenRecordings(SESSIONS.listener)).toBe(true);
  });
  test('secrétaire sans droit, rôle owner non prouvé, agent marqué owner, session vide : non', () => {
    expect(canListenRecordings(SESSIONS.secretary)).toBe(false);
    expect(canListenRecordings(SESSIONS['owner-unproven'])).toBe(false);
    expect(canListenRecordings(SESSIONS['owner-string'])).toBe(false);
    expect(canListenRecordings(SESSIONS['agent-flagged-owner'])).toBe(false);
    expect(canListenRecordings({ permissions: { 'calls.listen': 'true' } })).toBe(false);
    expect(canListenRecordings(null)).toBe(false);
    expect(canListenRecordings({})).toBe(false);
  });
  test('stripRecording met les deux URL à null sans toucher au reste', () => {
    const out = stripRecording(doc({ recordingStatus: 'recorded' }));
    expect(out).toMatchObject({ _id: CALL_ID, recording_url: null, recording_url_cloudinary: null, recordingStatus: 'recorded' });
  });
});

describe('détail GET /calls/:id', () => {
  const run = async (req) => {
    const c = require('../controllers/calls');
    mockCall.findById.mockImplementation(() => thenableDoc(doc()));
    const res = makeRes();
    await c.getCall({ params: { id: CALL_ID }, query: {}, ...req }, res);
    expect(res.statusCode).toBe(200);
    return res.body.data;
  };

  test('titulaire prouvé : URL renvoyées', async () => {
    const data = await run(reqFor('owner'));
    expect(data.recording_url).toBe(TWILIO);
    expect(data.recording_url_cloudinary).toBe(CLOUD);
    expect(data.recordingStatus).toBe('recorded');
  });
  test('titulaire prouvé sans calls.listen explicite : URL renvoyées', async () => {
    expect((await run(reqFor('owner-bare'))).recording_url_cloudinary).toBe(CLOUD);
  });
  test('calls.listen : URL renvoyées', async () => {
    const data = await run(reqFor('listener'));
    expect(data.recording_url).toBe(TWILIO);
    expect(data.recording_url_cloudinary).toBe(CLOUD);
  });
  test('secrétaire sans permission : null, le statut reste « enregistré »', async () => {
    const data = await run(reqFor('secretary'));
    expect(data.recording_url).toBeNull();
    expect(data.recording_url_cloudinary).toBeNull();
    expect(data.recordingStatus).toBe('recorded');
  });
  test('rôle owner sans isOwner === true : null', async () => {
    for (const who of ['owner-unproven', 'owner-string', 'agent-flagged-owner']) {
      const data = await run(reqFor(who));
      expect(data.recording_url).toBeNull();
      expect(data.recording_url_cloudinary).toBeNull();
    }
  });
  test('anonyme (compatibilité sans jeton) : null, sans appel au service d’inscription', async () => {
    const data = await run({ callsLegacy: true });
    expect(data.recording_url).toBeNull();
    expect(data.recording_url_cloudinary).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });
  test('service d’inscription indisponible : fermé (null), pas d’erreur', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
    const data = await run(reqFor('owner'));
    expect(data.recording_url).toBeNull();
    expect(data.recording_url_cloudinary).toBeNull();
  });
  test('jeton de service : inchangé (URL renvoyées, aucune recherche de droits)', async () => {
    const data = await run({ callsService: { scope: 'call-recording' } });
    expect(data.recording_url).toBe(TWILIO);
    expect(data.recording_url_cloudinary).toBe(CLOUD);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('listes GET /calls et /calls/agent/:agentId', () => {
  const rows = () => [
    { ...doc(), toObject: () => doc().toJSON() },
    { ...doc({ _id: 'cccccccccccccccccccccca2', recording_url: null, recording_url_cloudinary: null }), toObject: () => ({}) },
  ];
  test('GET /calls : titulaire voit les URL, secrétaire et anonyme non', async () => {
    const c = require('../controllers/calls');
    mockCall.find.mockImplementation(() => listChain(rows()));
    let res = makeRes();
    await c.getCalls(reqFor('owner', { query: { companyId: COMPANY } }), res);
    expect(res.body.data[0].recording_url_cloudinary).toBe(CLOUD);

    res = makeRes();
    await c.getCalls(reqFor('secretary', { query: { companyId: COMPANY } }), res);
    expect(res.body.data.map((r) => [r.recording_url, r.recording_url_cloudinary])).toEqual([[null, null], [null, null]]);
    expect(res.body.data[0].recordingStatus).toBe('recorded');

    res = makeRes();
    await c.getCalls({ query: { companyId: COMPANY }, callsLegacy: true }, res);
    expect(res.body.data[0].recording_url).toBeNull();
  });
  test('GET /calls/agent/:agentId : calls.listen voit les URL, secrétaire non', async () => {
    const c = require('../controllers/calls');
    mockCall.find.mockImplementation(() => listChain(rows()));
    let res = makeRes();
    await c.getCallsByAgent(reqFor('listener', { params: { agentId: 'dddddddddddddddddddddd01' } }), res);
    expect(res.body.data[0].recording_url).toBe(TWILIO);
    res = makeRes();
    await c.getCallsByAgent(reqFor('secretary', { params: { agentId: 'dddddddddddddddddddddd01' } }), res);
    expect(res.body.data[0].recording_url).toBeNull();
    expect(res.body.data[0].recording_url_cloudinary).toBeNull();
  });
  test('applyRecordingAccess : liste et objet unique', async () => {
    expect(await applyRecordingAccess({ callsService: { scope: 'call-recording' } }, [doc().toJSON()])).toEqual([doc().toJSON()]);
    const one = await applyRecordingAccess({}, doc().toJSON());
    expect(one.recording_url).toBeNull();
  });
});

describe('chaîne complète (routes + contrôle d’entreprise + filtre)', () => {
  let server; let port;
  const get = (path, auth) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: auth ? { Authorization: `Bearer ${auth}` } : {} }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject); r.end();
  });
  beforeEach(async () => {
    delete process.env.CALLS_REQUIRE_AUTH; delete process.env.CALLS_LEGACY_ANON; delete process.env.COMPANY_SCOPE_MODE;
    const app = express();
    app.use(express.json());
    app.use('/api/calls', require('../routes/calls'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    port = server.address().port;
    mockCall.find.mockImplementation(() => listChain([{ ...doc(), toObject: () => doc().toJSON() }]));
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); });

  test('membre du centre : une seule lecture de session (cache) ; secrétaire null, titulaire URL, anonyme null', async () => {
    let r = await get(`/api/calls?companyId=${COMPANY}`, token('secretary'));
    expect(r.status).toBe(200);
    expect(r.body.data[0].recording_url).toBeNull();
    expect(r.body.data[0].recording_url_cloudinary).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(1);

    r = await get(`/api/calls?companyId=${COMPANY}`, token('owner'));
    expect(r.status).toBe(200);
    expect(r.body.data[0].recording_url_cloudinary).toBe(CLOUD);

    r = await get(`/api/calls?companyId=${COMPANY}`);
    expect(r.status).toBe(200);
    expect(r.body.data[0].recording_url).toBeNull();
    expect(r.body.data[0].recording_url_cloudinary).toBeNull();
  });
});

describe('réponses d’écriture et d’analyse filtrées', () => {
  test('POST /:id/analyze (appel court déjà transcrit) : secrétaire null, titulaire URL', async () => {
    const c = require('../controllers/calls');
    const fields = { ...doc().toJSON(), duration: 10, ai_call_status: 'too_short', transcript: [{ speaker: 'Agent', text: 'Allô' }] };
    mockCall.findById.mockImplementation(() => ({ populate: async () => ({ ...fields, toJSON: () => ({ ...fields }) }) }));
    let res = makeRes();
    await c.analyzeCall(reqFor('secretary', { params: { id: CALL_ID }, body: {} }), res);
    expect(res.body.alreadyAnalyzed).toBe(true);
    expect(res.body.data.recording_url).toBeNull();
    expect(res.body.data.recording_url_cloudinary).toBeNull();
    res = makeRes();
    await c.analyzeCall(reqFor('owner', { params: { id: CALL_ID }, body: {} }), res);
    expect(res.body.data.recording_url_cloudinary).toBe(CLOUD);
  });
  test('POST /store-call-in-db-at-end-call : réponse filtrée, l’écriture a bien lieu', async () => {
    const c = require('../controllers/calls');
    mockQalqul.storeCallsInDBatEndingCall.mockResolvedValue({ sid: 'CA1', recording_url: TWILIO, recording_url_cloudinary: CLOUD });
    const res = makeRes();
    await c.storeCallsInDBatEndingCall({ body: { phoneNumber: '+33100000000', callSid: 'CA1' }, callsLegacy: true }, res);
    expect(mockQalqul.storeCallsInDBatEndingCall).toHaveBeenCalledWith('+33100000000', 'CA1');
    expect(res.body.data).toMatchObject({ sid: 'CA1', recording_url: null, recording_url_cloudinary: null });
  });
  test('POST /center-call : jeton de service inchangé, utilisateur sans droit filtré', async () => {
    const c = require('../controllers/calls');
    const body = { sid: 'CA2', companyId: COMPANY, handledBy: { userId: 'eeeeeeeeeeeeeeeeeeeeeee1', name: 'Léa' } };
    mockCall.findOneAndUpdate.mockResolvedValue(doc({ sid: 'CA2' }));
    let res = makeRes();
    await c.saveCenterCall({ body, callsService: { scope: 'center-data' } }, res);
    expect(res.body.data.toJSON().recording_url).toBe(TWILIO);
    res = makeRes();
    await c.saveCenterCall(reqFor('secretary', { body }), res);
    expect(res.body.data.recording_url).toBeNull();
  });
});

describe('POST /fetch-recording', () => {
  const ACC = process.env.TWILIO_ACCOUNT_SID;
  const RE = `RE${'a'.repeat(32)}`;
  const good = `https://api.twilio.com/2010-04-01/Accounts/${ACC}/Recordings/${RE}.mp3`;
  let server; let port;
  const post = (body, auth) => new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/calls/fetch-recording', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) } }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject); r.write(data); r.end();
  });
  beforeEach(async () => {
    delete process.env.CALLS_REQUIRE_AUTH; delete process.env.CALLS_LEGACY_ANON; delete process.env.COMPANY_SCOPE_MODE;
    const app = express();
    app.use(express.json());
    app.use('/api/calls', require('../routes/calls'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    port = server.address().port;
    mockTwilio.fetchTwilioRecording.mockResolvedValue(CLOUD);
    mockCall.findOne.mockImplementation(() => ({ select: () => ({ lean: async () => null }) }));
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); });

  test('URL hors enregistrement Twilio du compte : 400, aucun téléchargement', async () => {
    const bad = [
      `https://api.twilio.com/2010-04-01/Accounts/${ACC}/Recordings/${RE.toUpperCase()}.mp3`,
      `https://api.twilio.com/2010-04-01/Accounts/${ACC}/Recordings/re${'a'.repeat(32)}.mp3`,
      `https://API.twilio.com/2010-04-01/Accounts/${ACC}/recordings/${RE}.mp3`,
      'https://evil.example/2010-04-01/Accounts/x/Recordings/y',
      `https://api.twilio.com/2010-04-01/Accounts/AC${'2'.repeat(32)}/Recordings/${RE}.mp3`,
      `http://api.twilio.com/2010-04-01/Accounts/${ACC}/Recordings/${RE}.mp3`,
      `${good}?x=1`,
      `https://user:pw@api.twilio.com/2010-04-01/Accounts/${ACC}/Recordings/${RE}.mp3`,
      `https://api.twilio.com.evil.example/2010-04-01/Accounts/${ACC}/Recordings/${RE}.mp3`,
      `https://api.twilio.com/2010-04-01/Accounts/${ACC}/Calls/CA1`,
    ];
    for (const recordingUrl of bad) {
      expect((await post({ recordingUrl, userId: 'u' }, token('owner'))).status).toBe(400);
    }
    expect(mockTwilio.fetchTwilioRecording).not.toHaveBeenCalled();
  });
  test('enregistrement d’un appel d’une autre entreprise : 403', async () => {
    mockCall.findOne.mockImplementation(() => ({ select: () => ({ lean: async () => ({ companyId: COMPANY, agent: null }) }) }));
    expect((await post({ recordingUrl: good, userId: 'u' }, token('other'))).status).toBe(403);
    expect(mockTwilio.fetchTwilioRecording).not.toHaveBeenCalled();
  });
  test('appel encore inconnu : téléchargé ; URL renvoyée au titulaire, null pour la secrétaire et l’anonyme', async () => {
    let r = await post({ recordingUrl: good, userId: 'u' }, token('owner'));
    expect(r.status).toBe(200);
    expect(r.body.url).toBe(CLOUD);
    r = await post({ recordingUrl: good, userId: 'u' }, token('secretary'));
    expect(r.status).toBe(200);
    expect(r.body.url).toBeNull();
    r = await post({ recordingUrl: good, userId: 'u' });
    expect(r.status).toBe(200);
    expect(r.body.url).toBeNull();
    expect(mockTwilio.fetchTwilioRecording).toHaveBeenCalledTimes(3);
  });
  test('le téléchargement reçoit l’URL canonique reconstruite, pas la chaîne du client', async () => {
    // Hôte en majuscules et port 443 explicite : normalisés par URL(), l'URL téléchargée est reconstruite.
    const r = await post({ recordingUrl: `https://API.TWILIO.COM:443/2010-04-01/Accounts/${ACC}/Recordings/${RE}.wav`, userId: 'u' }, token('owner'));
    expect(r.status).toBe(200);
    expect(mockTwilio.fetchTwilioRecording).toHaveBeenCalledWith(`https://api.twilio.com/2010-04-01/Accounts/${ACC}/Recordings/${RE}.wav`, 'u');
    expect(mockCall.findOne).toHaveBeenCalledWith({ recording_url: { $in: [`https://api.twilio.com/2010-04-01/Accounts/${ACC}/Recordings/${RE}`, expect.any(String), expect.any(String)], $type: 'string' } });
  });
});

describe('/api/analytics et /api/dashboard cantonnés à l’entreprise de l’appelant', () => {
  let server; let port;
  const get = (path, auth) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: auth ? { Authorization: `Bearer ${auth}` } : {} }, (res) => {
      let raw = ''; res.on('data', (c) => { raw += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
    });
    r.on('error', reject); r.end();
  });
  const chain = (rows) => { const p = { populate: () => p, select: () => p, sort: () => p, limit: () => p, then: (ok, ko) => Promise.resolve(rows).then(ok, ko) }; return p; };
  beforeEach(async () => {
    const app = express();
    app.use('/api/analytics', require('../routes/analytics'));
    app.use('/api/dashboard', require('../routes/dashboard'));
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    port = server.address().port;
    mockCall.find.mockImplementation(() => chain([doc()]));
    mockCall.distinct.mockResolvedValue([]);
    mockAgentModel.find.mockImplementation(() => chain([]));
    mockLeadModel.find.mockImplementation(() => chain([]));
  });
  afterEach(async () => { await new Promise((r) => server.close(r)); });

  test('sans jeton 401 ; compte sans entreprise (rep freelance) 403 ; aucune lecture de la base', async () => {
    expect((await get('/api/analytics/calls')).status).toBe(401);
    expect((await get('/api/dashboard/live-calls')).status).toBe(401);
    expect((await get('/api/analytics/calls', token('freelance'))).status).toBe(403);
    expect((await get('/api/dashboard/live-calls', token('freelance'))).status).toBe(403);
    expect(mockCall.find).not.toHaveBeenCalled();
  });
  test('analytics/calls et live-calls : filtre companyId de l’appelant (paramètre client ignoré), URL selon le droit', async () => {
    let r = await get(`/api/analytics/calls?companyId=bbbbbbbbbbbbbbbbbbbbbbb2`, token('secretary'));
    expect(r.status).toBe(200);
    expect(mockCall.find).toHaveBeenLastCalledWith({ companyId: COMPANY });
    expect(r.body.data[0].recording_url).toBeNull();
    expect(r.body.data[0].recording_url_cloudinary).toBeNull();

    r = await get('/api/dashboard/live-calls', token('owner'));
    expect(r.status).toBe(200);
    expect(mockCall.find).toHaveBeenLastCalledWith({ companyId: COMPANY, status: 'active' });
    expect(r.body.data[0].recording_url_cloudinary).toBe(CLOUD);
  });
  test('overview, quality, stats, top-reps : lectures limitées à l’entreprise', async () => {
    for (const path of ['/api/analytics/overview', '/api/analytics/quality', '/api/analytics/agents', '/api/dashboard/stats', '/api/dashboard/top-reps', '/api/dashboard/top-gigs']) {
      expect((await get(path, token('owner'))).status).toBe(200);
    }
    for (const [q] of mockCall.find.mock.calls) expect(q.companyId).toBe(COMPANY);
    for (const [, q] of mockCall.distinct.mock.calls) expect(q.companyId).toBe(COMPANY);
    // Lead.companyId est Mixed : ObjectId OU texte, les deux formes sont cherchées.
    expect(mockLeadModel.find).toHaveBeenCalled();
    for (const [q] of mockLeadModel.find.mock.calls) {
      expect(q.companyId.$in).toHaveLength(2);
      expect(q.companyId.$in.map(String)).toEqual([COMPANY, COMPANY]);
      expect(q.companyId.$in[0]).toBeInstanceOf(require('mongoose').Types.ObjectId);
      expect(typeof q.companyId.$in[1]).toBe('string');
    }
    for (const [q] of mockAgentModel.find.mock.calls) expect(q).toEqual({ _id: { $in: [] } });
  });
});

describe('relecture 2 : fraud-review, création, index', () => {
  test('PATCH /:id/fraud-review : réponse filtrée pour la secrétaire, URL pour le titulaire', async () => {
    const c = require('../controllers/calls');
    const make = () => {
      const call = { ...doc().toJSON(), flags: { fraud: true }, save: jest.fn(async () => {}) };
      call.toJSON = () => { const { save, toJSON, ...rest } = call; return { ...rest }; };
      return call;
    };
    mockCall.findById.mockImplementation(async () => make());
    let res = makeRes();
    await c.overturnCallFraud(reqFor('secretary', { params: { id: CALL_ID }, body: { decision: 'confirm' } }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ recording_url: null, recording_url_cloudinary: null });
    res = makeRes();
    await c.overturnCallFraud(reqFor('owner', { params: { id: CALL_ID }, body: { decision: 'confirm' } }), res);
    expect(res.body.data.recording_url).toBe(TWILIO);
  });
  test('POST /calls : réponse filtrée', async () => {
    const c = require('../controllers/calls');
    mockCall.create = jest.fn(async () => ({ _id: CALL_ID }));
    mockCall.findById.mockImplementation(() => thenableDoc(doc()));
    const res = makeRes();
    await c.createCall(reqFor('secretary', { body: { companyId: COMPANY } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.data).toMatchObject({ recording_url: null, recording_url_cloudinary: null });
  });
  test('index du modèle Call : recording_url partiel (chaîne) et companyId + status', () => {
    const { Call } = jest.requireActual('../models/Call');
    const idx = Call.schema.indexes();
    expect(idx).toContainEqual([{ recording_url: 1 }, expect.objectContaining({ partialFilterExpression: { recording_url: { $type: 'string' } } })]);
    expect(idx).toContainEqual([{ companyId: 1, status: 1 }, expect.anything()]);
  });
});
