jest.mock('../models/Call', () => ({ Call: {} }));

const { VertexAI } = require('@google-cloud/vertexai');
const vertex = require('../services/vertexai.service');

const silent = { warn: jest.fn() };
const AUTH = { scopes: ['https://www.googleapis.com/auth/cloud-platform'] };

/** Appelle generateContent avec un faux fetch et un faux jeton : renvoie l'URL et le corps envoyés, sans appeler Google. */
async function captureRequest(env, request = 'bonjour') {
  const modelName = vertex.resolveVertexModel(env, silent);
  const options = vertex.vertexClientOptions(AUTH, env, modelName, silent);
  const model = new VertexAI(options).getGenerativeModel({ model: modelName });
  model.googleAuth = { getAccessToken: async () => 'faux-jeton' };
  const calls = [];
  const realFetch = global.fetch;
  global.fetch = jest.fn(async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '[]' }] } }] }), { status: 200 });
  });
  try {
    await model.generateContent(request);
  } finally {
    global.fetch = realFetch;
  }
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('vertexai.service : modèle et emplacement servis', () => {
  test('par défaut : gemini-3.1-flash-lite en multi-région UE (aiplatform.eu.rep.googleapis.com)', async () => {
    expect(vertex.resolveVertexModel({}, silent)).toBe('gemini-3.1-flash-lite');
    expect(vertex.vertexClientOptions(AUTH, {}, undefined, silent)).toMatchObject({ location: 'eu', apiEndpoint: 'aiplatform.eu.rep.googleapis.com', googleAuthOptions: AUTH });
    const { url } = await captureRequest({ GOOGLE_CLOUD_PROJECT: 'ignoré-car-lu-au-chargement' });
    expect(url).toMatch(/^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/eu\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/);
  });

  test('multi-région us et global : points d’accès dédiés', async () => {
    expect((await captureRequest({ GOOGLE_CLOUD_LOCATION: 'us' })).url)
      .toMatch(/^https:\/\/aiplatform\.us\.rep\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/us\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/);
    expect((await captureRequest({ GOOGLE_CLOUD_LOCATION: 'global' })).url)
      .toMatch(/^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/global\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/);
  });

  test('région classique avec un modèle qui y est servi : pas d’apiEndpoint, point d’accès régional du SDK (comportement inchangé)', async () => {
    const env = { GOOGLE_CLOUD_LOCATION: 'europe-west4', VERTEX_AI_MODEL: 'modele-regional-test' };
    expect(vertex.vertexClientOptions(AUTH, env, 'modele-regional-test', silent).apiEndpoint).toBeUndefined();
    const { url } = await captureRequest(env);
    expect(url).toMatch(/^https:\/\/europe-west4-aiplatform\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/europe-west4\/publishers\/google\/models\/modele-regional-test:generateContent$/);
  });

  test.each([
    [{ GOOGLE_CLOUD_LOCATION: 'us-central1' }, 'GOOGLE_CLOUD_LOCATION'],
    [{ GOOGLE_CLOUD_LOCATION: 'us-central1', VERTEX_AI_MODEL: 'gemini-2.5-flash-lite' }, 'GOOGLE_CLOUD_LOCATION'],
    [{ GOOGLE_CLOUD_LOCATION: 'us', VERTEX_AI_LOCATION: 'europe-west1', VERTEX_AI_MODEL: 'gemini-3.1-flash-lite' }, 'VERTEX_AI_LOCATION'],
  ])('modèle multi-région seulement dans une région classique (%j) : avertissement et repli sur eu', async (env, source) => {
    const logger = { warn: jest.fn() };
    const model = vertex.resolveVertexModel(env, silent);
    expect(vertex.resolveVertexLocation(env, model, logger)).toEqual({ location: 'eu', apiEndpoint: 'aiplatform.eu.rep.googleapis.com' });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(source);
    expect(logger.warn.mock.calls[0][0]).toContain(model);
    const { url } = await captureRequest(env);
    expect(url).toMatch(/^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/eu\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/);
  });

  test.each([
    ['europe-west3', 'gemini-3.5-flash'],
    ['northamerica-northeast1', 'gemini-3.8-flash'],
    ['asia-south1', 'gemini-3.5-flash-lite'],
  ])('autre modèle gemini-3.x dans une région classique (%s, %s) : région conservée, sans avertissement', async (region, modelName) => {
    const logger = { warn: jest.fn() };
    const env = { VERTEX_AI_LOCATION: region, VERTEX_AI_MODEL: modelName };
    expect(vertex.resolveVertexLocation(env, vertex.resolveVertexModel(env, logger), logger)).toEqual({ location: region, apiEndpoint: undefined });
    expect(logger.warn).not.toHaveBeenCalled();
    const { url } = await captureRequest(env);
    expect(url).toBe(`https://${region}-aiplatform.googleapis.com/v1/projects/${url.split('/projects/')[1].split('/')[0]}/locations/${region}/publishers/google/models/${modelName}:generateContent`);
  });

  test('VERTEX_AI_LOCATION est prioritaire sur GOOGLE_CLOUD_LOCATION', async () => {
    const logger = { warn: jest.fn() };
    const env = { GOOGLE_CLOUD_LOCATION: 'us-central1', VERTEX_AI_LOCATION: 'us' };
    expect(vertex.resolveVertexLocation(env, 'gemini-3.1-flash-lite', logger)).toEqual({ location: 'us', apiEndpoint: 'aiplatform.us.rep.googleapis.com' });
    expect(logger.warn).not.toHaveBeenCalled();
    expect((await captureRequest(env)).url).toMatch(/^https:\/\/aiplatform\.us\.rep\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/us\//);
  });

  test('VERTEX_AI_MODEL servi : utilisé tel quel', () => {
    const logger = { warn: jest.fn() };
    expect(vertex.resolveVertexModel({ VERTEX_AI_MODEL: 'gemini-3.5-flash-lite' }, logger)).toBe('gemini-3.5-flash-lite');
    expect(vertex.resolveVertexModel({ VERTEX_AI_MODEL: '"gemini-3.5-flash-lite"' }, logger)).toBe('gemini-3.5-flash-lite');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test.each(['gemini-2.5-flash-lite', 'gemini-2.5-flash-lite-preview-06-17', 'gemini-2.5-flash', 'gemini-2.5-flash-001', 'gemini-2.5-pro', 'gemini-2.5-pro-preview-05-06', 'gemini-1.5-flash', 'gemini-1.5-pro-002', 'gemini-2.0-flash-001', 'gemini-2.0-flash-lite', 'Gemini-2.0-Flash-Lite'])(
    'VERTEX_AI_MODEL retiré (%s) : avertissement et repli sur le modèle par défaut',
    async (retired) => {
      const logger = { warn: jest.fn() };
      expect(vertex.resolveVertexModel({ VERTEX_AI_MODEL: retired }, logger)).toBe('gemini-3.1-flash-lite');
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn.mock.calls[0][0]).toContain(retired);
      const { url } = await captureRequest({ VERTEX_AI_MODEL: retired });
      expect(url).toMatch(/\/models\/gemini-3\.1-flash-lite:generateContent$/);
    },
  );

  test.each(['gemini-2.5-flash-image', 'gemini-2.5-flash-image-preview'])('%s (encore servi) n’est pas remplacé', (name) => {
    const logger = { warn: jest.fn() };
    expect(vertex.resolveVertexModel({ VERTEX_AI_MODEL: name }, logger)).toBe(name);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('gemini-live-2.5-flash-native-audio n’est pas considéré comme retiré', () => {
    const logger = { warn: jest.fn() };
    expect(vertex.resolveVertexModel({ VERTEX_AI_MODEL: 'gemini-live-2.5-flash-native-audio' }, logger)).toBe('gemini-live-2.5-flash-native-audio');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('audio inline : la partie inline_data est transmise intacte au point d’accès UE', async () => {
    const request = { contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/wav', data: 'UklGRg==' } }, { text: 'Transcris.' }] }] };
    const { url, body } = await captureRequest({}, request);
    expect(url).toMatch(/^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\//);
    expect(body.contents).toEqual(request.contents);
  });
});
