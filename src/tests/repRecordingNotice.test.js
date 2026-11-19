jest.mock('../models/Call', () => ({ Call: {} }));
jest.mock('../models/Transaction', () => ({}));
jest.mock('../services/vertexai.service', () => ({}));
jest.mock('../services/orchestratorServiceAuth', () => ({ serviceAuthHeaders: () => ({}), ESCROW_RECONCILE_SCOPE: 'x' }));

const notice = require('../services/aiOutboundRecordingNotice');
const twilioService = require('../services/integrations/twilio');

describe('Annonce des appels des REPS : TwiML « whisper »', () => {
  test('texte et voix par langue, français par défaut', () => {
    expect(notice.buildNoticeTwiml('fr')).toContain('<Say language="fr-FR" voice="Polly.Lea">Cet appel est enregistré.</Say>');
    expect(notice.buildNoticeTwiml('en')).toContain('<Say language="en-US" voice="Polly.Joanna">This call is recorded.</Say>');
    expect(notice.buildNoticeTwiml('es')).toContain('Esta llamada está siendo grabada.');
    expect(notice.buildNoticeTwiml('ar')).toContain('<Say language="arb" voice="Polly.Zeina">هذه المكالمة مسجلة.</Say>');
    expect(notice.buildNoticeTwiml(undefined)).toContain('Cet appel est enregistré.');
  });

  test('<Dial record-from-answer> : la personne appelée entend l\'annonce au décroché, avant la mise en relation', async () => {
    const xml = await twilioService.generateTwimlResponse('+33612345678', '+33140000000', { noticeUrl: 'https://calls.test/api/calls/twilio-recording-notice?lang=es' });
    expect(xml).toMatch(/<Dial callerId="\+33140000000" record="record-from-answer">/);
    expect(xml).toMatch(/<Number [^>]*url="https:\/\/calls\.test\/api\/calls\/twilio-recording-notice\?lang=es"[^>]*method="POST"[^>]*>\+33612345678<\/Number>/);
    expect(xml).toMatch(/machineDetection="DetectMessageEnd"/);
  });

  test('sans noticeUrl : TwiML inchangé', async () => {
    const xml = await twilioService.generateTwimlResponse('+33612345678', '+33140000000');
    expect(xml).not.toMatch(/url=/);
  });
});

describe('Langue d\'un appel de gig (même choix que l\'agent IA)', () => {
  test('script, puis assistant vocal, puis gig ; fr par défaut', async () => {
    expect(await notice.resolveGigCallLanguage('g1', { loadScript: async () => ({ language: 'es' }), loadVoiceAssistant: async () => ({ language: 'en' }) })).toBe('es');
    expect(await notice.resolveGigCallLanguage('g1', { loadScript: async () => null, loadVoiceAssistant: async () => ({ language: 'en-GB' }) })).toBe('en');
    expect(await notice.resolveGigCallLanguage('g1', { loadGig: async () => ({ language: 'ar' }) })).toBe('ar');
    expect(await notice.resolveGigCallLanguage(null, {})).toBe('fr');
  });

  test('erreur ou lenteur d\'une source : ignorée, sans retarder l\'appel', async () => {
    const slow = () => new Promise((r) => setTimeout(() => r({ language: 'es' }), 200));
    const t0 = Date.now();
    const lang = await notice.resolveGigCallLanguage('g1', { loadScript: slow, loadVoiceAssistant: async () => { throw new Error('db'); }, loadGig: async () => ({ language: 'en' }) }, { timeoutMs: 20 });
    expect(lang).toBe('en');
    expect(Date.now() - t0).toBeLessThan(150);
  });
});
