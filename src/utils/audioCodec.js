/**
 * Lightweight PCM / µ-law helpers for Telnyx <-> OpenAI Realtime bridging.
 * OpenAI Realtime expects PCM16 @ 24kHz; Telnyx bidirectional streams often use PCMU @ 8kHz.
 */

function mulawDecodeSample(muLawByte) {
  const BIAS = 0x84;
  let u = (~muLawByte) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  let mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + BIAS) << exponent;
  sample -= BIAS;
  return sign ? -sample : sample;
}

function mulawEncodeSample(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {
    /* find exponent */
  }
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  const muLawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
  return muLawByte;
}

/** Upsample PCM16 8kHz -> 24kHz by simple linear hold (x3). */
function upsample8kTo24k(int16Array) {
  const out = new Int16Array(int16Array.length * 3);
  for (let i = 0; i < int16Array.length; i++) {
    const s = int16Array[i];
    const o = i * 3;
    out[o] = s;
    out[o + 1] = s;
    out[o + 2] = s;
  }
  return out;
}

/** Downsample PCM16 24kHz -> 8kHz by picking every 3rd sample. */
function downsample24kTo8k(int16Array) {
  const outLen = Math.floor(int16Array.length / 3);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    out[i] = int16Array[i * 3];
  }
  return out;
}

function mulawBufferToPcm16Base64_24k(mulawBuf) {
  const pcm8 = new Int16Array(mulawBuf.length);
  for (let i = 0; i < mulawBuf.length; i++) {
    pcm8[i] = mulawDecodeSample(mulawBuf[i]);
  }
  const pcm24 = upsample8kTo24k(pcm8);
  return Buffer.from(pcm24.buffer).toString('base64');
}

function pcm16Base64_24kToMulawBuffer(base64) {
  const buf = Buffer.from(base64, 'base64');
  const pcm24 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const pcm8 = downsample24kTo8k(pcm24);
  const mulaw = Buffer.alloc(pcm8.length);
  for (let i = 0; i < pcm8.length; i++) {
    mulaw[i] = mulawEncodeSample(pcm8[i]);
  }
  return mulaw;
}

module.exports = {
  mulawBufferToPcm16Base64_24k,
  pcm16Base64_24kToMulawBuffer,
};
