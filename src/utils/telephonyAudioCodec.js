/**
 * Telnyx PCMU (G.711 µ-law, 8 kHz) ↔ Gemini Live PCM16 helpers.
 * Gemini Live: input 16-bit LE PCM @ 16 kHz; output 16-bit LE PCM @ 24 kHz.
 */

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;
const MULAW_MAX = 0x1fff;

/** Decode one µ-law byte → signed 16-bit linear PCM. */
function mulawToLinear(mu) {
  const u = ~mu & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

/** Encode one signed 16-bit linear sample → µ-law byte. */
function linearToMulaw(sample) {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (s < 0) s = -s;
  if (s > MULAW_CLIP) s = MULAW_CLIP;
  s += MULAW_BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (s & expMask) === 0 && exponent > 0; exponent -= 1, expMask >>= 1) {
    /* find segment */
  }
  const mantissa = (s >> (exponent === 0 ? 4 : exponent + 3)) & 0x0f;
  const mu = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return mu;
}

/** PCMU buffer → Int16Array (same sample rate). */
function pcmuToPcm16(pcmuBuf) {
  const out = new Int16Array(pcmuBuf.length);
  for (let i = 0; i < pcmuBuf.length; i += 1) {
    out[i] = mulawToLinear(pcmuBuf[i]);
  }
  return out;
}

/** Int16Array → PCMU Buffer (same sample rate). */
function pcm16ToPcmu(pcm16) {
  const out = Buffer.allocUnsafe(pcm16.length);
  for (let i = 0; i < pcm16.length; i += 1) {
    out[i] = linearToMulaw(pcm16[i]);
  }
  return out;
}

/**
 * Linear resample mono Int16 PCM between sample rates.
 * fromRate/toRate must be positive integers.
 */
function resamplePcm16(input, fromRate, toRate) {
  if (!input?.length) return new Int16Array(0);
  if (fromRate === toRate) return input;
  const outLen = Math.max(1, Math.round((input.length * toRate) / fromRate));
  const out = new Int16Array(outLen);
  const ratio = fromRate / toRate;
  for (let i = 0; i < outLen; i += 1) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = src - i0;
    out[i] = (input[i0] * (1 - frac) + input[i1] * frac) | 0;
  }
  return out;
}

/** Telnyx PCMU base64 (8 kHz) → PCM16 base64 for Gemini (16 kHz). */
function telnyxPcmuBase64ToGeminiPcm16Base64(base64Pcmu) {
  const pcmu = Buffer.from(base64Pcmu, 'base64');
  const pcm8 = pcmuToPcm16(pcmu);
  const pcm16 = resamplePcm16(pcm8, 8000, 16000);
  return Buffer.from(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength).toString('base64');
}

/**
 * Gemini PCM16 base64 (24 kHz default) → Telnyx PCMU base64 (8 kHz).
 * Chunks into ~20 ms PCMU frames (160 bytes) for smoother playout.
 */
function geminiPcm16Base64ToTelnyxPcmuFrames(base64Pcm, inputRate = 24000) {
  const raw = Buffer.from(base64Pcm, 'base64');
  if (raw.length < 2) return [];
  const sampleCount = Math.floor(raw.length / 2);
  const pcmIn = new Int16Array(raw.buffer, raw.byteOffset, sampleCount);
  const pcm8 = resamplePcm16(pcmIn, inputRate, 8000);
  const pcmu = pcm16ToPcmu(pcm8);
  const FRAME = 160; // 20 ms @ 8 kHz
  const frames = [];
  for (let offset = 0; offset < pcmu.length; offset += FRAME) {
    const slice = pcmu.subarray(offset, Math.min(offset + FRAME, pcmu.length));
    if (slice.length) frames.push(Buffer.from(slice).toString('base64'));
  }
  return frames;
}

module.exports = {
  mulawToLinear,
  linearToMulaw,
  pcmuToPcm16,
  pcm16ToPcmu,
  resamplePcm16,
  telnyxPcmuBase64ToGeminiPcm16Base64,
  geminiPcm16Base64ToTelnyxPcmuFrames,
  MULAW_MAX,
};
