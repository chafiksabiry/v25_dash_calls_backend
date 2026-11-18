process.env.JWT_SECRET = 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://reg.example';

const mockCall = { find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), findOneAndUpdate: jest.fn() };
const mockIntent = { find: jest.fn() };
jest.mock('../models/Call', () => ({ Call: mockCall }));
jest.mock('../models/CallRecordingIntent', () => mockIntent);
jest.mock('../services/vertexai.service', () => ({}));
jest.mock('../services/integrations/twilio', () => ({}));
jest.mock('../services/integrations/telnyxService', () => ({}));
jest.mock('../services/integrations/qaqlulService', () => ({}));
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
