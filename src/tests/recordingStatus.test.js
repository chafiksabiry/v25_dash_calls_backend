process.env.JWT_SECRET = 'test-secret';

const mockIntentFind = jest.fn();
jest.mock('../models/CallRecordingIntent', () => ({ find: (...a) => mockIntentFind(...a) }));

const {
  STATUSES, REASONS, parseIntentBody, parseFailureBody, recordIntent, reportRecordingFailure,
  deriveRecordingStatus, withRecordingStatus,
} = require('../utils/recordingStatus');
const { attachRecording } = require('../utils/callRecording');

const COMPANY = '64b0000000000000000000c1';
const OTHER = '64b0000000000000000000c2';
const SID = `CA${'a'.repeat(32)}`;
const REC = `RE${'c'.repeat(32)}`;
const URL = `https://api.twilio.com/2010-04-01/Accounts/AC1/Recordings/${REC}`;
const attachBody = { sid: SID, companyId: COMPANY, recordingSid: REC, recordingUrl: URL, durationSeconds: 60 };
const intentBody = (over = {}) => ({ sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned', ...over });

/** Collection en mémoire : findOne(...).select().lean(), updateOne avec $set / $setOnInsert / upsert. */
const fakeCollection = (docs = []) => {
  const rows = docs.map((d) => ({ ...d }));
  const find = (q) => rows.find((r) => r.sid === q.sid) || null;
  return {
    rows,
    updates: [],
    findOne: (q) => { const hit = find(q); const p = { select: () => p, lean: async () => (hit ? { ...hit } : null) }; return p; },
    updateOne: async function (filter, update, opts = {}) {
      this.updates.push({ filter, update });
      let hit = find(filter);
      if (!hit) {
        if (!opts.upsert) return { modifiedCount: 0 };
        hit = { sid: filter.sid, ...(update.$setOnInsert || {}) };
        rows.push(hit);
      }
      Object.assign(hit, update.$set || {});
      for (const [k, v] of Object.entries(update.$push || {})) {
        hit[k] = [...(hit[k] || []), ...v.$each].slice(v.$slice);
      }
      return { modifiedCount: 1 };
    },
  };
};
const world = ({ call, intent } = {}) => ({ Call: fakeCollection(call ? [call] : []), Intent: fakeCollection(intent ? [intent] : []) });

describe('contrat : valeurs autorisées', () => {
  it('expose exactement les statuts et motifs du contrat', () => {
    expect([...STATUSES].sort()).toEqual(['not_recorded', 'pending', 'recorded']);
    expect([...REASONS].sort()).toEqual(['disabled_by_company', 'lookup_failed', 'not_applicable', 'plan_excludes', 'recorded_planned', 'technical_failure']);
  });
});

describe('parseIntentBody', () => {
  it('accepte pending/recorded_planned et not_recorded avec un motif de décision', () => {
    expect(parseIntentBody(intentBody())).toEqual({ sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned' });
    for (const reason of ['plan_excludes', 'disabled_by_company', 'not_applicable', 'lookup_failed']) {
      expect(parseIntentBody(intentBody({ recordingStatus: 'not_recorded', recordingReason: reason })).recordingReason).toBe(reason);
    }
  });
  it('refuse les combinaisons incohérentes, recorded et technical_failure (réservés à l’attache et au signalement)', () => {
    expect(() => parseIntentBody(intentBody({ recordingReason: 'plan_excludes' }))).toThrow('recordingReason');
    expect(() => parseIntentBody(intentBody({ recordingStatus: 'not_recorded', recordingReason: 'recorded_planned' }))).toThrow('recordingReason');
    expect(() => parseIntentBody(intentBody({ recordingStatus: 'not_recorded', recordingReason: 'technical_failure' }))).toThrow('recordingReason');
    expect(() => parseIntentBody(intentBody({ recordingStatus: 'recorded' }))).toThrow('recordingStatus');
    expect(() => parseIntentBody(intentBody({ recordingStatus: 'x' }))).toThrow('recordingStatus');
    expect(() => parseIntentBody(intentBody({ sid: 'x' }))).toThrow('sid');
    expect(() => parseIntentBody(intentBody({ companyId: 'x' }))).toThrow('companyId');
  });
});

describe('parseFailureBody', () => {
  it('exige sid et companyId valides', () => {
    expect(parseFailureBody({ sid: SID, companyId: COMPANY })).toEqual({ sid: SID, companyId: COMPANY });
    expect(() => parseFailureBody({ sid: 'x', companyId: COMPANY })).toThrow('sid');
    expect(() => parseFailureBody({ sid: SID, companyId: 'x' })).toThrow('companyId');
  });
});

describe('recordIntent (décision de l’orchestrateur)', () => {
  it('appel pas encore créé : mémorise la décision dans l’intention, ne crée aucun appel', async () => {
    const w = world();
    const out = await recordIntent(w, intentBody());
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ success: true, recordingStatus: 'pending', recordingReason: 'recorded_planned' });
    expect(w.Intent.rows).toHaveLength(1);
    expect(w.Intent.rows[0]).toMatchObject({ sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned' });
    expect(w.Call.updates).toHaveLength(0);
  });
  it('appel déjà créé : reporte aussi la décision sur l’appel', async () => {
    const w = world({ call: { sid: SID, companyId: COMPANY } });
    const out = await recordIntent(w, intentBody({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' }));
    expect(out.status).toBe(200);
    expect(w.Call.rows[0]).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' });
    expect(w.Call.rows[0].recordingReasonAt).toBeInstanceOf(Date);
  });
  it('idempotent : même décision rejouée = rien de modifié', async () => {
    const w = world({ intent: { sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned' } });
    const out = await recordIntent(w, intentBody());
    expect(out.status).toBe(200);
    expect(out.body.unchanged).toBe(true);
    expect(w.Intent.updates).toHaveLength(0);
    expect(w.Call.updates).toHaveLength(0);
  });
  it('envois répétés identiques : aucun effet, aucune entrée d’historique', async () => {
    const w = world();
    await recordIntent(w, intentBody());
    const before = w.Intent.updates.length;
    for (let i = 0; i < 3; i += 1) expect((await recordIntent(w, intentBody())).body.unchanged).toBe(true);
    expect(w.Intent.updates).toHaveLength(before);
    expect(w.Intent.rows[0].history).toBeUndefined();
  });
  it('décision différente : le dernier envoi l’emporte (pas de 409), l’ancienne décision et son horodatage sont conservés', async () => {
    const decidedAt = new Date('2026-11-01T10:00:00Z');
    const w = world({
      call: { sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned', recordingReasonAt: decidedAt },
      intent: { sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned', decidedAt },
    });
    const out = await recordIntent(w, intentBody({ recordingStatus: 'not_recorded', recordingReason: 'disabled_by_company' }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ success: true, recordingStatus: 'not_recorded', recordingReason: 'disabled_by_company', replaced: true });
    expect(w.Intent.rows[0]).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'disabled_by_company' });
    expect(w.Call.rows[0]).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'disabled_by_company' });
    for (const doc of [w.Intent.rows[0].history, w.Call.rows[0].recordingHistory]) {
      expect(doc).toHaveLength(1);
      expect(doc[0]).toMatchObject({ recordingStatus: 'pending', recordingReason: 'recorded_planned', decidedAt });
      expect(doc[0].replacedAt).toBeInstanceOf(Date);
    }
  });
  it('plusieurs changements : l’historique garde les plus récents (5 au plus)', async () => {
    const w = world();
    const flip = ['plan_excludes', 'disabled_by_company', 'not_applicable', 'lookup_failed'];
    await recordIntent(w, intentBody());
    for (let i = 0; i < 8; i += 1) {
      await recordIntent(w, i % 2 ? intentBody() : intentBody({ recordingStatus: 'not_recorded', recordingReason: flip[(i / 2) % flip.length] }));
    }
    expect(w.Intent.rows[0].history).toHaveLength(5);
    expect(w.Intent.updates.some((u) => u.update.$push && u.update.$push.history.$slice === -5)).toBe(true);
  });
  it('ordre inversé : décision avant la création de l’appel, puis changement après sa création', async () => {
    const w = world();
    await recordIntent(w, intentBody());                                   // l’appel n’existe pas encore
    expect(w.Call.updates).toHaveLength(0);
    w.Call.rows.push({ sid: SID, companyId: COMPANY });                    // l’appel est créé ensuite
    const out = await recordIntent(w, intentBody({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' }));
    expect(out.body).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes', replaced: true });
    expect(w.Call.rows[0]).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' });
    expect(w.Call.rows[0].recordingHistory[0]).toMatchObject({ recordingStatus: 'pending', recordingReason: 'recorded_planned' });
  });
  it('un recordingUrl déjà posé n’est jamais effacé ni rétrogradé par un envoi ultérieur', async () => {
    const w = world({ call: { sid: SID, companyId: COMPANY, recording_url: URL, recording_url_cloudinary: 'https://res.cloudinary.com/x.mp3', recordingStatus: 'recorded', recordingReason: 'recorded_planned' } });
    for (const body of [intentBody({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' }), intentBody()]) {
      const out = await recordIntent(w, body);
      expect(out.body).toMatchObject({ recordingStatus: 'recorded', unchanged: true });
    }
    expect(w.Call.updates).toHaveLength(0);
    expect(w.Call.rows[0]).toMatchObject({ recording_url: URL, recording_url_cloudinary: 'https://res.cloudinary.com/x.mp3', recordingStatus: 'recorded' });
    const none = world({ call: { sid: SID, companyId: COMPANY, recording_url: URL } }); // ancien appel sans statut
    await recordIntent(none, intentBody({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' }));
    for (const u of none.Call.updates) expect(Object.keys(u.update.$set)).not.toContain('recording_url');
    expect(none.Call.rows[0].recording_url).toBe(URL);
  });
  it('un pending tardif ne rouvre pas un échec technique ; une décision négative explicite le remplace', async () => {
    const w = world({ intent: { sid: SID, companyId: COMPANY, recordingStatus: 'not_recorded', recordingReason: 'technical_failure' } });
    expect((await recordIntent(w, intentBody())).body).toMatchObject({ recordingReason: 'technical_failure', unchanged: true });
    const out = await recordIntent(w, intentBody({ recordingStatus: 'not_recorded', recordingReason: 'disabled_by_company' }));
    expect(out.body).toMatchObject({ recordingReason: 'disabled_by_company', replaced: true });
    expect(w.Intent.rows[0].history[0]).toMatchObject({ recordingReason: 'technical_failure' });
  });
  it('409 si l’appel appartient à une autre entreprise, 409 si l’intention en mémoire est d’une autre entreprise', async () => {
    const a = world({ call: { sid: SID, companyId: OTHER } });
    expect((await recordIntent(a, intentBody())).status).toBe(409);
    expect(a.Intent.updates).toHaveLength(0);
    const b = world({ intent: { sid: SID, companyId: OTHER, recordingStatus: 'pending', recordingReason: 'recorded_planned' } });
    expect((await recordIntent(b, intentBody())).status).toBe(409);
  });
  it('appel déjà enregistré (URL rattachée) : reste recorded, la décision tardive est sans effet', async () => {
    const w = world({ call: { sid: SID, companyId: COMPANY, recording_url: URL, recordingStatus: 'recorded', recordingReason: 'recorded_planned' } });
    const out = await recordIntent(w, intentBody({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' }));
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ recordingStatus: 'recorded', unchanged: true });
    expect(w.Call.updates).toHaveLength(0);
  });
  it('après un échec technique : la décision tardive est sans effet', async () => {
    const w = world({ intent: { sid: SID, companyId: COMPANY, recordingStatus: 'not_recorded', recordingReason: 'technical_failure' } });
    const out = await recordIntent(w, intentBody());
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'technical_failure', unchanged: true });
  });
  it('corps invalide : 400 sans toucher à la base', async () => {
    const w = world();
    expect((await recordIntent(w, intentBody({ recordingStatus: 'recorded' }))).status).toBe(400);
    expect(w.Intent.updates).toHaveLength(0);
  });
});

describe('reportRecordingFailure (retries d’attache épuisés)', () => {
  it('pending → not_recorded / technical_failure, sur l’appel et sur l’intention', async () => {
    const w = world({ call: { sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned' }, intent: { sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned' } });
    const out = await reportRecordingFailure(w, { sid: SID, companyId: COMPANY });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'technical_failure' });
    expect(w.Call.rows[0]).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'technical_failure' });
    expect(w.Intent.rows[0]).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'technical_failure' });
  });
  it('appel jamais créé : l’échec est mémorisé dans l’intention (pas de 404)', async () => {
    const w = world();
    const out = await reportRecordingFailure(w, { sid: SID, companyId: COMPANY });
    expect(out.status).toBe(200);
    expect(w.Intent.rows[0]).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'technical_failure' });
    expect(w.Call.updates).toHaveLength(0);
  });
  it('historise la décision remplacée par l’échec technique', async () => {
    const w = world({ intent: { sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned', decidedAt: new Date('2026-11-01T10:00:00Z') } });
    await reportRecordingFailure(w, { sid: SID, companyId: COMPANY });
    expect(w.Intent.rows[0].history[0]).toMatchObject({ recordingStatus: 'pending', recordingReason: 'recorded_planned' });
  });
  it('idempotent : un second signalement ne réécrit rien', async () => {
    const w = world({ call: { sid: SID, companyId: COMPANY, recordingStatus: 'not_recorded', recordingReason: 'technical_failure' } });
    const out = await reportRecordingFailure(w, { sid: SID, companyId: COMPANY });
    expect(out.status).toBe(200);
    expect(out.body.unchanged).toBe(true);
    expect(w.Call.updates).toHaveLength(0);
  });
  it('ne dégrade jamais un appel déjà enregistré ni une non-décision (not_recorded motivé)', async () => {
    const rec = world({ call: { sid: SID, companyId: COMPANY, recording_url: URL, recordingStatus: 'recorded', recordingReason: 'recorded_planned' } });
    expect((await reportRecordingFailure(rec, { sid: SID, companyId: COMPANY })).body).toMatchObject({ recordingStatus: 'recorded', unchanged: true });
    expect(rec.Call.updates).toHaveLength(0);
    const no = world({ call: { sid: SID, companyId: COMPANY, recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' } });
    expect((await reportRecordingFailure(no, { sid: SID, companyId: COMPANY })).body).toMatchObject({ recordingReason: 'plan_excludes', unchanged: true });
    expect(no.Call.updates).toHaveLength(0);
  });
  it('409 autre société, 400 corps invalide', async () => {
    const w = world({ call: { sid: SID, companyId: OTHER } });
    expect((await reportRecordingFailure(w, { sid: SID, companyId: COMPANY })).status).toBe(409);
    expect(w.Call.updates).toHaveLength(0);
    expect((await reportRecordingFailure(world(), { sid: 'x', companyId: COMPANY })).status).toBe(400);
  });
});

describe('attachRecording → statut recorded', () => {
  const archive = async () => 'https://res.cloudinary.com/x/a.mp3';
  it('pending → recorded / recorded_planned dès que l’URL est rattachée', async () => {
    const Call = fakeCollection([{ sid: SID, companyId: COMPANY, recordingStatus: 'pending', recordingReason: 'recorded_planned' }]);
    const out = await attachRecording({ Call, archive }, attachBody);
    expect(out.status).toBe(200);
    expect(Call.rows[0]).toMatchObject({ recording_url: URL, recordingStatus: 'recorded', recordingReason: 'recorded_planned' });
    expect(Call.rows[0].recordingReasonAt).toBeInstanceOf(Date);
  });
  it('appel sans décision connue (ou ancien) : recorded, sans prétendre à un enregistrement planifié', async () => {
    const Call = fakeCollection([{ sid: SID, companyId: COMPANY }]);
    await attachRecording({ Call, archive }, attachBody);
    expect(Call.rows[0].recordingStatus).toBe('recorded');
    expect(Call.rows[0].recordingReason).toBeNull();
  });
  it('technical_failure puis URL tardive : recorded l’emporte (rattrapage)', async () => {
    const Call = fakeCollection([{ sid: SID, companyId: COMPANY, recordingStatus: 'not_recorded', recordingReason: 'technical_failure' }]);
    await attachRecording({ Call, archive }, attachBody);
    expect(Call.rows[0]).toMatchObject({ recordingStatus: 'recorded', recordingReason: null });
  });
  it('idempotent : déjà rattaché et déjà recorded, aucune écriture', async () => {
    const Call = fakeCollection([{ sid: SID, companyId: COMPANY, recording_url: URL, recording_url_cloudinary: 'https://res.cloudinary.com/x.mp3', recordingStatus: 'recorded', recordingReason: 'recorded_planned' }]);
    const out = await attachRecording({ Call, archive: jest.fn() }, attachBody);
    expect(out.body.unchanged).toBe(true);
    expect(Call.updates).toHaveLength(0);
  });
  it('déjà rattaché avant ce déploiement (sans statut) : le statut est complété, sans refaire la copie', async () => {
    const Call = fakeCollection([{ sid: SID, companyId: COMPANY, recording_url: URL, recording_url_cloudinary: 'https://res.cloudinary.com/x.mp3' }]);
    const arch = jest.fn();
    const out = await attachRecording({ Call, archive: arch }, attachBody);
    expect(out.body.unchanged).toBe(true);
    expect(arch).not.toHaveBeenCalled();
    expect(Call.rows[0].recordingStatus).toBe('recorded');
  });
  it('404 si l’appel n’est pas inscrit, 409 si autre société : aucune écriture', async () => {
    const none = fakeCollection([]);
    expect((await attachRecording({ Call: none, archive }, attachBody)).status).toBe(404);
    expect(none.updates).toHaveLength(0);
    const other = fakeCollection([{ sid: SID, companyId: OTHER }]);
    expect((await attachRecording({ Call: other, archive }, attachBody)).status).toBe(409);
    expect(other.updates).toHaveLength(0);
  });
});

describe('deriveRecordingStatus (lecture)', () => {
  it('appel ancien sans champs : URL présente → recorded', () => {
    expect(deriveRecordingStatus({ recording_url: URL })).toEqual({ recordingStatus: 'recorded', recordingReason: null, recordingReasonAt: null });
    expect(deriveRecordingStatus({ recording_url_cloudinary: 'https://res.cloudinary.com/x.mp3' }).recordingStatus).toBe('recorded');
  });
  it('appel ancien sans champs ni URL → not_recorded / unknown_legacy', () => {
    expect(deriveRecordingStatus({})).toEqual({ recordingStatus: 'not_recorded', recordingReason: 'unknown_legacy', recordingReasonAt: null });
  });
  it('champs stockés renvoyés tels quels', () => {
    const at = new Date('2026-11-01T10:00:00Z');
    expect(deriveRecordingStatus({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes', recordingReasonAt: at })).toEqual({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes', recordingReasonAt: at });
    expect(deriveRecordingStatus({ recordingStatus: 'pending', recordingReason: 'recorded_planned' }).recordingStatus).toBe('pending');
  });
  it('l’URL l’emporte sur un statut stocké périmé (pending ou not_recorded)', () => {
    expect(deriveRecordingStatus({ recordingStatus: 'pending', recordingReason: 'recorded_planned', recording_url: URL })).toMatchObject({ recordingStatus: 'recorded', recordingReason: 'recorded_planned' });
    expect(deriveRecordingStatus({ recordingStatus: 'not_recorded', recordingReason: 'technical_failure', recording_url: URL })).toMatchObject({ recordingStatus: 'recorded', recordingReason: null });
  });
  it('sans statut sur l’appel, l’intention mémorisée sert de repli', () => {
    const intent = { recordingStatus: 'not_recorded', recordingReason: 'disabled_by_company', decidedAt: new Date('2026-11-02T00:00:00Z') };
    expect(deriveRecordingStatus({}, intent)).toEqual({ recordingStatus: 'not_recorded', recordingReason: 'disabled_by_company', recordingReasonAt: intent.decidedAt });
  });
});

describe('withRecordingStatus (listes)', () => {
  beforeEach(() => mockIntentFind.mockReset());
  const intents = (rows) => mockIntentFind.mockImplementation(() => ({ select: () => ({ lean: async () => rows }) }));
  it('ajoute les trois champs à chaque appel, sans interroger les intentions quand tout est déjà connu', async () => {
    const rows = [{ sid: 'CA1', recording_url: URL }, { sid: 'CA2', recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' }];
    const out = await withRecordingStatus(rows);
    expect(mockIntentFind).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({ recordingStatus: 'recorded' });
    expect(out[1]).toMatchObject({ recordingStatus: 'not_recorded', recordingReason: 'plan_excludes' });
    expect(rows[0].recordingStatus).toBeUndefined(); // entrée non mutée
  });
  it('une seule requête groupée pour les appels sans statut ni URL ; repli sur l’intention puis sur unknown_legacy', async () => {
    intents([{ sid: 'CA1', recordingStatus: 'pending', recordingReason: 'recorded_planned' }]);
    const out = await withRecordingStatus([{ sid: 'CA1' }, { sid: 'CA2' }, { sid: 'CA3', recording_url: URL }]);
    expect(mockIntentFind).toHaveBeenCalledTimes(1);
    expect(mockIntentFind.mock.calls[0][0]).toEqual({ sid: { $in: ['CA1', 'CA2'] } });
    expect(out.map((r) => [r.recordingStatus, r.recordingReason])).toEqual([['pending', 'recorded_planned'], ['not_recorded', 'unknown_legacy'], ['recorded', null]]);
  });
  it('accepte des documents Mongoose (toJSON) et reste lisible si la lecture des intentions échoue', async () => {
    mockIntentFind.mockImplementation(() => { throw new Error('db'); });
    const doc = { toJSON: () => ({ sid: 'CA9', direction: 'outbound' }) };
    const out = await withRecordingStatus([doc]);
    expect(out[0]).toMatchObject({ sid: 'CA9', direction: 'outbound', recordingStatus: 'not_recorded', recordingReason: 'unknown_legacy' });
  });
});
