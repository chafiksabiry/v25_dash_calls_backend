/**
 * Portail client (lecture seule) : les appels des opérations d'UN client du centre.
 *
 * Aucune route d'écriture. La portée vient du service d'inscription (`clientScope`), jamais de la requête : le client ne
 * peut ni choisir une société, ni un autre client, ni une opération qui n'est pas la sienne (un `gigId` demandé est
 * croisé avec ses opérations). Les données du centre (agents, rémunérations, fraude, notes internes, transcriptions) ne
 * sont pas renvoyées ; l'enregistrement audio n'est renvoyé que si le centre l'a autorisé pour ce client.
 */
const mongoose = require('mongoose');
const { Call } = require('../models/Call');
const Gig = require('../models/Gig');
const { clientScope, ScopeError } = require('../middleware/companyScope');

const oid = (v) => new mongoose.Types.ObjectId(String(v));
const DAY = 24 * 60 * 60 * 1000;

function days(req) {
  const n = Number.parseInt(String(req.query.days ?? '30'), 10);
  return [7, 30, 90, 365].includes(n) ? n : 30;
}

/** Opérations visibles : celles du client, éventuellement réduites à une seule demandée (si elle est bien la sienne). */
function visibleGigIds(scope, requested) {
  if (!requested || requested === 'all') return scope.gigIds;
  return scope.gigIds.includes(String(requested)) ? [String(requested)] : [];
}

const baseMatch = (gigIds, since) => ({
  gigId: { $in: gigIds.map(oid) },
  isTest: { $ne: true },
  startTime: { $gte: since },
});

const qualityExpr = { $ifNull: ['$ai_call_score.overall.score', '$quality_score'] };

const handle = (fn) => async (req, res) => {
  try {
    const scope = await clientScope(req.auth);
    return res.json({ success: true, data: await fn(req, scope) });
  } catch (error) {
    if (error instanceof ScopeError) return res.status(error.status).json({ success: false, message: error.message });
    console.error('[clientPortal]', error && error.message);
    return res.status(500).json({ success: false, message: 'Lecture impossible.' });
  }
};

const me = handle(async (req, scope) => ({
  clientName: scope.clientName,
  allowRecordings: scope.allowRecordings,
  operationCount: scope.gigIds.length,
  branding: scope.branding,
}));

const overview = handle(async (req, scope) => {
  const nDays = days(req);
  const gigIds = visibleGigIds(scope, req.query.gigId);
  const empty = { days: nDays, totals: { calls: 0, answered: 0, durationSeconds: 0, averageSeconds: 0, averageQuality: null, scoredCalls: 0 }, operations: [] };
  if (!gigIds.length) return empty;
  const since = new Date(Date.now() - nDays * DAY);
  const rows = await Call.aggregate([
    { $match: baseMatch(gigIds, since) },
    {
      $group: {
        _id: '$gigId',
        calls: { $sum: 1 },
        answered: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$duration', 0] }, 0] }, 1, 0] } },
        durationSeconds: { $sum: { $ifNull: ['$duration', 0] } },
        qualitySum: { $sum: { $cond: [{ $gt: [qualityExpr, 0] }, qualityExpr, 0] } },
        scoredCalls: { $sum: { $cond: [{ $gt: [qualityExpr, 0] }, 1, 0] } },
      },
    },
  ]);
  const gigs = await Gig.find({ _id: { $in: gigIds.map(oid) } }).select('title');
  const titleOf = new Map(gigs.map((g) => [String(g._id), g.title]));
  const operations = rows.map((r) => ({
    gigId: String(r._id),
    name: titleOf.get(String(r._id)) || 'Opération',
    calls: r.calls,
    answered: r.answered,
    durationSeconds: r.durationSeconds,
    averageQuality: r.scoredCalls ? Math.round(r.qualitySum / r.scoredCalls) : null,
  }));
  const sum = (k) => rows.reduce((a, r) => a + (r[k] || 0), 0);
  const calls = sum('calls');
  const scored = sum('scoredCalls');
  return {
    days: nDays,
    totals: {
      calls,
      answered: sum('answered'),
      durationSeconds: sum('durationSeconds'),
      averageSeconds: sum('answered') ? Math.round(sum('durationSeconds') / sum('answered')) : 0,
      averageQuality: scored ? Math.round(sum('qualitySum') / scored) : null,
      scoredCalls: scored,
    },
    operations,
  };
});

const calls = handle(async (req, scope) => {
  const nDays = days(req);
  const gigIds = visibleGigIds(scope, req.query.gigId);
  const limit = Math.min(Math.max(Number.parseInt(String(req.query.limit ?? '25'), 10) || 25, 1), 100);
  const page = Math.max(Number.parseInt(String(req.query.page ?? '1'), 10) || 1, 1);
  if (!gigIds.length) return { page, limit, total: 0, calls: [] };
  const match = baseMatch(gigIds, new Date(Date.now() - nDays * DAY));
  const [total, rows] = await Promise.all([
    Call.countDocuments(match),
    Call.find(match)
      .select('direction from to startTime duration status gigId quality_score ai_call_score.overall.score recording_url recording_url_cloudinary')
      .sort({ startTime: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
  ]);
  const gigs = await Gig.find({ _id: { $in: gigIds.map(oid) } }).select('title');
  const titleOf = new Map(gigs.map((g) => [String(g._id), g.title]));
  return {
    page,
    limit,
    total,
    calls: rows.map((c) => {
      const q = c.ai_call_score && c.ai_call_score.overall && c.ai_call_score.overall.score;
      const quality = q > 0 ? Math.round(q) : c.quality_score > 0 ? Math.round(c.quality_score) : null;
      return {
        id: String(c._id),
        direction: String(c.direction || '').toLowerCase().startsWith('in') ? 'inbound' : 'outbound',
        from: c.from || '',
        to: c.to || '',
        startTime: c.startTime,
        durationSeconds: c.duration || 0,
        status: c.status || '',
        operation: titleOf.get(String(c.gigId)) || 'Opération',
        quality,
        recordingUrl: scope.allowRecordings ? c.recording_url_cloudinary || c.recording_url || null : null,
      };
    }),
  };
});

module.exports = { me, overview, calls };
