const mockCalls = [];

jest.mock('../models/Call', () => {
  const chain = (rows) => {
    const q = {
      sort: () => q,
      limit: () => q,
      populate: () => q,
      lean: () => Promise.resolve(rows),
    };
    return q;
  };
  return {
    Call: {
      findById: jest.fn(async (id) => mockCalls.find((c) => String(c._id) === String(id)) || null),
      find: jest.fn(() => chain(mockCalls)),
    },
  };
});

process.env.JWT_SECRET = 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://registration.test';
const jwt = require('jsonwebtoken');
const { clearCompanyCache } = require('../middleware/companyScope');
const { overturnCallFraud, getCompanyFraudCalls } = require('../controllers/fraudReview');
const { buildCompanyFraudStatsFromCalls, buildFraudOrConditions, isCallFraudDetected, fraudReviewState } = require('../utils/fraudStats');

const ID = (n) => `64b000000000000000000${String(n).padStart(3, '0')}`;
const makeCall = (n, extra = {}) => ({
  _id: ID(n),
  companyId: COMPANY,
  flags: { fraud: true },
  callOutcome: 'fraud',
  agent: { _id: ID(900), firstName: 'Sam', lastName: 'Rep' },
  lead: { Deal_Name: 'Lead A', Phone: '+33600000000' },
  ai_call_score: { 'Fraud detection': { score: 20, feedback_fr: 'Client absent', feedback_en: 'Customer absent' } },
  transcript: Array.from({ length: 12 }, (_, i) => ({ speaker: 'Agent', text: `turn ${i}` })),
  save: jest.fn(async function save() { return this; }),
  ...extra,
});

const COMPANY = '64b0000000000000000000c1';
const run = async (handler, { params = {}, body = {}, query = {}, auth = { userId: 'u-1', token: 't' } } = {}) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
  await handler({ params, body, query, auth }, res);
  return res;
};

// The registration backend says which company the caller belongs to.
const callerCompany = (companyId) => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ success: true, data: { companyId } }) }));
};

beforeEach(() => {
  mockCalls.length = 0;
  clearCompanyCache();
  callerCompany(COMPANY);
});

describe('fraud review decision', () => {
  test('overturn (default) clears the flag and keeps an audit trail', async () => {
    const call = makeCall(1);
    mockCalls.push(call);
    const res = await run(overturnCallFraud, { params: { id: call._id }, body: { reason: 'client réel' } });
    expect(res.statusCode).toBe(200);
    expect(call.flags.fraud).toBe(false);
    expect(call.fraudReview).toMatchObject({ overturned: true, confirmed: false, reason: 'client réel' });
    expect(isCallFraudDetected(call)).toBe(false);
  });

  test('confirm keeps the call counted and marks it reviewed', async () => {
    const call = makeCall(2, { flags: { fraud: false }, callOutcome: null });
    mockCalls.push(call);
    const res = await run(overturnCallFraud, { params: { id: call._id }, body: { decision: 'confirm' } });
    expect(res.statusCode).toBe(200);
    expect(call.flags.fraud).toBe(true);
    expect(call.fraudReview).toMatchObject({ overturned: false, confirmed: true });
    expect(fraudReviewState(call)).toBe('confirmed');
    expect(isCallFraudDetected(call)).toBe(true);
  });

  test('a reviewer can confirm a call they had overturned', async () => {
    const call = makeCall(3, { flags: { fraud: false }, callOutcome: null, ai_call_score: null, fraudReview: { overturned: true } });
    mockCalls.push(call);
    const res = await run(overturnCallFraud, { params: { id: call._id }, body: { decision: 'confirm' } });
    expect(res.statusCode).toBe(200);
    expect(isCallFraudDetected(call)).toBe(true);
  });

  test('rejects an unknown decision and a call that was never flagged', async () => {
    const flagged = makeCall(4);
    const clean = makeCall(5, { flags: { fraud: false }, callOutcome: 'transaction', ai_call_score: { 'Fraud detection': { score: 95 } } });
    mockCalls.push(flagged, clean);
    expect((await run(overturnCallFraud, { params: { id: flagged._id }, body: { decision: 'maybe' } })).statusCode).toBe(400);
    expect((await run(overturnCallFraud, { params: { id: clean._id }, body: { decision: 'confirm' } })).statusCode).toBe(400);
    expect((await run(overturnCallFraud, { params: { id: 'nope' } })).statusCode).toBe(400);
  });
});

describe('authentication and company scope', () => {
  const { authenticateUser } = require('../middleware/companyScope');
  const respond = () => ({ statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } });

  test('authenticateUser rejects a missing, invalid or user-less token and accepts a real one', () => {
    const next = jest.fn();
    let res = respond();
    authenticateUser({ headers: {} }, res, next);
    expect(res.statusCode).toBe(401);
    res = respond();
    authenticateUser({ headers: { authorization: 'Bearer nope' } }, res, next);
    expect(res.statusCode).toBe(401);
    res = respond();
    authenticateUser({ headers: { authorization: `Bearer ${jwt.sign({ scope: 'x' }, 'test-secret')}` } }, res, next);
    expect(res.statusCode).toBe(401);
    res = respond();
    authenticateUser({ headers: { authorization: `Bearer ${jwt.sign({ userId: 'u-1' }, 'other-secret')}` } }, res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();

    const req = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'u-1' }, 'test-secret')}` } };
    authenticateUser(req, respond(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.auth.userId).toBe('u-1');
  });

  test('a user of another company can neither review a call nor list the flagged calls', async () => {
    const call = makeCall(20);
    mockCalls.push(call);
    callerCompany('64b0000000000000000000d9');
    const review = await run(overturnCallFraud, { params: { id: call._id }, body: { decision: 'confirm' } });
    expect(review.statusCode).toBe(403);
    expect(call.fraudReview).toBeUndefined();
    const list = await run(getCompanyFraudCalls, { params: { companyId: COMPANY } });
    expect(list.statusCode).toBe(403);
  });

  test('a caller with no company is refused', async () => {
    mockCalls.push(makeCall(21));
    callerCompany(null);
    expect((await run(getCompanyFraudCalls, { params: { companyId: COMPANY } })).statusCode).toBe(403);
  });

  test('fails closed (503) when the company lookup is down, unless the log-only escape hatch is set', async () => {
    mockCalls.push(makeCall(22));
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 }));
    expect((await run(getCompanyFraudCalls, { params: { companyId: COMPANY } })).statusCode).toBe(503);
    process.env.COMPANY_SCOPE_MODE = 'log';
    callerCompany('64b0000000000000000000d9');
    clearCompanyCache();
    expect((await run(getCompanyFraudCalls, { params: { companyId: COMPANY } })).statusCode).toBe(200);
    delete process.env.COMPANY_SCOPE_MODE;
  });

  test('the reviewer recorded is the authenticated user, not a value sent by the client', async () => {
    const call = makeCall(23);
    mockCalls.push(call);
    await run(overturnCallFraud, { params: { id: call._id }, body: { reviewedBy: '64b0000000000000000000ff' }, auth: { userId: '64b0000000000000000000aa', token: 't' } });
    expect(String(call.fraudReview.reviewedBy)).toBe('64b0000000000000000000aa');
  });
});

describe('fraud review queue', () => {
  const seed = () => {
    mockCalls.push(
      makeCall(10),
      makeCall(11, { fraudReview: { confirmed: true } }),
      makeCall(12, { flags: { fraud: false }, fraudReview: { overturned: true } }),
      makeCall(13, { flags: { fraud: false }, callOutcome: 'transaction', ai_call_score: { 'Fraud detection': { score: 90 } } })
    );
  };

  test('counts per state, default list is "à examiner", clean calls are left out', async () => {
    seed();
    const res = await run(getCompanyFraudCalls, { params: { companyId: COMPANY } });
    expect(res.body.data.counts).toEqual({ pending: 1, confirmed: 1, overturned: 1 });
    expect(res.body.data.calls.map((c) => c.id)).toEqual([ID(10)]);
  });

  test('filters by state and carries the evidence', async () => {
    seed();
    const res = await run(getCompanyFraudCalls, { params: { companyId: COMPANY }, query: { status: 'all' } });
    expect(res.body.data.calls).toHaveLength(3);
    const row = res.body.data.calls.find((c) => c.id === ID(10));
    expect(row).toMatchObject({ agentName: 'Sam Rep', leadName: 'Lead A', fraudScore: 20, review: { state: 'pending' } });
    expect(row.reason.fr).toBe('Client absent');
    expect(row.transcriptPreview).toHaveLength(8);
    const confirmed = await run(getCompanyFraudCalls, { params: { companyId: COMPANY }, query: { status: 'confirmed' } });
    expect(confirmed.body.data.calls.map((c) => c.id)).toEqual([ID(11)]);
  });
});

describe('fraud stats', () => {
  test('separates confirmed from pending and counts overturned calls', () => {
    const calls = [makeCall(1), makeCall(2, { fraudReview: { confirmed: true } }), makeCall(3, { flags: { fraud: false }, fraudReview: { overturned: true } })];
    const stats = buildCompanyFraudStatsFromCalls(calls);
    expect(stats).toMatchObject({ totalFraudCount: 2, confirmedCount: 1, pendingReviewCount: 1, overturnedCount: 1 });
  });

  test('the match query keeps overturned calls reachable', () => {
    expect(buildFraudOrConditions()).toContainEqual({ 'fraudReview.overturned': true });
  });
});
