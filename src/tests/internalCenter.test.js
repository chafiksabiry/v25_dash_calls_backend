const jwt = require('jsonwebtoken');

const OID = '64b000000000000000000001';
const OTHER = '64b000000000000000000002';
const mockFind = jest.fn();
const mockGigFindOne = jest.fn();
const mockInsertMany = jest.fn();
const chain = (rows) => ({ sort: () => ({ limit: () => ({ select: () => ({ lean: async () => rows }) }) }) });
jest.mock('../models/Call', () => ({ find: (...a) => mockFind('call', ...a) }));
jest.mock('../models/Lead', () => ({ Lead: { find: (...a) => mockFind('lead', ...a), insertMany: (...a) => mockInsertMany(...a) } }));
jest.mock('../models/Gig', () => ({ findOne: (...a) => ({ select: () => ({ lean: async () => mockGigFindOne(...a) }) }) }));

process.env.JWT_SECRET = 'secret';
const c = require('../controllers/internalCenter');
const res = () => { const r = { code: 200, status(x) { r.code = x; return r; }, json(b) { r.body = b; return r; } }; return r; };
const bearer = (scope = 'center-data', exp = 60) => ({ authorization: `Bearer ${jwt.sign({ scope }, 'secret', { expiresIn: exp })}` });

describe('authenticateCenterService', () => {
  const run = (headers) => { const r = res(); const next = jest.fn(); c.authenticateCenterService({ headers }, r, next); return { r, next }; };
  it('accepte uniquement un jeton de service de portée center-data', () => {
    expect(run(bearer()).next).toHaveBeenCalled();
    expect(run(bearer('voicemail-analyze')).r.code).toBe(401);
    expect(run({}).r.code).toBe(401);
    expect(run({ authorization: `Bearer ${jwt.sign({ scope: 'center-data' }, 'autre', { expiresIn: 60 })}` }).r.code).toBe(401);
    expect(run({ authorization: `Bearer ${jwt.sign({ scope: 'center-data' }, 'secret')}` }).r.code).toBe(401); // sans expiration
  });
});

describe('lecture', () => {
  beforeEach(() => { mockFind.mockReset(); mockInsertMany.mockReset(); mockGigFindOne.mockReset(); });
  it('appels : filtrés sur le centre, hors appels de test, pagination par curseur', async () => {
    const rows = [{ _id: 'b'.repeat(24), sid: 'CA2', duration: 5 }, { _id: 'a'.repeat(24), sid: 'CA1', duration: 3 }];
    mockFind.mockImplementation((kind) => chain(rows));
    const r = res();
    await c.listCalls({ params: { companyId: OID }, query: { limit: '1', cursor: OTHER, since: '2026-01-01' } }, r);
    const filter = mockFind.mock.calls[0][1];
    expect(String(filter.companyId.$in[0])).toBe(OID);
    expect(filter.isTest).toEqual({ $ne: true });
    expect(String(filter._id.$lt)).toBe(OTHER);
    expect(r.body.data).toHaveLength(1);
    expect(r.body.nextCursor).toBe('b'.repeat(24));
    const bad = res(); await c.listCalls({ params: { companyId: 'x' }, query: {} }, bad); expect(bad.code).toBe(400);
  });
  it('contacts : nom complet scindé quand seul `name` existe', async () => {
    mockFind.mockImplementation(() => chain([{ _id: 'a'.repeat(24), name: 'Marie Martin', email: 'm@x.fr', phone: '06' }]));
    const r = res();
    await c.listContacts({ params: { companyId: OID }, query: {} }, r);
    expect(r.body.data[0]).toMatchObject({ firstName: 'Marie', lastName: 'Martin', email: 'm@x.fr', phone: '06' });
    expect(r.body.nextCursor).toBeNull();
  });
});

describe('import de contacts', () => {
  beforeEach(() => { mockFind.mockReset(); mockInsertMany.mockReset(); mockGigFindOne.mockReset(); });
  const body = (contacts) => ({ params: { companyId: OID }, body: { gigId: OTHER, source: 'hubspot', contacts } });
  it('refuse une opération qui n’est pas celle du centre', async () => {
    mockGigFindOne.mockReturnValue(null);
    const r = res(); await c.importLeads(body([{ email: 'a@b.fr' }]), r);
    expect(r.code).toBe(404); expect(mockInsertMany).not.toHaveBeenCalled();
  });
  it('crée les prospects avec les champs existants et ignore les doublons', async () => {
    mockGigFindOne.mockReturnValue({ _id: OTHER });
    mockFind.mockReturnValue({ select: () => ({ lean: async () => [{ Phone: '+33 6 12 34 56 78' }, { Email_1: 'deja@x.fr' }] }) });
    const r = res();
    await c.importLeads(body([
      { firstName: 'A', lastName: 'B', email: 'A@x.fr', phone: '0611111111' },
      { email: 'deja@x.fr' }, { phone: '+33612345678' }, { firstName: 'sans moyen de contact' }, { email: 'a@x.fr' },
    ]), r);
    expect(r.body.data).toEqual({ created: 1, skipped: 4 });
    const docs = mockInsertMany.mock.calls[0][0];
    expect(docs[0]).toMatchObject({ First_Name: 'A', Last_Name: 'B', Email_1: 'a@x.fr', Phone: '0611111111', source: 'crm:hubspot', status: 'new' });
    expect(String(docs[0].companyId)).toBe(OID); expect(String(docs[0].gigId)).toBe(OTHER);
  });
});
