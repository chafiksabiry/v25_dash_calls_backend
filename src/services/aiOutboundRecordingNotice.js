/**
 * Annonce automatique d'enregistrement des appels SORTANTS de l'agent IA (TAAS).
 *
 * Jouée par l'opérateur (Twilio <Say> / Telnyx speak) dès le décroché, AVANT que l'IA ne parle,
 * dans la langue de l'appel quand elle est connue (fr/en/es/ar), en français sinon.
 * Si l'opérateur ne peut pas la jouer, l'IA la dit elle-même en tout premier (repli).
 */

const NOTICES = {
  fr: { text: 'Cet appel est enregistré.', twilio: { language: 'fr-FR', voice: 'Polly.Lea' }, telnyx: 'fr-FR' },
  en: { text: 'This call is recorded.', twilio: { language: 'en-US', voice: 'Polly.Joanna' }, telnyx: 'en-US' },
  es: { text: 'Esta llamada está siendo grabada.', twilio: { language: 'es-ES', voice: 'Polly.Lucia' }, telnyx: 'es-ES' },
  ar: { text: 'هذه المكالمة مسجلة.', twilio: { language: 'arb', voice: 'Polly.Zeina' }, telnyx: 'arb' },
};

const DEFAULT_LANGUAGE = 'fr';

/** 'fr-FR', 'EN', 'es_ES', 'arb', 'ar-MA' … -> fr | en | es | ar ; inconnu ou absent -> fr. */
function normalizeNoticeLanguage(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return DEFAULT_LANGUAGE;
  if (raw === 'arb' || raw.startsWith('arabic')) return 'ar';
  const code = raw.split(/[-_]/)[0];
  if (NOTICES[code]) return code;
  const byName = { french: 'fr', francais: 'fr', 'français': 'fr', english: 'en', anglais: 'en', spanish: 'es', espagnol: 'es', 'español': 'es', arabe: 'ar' };
  return byName[raw] || DEFAULT_LANGUAGE;
}

/** Langue de l'appel : script actif du gig, puis réglage de l'assistant vocal, puis langue du gig. */
function resolveCallLanguage(ctx) {
  const candidates = [
    ctx?.callScript?.language,
    ctx?.voiceAssistant?.language,
    ctx?.gig?.language,
  ];
  const found = candidates.find((c) => typeof c === 'string' && c.trim());
  return normalizeNoticeLanguage(found);
}

function getRecordingNotice(language) {
  const lang = normalizeNoticeLanguage(language);
  return { language: lang, ...NOTICES[lang] };
}

/** Consigne de repli pour l'IA : dire l'annonce mot pour mot avant toute autre parole. */
function engineNoticeInstruction(language) {
  const { text } = getRecordingNotice(language);
  return `FIRST, before anything else, say EXACTLY these words, word for word: "${text}" Then continue.`;
}

/** TwiML <Say> de l'annonce (utilisé comme « whisper » <Number url> des appels des REPS). */
function buildNoticeTwiml(language) {
  // eslint-disable-next-line global-require
  const twilio = require('twilio');
  const vr = new twilio.twiml.VoiceResponse();
  const notice = getRecordingNotice(language);
  vr.say(notice.twilio, notice.text);
  return vr.toString();
}

/**
 * Langue d'un appel de gig (même choix que l'agent IA : script actif, assistant vocal, gig ; fr par défaut).
 * `loaders` = { loadScript, loadVoiceAssistant, loadGig } ; le script est borné dans le temps
 * pour ne pas retarder la mise en relation. Toute erreur => français.
 */
async function resolveGigCallLanguage(gigId, loaders = {}, { timeoutMs = 1500 } = {}) {
  if (!gigId) return DEFAULT_LANGUAGE;
  const safe = (fn) => (typeof fn === 'function' ? Promise.resolve().then(() => fn(gigId)).catch(() => null) : Promise.resolve(null));
  const withTimeout = (p) => Promise.race([p, new Promise((r) => { const t = setTimeout(() => r(null), timeoutMs); if (t.unref) t.unref(); })]);
  const [callScript, voiceAssistant, gig] = await Promise.all([
    withTimeout(safe(loaders.loadScript)),
    withTimeout(safe(loaders.loadVoiceAssistant)),
    withTimeout(safe(loaders.loadGig)),
  ]);
  return resolveCallLanguage({ callScript, voiceAssistant, gig });
}

module.exports = {
  NOTICES,
  buildNoticeTwiml,
  resolveGigCallLanguage,
  DEFAULT_LANGUAGE,
  normalizeNoticeLanguage,
  resolveCallLanguage,
  getRecordingNotice,
  engineNoticeInstruction,
};
