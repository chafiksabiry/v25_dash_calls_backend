const { buildCenterCall } = require('../utils/centerCall');

const OID = '64b000000000000000000001';
const base = { sid: 'CA1', companyId: OID, handledBy: { userId: OID, name: 'Marie Durand', role: 'member' }, direction: 'inbound', from: '+33612345678', to: '+33219122061', duration: 42 };

describe('buildCenterCall', () => {
  it('garde qui a pris l’appel et la direction', () => {
    const d = buildCenterCall(base);
    expect(d.handledBy.name).toBe('Marie Durand');
    expect(d.handledBy.role).toBe('member');
    expect(d.direction).toBe('inbound');
    expect(d.isTest).toBe(false);
    expect(d.source).toBe('center_portal');
    expect(d.callOutcome).toBeUndefined();
  });
  it('marque un appel de test', () => {
    expect(buildCenterCall({ ...base, isTest: true, direction: 'outbound' }).isTest).toBe(true);
  });
  it('un appel non décroché ou sans durée est sans réponse', () => {
    expect(buildCenterCall({ ...base, status: 'no-answer', duration: 0 }).callOutcome).toBe('no_answer');
    expect(buildCenterCall({ ...base, duration: 0 }).callOutcome).toBe('no_answer');
  });
  it('un appel entrant non décroché n’a pas de conseiller et n’est pas facturé', () => {
    const d = buildCenterCall({ sid: 'CA9', companyId: OID, unanswered: true, outcome: 'voicemail', from: '+33612345678', to: '+33219122061', duration: 19 });
    expect(d.handledBy).toBeUndefined();
    expect(d.direction).toBe('inbound');
    expect(d.status).toBe('no-answer');
    expect(d.duration).toBe(0);
    expect(d.callOutcome).toBe('voicemail');
    expect(buildCenterCall({ sid: 'CA8', companyId: OID, unanswered: true }).callOutcome).toBe('no_answer');
  });
  it('refuse un corps inexploitable', () => {
    expect(() => buildCenterCall({ ...base, sid: '' })).toThrow('sid');
    expect(() => buildCenterCall({ ...base, companyId: 'x' })).toThrow('companyId');
    expect(() => buildCenterCall({ ...base, handledBy: { userId: OID } })).toThrow('handledBy');
  });
  it('un rôle inconnu devient membre', () => {
    expect(buildCenterCall({ ...base, handledBy: { userId: OID, name: 'A', role: 'admin' } }).handledBy.role).toBe('member');
  });
});
