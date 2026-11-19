const mockPost = jest.fn(async () => ({ data: { data: { result: 'ok' } } }));
jest.mock('axios', () => ({ post: (...a) => mockPost(...a), get: jest.fn() }));
process.env.TELNYX_API_KEY = 'test-key';
const telnyx = require('../services/integrations/telnyxService');

describe('telnyxService.speak', () => {
  beforeEach(() => mockPost.mockClear());
  test('target_legs transmis quand demandé (annonce entendue par la personne appelée)', async () => {
    await telnyx.speak('v3:rep', { payload: 'Cet appel est enregistré.', language: 'fr-FR', targetLegs: 'both' });
    expect(mockPost.mock.calls[0][0]).toBe('https://api.telnyx.com/v2/calls/v3%3Arep/actions/speak');
    expect(mockPost.mock.calls[0][1]).toEqual({ payload: 'Cet appel est enregistré.', voice: 'female', language: 'fr-FR', target_legs: 'both' });
  });
  test('sans targetLegs : défaut Telnyx (champ absent)', async () => {
    await telnyx.speak('v3:x', { payload: 'Hi', language: 'en-US' });
    expect(mockPost.mock.calls[0][1]).not.toHaveProperty('target_legs');
  });
});
