process.env.JWT_SECRET = 'test-secret';
const mockTelnyx = { startCallRecording: jest.fn(async () => ({ recording: 'ok' })), speak: jest.fn(async () => ({ ok: true })) };
const mockLang = jest.fn(async () => 'en');
const mockLine = jest.fn(async () => ({ lead: { gigId: '64b0000000000000000000e1' }, line: null }));
jest.mock('../models/Call', () => ({ Call: {} }));
jest.mock('../models/Gig', () => ({}));
jest.mock('../services/vertexai.service', () => ({}));
jest.mock('../services/integrations/twilio', () => ({}));
jest.mock('../services/integrations/telnyxService', () => mockTelnyx);
jest.mock('../services/integrations/qaqlulService', () => ({}));
jest.mock('../services/integrations/ovh', () => ({}));
jest.mock('../services/CallService', () => ({ CallService: function CallService() {} }));
jest.mock('../services/aiOutboundCallService', () => ({ resolveRecordingNoticeLanguageForGig: mockLang }));
jest.mock('../utils/resolveGigPhoneLine', () => ({ resolveActiveLineForLead: mockLine, resolveActiveLineForGig: jest.fn() }));

const ctrl = require('../controllers/calls');
const makeRes = () => {
  const res = { statusCode: 200 };
  res.status = jest.fn((c) => { res.statusCode = c; return res; });
  res.json = jest.fn((b) => { res.body = b; return res; });
  res.type = jest.fn(() => res);
  res.send = jest.fn((b) => { res.body = b; return res; });
  return res;
};

beforeEach(() => {
  mockTelnyx.startCallRecording.mockClear(); mockTelnyx.speak.mockClear(); mockLang.mockClear(); mockLine.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'warn').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

describe('Twilio : route de l\'annonce (whisper)', () => {
  test('renvoie le TwiML <Say> dans la langue demandée', () => {
    const res = makeRes();
    ctrl.twilioRecordingNotice({ query: { lang: 'ar' }, body: {} }, res);
    expect(res.type).toHaveBeenCalledWith('text/xml');
    expect(res.body).toContain('هذه المكالمة مسجلة.');
    const fr = makeRes();
    ctrl.twilioRecordingNotice({ query: {}, body: {} }, fr);
    expect(fr.body).toContain('Cet appel est enregistré.');
  });
});

describe('Telnyx : annonce jouée dès le début de l\'enregistrement d\'un appel de REP', () => {
  test('record_start puis speak, langue du gig du lead', async () => {
    const res = makeRes();
    await ctrl.startTelnyxRecording({ body: { callControlId: 'v3:rep', leadId: '64b0000000000000000000d1' } }, res);
    expect(mockTelnyx.startCallRecording).toHaveBeenCalledWith('v3:rep');
    expect(mockLang).toHaveBeenCalledWith('64b0000000000000000000e1');
    expect(mockTelnyx.speak).toHaveBeenCalledWith('v3:rep', { payload: 'This call is recorded.', language: 'en-US' });
    expect(mockTelnyx.startCallRecording.mock.invocationCallOrder[0]).toBeLessThan(mockTelnyx.speak.mock.invocationCallOrder[0]);
    expect(res.body).toMatchObject({ success: true, notice: { language: 'en', text: 'This call is recorded.' } });
  });

  test('sans gig ni lead : annonce en français', async () => {
    const res = makeRes();
    await ctrl.startTelnyxRecording({ body: { callControlId: 'v3:rep' } }, res);
    expect(mockTelnyx.speak).toHaveBeenCalledWith('v3:rep', { payload: 'Cet appel est enregistré.', language: 'fr-FR' });
  });

  test('enregistrement refusé : pas d\'annonce ; annonce en échec : l\'enregistrement reste OK', async () => {
    mockTelnyx.startCallRecording.mockRejectedValueOnce(new Error('422'));
    const res = makeRes();
    await ctrl.startTelnyxRecording({ body: { callControlId: 'v3:rep' } }, res);
    expect(res.statusCode).toBe(500);
    expect(mockTelnyx.speak).not.toHaveBeenCalled();

    mockTelnyx.speak.mockRejectedValueOnce(new Error('speak down'));
    const ok = makeRes();
    await ctrl.startTelnyxRecording({ body: { callControlId: 'v3:rep', gigId: 'g1' } }, ok);
    expect(ok.body).toMatchObject({ success: true, notice: null });
  });
});
