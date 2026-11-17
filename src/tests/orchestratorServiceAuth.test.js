const jwt = require('jsonwebtoken');
const {
  ESCROW_RECONCILE_SCOPE, CALL_ANALYSIS_NOTIFY_SCOPE, signServiceToken, serviceAuthHeaders, tokensServiceHeaders,
} = require('../services/orchestratorServiceAuth');

describe('orchestratorServiceAuth', () => {
  test('portées attendues par comporchestrator_back', () => {
    expect(ESCROW_RECONCILE_SCOPE).toBe('escrow-reconcile');
    expect(CALL_ANALYSIS_NOTIFY_SCOPE).toBe('call-analysis-notify');
  });

  test('jeton de service HS256 : scope, exp ~120 s, sans userId, vérifiable avec le secret partagé', () => {
    const token = signServiceToken(ESCROW_RECONCILE_SCOPE, 'shared');
    const decoded = jwt.verify(token, 'shared', { algorithms: ['HS256'] });
    expect(decoded.scope).toBe('escrow-reconcile');
    expect(decoded.exp - decoded.iat).toBe(120);
    expect(decoded.userId).toBeUndefined();
    expect(decoded.id).toBeUndefined();
    expect(() => jwt.verify(token, 'autre')).toThrow();
  });

  test('serviceAuthHeaders ajoute Authorization et garde les autres en-têtes', () => {
    const headers = serviceAuthHeaders(CALL_ANALYSIS_NOTIFY_SCOPE, { 'Content-Type': 'application/json' }, { JWT_SECRET: 's' });
    expect(headers['Content-Type']).toBe('application/json');
    const decoded = jwt.verify(headers.Authorization.replace(/^Bearer /, ''), 's', { algorithms: ['HS256'] });
    expect(decoded.scope).toBe('call-analysis-notify');
  });

  test('sans JWT_SECRET : aucun en-tête Authorization (pas de secret par défaut), l\'appel part comme avant', () => {
    expect(signServiceToken(ESCROW_RECONCILE_SCOPE, '')).toBeNull();
    expect(serviceAuthHeaders(ESCROW_RECONCILE_SCOPE, { a: '1' }, {})).toEqual({ a: '1' });
  });

  test('tokensServiceHeaders : x-service-key seulement si TOKENS_SERVICE_KEY est définie', () => {
    expect(tokensServiceHeaders({ a: '1' }, { TOKENS_SERVICE_KEY: 'k' })).toEqual({ a: '1', 'x-service-key': 'k' });
    expect(tokensServiceHeaders({ a: '1' }, {})).toEqual({ a: '1' });
    expect(tokensServiceHeaders({ a: '1' }, { TOKENS_SERVICE_KEY: '' })).toEqual({ a: '1' });
  });
});
