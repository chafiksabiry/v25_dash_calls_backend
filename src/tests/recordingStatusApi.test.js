process.env.JWT_SECRET = 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://reg.example';

const mockCall = { find: jest.fn(), findById: jest.fn(), findOne: jest.fn(), updateOne: jest.fn(), aggregate: jest.fn(), countDocuments: jest.fn() };
const mockIntent = { find: jest.fn(), findOne: jest.fn(), updateOne: jest.fn() };
jest.mock('../models/Call', () => ({ Call: mockCall }));
jest.mock('../models/CallRecordingIntent', () => mockIntent);
jest.mock('../models/Gig', () => ({ find: () => ({ select: async () => [{ _id: 'aaaaaaaaaaaaaaaaaaaaaaa1', title: 'Support Acme' }] }) }));
jest.mock('../services/vertexai.service', () => ({}));
jest.mock('../services/integrations/twilio', () => ({}));
jest.mock('../services/integrations/telnyxService', () => ({}));
jest.mock('../services/integrations/qaqlulService', () => ({}));
jest.mock('../services/integrations/ovh', () => ({}));
jest.mock('../services/CallService', () => ({ CallService: function CallService() {} }));

const URL = 'https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/RE1';
const COMPANY = '64b0000000000000000000c1';
const makeRes = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  return res;
};
const noIntent = () => mockIntent.find.mockImplementation(() => ({ select: () => ({ lean: async () => [] }) }));
beforeEach(() => { Object.values(mockCall).forEach((f) => f.mockReset()); Object.values(mockIntent).forEach((f) => f.mockReset()); noIntent(); });

describe('routes', () => {
  it('décision et échec d’enregistrement : POST, jeton de service call-recording, déclarés avant /:id', () => {
    jest.isolateModules(() => {
      jest.doMock('../controllers/calls', () => new Proxy({}, { get: (_t, n) => (typeof n === 'string' && n !== 'then' && n !== '__esModule' ? () => {} : undefined) }));
      const access = require('../middleware/callsAccess');
      const router = require('../routes/calls');
      const routes = router.stack.filter((l) => l.route).map((l) => l.route);
      for (const path of ['/recording', '/recording/intent', '/recording/failed']) {
        const r = routes.find((x) => x.path === path);
        expect(r).toBeDefined();
        expect(Object.keys(r.methods)).toEqual(['post']);
        expect(r.stack[0].handle).toBe(access.callRecordingServiceAuth);
      }
    });
    jest.dontMock('../controllers/calls');
  });
});

describe('contrôleurs de décision / échec', () => {
  const SID = `CA${'a'.repeat(32)}`;
  const lean = (v) => { const p = { select: () => p, lean: async () => v }; return p; };
  it('POST /recording/intent : 200 et mémorise la décision (appel non créé)', async () => {
    const c = require('../controllers/calls');
    mockCall.findOne.mockImplementation(() => lean(null));
    mockIntent.findOne.mockImplementation(() => lean(null));
    mockIntent.updateOne.mockResolvedValue({});
    const res = makeRes();
    await c.recordCallRecordingIntent({ body: { sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, recordingStatus: 'pending' });
    expect(mockIntent.updateOne).toHaveBeenCalled();
  });
  it('POST /recording/failed : 409 pour une autre société, 500 propre si la base échoue', async () => {
    const c = require('../controllers/calls');
    mockCall.findOne.mockImplementation(() => lean({ sid: SID, companyId: '64b0000000000000000000c2' }));
    mockIntent.findOne.mockImplementation(() => lean(null));
    let res = makeRes();
    await c.reportCallRecordingFailure({ body: { sid: SID, companyId: COMPANY } }, res);
    expect(res.statusCode).toBe(409);
    mockCall.findOne.mockImplementation(() => { throw new Error('db'); });
    res = makeRes();
    await c.reportCallRecordingFailure({ body: { sid: SID, companyId: COMPANY } }, res);
    expect(res.statusCode).toBe(500);
  });
});

describe('détail et listes exposent recordingStatus / recordingReason', () => {
  const doc = (o) => ({ toJSON: () => ({ _id: 'x', sid: 'CA1', ...o }) });
  const popChain = (rows) => { const p = { populate: () => p, sort: async () => rows, then: undefined }; return p; };

  it('GET /calls/:id : appel ancien avec URL → recorded', async () => {
    const c = require('../controllers/calls');
    mockCall.findById.mockImplementation(() => { const p = { populate: () => p, then: (ok) => ok(doc({ recording_url: URL })) }; return p; });
    const res = makeRes();
    await c.getCall({ params: { id: 'x' } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ sid: 'CA1', recordingStatus: 'recorded', recordingReason: null });
  });
  it('GET /calls/:id : appel ancien sans URL → not_recorded / unknown_legacy ; appel introuvable : 404', async () => {
    const c = require('../controllers/calls');
    mockCall.findById.mockImplementation(() => { const p = { populate: () => p, then: (ok) => ok(doc({})) }; return p; });
    let res = makeRes();
    await c.getCall({ params: { id: 'x' } }, res);
    expect(res.body.data).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'unknown_legacy' });
    mockCall.findById.mockImplementation(() => { const p = { populate: () => p, then: (ok) => ok(null) }; return p; });
    res = makeRes();
    await c.getCall({ params: { id: 'x' } }, res);
    expect(res.statusCode).toBe(404);
  });
  it('GET /calls (société) : chaque appel porte son statut, les commissions restent inversées', async () => {
    const c = require('../controllers/calls');
    const rows = [
      { toObject: () => ({ sid: 'CA1', repCallCommission: 5, recordingStatus: 'pending', recordingReason: 'recorded_planned' }), toJSON: () => ({}) },
      { toObject: () => ({ sid: 'CA2', recording_url: URL }), toJSON: () => ({}) },
    ];
    mockCall.find.mockImplementation(() => popChain(rows));
    const res = makeRes();
    await c.getCalls({ query: { companyId: COMPANY } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((r) => r.recordingStatus)).toEqual(['pending', 'recorded']);
    expect(res.body.data[0].repCallCommission).toBe(-5);
  });
  it('GET /calls/agent/:id : statut présent', async () => {
    const c = require('../controllers/calls');
    const rows = [{ toObject: () => ({ sid: 'CA1' }), toJSON: () => ({ sid: 'CA1' }) }];
    mockCall.find.mockImplementation(() => popChain(rows));
    const res = makeRes();
    await c.getCallsByAgent({ params: { agentId: 'a1' } }, res);
    expect(res.body.data[0]).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'unknown_legacy' });
  });

  it('portail client : statut exposé même quand l’écoute est interdite (URL masquée)', async () => {
    const portal = require('../controllers/clientPortal');
    const G1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
    global.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ data: { isClient: true, isOwner: false, companyId: null, permissions: { 'calls.view': true, 'calls.listen': false }, client: { id: 'c1', name: 'Acme', gigIds: [G1], allowRecordings: false, branding: {} } } }) }));
    const rows = [{ _id: 'r1', sid: 'CA1', direction: 'outbound', gigId: G1, recording_url: URL }, { _id: 'r2', sid: 'CA2', direction: 'inbound', gigId: G1, recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' }];
    mockCall.countDocuments.mockResolvedValue(2);
    mockCall.find.mockImplementation(() => ({ select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }) }) }) }));
    const res = makeRes();
    await portal.calls({ query: {}, auth: { userId: 'u-client', token: 'tok' } }, res);
    expect(res.statusCode).toBe(200);
    const out = res.body.data ? res.body.data.calls : res.body.calls;
    expect(out.map((r) => [r.recordingStatus, r.recordingReason, r.recordingUrl])).toEqual([['recorded', null, null], ['not_recorded', 'plan_excludes', null]]);
  });

  it('API centre (center-data) : statut présent dans la liste des appels', async () => {
    const center = require('../controllers/internalCenter');
    const rows = [{ _id: 'b'.repeat(24), sid: 'CA1', recording_url: URL }, { _id: 'a'.repeat(24), sid: 'CA2' }];
    mockCall.find.mockImplementation(() => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => rows }) }) }) }));
    const res = { code: 200, status(x) { res.code = x; return res; }, json(b) { res.body = b; return res; } };
    await center.listCalls({ params: { companyId: '64b000000000000000000001' }, query: {} }, res);
    expect(res.code).toBe(200);
    expect(res.body.data.map((r) => [r.recordingStatus, r.recordingReason])).toEqual([['recorded', null], ['not_recorded', 'unknown_legacy']]);
  });

  it('analytics « appels récents » : statut présent, sans exposer d’URL', async () => {
    const analytics = require('../controllers/callsAnalytics');
    mockCall.aggregate.mockImplementation(async (pipeline) => {
      const project = pipeline.find((s) => s.$project).$project;
      expect(project).toMatchObject({ sid: 1, recordingStatus: 1, recordingReason: 1, recordingReasonAt: 1 });
      expect(project.hasRecording).toBeDefined();
      expect(project.recording_url).toBeUndefined();
      expect(project.recording_url_cloudinary).toBeUndefined();
      return [{ _id: 'c1', sid: 'CA1', hasRecording: true }, { _id: 'c2', sid: 'CA2', hasRecording: false, recordingStatus: 'pending', recordingReason: 'recorded_planned' }];
    });
    const res = makeRes();
    await analytics.recent({ params: { companyId: '64b000000000000000000001' }, query: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.calls.map((r) => r.recordingStatus)).toEqual(['recorded', 'pending']);
  });
});
