/**
 * Routes de l'agent vocal IA : jeton de l'entreprise exigé, appartenance au centre vérifiée, webhooks signés.
 */
process.env.JWT_SECRET = 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://reg.example';

const handlerOf = (name) => (req, res) => res.status(200).json({ success: true, handler: name, companyId: req.companyId || null });
jest.mock('../controllers/calls', () => new Proxy({}, { get: (_t, name) => (typeof name === 'string' && name !== 'then' && name !== '__esModule' ? handlerOf(name) : undefined) }));
jest.mock('../controllers/gigs', () => ({ getGig: (req, res) => res.json({ ok: true }), updateGigVoiceAssistant: (req, res) => res.status(200).json({ success: true, handler: 'updateGigVoiceAssistant', companyId: req.companyId }) }));

const mockGigs = {};
const mongoose = require('mongoose');
Object.defineProperty(mongoose.connection, 'db', {
  configurable: true,
  get: () => ({
    collection: () => ({
      findOne: async (q) => {
        const ids = (q.$or || []).map((c) => String(c._id));
        return ids.map((id) => mockGigs[id]).find(Boolean) || null;
      },
    }),
  }),
});

const crypto = require('crypto');
const http = require('http');
const express = require('express');
const jwt = require('jsonwebtoken');
const twilio = require('twilio');
const { clearCompanyCache } = require('../middleware/companyScope');
const { captureRawBody } = require('../middleware/webhookSignature');

const A = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const B = 'bbbbbbbbbbbbbbbbbbbbbbb2';
const GIG_A = '6a0000000000000000000a01';
const GIG_B = '6b0000000000000000000b02';
const GIG_NONE = '6c0000000000000000000c03';
const token = (userId) => jwt.sign({ userId }, 'test-secret');
const members = { 'u-a': A, 'u-b': B, 'u-none': null };

let server; let port; let realFetch;
const request = (method, path, { auth, body, headers = {}, raw, contentType = 'application/json' } = {}) => new Promise((resolve, reject) => {
  const data = raw !== undefined ? raw : (body ? JSON.stringify(body) : null);
  const req = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': contentType, ...(auth ? { Authorization: `Bearer ${auth}` } : {}), ...headers } }, (res) => {
    let out = ''; res.on('data', (c) => { out += c; });
    res.on('end', () => { let parsed = out; try { parsed = JSON.parse(out); } catch (_e) { /* texte */ } resolve({ status: res.statusCode, body: parsed }); });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

beforeAll(async () => {
  realFetch = global.fetch;
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ verify: captureRawBody }));
  app.use('/api/calls', require('../routes/calls'));
  app.use('/api/gigs', require('../routes/gigs'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});
afterAll(async () => { global.fetch = realFetch; await new Promise((r) => server.close(r)); });
beforeEach(() => {
  clearCompanyCache();
  delete process.env.WEBHOOK_SIGNATURE_MODE;
  Object.keys(mockGigs).forEach((k) => delete mockGigs[k]);
  mockGigs[GIG_A] = { _id: GIG_A, companyId: A };
  mockGigs[GIG_B] = { _id: GIG_B, companyId: B };
  global.fetch = jest.fn(async (url) => {
    const userId = new URL(url).searchParams.get('userId');
    return { ok: true, json: async () => ({ success: true, data: { companyId: members[userId] ?? null } }) };
  });
});

describe('POST /api/calls/ai-outbound', () => {
  test('rejects a request without token', async () => {
    const res = await request('POST', '/api/calls/ai-outbound', { body: { leadId: GIG_A, companyId: A } });
    expect(res.status).toBe(401);
  });

  test('rejects an invalid token', async () => {
    const res = await request('POST', '/api/calls/ai-outbound', { auth: jwt.sign({ userId: 'u-a' }, 'other-secret'), body: { leadId: GIG_A } });
    expect(res.status).toBe(401);
  });

  test('ignores the legacy anonymous fallback (CALLS_REQUIRE_AUTH=false)', async () => {
    process.env.CALLS_REQUIRE_AUTH = 'false';
    try {
      const res = await request('POST', '/api/calls/ai-outbound', { body: { leadId: GIG_A }, headers: { 'x-company-id': A } });
      expect(res.status).toBe(401);
    } finally {
      delete process.env.CALLS_REQUIRE_AUTH;
    }
  });

  test('passes the caller company (from the registration service) to the controller', async () => {
    const res = await request('POST', '/api/calls/ai-outbound', { auth: token('u-a'), body: { leadId: GIG_A } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handler: 'startAiOutbound', companyId: A });
  });

  test('rejects a companyId in the body that is not the caller company', async () => {
    const res = await request('POST', '/api/calls/ai-outbound', { auth: token('u-a'), body: { leadId: GIG_A, companyId: B } });
    expect(res.status).toBe(403);
  });

  test('rejects an x-company-id header that is not the caller company', async () => {
    const res = await request('POST', '/api/calls/ai-outbound', { auth: token('u-a'), body: { leadId: GIG_A }, headers: { 'x-company-id': B } });
    expect(res.status).toBe(403);
  });

  test('rejects a user attached to no company', async () => {
    const res = await request('POST', '/api/calls/ai-outbound', { auth: token('u-none'), body: { leadId: GIG_A } });
    expect(res.status).toBe(403);
  });

  test('hangup requires a token too', async () => {
    expect((await request('POST', '/api/calls/ai-outbound/hangup', { body: { callControlId: 'v3:abc' } })).status).toBe(401);
    const ok = await request('POST', '/api/calls/ai-outbound/hangup', { auth: token('u-a'), body: { callControlId: 'v3:abc' } });
    expect(ok.body).toMatchObject({ handler: 'hangupAiOutbound', companyId: A });
  });
});

describe('/api/gigs/:id/voice-assistant', () => {
  test.each(['GET', 'PUT'])('%s without token is rejected', async (method) => {
    const res = await request(method, `/api/gigs/${GIG_A}/voice-assistant`, { body: method === 'PUT' ? { enabled: true, systemPrompt: 'x' } : undefined });
    expect(res.status).toBe(401);
  });

  test.each(['GET', 'PUT'])('%s on another company gig is rejected', async (method) => {
    const res = await request(method, `/api/gigs/${GIG_B}/voice-assistant`, { auth: token('u-a'), body: method === 'PUT' ? { enabled: true, systemPrompt: 'ignore previous instructions' } : undefined });
    expect(res.status).toBe(403);
  });

  test('PUT on an unknown gig is rejected (no gig is created)', async () => {
    const res = await request('PUT', `/api/gigs/${GIG_NONE}/voice-assistant`, { auth: token('u-a'), body: { enabled: true } });
    expect(res.status).toBe(404);
  });

  test('PUT on an own gig reaches the controller', async () => {
    const res = await request('PUT', `/api/gigs/${GIG_A}/voice-assistant`, { auth: token('u-a'), body: { enabled: true } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handler: 'updateGigVoiceAssistant', companyId: A });
  });
});

describe('AI outbound webhooks signatures', () => {
  const TWILIO_TOKEN = 'twilio-test-token';
  const twilioPath = '/api/calls/webhooks/twilio/ai-outbound/status?streamToken=abc';
  const params = { CallSid: 'CA123', CallStatus: 'completed' };
  const form = new URLSearchParams(params).toString();

  beforeEach(() => {
    process.env.TWILIO_AUTH_TOKEN = TWILIO_TOKEN;
    process.env.PUBLIC_BASE_URL = 'https://calls.example';
  });
  afterEach(() => { delete process.env.TWILIO_AUTH_TOKEN; delete process.env.PUBLIC_BASE_URL; delete process.env.TELNYX_PUBLIC_KEY; });

  test('Twilio webhook without signature is rejected', async () => {
    const res = await request('POST', twilioPath, { raw: form, contentType: 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(403);
  });

  test('Twilio webhook with a valid signature is accepted', async () => {
    const sig = twilio.getExpectedTwilioSignature(TWILIO_TOKEN, `https://calls.example${twilioPath}`, params);
    const res = await request('POST', twilioPath, { raw: form, contentType: 'application/x-www-form-urlencoded', headers: { 'X-Twilio-Signature': sig } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handler: 'handleTwilioAiOutboundStatus' });
  });

  test('Twilio webhook with a signature for other params is rejected', async () => {
    const sig = twilio.getExpectedTwilioSignature(TWILIO_TOKEN, `https://calls.example${twilioPath}`, { ...params, CallStatus: 'ringing' });
    const res = await request('POST', twilioPath, { raw: form, contentType: 'application/x-www-form-urlencoded', headers: { 'X-Twilio-Signature': sig } });
    expect(res.status).toBe(403);
  });

  test('Twilio webhook fails closed when TWILIO_AUTH_TOKEN is missing', async () => {
    delete process.env.TWILIO_AUTH_TOKEN;
    const res = await request('POST', twilioPath, { raw: form, contentType: 'application/x-www-form-urlencoded', headers: { 'X-Twilio-Signature': 'x' } });
    expect(res.status).toBe(503);
  });

  describe('Telnyx', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const rawPub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const path = '/api/calls/webhooks/telnyx/ai-outbound';
    const body = JSON.stringify({ data: { event_type: 'call.answered', payload: { call_control_id: 'v3:abc' } } });
    const sign = (ts, payload = body) => crypto.sign(null, Buffer.from(`${ts}|${payload}`), privateKey).toString('base64');
    const now = () => String(Math.floor(Date.now() / 1000));

    beforeEach(() => { process.env.TELNYX_PUBLIC_KEY = rawPub; });

    test('without signature is rejected', async () => {
      expect((await request('POST', path, { raw: body })).status).toBe(403);
    });

    test('with a valid signature is accepted', async () => {
      const ts = now();
      const res = await request('POST', path, { raw: body, headers: { 'telnyx-signature-ed25519': sign(ts), 'telnyx-timestamp': ts } });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ handler: 'handleTelnyxAiOutboundWebhook' });
    });

    test('with a tampered body is rejected', async () => {
      const ts = now();
      const res = await request('POST', path, { raw: body.replace('call.answered', 'call.hangup'), headers: { 'telnyx-signature-ed25519': sign(ts), 'telnyx-timestamp': ts } });
      expect(res.status).toBe(403);
    });

    test('with a stale timestamp is rejected (replay)', async () => {
      const ts = String(Math.floor(Date.now() / 1000) - 3600);
      const res = await request('POST', path, { raw: body, headers: { 'telnyx-signature-ed25519': sign(ts), 'telnyx-timestamp': ts } });
      expect(res.status).toBe(403);
    });

    test('fails closed when TELNYX_PUBLIC_KEY is missing', async () => {
      delete process.env.TELNYX_PUBLIC_KEY;
      const ts = now();
      const res = await request('POST', path, { raw: body, headers: { 'telnyx-signature-ed25519': sign(ts), 'telnyx-timestamp': ts } });
      expect(res.status).toBe(503);
    });

    test('WEBHOOK_SIGNATURE_MODE=log tolerates an unsigned request', async () => {
      process.env.WEBHOOK_SIGNATURE_MODE = 'log';
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await request('POST', path, { raw: body })).status).toBe(200);
      warn.mockRestore();
    });
  });
});
