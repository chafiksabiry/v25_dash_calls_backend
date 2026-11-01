const jwt = require('jsonwebtoken');
const { notifyCallEnded, buildCallEndedPayload } = require('../services/callEndedNotifier');

const OID = '64b000000000000000000001';
const call = { sid: 'CA1', companyId: OID, direction: 'outbound', status: 'completed', duration: 42, from: '+33100000000', to: '+33612345678', startTime: '2026-11-02T10:00:00Z', endTime: '2026-11-02T10:00:42Z', gigId: OID, handledBy: { name: 'Marie' } };
const env = { JWT_SECRET: 'secret', COMPORCHESTRATOR_API_URL: 'https://orch.test/api' };

describe('buildCallEndedPayload', () => {
  it('garde le centre, l’appel et le contact du prospect, sans enregistrement ni transcription', () => {
    const p = buildCallEndedPayload({ ...call, recording_url: 'http://x', transcript: 'secret' }, { name: 'Marie Martin', Email_1: 'm@x.fr', Phone: '0612' });
    expect(p.companyId).toBe(OID);
    expect(p.call).toMatchObject({ sid: 'CA1', duration: 42, handledByName: 'Marie', contact: { firstName: 'Marie', lastName: 'Martin', email: 'm@x.fr' } });
    expect(JSON.stringify(p)).not.toMatch(/recording|transcript|secret/);
  });
  it('ignore un appel sans centre ou sans identifiant', () => {
    expect(buildCallEndedPayload({ ...call, companyId: undefined })).toBeNull();
    expect(buildCallEndedPayload({ ...call, sid: '' })).toBeNull();
  });
});

describe('notifyCallEnded', () => {
  it('envoie un jeton de service signé de portée call-ended, à durée limitée', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: true });
    expect(await notifyCallEnded(call, { fetchImpl, env })).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://orch.test/api/internal/call-ended');
    const decoded = jwt.verify(init.headers.Authorization.split(' ')[1], 'secret');
    expect(decoded.scope).toBe('call-ended');
    expect(typeof decoded.exp).toBe('number');
  });
  it('ne prévient pas pour un appel de test ou sans réponse', async () => {
    const fetchImpl = jest.fn();
    expect(await notifyCallEnded({ ...call, isTest: true }, { fetchImpl, env })).toBe(false);
    expect(await notifyCallEnded({ ...call, status: 'no-answer' }, { fetchImpl, env })).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('ne lève jamais (orchestrateur en panne, secret absent)', async () => {
    expect(await notifyCallEnded(call, { fetchImpl: jest.fn().mockRejectedValue(new Error('boum')), env })).toBe(false);
    expect(await notifyCallEnded(call, { fetchImpl: jest.fn(), env: {} })).toBe(false);
  });
});
