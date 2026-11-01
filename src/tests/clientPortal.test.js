process.env.JWT_SECRET = 'test-secret';
process.env.REGISTRATION_BACKEND_URL = 'https://reg.example';

const mockAggregate = jest.fn();
const mockFind = jest.fn();
const mockCount = jest.fn();
jest.mock('../models/Call', () => ({ Call: { aggregate: (...a) => mockAggregate(...a), find: (...a) => mockFind(...a), countDocuments: (...a) => mockCount(...a) } }));
jest.mock('../models/Gig', () => ({ find: () => ({ select: async () => [{ _id: 'aaaaaaaaaaaaaaaaaaaaaaa1', title: 'Support Acme' }] }) }));

const jwt = require('jsonwebtoken');
const { authenticateUser } = require('../middleware/companyScope');
const router = require('../routes/clientPortal');
const controller = require('../controllers/clientPortal');

const G1 = 'aaaaaaaaaaaaaaaaaaaaaaa1';
const G2 = 'aaaaaaaaaaaaaaaaaaaaaaa2';
const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbb9';
const makeRes = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  return res;
};
const req = (query = {}) => ({ query, auth: { userId: 'u-client', token: 'tok' } });
const me = (data, ok = true) => { global.fetch = jest.fn(async () => ({ ok, status: ok ? 200 : 500, json: async () => ({ data }) })); };
const clientMe = (over = {}) => ({
  isClient: true, isOwner: false, companyId: null, permissions: { 'calls.view': true, 'calls.listen': false },
  client: { id: 'c1', name: 'Acme', gigIds: [G1, G2], allowRecordings: false, branding: { displayName: 'Marque', primaryColor: '#112233', logoUrl: '' }, ...over },
});
const chain = (rows) => ({ select: () => ({ sort: () => ({ skip: () => ({ limit: () => ({ lean: async () => rows }) }) }) }) });

beforeEach(() => { jest.clearAllMocks(); mockCount.mockResolvedValue(1); });

describe('routes du portail client', () => {
  test('lecture seule : uniquement des GET, derrière le jeton', () => {
    const layers = router.stack.filter((l) => l.route);
    expect(layers.length).toBe(3);
    for (const l of layers) expect(Object.keys(l.route.methods)).toEqual(['get']);
    expect(router.stack[0].handle).toBe(authenticateUser);
  });
  test('sans jeton : 401', () => {
    const res = makeRes(); const next = jest.fn();
    authenticateUser({ headers: {} }, res, next);
    expect(res.statusCode).toBe(401); expect(next).not.toHaveBeenCalled();
    const ok = { headers: { authorization: `Bearer ${jwt.sign({ userId: 'u1' }, 'test-secret')}` } };
    authenticateUser(ok, makeRes(), next); expect(next).toHaveBeenCalled();
  });
});

describe('portée', () => {
  test.each([
    ['titulaire du centre', { isOwner: true, isClient: false, companyId: 'co1', permissions: {} }],
    ['agent', { isAgent: true, isOwner: false, companyId: 'co1' }],
    ['accès retiré', { isClient: true, isOwner: false, client: null, closedReason: 'revoked' }],
  ])('%s : 403, aucune lecture d’appel', async (_l, data) => {
    me(data);
    for (const fn of [controller.overview, controller.calls, controller.me]) {
      const res = makeRes(); await fn(req(), res);
      expect(res.statusCode).toBe(403);
    }
    expect(mockAggregate).not.toHaveBeenCalled(); expect(mockFind).not.toHaveBeenCalled();
  });
  test('service d’inscription indisponible : 503, fermé', async () => {
    me({}, false); const res = makeRes(); await controller.calls(req(), res);
    expect(res.statusCode).toBe(503); expect(mockFind).not.toHaveBeenCalled();
  });
  test('un autre client (gigId étranger demandé) : rien, aucune requête', async () => {
    me(clientMe());
    const res = makeRes(); await controller.calls(req({ gigId: OTHER }), res);
    expect(res.body.data.calls).toEqual([]); expect(mockFind).not.toHaveBeenCalled();
    const res2 = makeRes(); await controller.overview(req({ gigId: OTHER }), res2);
    expect(res2.body.data.totals.calls).toBe(0); expect(mockAggregate).not.toHaveBeenCalled();
  });
  test('la requête est limitée aux opérations du client, hors tests ; companyId de la requête ignoré', async () => {
    me(clientMe());
    mockFind.mockReturnValue(chain([]));
    await controller.calls(req({ companyId: 'autre', gigId: 'all' }), makeRes());
    const match = mockCount.mock.calls[0][0];
    expect(match.gigId.$in.map(String).sort()).toEqual([G1, G2]);
    expect(match.isTest).toEqual({ $ne: true });
    expect(match.companyId).toBeUndefined();
  });
});

describe('contenu', () => {
  const row = { _id: 'cc1', direction: 'inbound', from: '+33100000000', to: '+33900000000', startTime: new Date(), duration: 120, status: 'completed', gigId: G1, ai_call_score: { overall: { score: 81.4 } }, recording_url: 'https://rec/1.mp3' };
  test('enregistrement masqué si le centre ne l’autorise pas', async () => {
    me(clientMe()); mockFind.mockReturnValue(chain([row]));
    const res = makeRes(); await controller.calls(req(), res);
    const c = res.body.data.calls[0];
    expect(c.recordingUrl).toBeNull(); expect(c.quality).toBe(81); expect(c.operation).toBe('Support Acme');
    expect(Object.keys(c).sort()).toEqual(['direction', 'durationSeconds', 'from', 'id', 'operation', 'quality', 'recordingUrl', 'startTime', 'status', 'to']);
  });
  test('enregistrement renvoyé si autorisé', async () => {
    const d = clientMe({ allowRecordings: true }); d.permissions['calls.listen'] = true; me(d); mockFind.mockReturnValue(chain([row]));
    const res = makeRes(); await controller.calls(req(), res);
    expect(res.body.data.calls[0].recordingUrl).toBe('https://rec/1.mp3');
  });
  test('autorisation d’écoute sans droit calls.listen : masqué', async () => {
    const d = clientMe({ allowRecordings: true }); me(d); mockFind.mockReturnValue(chain([row]));
    const res = makeRes(); await controller.calls(req(), res);
    expect(res.body.data.calls[0].recordingUrl).toBeNull();
  });
  test('indicateurs', async () => {
    me(clientMe());
    mockAggregate.mockResolvedValue([{ _id: G1, calls: 10, answered: 8, durationSeconds: 800, qualitySum: 640, scoredCalls: 8 }]);
    const res = makeRes(); await controller.overview(req({ days: '7' }), res);
    expect(res.body.data.totals).toEqual({ calls: 10, answered: 8, durationSeconds: 800, averageSeconds: 100, averageQuality: 80, scoredCalls: 8 });
    expect(res.body.data.days).toBe(7);
    expect(res.body.data.operations[0].name).toBe('Support Acme');
  });
  test('/me renvoie la marque du centre', async () => {
    me(clientMe()); const res = makeRes(); await controller.me(req(), res);
    expect(res.body.data.branding.displayName).toBe('Marque'); expect(res.body.data.clientName).toBe('Acme');
  });
});
