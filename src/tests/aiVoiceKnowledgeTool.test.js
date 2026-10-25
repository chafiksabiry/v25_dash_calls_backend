jest.mock('../models/Lead', () => ({ Lead: {} }));
jest.mock('../models/Call', () => ({ Call: {} }));

const { buildRealtimeTools, executeVoiceTool } = require('../services/aiVoiceTools');

const ctx = { gigId: '64b0000000000000000000a1', companyId: '64b000000000000000000001' };
const respond = (status, body) => Promise.resolve({ ok: status < 400, status, json: async () => body });

afterEach(() => {
  delete global.fetch;
});

describe('search_knowledge voice tool', () => {
  test('is declared with a required query', () => {
    const tool = buildRealtimeTools().find((t) => t.name === 'search_knowledge');
    expect(tool.parameters.required).toEqual(['query']);
  });

  test('sends the gig and company of the call and returns the passages as sources', async () => {
    global.fetch = jest.fn(() => respond(200, { data: { passages: [{ title: 'Tarifs', content: 'Prime : 12 € / mois', score: 0.8 }] } }));
    const out = await executeVoiceTool('search_knowledge', { query: 'combien ça coûte ?' }, ctx);
    const [url, init] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/rag\/agent-search$/);
    expect(JSON.parse(init.body)).toMatchObject({ companyId: ctx.companyId, gigId: ctx.gigId, query: 'combien ça coûte ?', topK: 3 });
    expect(out).toMatchObject({ ok: true, found: true, passages: [{ source: 'Tarifs', text: 'Prime : 12 € / mois' }] });
  });

  test('tells the agent not to answer from memory when nothing is found', async () => {
    global.fetch = jest.fn(() => respond(200, { data: { found: false, passages: [] } }));
    const out = await executeVoiceTool('search_knowledge', { query: 'x' }, ctx);
    expect(out.found).toBe(false);
    expect(out.note).toMatch(/Do not answer from memory/);
  });

  test('degrades to an error result (never throws) when the knowledge base fails or is slow', async () => {
    global.fetch = jest.fn(() => respond(500, {}));
    expect(await executeVoiceTool('search_knowledge', { query: 'x' }, ctx)).toMatchObject({ ok: false });
    global.fetch = jest.fn(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    expect(await executeVoiceTool('search_knowledge', { query: 'x' }, ctx)).toEqual({ ok: false, error: 'knowledge base timeout' });
  });

  test('needs a query and a company', async () => {
    global.fetch = jest.fn();
    expect((await executeVoiceTool('search_knowledge', { query: ' ' }, ctx)).ok).toBe(false);
    expect((await executeVoiceTool('search_knowledge', { query: 'x' }, { gigId: ctx.gigId })).ok).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
