/**
 * Mesure du coût réel d'un appel IA : cumul des jetons renvoyés par le moteur (OpenAI `response.done.usage`, Gemini `usageMetadata`)
 * puis coût estimé avec une grille de prix (dollars par million de jetons) réglable par variables d'environnement.
 * Les jetons bruts sont journalisés et envoyés sur la fiche : le coût peut être recalculé si les prix changent.
 *
 * Prix relevés le 18/11/2026 (étude, section 2) pour l'audio ; gpt-realtime-2.1 texte relevé (4 $ / 24 $) ; les autres prix « texte » sont des
 * HYPOTHÈSES à confirmer (variables *_TEXT_*).
 * Gemini : la « part de contexte » = jetons d'entrée relus à chaque tour au-delà de l'audio nouveau de l'appelant (25 jetons/s).
 */
const PRICES_VERSION = '2026-11-18';
const num = (v, d) => (Number.isFinite(Number(v)) && v !== '' && v !== undefined && v !== null ? Number(v) : d);

function priceTable(env = process.env) {
  return {
    gemini: {
      audioIn: num(env.AI_PRICE_GEMINI_AUDIO_IN_USD, 3), audioOut: num(env.AI_PRICE_GEMINI_AUDIO_OUT_USD, 12),
      textIn: num(env.AI_PRICE_GEMINI_TEXT_IN_USD, 0.75), textOut: num(env.AI_PRICE_GEMINI_TEXT_OUT_USD, 4.5), cached: num(env.AI_PRICE_GEMINI_CACHED_USD, 0.75),
    },
    'openai-mini': {
      audioIn: num(env.AI_PRICE_OPENAI_MINI_AUDIO_IN_USD, 10), audioOut: num(env.AI_PRICE_OPENAI_MINI_AUDIO_OUT_USD, 20),
      textIn: num(env.AI_PRICE_OPENAI_MINI_TEXT_IN_USD, 0.6), textOut: num(env.AI_PRICE_OPENAI_MINI_TEXT_OUT_USD, 2.4), cached: num(env.AI_PRICE_OPENAI_MINI_CACHED_USD, 0.3),
    },
    openai: {
      audioIn: num(env.AI_PRICE_OPENAI_AUDIO_IN_USD, 32), audioOut: num(env.AI_PRICE_OPENAI_AUDIO_OUT_USD, 64),
      textIn: num(env.AI_PRICE_OPENAI_TEXT_IN_USD, 4), textOut: num(env.AI_PRICE_OPENAI_TEXT_OUT_USD, 24), cached: num(env.AI_PRICE_OPENAI_CACHED_USD, 0.4),
    },
  };
}

const emptyUsage = (provider = '', model = '') => ({
  provider, model, turns: 0, inputTokens: 0, outputTokens: 0, inputAudioTokens: 0, inputTextTokens: 0,
  outputAudioTokens: 0, outputTextTokens: 0, cachedTokens: 0, cachedAudioTokens: 0, toolPromptTokens: 0, thoughtsTokens: 0,
});

/** OpenAI Realtime `response.done` → cumul. */
function addOpenAiUsage(acc, usage) {
  if (!usage || typeof usage !== 'object') return acc;
  const inD = usage.input_token_details || {};
  const outD = usage.output_token_details || {};
  acc.turns += 1;
  acc.inputTokens += num(usage.input_tokens, 0);
  acc.outputTokens += num(usage.output_tokens, 0);
  acc.inputAudioTokens += num(inD.audio_tokens, 0);
  acc.inputTextTokens += num(inD.text_tokens, 0);
  acc.cachedTokens += num(inD.cached_tokens, 0);
  acc.cachedAudioTokens += num(inD.cached_tokens_details && inD.cached_tokens_details.audio_tokens, 0);
  acc.outputAudioTokens += num(outD.audio_tokens, 0);
  acc.outputTextTokens += num(outD.text_tokens, 0);
  return acc;
}

const byModality = (details, modality) => (Array.isArray(details) ? details : [])
  .filter((d) => String(d.modality || '').toUpperCase() === modality)
  .reduce((s, d) => s + num(d.tokenCount ?? d.token_count, 0), 0);

/** Gemini Live `usageMetadata` (camelCase Google AI, snake_case Vertex) → cumul. Chaque message porte l'usage de SON tour. */
function addGeminiUsage(acc, meta) {
  if (!meta || typeof meta !== 'object') return acc;
  const g = (a, b) => num(meta[a] ?? meta[b], 0);
  const promptDetails = meta.promptTokensDetails || meta.prompt_tokens_details;
  const respDetails = meta.responseTokensDetails || meta.response_tokens_details;
  acc.turns += 1;
  acc.inputTokens += g('promptTokenCount', 'prompt_token_count');
  acc.outputTokens += g('responseTokenCount', 'response_token_count');
  acc.cachedTokens += g('cachedContentTokenCount', 'cached_content_token_count');
  acc.toolPromptTokens += g('toolUsePromptTokenCount', 'tool_use_prompt_token_count');
  acc.thoughtsTokens += g('thoughtsTokenCount', 'thoughts_token_count');
  acc.inputAudioTokens += byModality(promptDetails, 'AUDIO');
  acc.inputTextTokens += byModality(promptDetails, 'TEXT');
  acc.outputAudioTokens += byModality(respDetails, 'AUDIO');
  acc.outputTextTokens += byModality(respDetails, 'TEXT');
  return acc;
}

function priceKey(provider, model) {
  if (provider === 'openai') return /mini/i.test(String(model)) ? 'openai-mini' : 'openai';
  return 'gemini';
}

/**
 * Coût estimé d'un appel. `callerSeconds` : durée d'écoute (Gemini facture le flux audio continu, 25 jetons/s) pour isoler la part de contexte.
 * @returns {{ usd, eur, perMinuteUsd, contextTokens, contextShare, pricesVersion, priceKey }}
 */
function estimateCost(usage, { durationSeconds = 0, callerSeconds = null, env = process.env } = {}) {
  const key = priceKey(usage.provider, usage.model);
  const p = priceTable(env)[key];
  const M = 1e6;
  // Sans détail par modalité (certains messages), on impute l'entrée non détaillée à l'audio (prudent : prix le plus haut côté entrée).
  const inAudio = usage.inputAudioTokens || Math.max(0, usage.inputTokens - usage.inputTextTokens);
  const outAudio = usage.outputAudioTokens || Math.max(0, usage.outputTokens - usage.outputTextTokens);
  // Les jetons en cache sont inclus dans les jetons d'entrée : ils sont retirés de leur modalité et facturés au tarif « cache ».
  const cachedAudio = Math.min(inAudio, usage.cachedAudioTokens || 0);
  const cachedText = Math.min(usage.inputTextTokens, Math.max(0, usage.cachedTokens - cachedAudio));
  const cachedRest = Math.max(0, usage.cachedTokens - cachedAudio - cachedText);
  const usd = ((inAudio - cachedAudio - Math.min(cachedRest, inAudio - cachedAudio)) * p.audioIn + (usage.inputTextTokens - cachedText) * p.textIn
    + usage.cachedTokens * p.cached + outAudio * p.audioOut + usage.outputTextTokens * p.textOut) / M;
  const listenSeconds = callerSeconds === null ? durationSeconds : callerSeconds;
  const freshAudio = key === 'gemini' ? Math.round(listenSeconds * 25) : Math.round(listenSeconds * 10);
  const contextTokens = Math.max(0, usage.inputTokens - Math.min(usage.inputTokens, freshAudio));
  const eurRate = num(env.AI_USD_EUR_RATE, 0.9);
  return {
    usd: Math.round(usd * 1e6) / 1e6,
    eur: Math.round(usd * eurRate * 1e6) / 1e6,
    perMinuteUsd: durationSeconds > 0 ? Math.round((usd / (durationSeconds / 60)) * 1e6) / 1e6 : null,
    contextTokens,
    contextShare: usage.inputTokens > 0 ? Math.round((contextTokens / usage.inputTokens) * 1000) / 1000 : null,
    pricesVersion: PRICES_VERSION,
    priceKey: key,
  };
}

module.exports = { emptyUsage, addOpenAiUsage, addGeminiUsage, estimateCost, priceTable, PRICES_VERSION };
