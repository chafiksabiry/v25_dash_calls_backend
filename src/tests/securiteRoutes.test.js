process.env.JWT_SECRET = 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://reg.example';
process.env.MATCHING_API_URL = 'https://match.example/api';

const echo = () => new Proxy({}, { get: (_t, name) => (typeof name === 'string' && name !== 'then' && name !== '__esModule' ? (req, res) => res.status(200).json({ success: true, handler: name, body: req.body }) : undefined) });
jest.mock('../controllers/calls', () => echo());
jest.mock('../controllers/vertexController', () => echo());
jest.mock('../controllers/gigs', () => echo());

const mockCalls = {};
jest.mock('../models/Call', () => ({
  Call: {
    findById: (id) => ({ select: () => ({ lean: async () => mockCalls[id] || null }) }),
    findOne: (q) => ({ select: () => ({ lean: async () => Object.values(mockCalls).find((c) => q.$or.some((o) => (o.sid && o.sid === c.sid) || (o.call_id && o.call_id === c.sid))) || null }) }),
  },
}));

const U_REP = '6d00000000000000000000e1';
const AGENT_REP = '6e00000000000000000000e1';
jest.mock('../models/Agent', () => ({
  findOne: ({ userId }) => ({ select: () => ({ lean: async () => (String(userId) === '6d00000000000000000000e1' ? { _id: '6e00000000000000000000e1' } : null) }) }),
}));

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const { clearCompanyCache } = require('../middleware/companyScope');

const A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const B = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const GIG_A = '6a0000000000000000000a01';
const GIG_B = '6a0000000000000000000b02';
const LEAD_A = '6b0000000000000000000a01';
const LEAD_B = '6b0000000000000000000b02';
const LEAD_NOCOMPANY = '6b0000000000000000000c03';
const CALL_B = '6c0000000000000000000b02';
const token = (userId) => jwt.sign({ userId }, 'test-secret');
const members = { 'u-a': { companyId: A }, 'u-b': { companyId: B } };

// Base Mongo simulée (collections brutes gigs / leads).
const db = {
  gigs: { [GIG_A]: { _id: GIG_A, companyId: A }, [GIG_B]: { _id: GIG_B, companyId: B } },
  leads: { [LEAD_A]: { _id: LEAD_A, gigId: GIG_A }, [LEAD_B]: { _id: LEAD_B, companyId: B, gigId: GIG_B }, [LEAD_NOCOMPANY]: { _id: LEAD_NOCOMPANY } },
};
const fakeDb = (m) => Object.defineProperty(m.connection, 'db', {
  configurable: true,
  get: () => ({ collection: (name) => ({ findOne: async (q) => (db[name] || {})[String(q.$or[0]._id)] || null }) }),
});

let server; let port; let realFetch;
const build = () => {
  jest.resetModules();
  fakeDb(require('mongoose'));
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/calls', require('../routes/calls'));
  app.use('/api/vertex', require('../routes/vertex'));
  app.use('/api/gigs', require('../routes/gigs'));
  return app;
};
const call = (method, path, { auth, body, raw, headers = {} } = {}) => new Promise((resolve, reject) => {
  const data = raw !== undefined ? raw : body ? JSON.stringify(body) : null;
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers } }, (res) => {
    let out = ''; res.on('data', (c) => { out += c; });
    res.on('end', () => { let parsed = null; try { parsed = out ? JSON.parse(out) : null; } catch { parsed = out; } resolve({ status: res.statusCode, body: parsed }); });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

const ENV_KEYS = ['CALLS_REQUIRE_AUTH', 'CALLS_LEGACY_ANON', 'COMPANY_SCOPE_MODE', 'WEBHOOK_SIGNATURE_MODE', 'TELNYX_PUBLIC_KEY', 'TWILIO_AUTH_TOKEN', 'PUBLIC_BASE_URL', 'BASE_URL', 'SELF_API_URL'];
beforeAll(() => { realFetch = global.fetch; });
beforeEach(async () => {
  clearCompanyCache();
  require('../middleware/callsAccess').clearEnrollCache();
  ENV_KEYS.forEach((k) => delete process.env[k]);
  Object.keys(mockCalls).forEach((k) => delete mockCalls[k]);
  mockCalls[CALL_B] = { _id: CALL_B, companyId: B, sid: 'v3:call-b' };
  const app = build();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  port = server.address().port;
  global.fetch = jest.fn(async (url) => {
    const u = new URL(url);
    if (u.host === 'match.example') {
      const gigs = u.pathname.includes(AGENT_REP) ? [{ gig: { _id: GIG_A } }] : [];
      return { ok: true, json: async () => ({ gigs }) };
    }
    const userId = u.searchParams.get('userId');
    return { ok: true, json: async () => ({ success: true, data: members[userId] || { companyId: null } }) };
  });
});
afterEach(async () => { await new Promise((r) => server.close(r)); global.fetch = realFetch; });

describe('routes sans appelant anonyme connu : jeton exigé (401)', () => {
  const routes = [
    ['POST', '/api/calls/initiate'], ['POST', '/api/calls/dialplan'], ['POST', '/api/calls/call'], ['POST', '/api/calls/end'],
    ['POST', '/api/vertex/call/score'], ['POST', '/api/vertex/audio/summarize'], ['POST', '/api/vertex/upload'],
  ];
  test.each(routes)('%s %s sans jeton : 401', async (method, path) => {
    expect((await call(method, path, { body: {} })).status).toBe(401);
  });
  test.each(routes)('%s %s jeton forgé avec un autre secret : 401', async (method, path) => {
    const forged = jwt.sign({ userId: 'u-a' }, 'your-secret-key');
    expect((await call(method, path, { auth: forged, body: {} })).status).toBe(401);
  });
  test.each(routes)('%s %s jeton valable : 200', async (method, path) => {
    expect((await call(method, path, { auth: token('u-a'), body: {} })).status).toBe(200);
  });
});

describe('jetons Twilio / Telnyx et IA (groupe compat)', () => {
  const routes = [
    ['GET', '/api/calls/token'], ['POST', '/api/calls/token'], ['POST', '/api/calls/get-login-token'],
    ['POST', '/api/calls/ai-assist'], ['POST', '/api/calls/store-call'], ['POST', '/api/vertex/evaluate-language'],
  ];
  test.each(routes)('%s %s : jeton invalide refusé (401)', async (method, path) => {
    expect((await call(method, path, { auth: 'pas-un-jeton', body: {} })).status).toBe(401);
  });
  test.each(routes)('%s %s : sans jeton refusé quand CALLS_LEGACY_ANON=false (401)', async (method, path) => {
    process.env.CALLS_LEGACY_ANON = 'false';
    expect((await call(method, path, { body: {} })).status).toBe(401);
  });
  test.each(routes)('%s %s : sans jeton toléré tant que les applications ne sont pas migrées (défaut)', async (method, path) => {
    expect((await call(method, path, { body: {} })).status).toBe(200);
  });
  test('jeton valable : 200', async () => {
    expect((await call('GET', '/api/calls/token', { auth: token('u-a') })).status).toBe(200);
  });
});

describe('POST /api/calls/ai-outbound : prospect de l\'entreprise de l\'appelant', () => {
  test('sans jeton et CALLS_LEGACY_ANON=false : 401', async () => {
    process.env.CALLS_LEGACY_ANON = 'false';
    expect((await call('POST', '/api/calls/ai-outbound', { body: { leadId: LEAD_A } })).status).toBe(401);
  });
  test('prospect d\'une autre entreprise : 403', async () => {
    expect((await call('POST', '/api/calls/ai-outbound', { auth: token('u-a'), body: { leadId: LEAD_B } })).status).toBe(403);
  });
  test('prospect sans entreprise déterminable : 403', async () => {
    expect((await call('POST', '/api/calls/ai-outbound', { auth: token('u-a'), body: { leadId: LEAD_NOCOMPANY } })).status).toBe(403);
  });
  test('prospect de son entreprise (via le gig) : 200, entreprise vérifiée imposée', async () => {
    const r = await call('POST', '/api/calls/ai-outbound', { auth: token('u-a'), body: { leadId: LEAD_A, companyId: B }, headers: { 'x-company-id': B } });
    expect(r.status).toBe(200);
    expect(r.body.body.companyId).toBe(A);
  });
  test('raccrocher l\'appel IA d\'une autre entreprise : 403', async () => {
    expect((await call('POST', '/api/calls/ai-outbound/hangup', { auth: token('u-a'), body: { callControlId: 'v3:call-b' } })).status).toBe(403);
    expect((await call('POST', '/api/calls/ai-outbound/hangup', { auth: token('u-b'), body: { callControlId: 'v3:call-b' } })).status).toBe(200);
  });
});

describe('/api/gigs/:id/voice-assistant', () => {
  test('autre entreprise : 403 (lecture et écriture)', async () => {
    expect((await call('GET', `/api/gigs/${GIG_B}/voice-assistant`, { auth: token('u-a') })).status).toBe(403);
    expect((await call('PUT', `/api/gigs/${GIG_B}/voice-assistant`, { auth: token('u-a'), body: { enabled: true } })).status).toBe(403);
  });
  test('son entreprise : 200', async () => {
    expect((await call('PUT', `/api/gigs/${GIG_A}/voice-assistant`, { auth: token('u-a'), body: { enabled: true } })).status).toBe(200);
  });
  test('sans jeton et CALLS_LEGACY_ANON=false : 401', async () => {
    process.env.CALLS_LEGACY_ANON = 'false';
    expect((await call('PUT', `/api/gigs/${GIG_A}/voice-assistant`, { body: { enabled: true } })).status).toBe(401);
  });
});


describe('ressources d\'une entreprise sur les routes des reps (avec un jeton)', () => {
  test('line-for-lead : autre entreprise 403, la sienne 200, rep inscrit au gig 200, rep non inscrit 403', async () => {
    expect((await call('GET', `/api/calls/line-for-lead/${LEAD_B}`, { auth: token('u-a') })).status).toBe(403);
    expect((await call('GET', `/api/calls/line-for-lead/${LEAD_A}`, { auth: token('u-a') })).status).toBe(200);
    expect((await call('GET', `/api/calls/line-for-lead/${LEAD_A}`, { auth: token(U_REP) })).status).toBe(200);
    expect((await call('GET', `/api/calls/line-for-lead/${LEAD_B}`, { auth: token(U_REP) })).status).toBe(403);
  });
  test('store-call et telnyx/finalize : prospect d\'une autre entreprise 403', async () => {
    expect((await call('POST', '/api/calls/store-call', { auth: token('u-a'), body: { leadId: LEAD_B } })).status).toBe(403);
    expect((await call('POST', '/api/calls/telnyx/finalize', { auth: token('u-a'), body: { leadId: LEAD_B } })).status).toBe(403);
    expect((await call('POST', '/api/calls/store-call', { auth: token('u-a'), body: { leadId: LEAD_A } })).status).toBe(200);
  });
  test('telnyx/record-start : appel d\'une autre entreprise 403', async () => {
    expect((await call('POST', '/api/calls/telnyx/record-start', { auth: token('u-a'), body: { callControlId: 'v3:call-b' } })).status).toBe(403);
    expect((await call('POST', '/api/calls/telnyx/record-start', { auth: token('u-b'), body: { callControlId: 'v3:call-b' } })).status).toBe(200);
  });
  test('token et get-login-token : entreprise ou gig d\'une autre entreprise 403', async () => {
    expect((await call('GET', `/api/calls/token?companyId=${B}`, { auth: token('u-a') })).status).toBe(403);
    expect((await call('POST', '/api/calls/get-login-token', { auth: token('u-a'), body: { gigId: GIG_B } })).status).toBe(403);
    expect((await call('POST', '/api/calls/get-login-token', { auth: token('u-a'), body: { gigId: GIG_A } })).status).toBe(200);
  });
  test('ai-outbound/hangup : appel inconnu 404', async () => {
    expect((await call('POST', '/api/calls/ai-outbound/hangup', { auth: token('u-a'), body: { callControlId: 'inconnu' } })).status).toBe(404);
  });
});

describe('OVH : identifiants par variables uniquement', () => {
  test('aucune clé OVH codée en dur', () => {
    const fs = require('fs'); const path = require('path');
    for (const f of ['src/services/integrations/OVHService.js', 'scripts/generatekey.js', 'src/services/integrations/ovh.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');
      expect(src).not.toMatch(/(applicationKey|applicationSecret|consumerKey|appKey|appSecret)\s*[:=]\s*['"`][A-Za-z0-9]{8,}/);
    }
  });
  test('variable manquante : erreur claire', () => {
    const saved = { ...process.env };
    ['OVH_APPLICATION_KEY', 'OVH_APP_KEY', 'OVH_APPLICATION_SECRET', 'OVH_APP_SECRET', 'OVH_CONSUMER_KEY', 'OVH_BILLING_ACCOUNT', 'OVH_SERVICE_NAME', 'OVH_DEFAULT_NUMBER'].forEach((k) => delete process.env[k]);
    const { OVHService } = require('../services/integrations/OVHService');
    expect(() => new OVHService().assertConfigured()).toThrow(/OVH_APPLICATION_KEY/);
    process.env = saved;
  });
});

describe('webhooks Telnyx : signature Ed25519', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const rawKey = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
  const signed = (payload, ts = Math.floor(Date.now() / 1000)) => ({
    'telnyx-timestamp': String(ts),
    'telnyx-signature-ed25519': crypto.sign(null, Buffer.from(`${ts}|${payload}`), privateKey).toString('base64'),
  });
  const payload = JSON.stringify({ data: { event_type: 'call.answered', payload: { call_control_id: 'x' } } });

  test('mode enforce : sans signature 403, signature valable 200, corps modifié 403, horodatage ancien 403', async () => {
    process.env.WEBHOOK_SIGNATURE_MODE = 'enforce';
    process.env.TELNYX_PUBLIC_KEY = rawKey;
    expect((await call('POST', '/api/calls/webhooks/telnyx/call-control', { raw: payload })).status).toBe(403);
    expect((await call('POST', '/api/calls/webhooks/telnyx/call-control', { raw: payload, headers: signed(payload) })).status).toBe(200);
    expect((await call('POST', '/api/calls/webhooks/telnyx/ai-outbound', { raw: payload.replace('answered', 'hangup'), headers: signed(payload) })).status).toBe(403);
    const old = Math.floor(Date.now() / 1000) - 3600;
    expect((await call('POST', '/api/calls/webhooks/telnyx/ai-outbound', { raw: payload, headers: signed(payload, old) })).status).toBe(403);
  });
  test('mode enforce sans TELNYX_PUBLIC_KEY : 403', async () => {
    process.env.WEBHOOK_SIGNATURE_MODE = 'enforce';
    expect((await call('POST', '/api/calls/webhooks/telnyx/call-control', { raw: payload, headers: signed(payload) })).status).toBe(403);
  });
  test('mode log (défaut) : signature absente tolérée', async () => {
    expect((await call('POST', '/api/calls/webhooks/telnyx/call-control', { raw: payload })).status).toBe(200);
  });
});

describe('webhooks Twilio : X-Twilio-Signature', () => {
  const params = { CallSid: 'CA123', CallStatus: 'completed' };
  const form = new URLSearchParams(params).toString();
  const sign = (path) => twilio.getExpectedTwilioSignature('tw-token', `https://dash.example${path}`, params);
  const formHeaders = (extra = {}) => ({ 'Content-Type': 'application/x-www-form-urlencoded', ...extra });

  test('mode enforce : signature valable 200, fausse ou absente 403', async () => {
    process.env.WEBHOOK_SIGNATURE_MODE = 'enforce';
    process.env.TWILIO_AUTH_TOKEN = 'tw-token';
    process.env.PUBLIC_BASE_URL = 'https://dash.example';
    const path = '/api/calls/webhooks/twilio/ai-outbound/status';
    expect((await call('POST', path, { raw: form, headers: formHeaders({ 'X-Twilio-Signature': sign(path) }) })).status).toBe(200);
    expect((await call('POST', path, { raw: form, headers: formHeaders({ 'X-Twilio-Signature': 'faux' }) })).status).toBe(403);
    expect((await call('POST', '/api/calls/amd-callback', { raw: form, headers: formHeaders() })).status).toBe(403);
    expect((await call('POST', '/api/calls/twilio-voice', { raw: form, headers: formHeaders({ 'X-Twilio-Signature': sign('/api/calls/twilio-voice') }) })).status).toBe(200);
  });
  test('mode log (défaut) : signature absente tolérée', async () => {
    expect((await call('POST', '/api/calls/amd-callback', { raw: form, headers: formHeaders() })).status).toBe(200);
  });
  test('URL signée construite depuis BASE_URL ou SELF_API_URL (adresses de rappel) : acceptée en mode enforce', async () => {
    process.env.WEBHOOK_SIGNATURE_MODE = 'enforce';
    process.env.TWILIO_AUTH_TOKEN = 'tw-token';
    process.env.BASE_URL = 'https://autre.example';
    process.env.SELF_API_URL = 'https://dash.example/';
    expect((await call('POST', '/api/calls/amd-callback', { raw: form, headers: formHeaders({ 'X-Twilio-Signature': sign('/api/calls/amd-callback') }) })).status).toBe(200);
  });
});

describe('configuration sans secret de repli', () => {
  test('JWT_SECRET et une adresse MongoDB requis au démarrage', () => {
    const { missingRequiredEnv, assertRequiredEnv } = require('../config/env');
    expect(missingRequiredEnv({})).toEqual(['JWT_SECRET', 'adresse MongoDB (MONGO_URI, MONGODB_URI, MONGO_URL, DATABASE_URL)']);
    expect(missingRequiredEnv({ JWT_SECRET: 's', MONGODB_URI: 'mongodb://h/db' })).toEqual([]);
    expect(() => assertRequiredEnv({ MONGO_URI: 'mongodb://h/db' })).toThrow(/JWT_SECRET/);
  });
  test('variables MongoDB de Railway acceptées ; seul le nom de la variable est donné', () => {
    const { mongoUriSource, missingRequiredEnv } = require('../config/env');
    expect(mongoUriSource({ MONGO_URL: 'mongodb://u:p@h/db' })).toBe('MONGO_URL');
    expect(mongoUriSource({ DATABASE_URL: 'mongodb://u:p@h/db' })).toBe('DATABASE_URL');
    expect(mongoUriSource({ MONGO_URI: 'a', MONGO_URL: 'b' })).toBe('MONGO_URI');
    expect(missingRequiredEnv({ JWT_SECRET: 's', MONGO_URL: 'mongodb://h/db' })).toEqual([]);
    const db = require('fs').readFileSync(require('path').join(__dirname, '../config/database.js'), 'utf8');
    expect(db).not.toMatch(/\$\{config\.MONGODB_URI\}|maskedUri/);
  });
  test('aucune valeur par défaut codée en dur', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '../config/env.js'), 'utf8');
    expect(src).not.toMatch(/your-secret-key/);
    expect(src).not.toMatch(/mongodb:\/\/[^'"`]*@/);
  });
});

describe('identifiants Google : variables JSON uniquement', () => {
  const { googleAuthOptions, readServiceAccount, VERTEX_VARS, STORAGE_VARS } = require('../services/gcpCredentials');
  const silent = { warn: jest.fn(), error: jest.fn() };
  const sa = { type: 'service_account', project_id: 'p1', client_email: 'x@p1.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n' };

  test('JSON entre guillemets et \\n de private_key corrigés', () => {
    const out = googleAuthOptions(VERTEX_VARS, 'Vertex', { VERTEX_AI_CREDENTIALS: `"${JSON.stringify(sa).replace(/"/g, '"')}"` }, silent);
    expect(out.credentials.private_key).toBe('-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n');
    expect(out.projectId).toBe('p1');
  });
  test('aucune variable : identifiants par défaut (ADC), message clair, pas d\'exception', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(googleAuthOptions(VERTEX_VARS, 'Vertex AI', {}, logger)).toEqual({});
    expect(logger.warn.mock.calls[0][0]).toMatch(/VERTEX_AI_CREDENTIALS/);
  });
  test('JSON invalide : erreur nommant la variable, sans sa valeur', () => {
    const logger = { warn: jest.fn(), error: jest.fn() };
    expect(googleAuthOptions(VERTEX_VARS, 'Vertex AI', { VERTEX_AI_CREDENTIALS: '{secret-cassé' }, logger)).toEqual({});
    expect(logger.error.mock.calls[0][0]).toMatch(/VERTEX_AI_CREDENTIALS contient un JSON invalide/);
    expect(logger.error.mock.calls[0][0]).not.toMatch(/secret-cassé/);
  });
  test('GOOGLE_APPLICATION_CREDENTIALS désignant un fichier : laissé à ADC sans erreur', () => {
    expect(readServiceAccount(VERTEX_VARS, { GOOGLE_APPLICATION_CREDENTIALS: '/secrets/key.json' })).toEqual({ source: null });
  });
  test('stockage : à défaut de variable dédiée, compte Vertex', () => {
    expect(readServiceAccount(STORAGE_VARS, { VERTEX_AI_CREDENTIALS: JSON.stringify(sa) }).source).toBe('VERTEX_AI_CREDENTIALS');
  });
  test('aucun fichier de clé dans le dépôt', () => {
    const fs = require('fs'); const path = require('path');
    const root = path.join(__dirname, '../..');
    for (const f of ['config/vertex-service-account.json', 'config/speechToTextServiceAccount.json', 'config/cloud-storage-service-account.json', 'temp/vertex-credentials.json']) {
      expect(fs.existsSync(path.join(root, f))).toBe(false);
    }
  });
});
