const { NUMBER_FALLBACK_SOURCES, leadNameFallbackStage } = require('../utils/leadNameFallback');

// Évaluateur minimal des opérateurs Mongo utilisés par l'étape (aucune base).
function ev(expr, doc) {
  if (typeof expr === 'string') return expr.startsWith('$') ? doc[expr.slice(1)] : expr;
  if (Array.isArray(expr) || expr === null || typeof expr !== 'object') return expr;
  const [op, a] = Object.entries(expr)[0];
  switch (op) {
    case '$cond': return ev(a[0], doc) ? ev(a[1], doc) : ev(a[2], doc);
    case '$and': return a.every((x) => ev(x, doc));
    case '$eq': return ev(a[0], doc) === ev(a[1], doc);
    case '$in': return ev(a[1], doc).includes(ev(a[0], doc));
    case '$ifNull': { const v = ev(a[0], doc); return v === null || v === undefined ? ev(a[1], doc) : v; }
    case '$toLower': return String(ev(a, doc)).toLowerCase();
    case '$regexMatch': return new RegExp(a.regex).test(ev(a.input, doc));
    default: throw new Error(`opérateur non géré ${op}`);
  }
}
const leadName = (doc) => ev(leadNameFallbackStage().$addFields.leadName, doc);
const out = { leadName: '', direction: 'outbound', from: '+33140000000', to: '+33612345678' };

describe('leadNameFallbackStage', () => {
  it('jambe transférée sans lead : numéro de l’interlocuteur', () => {
    expect(NUMBER_FALLBACK_SOURCES).toEqual(['center_portal', 'transfer']);
    expect(leadName({ ...out, source: 'transfer' })).toBe('+33612345678');
    expect(leadName({ ...out, source: 'transfer', direction: 'inbound' })).toBe('+33140000000');
  });
  it('portail du centre : inchangé', () => {
    expect(leadName({ ...out, source: 'center_portal' })).toBe('+33612345678');
    expect(leadName({ ...out, source: 'center_portal', direction: 'Inbound' })).toBe('+33140000000');
    expect(leadName({ ...out, source: 'center_portal', to: null })).toBe('+33140000000');
  });
  it('autres sources ou lead connu : inchangé', () => {
    expect(leadName({ ...out, source: 'rep' })).toBe('');
    expect(leadName({ ...out, source: null })).toBe('');
    expect(leadName({ ...out, source: 'transfer', leadName: 'Jean Dupont' })).toBe('Jean Dupont');
  });
});
