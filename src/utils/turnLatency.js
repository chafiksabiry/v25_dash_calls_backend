const { mulawToLinear } = require('./telephonyAudioCodec');

/**
 * Latence perçue de chaque tour de parole, mesurée sur le flux téléphonique (indépendante du moteur) :
 * fin de la parole de l'appelant (dernière trame µ-law « parlée », détection d'énergie) → première trame audio de l'IA renvoyée.
 * Objectif fondateur : < 800 ms, plafond 1,2 s au 95e centile (contrat-pilote.md, 4.3).
 */
const DEFAULT_THRESHOLD = 500; // RMS PCM16 : au-dessus = parole (bruit de ligne typique < 200)
const MIN_VOICED_FRAMES = 3; // ~60 ms de parole pour ouvrir un tour (évite les clics)

function frameRms(base64Pcmu) {
  const buf = Buffer.from(String(base64Pcmu || ''), 'base64');
  if (!buf.length) return 0;
  let sum = 0;
  for (let i = 0; i < buf.length; i += 1) {
    const s = mulawToLinear(buf[i]);
    sum += s * s;
  }
  return Math.sqrt(sum / buf.length);
}

class TurnLatencyMeter {
  constructor({ threshold = DEFAULT_THRESHOLD, minVoicedFrames = MIN_VOICED_FRAMES, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.minVoicedFrames = minVoicedFrames;
    this.now = now;
    this.turns = [];
    this.voicedRun = 0;
    this.callerSpoke = false; // un tour de l'appelant attend une réponse
    this.lastVoicedAt = null;
    this.agentSpeaking = false;
  }

  /** Trame entrante (appelant). */
  onInbound(base64Pcmu, at = this.now()) {
    if (frameRms(base64Pcmu) >= this.threshold) {
      this.voicedRun += 1;
      if (this.voicedRun >= this.minVoicedFrames) {
        this.callerSpoke = true;
        this.lastVoicedAt = at;
        this.agentSpeaking = false; // l'appelant reprend la parole (barge-in)
      }
    } else {
      this.voicedRun = 0;
    }
  }

  /** Trame sortante (IA). La première après un tour de l'appelant clôt la mesure. */
  onOutbound(at = this.now()) {
    if (this.callerSpoke && this.lastVoicedAt !== null && !this.agentSpeaking) {
      const ms = at - this.lastVoicedAt;
      if (ms >= 0 && ms < 60000) this.turns.push(ms);
      this.callerSpoke = false;
    }
    this.agentSpeaking = true;
  }

  /** Fin d'un tour de l'IA (turnComplete / response.done). */
  onAgentTurnEnd() {
    this.agentSpeaking = false;
  }

  stats() {
    const s = [...this.turns].sort((a, b) => a - b);
    if (!s.length) return { turns: [], medianMs: null, p95Ms: null };
    const median = s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
    const p95 = s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)];
    return { turns: [...this.turns], medianMs: median, p95Ms: p95 };
  }
}

module.exports = { TurnLatencyMeter, frameRms, DEFAULT_THRESHOLD };
