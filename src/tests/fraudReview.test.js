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

const { overturnCallFraud, getCompanyFraudCalls } = require('../controllers/fraudReview');
const { buildCompanyFraudStatsFromCalls, buildFraudOrConditions, isCallFraudDetected, fraudReviewState } = require('../utils/fraudStats');

const ID = (n) => `64b000000000000000000${String(n).padStart(3, '0')}`;
const makeCall = (n, extra = {}) => ({
  _id: ID(n),
  flags: { fraud: true },
  callOutcome: 'fraud',
  agent: { _id: ID(900), firstName: 'Sam', lastName: 'Rep' },
  lead: { Deal_Name: 'Lead A', Phone: '+33600000000' },
  ai_call_score: { 'Fraud detection': { score: 20, feedback_fr: 'Client absent', feedback_en: 'Customer absent' } },
  transcript: Array.from({ length: 12 }, (_, i) => ({ speaker: 'Agent', text: `turn ${i}` })),
  save: jest.fn(async function save() { return this; }),
  ...extra,
});

const run = async (handler, { params = {}, body = {}, query = {} } = {}) => {
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; } };
  await handler({ params, body, query }, res);
  return res;
};

beforeEach(() => { mockCalls.length = 0; });

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
    const res = await run(getCompanyFraudCalls, { params: { companyId: ID(1) } });
    expect(res.body.data.counts).toEqual({ pending: 1, confirmed: 1, overturned: 1 });
    expect(res.body.data.calls.map((c) => c.id)).toEqual([ID(10)]);
  });

  test('filters by state and carries the evidence', async () => {
    seed();
    const res = await run(getCompanyFraudCalls, { params: { companyId: ID(1) }, query: { status: 'all' } });
    expect(res.body.data.calls).toHaveLength(3);
    const row = res.body.data.calls.find((c) => c.id === ID(10));
    expect(row).toMatchObject({ agentName: 'Sam Rep', leadName: 'Lead A', fraudScore: 20, review: { state: 'pending' } });
    expect(row.reason.fr).toBe('Client absent');
    expect(row.transcriptPreview).toHaveLength(8);
    const confirmed = await run(getCompanyFraudCalls, { params: { companyId: ID(1) }, query: { status: 'confirmed' } });
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
