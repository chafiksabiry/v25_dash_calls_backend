jest.mock('../models/Call', () => ({ Call: {} }));

const { VertexAI } = require('@google-cloud/vertexai');
const vertex = require('../services/vertexai.service');

const silent = { warn: jest.fn() };
const AUTH = { scopes: ['https://www.googleapis.com/auth/cloud-platform'] };

/** Appelle generateContent avec un faux fetch et un faux jeton : renvoie l'URL et le corps envoyés, sans appeler Google. */
async function captureRequest(env, request = 'bonjour') {
  const options = vertex.vertexClientOptions(AUTH, env);
  const model = new VertexAI(options).getGenerativeModel({ model: vertex.resolveVertexModel(env, silent) });
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
    expect(vertex.vertexClientOptions(AUTH, {})).toMatchObject({ location: 'eu', apiEndpoint: 'aiplatform.eu.rep.googleapis.com', googleAuthOptions: AUTH });
    const { url } = await captureRequest({ GOOGLE_CLOUD_PROJECT: 'ignoré-car-lu-au-chargement' });
    expect(url).toMatch(/^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/eu\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/);
  });

  test('multi-région us et global : points d’accès dédiés', async () => {
    expect((await captureRequest({ GOOGLE_CLOUD_LOCATION: 'us' })).url)
      .toMatch(/^https:\/\/aiplatform\.us\.rep\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/us\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/);
    expect((await captureRequest({ GOOGLE_CLOUD_LOCATION: 'global' })).url)
      .toMatch(/^https:\/\/aiplatform\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/global\/publishers\/google\/models\/gemini-3\.1-flash-lite:generateContent$/);
  });

  test('région classique : pas d’apiEndpoint, point d’accès régional du SDK (comportement inchangé)', async () => {
    expect(vertex.vertexClientOptions(AUTH, { GOOGLE_CLOUD_LOCATION: 'europe-west4' }).apiEndpoint).toBeUndefined();
    const { url } = await captureRequest({ GOOGLE_CLOUD_LOCATION: 'europe-west4', VERTEX_AI_MODEL: 'gemini-2.5-flash' });
    expect(url).toMatch(/^https:\/\/europe-west4-aiplatform\.googleapis\.com\/v1\/projects\/[^/]+\/locations\/europe-west4\/publishers\/google\/models\/gemini-2\.5-flash:generateContent$/);
  });

  test('VERTEX_AI_MODEL servi : utilisé tel quel', () => {
    const logger = { warn: jest.fn() };
    expect(vertex.resolveVertexModel({ VERTEX_AI_MODEL: 'gemini-3.5-flash-lite' }, logger)).toBe('gemini-3.5-flash-lite');
    expect(vertex.resolveVertexModel({ VERTEX_AI_MODEL: '"gemini-3.5-flash-lite"' }, logger)).toBe('gemini-3.5-flash-lite');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test.each(['gemini-2.5-flash-lite', 'gemini-2.5-flash-lite-preview-06-17', 'gemini-1.5-flash', 'gemini-1.5-pro-002', 'gemini-2.0-flash-001', 'Gemini-2.0-Flash-Lite'])(
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

  test('modèle hors liste des retraits connus (gemini-2.5-flash) : non remplacé', () => {
    const logger = { warn: jest.fn() };
    expect(vertex.resolveVertexModel({ VERTEX_AI_MODEL: 'gemini-2.5-flash' }, logger)).toBe('gemini-2.5-flash');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('audio inline : la partie inline_data est transmise intacte au point d’accès UE', async () => {
    const request = { contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'audio/wav', data: 'UklGRg==' } }, { text: 'Transcris.' }] }] };
    const { url, body } = await captureRequest({}, request);
    expect(url).toMatch(/^https:\/\/aiplatform\.eu\.rep\.googleapis\.com\//);
    expect(body.contents).toEqual(request.contents);
  });
});
