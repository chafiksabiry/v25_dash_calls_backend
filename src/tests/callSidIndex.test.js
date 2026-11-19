const { Call } = require('../models/Call');

describe('index unique partiel sur calls.sid', () => {
  it('unique, limité aux sid de type texte (les sid null ou absents n’y entrent pas)', () => {
    const idx = Call.schema.indexes().filter(([keys]) => keys.sid === 1 && Object.keys(keys).length === 1);
    expect(idx).toHaveLength(1);
    const [, opts] = idx[0];
    expect(opts.unique).toBe(true);
    expect(opts.name).toBe('sid_1');
    expect(opts.partialFilterExpression).toEqual({ sid: { $type: 'string' } });
    expect(opts.sparse).toBeUndefined();
  });
  it('plus d’index « sparse » au niveau du champ (doublon de déclaration évité)', () => {
    const o = Call.schema.path('sid').options;
    expect(o.unique).toBeUndefined();
    expect(o.sparse).toBeUndefined();
  });
});
