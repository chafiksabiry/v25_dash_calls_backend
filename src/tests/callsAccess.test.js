process.env.JWT_SECRET = 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://reg.example';

jest.mock('../controllers/calls', () => new Proxy({}, { get: (_t, name) => (typeof name === 'string' && name !== 'then' && name !== '__esModule' ? (req, res) => res.status(200).json({ success: true, handler: name, query: req.query, agentScope: req.callsCompanyScope || null, body: req.body }) : undefined) }));
jest.mock('../controllers/callsAnalytics', () => new Proxy({}, { get: (_t, name) => (typeof name === 'string' && name !== 'then' && name !== '__esModule' ? (req, res) => res.status(200).json({ success: true, handler: name }) : undefined) }));

const mockCalls = {};
const mockAgents = {};
jest.mock('../models/Call', () => ({
  Call: { findById: (id) => ({ select: () => ({ lean: async () => mockCalls[id] || null }) }) },
}));
jest.mock('../models/Agent', () => ({
  findOne: ({ userId }) => ({ select: () => ({ lean: async () => mockAgents[userId] || null }) }),
}));

const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { clearCompanyCache } = require('../middleware/companyScope');

const A = 'aaaaaaaaaaaaaaaaaaaaaaa1'; // centre de l'appelant
const B = 'bbbbbbbbbbbbbbbbbbbbbbb2'; // autre centre
const CALL_A = 'cccccccccccccccccccccca1';
const CALL_B = 'ccccccccccccccccccccccb2';
const AGENT = 'dddddddddddddddddddddd01';
const OTHER_AGENT = 'dddddddddddddddddddddd02';
const UA = 'ffffffffffffffffffffff01';
const token = (userId) => jwt.sign({ userId }, 'test-secret');
const serviceToken = (scope) => jwt.sign({ scope }, 'test-secret', { algorithm: 'HS256', expiresIn: 60 });

let server; let port; let realFetch;
const build = () => {
  jest.resetModules();
  const app = express();
  app.use(express.json());
  app.use('/api/calls', require('../routes/callsAnalytics'));
  app.use('/api/calls', require('../routes/calls'));
  app.use('/api/rep-transactions', require('../routes/repTransactions'));
  app.use('/api/client-portal', require('../routes/clientPortal'));
  return app;
};
const call = (method, path, { auth, body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = body ? JSON.stringify(body) : null;
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers } }, (res) => {
    let raw = ''; res.on('data', (c) => { raw += c; });
    res.on('end', () => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }));
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

// Le service d'inscription dit à quel centre appartient chaque utilisateur.
const members = { 'u-a': { companyId: A }, 'u-b': { companyId: B }, [UA]: { companyId: null }, 'u-client': { companyId: null, isClient: true, client: { id: 'c1', gigIds: [] } } };
beforeAll(() => { realFetch = global.fetch; });
beforeEach(async () => {
  clearCompanyCache();
  Object.keys(mockCalls).forEach((k) => delete mockCalls[k]);
  Object.keys(mockAgents).forEach((k) => delete mockAgents[k]);
  mockCalls[CALL_A] = { _id: CALL_A, companyId: A, agent: AGENT };
  mockCalls[CALL_B] = { _id: CALL_B, companyId: B, agent: OTHER_AGENT };
  mockAgents[UA] = { _id: AGENT };
  delete process.env.CALLS_REQUIRE_AUTH; delete process.env.CALLS_LEGACY_ANON; delete process.env.COMPANY_SCOPE_MODE;
  const app = build();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
  global.fetch = jest.fn(async (url) => {
    const u = new URL(url); const userId = u.searchParams.get('userId');
    return { ok: true, json: async () => ({ success: true, data: members[userId] || { companyId: null } }) };
  });
});
afterEach(async () => { await new Promise((r) => server.close(r)); global.fetch = realFetch; });

describe('GET /api/calls', () => {
  test('anonyme sans filtre : 401 (plus de vidage de tous les centres)', async () => {
    expect((await call('GET', '/api/calls')).status).toBe(401);
    expect((await call('GET', '/api/calls?populate=lead', { headers: { 'x-user-id': 'u-a' } })).status).toBe(401);
  });
  test('anonyme sans filtre : 401 même en mode de secours', async () => {
    process.env.CALLS_REQUIRE_AUTH = 'false';
    expect((await call('GET', '/api/calls')).status).toBe(401);
  });
  test('jeton invalide : 401', async () => {
    expect((await call('GET', `/api/calls?companyId=${A}`, { auth: 'nope' })).status).toBe(401);
  });
  test('autre centre : 403', async () => {
    const r = await call('GET', `/api/calls?companyId=${B}`, { auth: token('u-a') });
    expect(r.status).toBe(403);
  });
  test('propre centre : 200', async () => {
    const r = await call('GET', `/api/calls?companyId=${A}`, { auth: token('u-a') });
    expect(r.status).toBe(200); expect(r.body.query.companyId).toBe(A);
  });
  test('jeton sans companyId : cantonné au centre de l’appelant', async () => {
    const r = await call('GET', '/api/calls?gigId=eeeeeeeeeeeeeeeeeeeeeee1', { auth: token('u-a') });
    expect(r.status).toBe(200); expect(r.body.query.companyId).toBe(A);
  });
  test('x-user-id seul ne vaut pas identité', async () => {
    const r = await call('GET', `/api/calls?companyId=${B}`, { headers: { 'x-user-id': 'u-b' }, auth: token('u-a') });
    expect(r.status).toBe(403);
  });
  test('l’agent lit ses propres appels (userId du jeton), pas ceux d’un autre', async () => {
    expect((await call('GET', `/api/calls?userId=${UA}`, { auth: token(UA) })).status).toBe(200);
    const other = await call('GET', `/api/calls?userId=u-a`, { auth: token(UA) });
    expect(other.status).toBe(403);
  });
  test('compat : anonyme avec périmètre toléré, CALLS_LEGACY_ANON=false le ferme', async () => {
    expect((await call('GET', `/api/calls?companyId=${A}`)).status).toBe(200);
    process.env.CALLS_LEGACY_ANON = 'false';
    expect((await call('GET', `/api/calls?companyId=${A}`)).status).toBe(401);
  });
  test('compat : identifiant de périmètre mal formé : 400', async () => {
    expect((await call('GET', '/api/calls?companyId=*')).status).toBe(400);
  });
  test('client du portail : 403 sur /api/calls', async () => {
    const r = await call('GET', `/api/calls?companyId=${A}`, { auth: token('u-client') });
    expect(r.status).toBe(403);
    expect((await call('GET', '/api/calls', { auth: token('u-client') })).status).toBe(403);
  });
});

describe('analytics, fraud-stats, rep-transactions', () => {
  const paths = (c) => [`/api/calls/company/${c}/analytics/overview`, `/api/calls/company/${c}/analytics/reps`, `/api/calls/company/${c}/fraud-stats`, `/api/rep-transactions/company/${c}`];
  test('jeton, propre centre : 200 ; autre centre : 403', async () => {
    for (const p of paths(A)) expect([p, (await call('GET', p, { auth: token('u-a') })).status]).toEqual([p, 200]);
    for (const p of paths(B)) expect([p, (await call('GET', p, { auth: token('u-a') })).status]).toEqual([p, 403]);
  });
  test('CALLS_LEGACY_ANON=false : anonyme 401', async () => {
    process.env.CALLS_LEGACY_ANON = 'false';
    for (const p of paths(A)) expect([p, (await call('GET', p)).status]).toEqual([p, 401]);
  });
  test('fraud-calls exige toujours le jeton', async () => {
    expect((await call('GET', `/api/calls/company/${A}/fraud-calls`)).status).toBe(401);
  });
});

describe('appels par identifiant et par agent', () => {
  test('GET /:id : propre centre 200, autre centre 403, inconnu 404, jeton invalide 401', async () => {
    expect((await call('GET', `/api/calls/${CALL_A}`, { auth: token('u-a') })).status).toBe(200);
    expect((await call('GET', `/api/calls/${CALL_B}`, { auth: token('u-a') })).status).toBe(403);
    expect((await call('GET', '/api/calls/cccccccccccccccccccccc99', { auth: token('u-a') })).status).toBe(404);
    expect((await call('GET', `/api/calls/${CALL_A}`, { auth: 'x' })).status).toBe(401);
  });
  test('PUT /:id : autre centre 403 ; l’agent propriétaire peut modifier son appel', async () => {
    expect((await call('PUT', `/api/calls/${CALL_B}`, { auth: token('u-a'), body: {} })).status).toBe(403);
    expect((await call('PUT', `/api/calls/${CALL_A}`, { auth: token(UA), body: {} })).status).toBe(200);
    expect((await call('PUT', `/api/calls/${CALL_B}`, { auth: token(UA), body: {} })).status).toBe(403);
  });
  test('analyse IA (groupe strict) : 401 sans jeton, 403 autre centre, 200 propre centre', async () => {
    for (const s of ['analyze', 'request-analysis-help', 'calibrate-score']) {
      expect((await call('POST', `/api/calls/${CALL_A}/${s}`, { body: {} })).status).toBe(401);
      expect((await call('POST', `/api/calls/${CALL_B}/${s}`, { auth: token('u-a'), body: {} })).status).toBe(403);
      expect((await call('POST', `/api/calls/${CALL_A}/${s}`, { auth: token('u-a'), body: {} })).status).toBe(200);
    }
  });
  test('CALLS_REQUIRE_AUTH=false : retour de secours pour le groupe strict', async () => {
    process.env.CALLS_REQUIRE_AUTH = 'false';
    expect((await call('POST', `/api/calls/${CALL_A}/analyze`, { body: {} })).status).toBe(200);
  });
  test('/agent/:id : profil de l’appelant 200 ; membre d’un centre restreint à son centre ; client 403', async () => {
    expect((await call('GET', `/api/calls/agent/${AGENT}`, { auth: token(UA) })).body.agentScope).toBeNull();
    const member = await call('GET', `/api/calls/agent/${OTHER_AGENT}`, { auth: token('u-a') });
    expect(member.status).toBe(200); expect(member.body.agentScope).toBe(A);
    expect((await call('GET', `/api/calls/agent/${OTHER_AGENT}`, { auth: token('u-client') })).status).toBe(403);
    expect((await call('GET', `/api/calls/agent/${OTHER_AGENT}`, { auth: token(UA) })).status).toBe(403);
  });
});

describe('écritures', () => {
  test('POST /calls : centre étranger 403 ; centre par défaut = celui de l’appelant ; anonyme sans centre 401', async () => {
    expect((await call('POST', '/api/calls', { auth: token('u-a'), body: { companyId: B } })).status).toBe(403);
    const ok = await call('POST', '/api/calls', { auth: token('u-a'), body: { status: 'x' } });
    expect(ok.status).toBe(200); expect(ok.body.body.companyId).toBe(A);
    expect((await call('POST', '/api/calls', { body: { status: 'x' } })).status).toBe(401);
  });
  test('center-call : 401 sans jeton ; jeton de service accepté ; utilisateur : son centre seulement', async () => {
    const body = { sid: 'CA1', companyId: A };
    expect((await call('POST', '/api/calls/center-call', { body })).status).toBe(401);
    expect((await call('POST', '/api/calls/center-call', { body, auth: serviceToken('voicemail-analyze') })).status).toBe(200);
    expect((await call('POST', '/api/calls/center-call', { body, auth: serviceToken('autre-scope') })).status).toBe(401);
    expect((await call('POST', '/api/calls/center-call', { body, auth: token('u-a') })).status).toBe(200);
    expect((await call('POST', '/api/calls/center-call', { body: { ...body, companyId: B }, auth: token('u-a') })).status).toBe(403);
  });
});

describe('portail client inchangé', () => {
  test('le portail garde son propre contrôle : 401 sans jeton', async () => {
    expect((await call('GET', '/api/client-portal/calls')).status).toBe(401);
    expect((await call('GET', '/api/client-portal/overview')).status).toBe(401);
  });
  test('portail : toujours 3 routes GET derrière authenticateUser', () => {
    const router = require('../routes/clientPortal');
    const { authenticateUser } = require('../middleware/companyScope');
    expect(router.stack[0].handle).toBe(authenticateUser);
    expect(router.stack.filter((l) => l.route).map((l) => Object.keys(l.route.methods)[0])).toEqual(['get', 'get', 'get']);
  });
});
