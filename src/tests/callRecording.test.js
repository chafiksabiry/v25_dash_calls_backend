process.env.JWT_SECRET = 'test-secret';

const jwt = require('jsonwebtoken');
const { parseRecordingBody, attachRecording } = require('../utils/callRecording');
const access = require('../middleware/callsAccess');

const COMPANY = '64b0000000000000000000c1';
const OTHER = '64b0000000000000000000c2';
const SID = `CA${'a'.repeat(32)}`;
const REC = `RE${'c'.repeat(32)}`;
const URL = `https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/${REC}`;
const body = { sid: SID, companyId: COMPANY, recordingSid: REC, recordingUrl: URL, durationSeconds: 1680 };

const fakeCall = (doc) => {
  const rows = doc ? [{ ...doc }] : [];
  return {
    updates: [],
    findOne: (q) => ({ select: () => ({ lean: async () => rows.find((r) => r.sid === q.sid) || null }) }),
    updateOne: async function (filter, update) { this.updates.push({ filter, update }); return { modifiedCount: 1 }; },
  };
};

describe('parseRecordingBody', () => {
  it('accepte un corps valide et retire l’extension de l’URL', () => {
    expect(parseRecordingBody({ ...body, recordingUrl: `${URL}.mp3` })).toEqual({ sid: SID, companyId: COMPANY, recordingSid: REC, recordingUrl: URL, durationSeconds: 1680 });
  });
  it('refuse un corps inexploitable ou une URL qui n’est pas celle de Twilio', () => {
    expect(() => parseRecordingBody({ ...body, sid: 'x' })).toThrow('sid');
    expect(() => parseRecordingBody({ ...body, companyId: 'x' })).toThrow('companyId');
    expect(() => parseRecordingBody({ ...body, recordingSid: 'x' })).toThrow('recordingSid');
    expect(() => parseRecordingBody({ ...body, recordingUrl: 'https://evil.test/a' })).toThrow('recordingUrl');
    expect(() => parseRecordingBody({ ...body, recordingUrl: 'http://api.twilio.com/a' })).toThrow('recordingUrl');
    expect(() => parseRecordingBody({ ...body, recordingUrl: 'https://api.twilio.com.evil.test/a' })).toThrow('recordingUrl');
  });
});

describe('attachRecording', () => {
  it('rattache l’URL Twilio et la copie Cloudinary à l’appel existant', async () => {
    const Call = fakeCall({ sid: SID, companyId: COMPANY });
    const archive = jest.fn(async () => 'https://res.cloudinary.com/x/video/upload/v1/V25_Call_Records/a.mp3');
    const out = await attachRecording({ Call, archive }, body);
    expect(out.status).toBe(200);
    expect(archive).toHaveBeenCalledWith(`${URL}.mp3`);
    expect(Call.updates).toHaveLength(1);
    expect(Call.updates[0].update.$set).toEqual({ recording_url: URL, recording_url_cloudinary: 'https://res.cloudinary.com/x/video/upload/v1/V25_Call_Records/a.mp3' });
    expect(Call.updates[0].filter.sid).toBe(SID);
  });
  it('garde l’URL Twilio si la copie Cloudinary échoue', async () => {
    const Call = fakeCall({ sid: SID, companyId: COMPANY });
    const out = await attachRecording({ Call, archive: async () => { throw new Error('cloudinary'); } }, body);
    expect(out.status).toBe(200);
    expect(out.body.archived).toBe(false);
    expect(Call.updates[0].update.$set).toEqual({ recording_url: URL });
  });
  it('ne crée jamais d’appel : 404 tant que l’appel n’est pas inscrit', async () => {
    const Call = fakeCall(null);
    const out = await attachRecording({ Call, archive: jest.fn() }, body);
    expect(out.status).toBe(404);
    expect(out.body.pending).toBe(true);
    expect(Call.updates).toHaveLength(0);
  });
  it('refuse l’appel d’une autre entreprise', async () => {
    const Call = fakeCall({ sid: SID, companyId: OTHER });
    const archive = jest.fn();
    const out = await attachRecording({ Call, archive }, body);
    expect(out.status).toBe(409);
    expect(Call.updates).toHaveLength(0);
    expect(archive).not.toHaveBeenCalled();
  });
  it('est idempotent : même enregistrement déjà rattaché, rien à refaire', async () => {
    const Call = fakeCall({ sid: SID, companyId: COMPANY, recording_url: URL, recording_url_cloudinary: 'https://res.cloudinary.com/x.mp3' });
    const archive = jest.fn();
    const out = await attachRecording({ Call, archive }, body);
    expect(out.status).toBe(200);
    expect(out.body.unchanged).toBe(true);
    expect(archive).not.toHaveBeenCalled();
    expect(Call.updates).toHaveLength(0);
  });
  it('un corps invalide est refusé sans toucher à la base', async () => {
    const Call = fakeCall({ sid: SID, companyId: COMPANY });
    const out = await attachRecording({ Call, archive: jest.fn() }, { ...body, recordingUrl: 'https://evil.test/a' });
    expect(out.status).toBe(400);
    expect(Call.updates).toHaveLength(0);
  });
});

describe('callRecordingServiceAuth', () => {
  const run = (authorization) => {
    const res = { code: null, status(c) { this.code = c; return this; }, json() { return this; } };
    let called = false;
    access.callRecordingServiceAuth({ headers: authorization ? { authorization } : {} }, res, () => { called = true; });
    return { called, code: res.code };
  };
  it('accepte un jeton de service au scope call-recording', () => {
    expect(run(`Bearer ${jwt.sign({ scope: 'call-recording' }, 'test-secret', { expiresIn: 60 })}`)).toEqual({ called: true, code: null });
  });
  it('refuse l’absence de jeton, un autre scope, un jeton utilisateur, un jeton sans expiration ou mal signé', () => {
    expect(run(undefined).code).toBe(401);
    expect(run(`Bearer ${jwt.sign({ scope: 'center-data' }, 'test-secret', { expiresIn: 60 })}`).code).toBe(401);
    expect(run(`Bearer ${jwt.sign({ userId: 'u1' }, 'test-secret')}`).code).toBe(401);
    expect(run(`Bearer ${jwt.sign({ scope: 'call-recording' }, 'test-secret')}`).code).toBe(401);
    expect(run(`Bearer ${jwt.sign({ scope: 'call-recording' }, 'autre', { expiresIn: 60 })}`).code).toBe(401);
  });
  it('reste exigé même si CALLS_REQUIRE_AUTH=false', () => {
    process.env.CALLS_REQUIRE_AUTH = 'false';
    try { expect(run(undefined).code).toBe(401); } finally { delete process.env.CALLS_REQUIRE_AUTH; }
  });
});
