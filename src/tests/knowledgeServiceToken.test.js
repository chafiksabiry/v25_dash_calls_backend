const jwt = require('jsonwebtoken');
const { knowledgeReadHeaders } = require('../utils/knowledgeServiceToken');

describe('jeton de service vers le service de connaissance', () => {
  const saved = process.env.JWT_SECRET;
  afterEach(() => { process.env.JWT_SECRET = saved; });

  test('porte la portée kb-read, signée avec JWT_SECRET, et expire vite', () => {
    process.env.JWT_SECRET = 'test-secret';
    const { Authorization } = knowledgeReadHeaders();
    const decoded = jwt.verify(Authorization.replace(/^Bearer /, ''), 'test-secret');
    expect(decoded.scope).toBe('kb-read');
    expect(decoded.userId).toBeUndefined();
    expect(decoded.exp - decoded.iat).toBeLessThanOrEqual(120);
  });

  test('sans JWT_SECRET, aucun jeton (pas de secret de repli)', () => {
    delete process.env.JWT_SECRET;
    expect(knowledgeReadHeaders()).toEqual({});
  });
});
