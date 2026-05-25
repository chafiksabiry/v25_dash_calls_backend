/**
 * Call analytics controller.
 *
 * Serves the company OperationsDashboard:
 *   • GET /api/calls/company/:companyId/analytics/overview     → KPIs, status buckets, 7-day series
 *   • GET /api/calls/company/:companyId/analytics/outcomes     → donut + breakdown
 *   • GET /api/calls/company/:companyId/analytics/reps         → per-rep matrix
 *   • GET /api/calls/company/:companyId/analytics/recent       → enriched recent calls
 *   • GET /api/calls/company/:companyId/analytics/rep-payouts  → rep commission payouts (wallet feed)
 *   • GET /api/calls/company/:companyId/analytics/callbacks    → scheduled callbacks + RDV
 *
 * Lazy fallback: old calls (analyzed before the `callOutcome` field existed)
 * are classified on the fly inside the aggregation via `derivedOutcomeExpr()`,
 * which mirrors the classifier in `controllers/calls.js`. No migration needed.
 */

const mongoose = require("mongoose");
const { Call } = require("../models/Call");

// ─────────────────────────────────────────────────────────────────────────────
// Mongo expression: derive `callOutcome` for calls that don't have one yet.
// MUST mirror `classifyCallOutcome` in calls.js — when one changes, update
// the other.
//
// Decision tree:
//   1. Telephony layer (Twilio status, voicemail).
//   2. If AI scored the call (overall.score > 0)
//      → AI-content-only outcomes (no duration heuristic).
//   3. Else → fall back on the duration heuristic.
// ─────────────────────────────────────────────────────────────────────────────
function derivedOutcomeExpr() {
  const status = { $toLower: { $ifNull: ["$status", ""] } };
  const dur = { $ifNull: ["$duration", 0] };
  const reason = { $toLower: { $ifNull: ["$ai_refusal_reason", ""] } };
  const fraudScore = { $ifNull: ["$ai_call_score.Fraud detection.score", null] };
  const sentimentScore = { $ifNull: ["$ai_call_score.Sentiment analysis.score", 0] };
  const argScore = { $ifNull: ["$argumentation_score", 0] };
  const validByAI = { $ifNull: ["$validByAI", false] };
  const refusalDetected = { $ifNull: ["$ai_call_score.refusal_detected", false] };
  const transactionDetected = { $ifNull: ["$ai_call_score.transaction_detected", false] };
  const overallScore = { $ifNull: ["$ai_call_score.overall.score", 0] };
  // "AI scored" = the LLM actually returned a non-zero overall score. Mirrors
  // `detectAiScoring()` in the controller.
  const hasAiScoring = { $gt: [overallScore, 0] };
  const hasRecording = {
    $gt: [{ $strLenCP: { $ifNull: ["$recording_url_cloudinary", ""] } }, 0]
  };

  // Sub-expression used in both AI and no-AI branches.
  const refusalCategory = {
    $switch: {
      branches: [
        {
          case: { $regexMatch: { input: reason, regex: "déjà équip|already equipped|déjà engag|already contract|déjà fourn|already supplier|déjà assur|already insured" } },
          then: "already_equipped"
        },
        {
          case: {
            $regexMatch: { input: reason, regex: "wrong|faux numéro|invalid phone" }
          },
          then: "wrong_number"
        },
        {
          case: { $regexMatch: { input: reason, regex: "pas intéress|not interested" } },
          then: "not_interested"
        }
      ],
      default: "refusal"
    }
  };

  // Tree applied when the AI HAS scored the call. Outcome is content-driven;
  // we never look at `duration` here.
  const aiBranch = {
    $switch: {
      branches: [
        {
          case: { $and: [{ $ne: [fraudScore, null] }, { $lt: [fraudScore, 50] }] },
          then: "fraud"
        },
        { case: { $eq: [transactionDetected, true] }, then: "transaction" },
        {
          case: {
            $or: [
              { $eq: [refusalDetected, true] },
              {
                $regexMatch: {
                  input: reason,
                  regex: "refus|pas intéress|not interested|déjà équip|already equipped|déjà engag|already contract|déjà fourn|already supplier|déjà assur|already insured|wrong|faux numéro"
                }
              }
            ]
          },
          then: refusalCategory
        },
        {
          case: {
            $and: [{ $gte: [argScore, 70] }, { $eq: [validByAI, true] }]
          },
          then: "argued_interested"
        },
        {
          // Polite but non-converting conversation: positive sentiment + at
          // least average argumentation.
          case: {
            $and: [{ $gte: [sentimentScore, 70] }, { $gte: [argScore, 50] }]
          },
          then: "argued_interested"
        }
      ],
      default: "connected_no_sale"
    }
  };

  // Tree applied when AI didn't score the call.
  const heuristicBranch = {
    $cond: [
      { $and: [{ $gt: [dur, 0] }, { $lt: [dur, 30] }] },
      "too_short",
      "connected_no_sale"
    ]
  };

  return {
    $switch: {
      branches: [
        // Use the persisted outcome whenever we have one.
        {
          case: { $ne: [{ $ifNull: ["$callOutcome", null] }, null] },
          then: "$callOutcome"
        },
        // 1) Telephony layer — always wins.
        { case: { $eq: [status, "busy"] }, then: "busy" },
        {
          case: {
            $in: [status, ["no-answer", "noanswer", "canceled", "cancelled"]]
          },
          then: "no_answer"
        },
        {
          case: { $eq: [status, "failed"] },
          then: {
            $cond: [
              {
                $regexMatch: { input: reason, regex: "invalid|no.?route|wrong|format" }
              },
              "wrong_number",
              "no_answer"
            ]
          }
        },
        {
          case: {
            $and: [
              { $eq: [status, "completed"] },
              { $eq: [dur, 0] },
              { $not: [hasRecording] }
            ]
          },
          then: "voicemail"
        },
        // 2) AI content drives the verdict whenever the LLM ran.
        { case: hasAiScoring, then: aiBranch }
      ],
      // 3) No AI signal → fall back on cheap heuristics.
      default: heuristicBranch
    }
  };
}

// Some legacy call documents store companyId/gigId as strings instead of
// ObjectId — match both shapes so analytics never return 0 incorrectly.
function buildCompanyScopeMatch(companyId, gigId) {
  const match = {
    companyId: {
      $in: [new mongoose.Types.ObjectId(companyId), companyId]
    }
  };
  if (gigId && gigId !== "all" && mongoose.Types.ObjectId.isValid(gigId)) {
    match.gigId = {
      $in: [new mongoose.Types.ObjectId(gigId), gigId]
    };
  }
  return match;
}

// Build the $match for calls of a company, optionally scoped to a gig + a date range.
function buildCompanyMatch(companyId, { gigId, from, to } = {}) {
  const match = buildCompanyScopeMatch(companyId, gigId);
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to) match.createdAt.$lte = new Date(to);
  }
  return match;
}

function parseRange(req) {
  // Default: last 30 days. Front can override with `from` / `to` query params.
  const to = req.query.to ? new Date(req.query.to) : new Date();
  const from = req.query.from
    ? new Date(req.query.from)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from, to, gigId: req.query.gigId };
}

function validateCompanyId(companyId, res) {
  if (!companyId) {
    res.status(400).json({ success: false, message: "Company ID is required" });
    return false;
  }
  if (!mongoose.Types.ObjectId.isValid(companyId)) {
    res.status(400).json({ success: false, error: "Invalid company ID format" });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/calls/company/:companyId/analytics/overview
//
//  Powers the "Vue globale" + "Appels" tabs. Returns:
//    • total / serious / voicemail / unreachable / fraud counts
//    • avgDuration (on serious calls)
//    • statuses[] for the colored bar chart
//    • series7d[] for the line chart
// ─────────────────────────────────────────────────────────────────────────────
exports.overview = async (req, res) => {
  try {
    const { companyId } = req.params;
    if (!validateCompanyId(companyId, res)) return;
    const range = parseRange(req);
    // Company (+ gig) scope is shared; date filter is applied per facet so
    // series7d always covers the last 7 days even when KPIs are "today".
    const baseMatch = buildCompanyMatch(companyId, { gigId: range.gigId });
    const periodMatch = {
      createdAt: { $gte: range.from, $lte: range.to }
    };
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const buildFacetPipeline = (rootMatch, periodFilter) => {
      const stages = [];
      if (rootMatch && Object.keys(rootMatch).length > 0) {
        stages.push({ $match: rootMatch });
      }
      stages.push({ $addFields: { _outcome: derivedOutcomeExpr() } });
      stages.push({
        $facet: {
          totals: [
            { $match: periodFilter },
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                serious: {
                  $sum: { $cond: [{ $eq: [{ $ifNull: ["$flags.serious", "$validByAI"] }, true] }, 1, 0] }
                },
                fraud: {
                  $sum: { $cond: [{ $eq: [{ $ifNull: ["$flags.fraud", false] }, true] }, 1, 0] }
                },
                voicemail: {
                  $sum: { $cond: [{ $eq: ["$_outcome", "voicemail"] }, 1, 0] }
                },
                unreachable: {
                  $sum: {
                    $cond: [
                      {
                        $in: [
                          "$_outcome",
                          ["no_answer", "busy", "voicemail", "wrong_number"]
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                sumDurationSerious: {
                  $sum: {
                    $cond: [
                      { $eq: [{ $ifNull: ["$flags.serious", "$validByAI"] }, true] },
                      { $ifNull: ["$duration", 0] },
                      0
                    ]
                  }
                }
              }
            }
          ],
          statuses: [
            { $match: periodFilter },
            { $group: { _id: "$_outcome", count: { $sum: 1 } } }
          ],
          series7d: [
            { $match: { createdAt: { $gte: sevenDaysAgo } } },
            {
              $group: {
                _id: {
                  $dateToString: { format: "%Y-%m-%d", date: "$createdAt" }
                },
                total: { $sum: 1 },
                serious: {
                  $sum: {
                    $cond: [
                      { $eq: [{ $ifNull: ["$flags.serious", "$validByAI"] }, true] },
                      1,
                      0
                    ]
                  }
                },
                transactions: {
                  $sum: {
                    $cond: [{ $eq: ["$_outcome", "transaction"] }, 1, 0]
                  }
                }
              }
            },
            { $sort: { _id: 1 } }
          ]
        }
      });
      return stages;
    };

    let [agg] = await Call.aggregate(buildFacetPipeline(baseMatch, periodMatch));
    let fallback = false;

    // Fallback when the requested period (e.g. "today") returns 0:
    //   1) same company, last 30 days
    //   2) any company, last 30 days (demo / fresh account)
    const totalsRaw0 = agg?.totals?.[0];
    if (!totalsRaw0 || (totalsRaw0.total ?? 0) === 0) {
      const fbFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const fbPeriod = { createdAt: { $gte: fbFrom, $lte: new Date() } };
      const [companyFb] = await Call.aggregate(
        buildFacetPipeline(baseMatch, fbPeriod)
      );
      if (companyFb?.totals?.[0]?.total > 0) {
        agg = companyFb;
        fallback = "company_30d";
      } else {
        const [globalFb] = await Call.aggregate(
          buildFacetPipeline({}, fbPeriod)
        );
        if (globalFb?.totals?.[0]?.total > 0) {
          agg = globalFb;
          fallback = "global_30d";
        }
      }
    }

    const totals = agg.totals[0] || {
      total: 0,
      serious: 0,
      fraud: 0,
      voicemail: 0,
      unreachable: 0,
      sumDurationSerious: 0
    };
    const avgDuration =
      totals.serious > 0
        ? Math.round(totals.sumDurationSerious / totals.serious)
        : 0;

    res.json({
      success: true,
      range: { from: range.from, to: range.to },
      gigId: range.gigId && range.gigId !== "all" ? range.gigId : null,
      fallback,
      totals: {
        total: totals.total,
        serious: totals.serious,
        fraud: totals.fraud,
        voicemail: totals.voicemail,
        unreachable: totals.unreachable,
        avgDuration
      },
      statuses: agg.statuses.map((s) => ({ outcome: s._id, count: s.count })),
      series7d: agg.series7d.map((s) => ({
        date: s._id,
        total: s.total,
        serious: s.serious,
        transactions: s.transactions ?? 0
      }))
    });
  } catch (err) {
    console.error("Error in analytics/overview:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/calls/company/:companyId/analytics/outcomes
//
//  Powers the "Résultats" donut + issues breakdown. Returns one bucket per
//  callOutcome value (zero buckets are omitted; the front pads with zeros).
// ─────────────────────────────────────────────────────────────────────────────
exports.outcomes = async (req, res) => {
  try {
    const { companyId } = req.params;
    if (!validateCompanyId(companyId, res)) return;
    const range = parseRange(req);
    const match = buildCompanyMatch(companyId, range);

    const rows = await Call.aggregate([
      { $match: match },
      { $addFields: { _outcome: derivedOutcomeExpr() } },
      { $group: { _id: "$_outcome", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const total = rows.reduce((acc, r) => acc + r.count, 0);
    const outcomes = rows.map((r) => ({
      outcome: r._id,
      count: r.count,
      pct: total > 0 ? Math.round((r.count / total) * 10000) / 100 : 0
    }));

    res.json({
      success: true,
      range: { from: range.from, to: range.to },
      gigId: range.gigId && range.gigId !== "all" ? range.gigId : null,
      total,
      outcomes
    });
  } catch (err) {
    console.error("Error in analytics/outcomes:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/calls/company/:companyId/analytics/reps
//
//  Per-rep matrix → for Résultats per-rep table + Équipe leaderboard.
//    { userId, name, total, transaction, appointment, argued, refusal,
//      validByAI, avgScore }
// ─────────────────────────────────────────────────────────────────────────────
exports.reps = async (req, res) => {
  try {
    const { companyId } = req.params;
    if (!validateCompanyId(companyId, res)) return;
    const range = parseRange(req);
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 20));
    const match = buildCompanyMatch(companyId, range);
    // Reps must have a userId
    match.userId = { $ne: null };

    const rows = await Call.aggregate([
      { $match: match },
      { $addFields: { _outcome: derivedOutcomeExpr() } },
      {
        $group: {
          _id: "$userId",
          total: { $sum: 1 },
          transaction: { $sum: { $cond: [{ $eq: ["$_outcome", "transaction"] }, 1, 0] } },
          appointment: { $sum: { $cond: [{ $eq: ["$_outcome", "appointment"] }, 1, 0] } },
          callbacks: { $sum: { $cond: [{ $eq: ["$_outcome", "callback_requested"] }, 1, 0] } },
          argued: { $sum: { $cond: [{ $eq: ["$_outcome", "argued_interested"] }, 1, 0] } },
          refusal: {
            $sum: {
              $cond: [{ $in: ["$_outcome", ["refusal", "not_interested", "already_equipped"]] }, 1, 0]
            }
          },
          serious: {
            $sum: { $cond: [{ $eq: [{ $ifNull: ["$flags.serious", "$validByAI"] }, true] }, 1, 0] }
          },
          sumScore: { $sum: { $ifNull: ["$ai_call_score.overall.score", 0] } },
          scoredCount: {
            $sum: { $cond: [{ $gt: [{ $ifNull: ["$ai_call_score.overall.score", 0] }, 0] }, 1, 0] }
          }
        }
      },
      {
        $lookup: {
          from: "users",
          localField: "_id",
          foreignField: "_id",
          as: "user"
        }
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          name: { $ifNull: ["$user.name", "Rep"] },
          total: 1,
          transaction: 1,
          appointment: 1,
          callbacks: 1,
          argued: 1,
          refusal: 1,
          serious: 1,
          validByAIPct: {
            $cond: [
              { $gt: ["$total", 0] },
              { $round: [{ $multiply: [{ $divide: ["$serious", "$total"] }, 100] }, 2] },
              0
            ]
          },
          avgScore: {
            $cond: [
              { $gt: ["$scoredCount", 0] },
              { $round: [{ $divide: ["$sumScore", "$scoredCount"] }, 1] },
              0
            ]
          }
        }
      },
      { $sort: { total: -1 } },
      { $limit: limit }
    ]);

    res.json({
      success: true,
      range: { from: range.from, to: range.to },
      gigId: range.gigId && range.gigId !== "all" ? range.gigId : null,
      reps: rows.map((r) => ({ ...r, userId: String(r.userId) }))
    });
  } catch (err) {
    console.error("Error in analytics/reps:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/calls/company/:companyId/analytics/recent
//
//  Recent calls with enriched fields for the "Derniers appels" panel.
// ─────────────────────────────────────────────────────────────────────────────
exports.recent = async (req, res) => {
  try {
    const { companyId } = req.params;
    if (!validateCompanyId(companyId, res)) return;
    const limit = Math.max(1, Math.min(50, parseInt(req.query.limit, 10) || 8));
    const gigId = req.query.gigId;

    // Reusable pipeline that enriches each call with rep + lead names and the
    // derived outcome. We run it twice if needed: first scoped to the
    // company/gig, then as a global fallback (last 2 calls anywhere) so the
    // "Recent calls" card never appears empty for a fresh company.
    const buildPipeline = (match, take) => [
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $limit: take },
      { $addFields: { _outcome: derivedOutcomeExpr() } },
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user"
        }
      },
      { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "agents",
          localField: "agent",
          foreignField: "_id",
          as: "agentDoc"
        }
      },
      { $unwind: { path: "$agentDoc", preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: "leads",
          localField: "lead",
          foreignField: "_id",
          as: "leadDoc"
        }
      },
      { $unwind: { path: "$leadDoc", preserveNullAndEmptyArrays: true } },
      {
        $project: {
          _id: 1,
          createdAt: 1,
          startTime: 1,
          duration: 1,
          status: 1,
          outcome: "$_outcome",
          score: { $ifNull: ["$ai_call_score.overall.score", null] },
          validByAI: 1,
          summary: { $ifNull: ["$ai_summary", null] },
          ai_call_status: 1,
          repName: {
            $ifNull: [
              "$user.name",
              "$agentDoc.personalInfo.name",
              null
            ]
          },
          leadName: {
            $trim: {
              input: {
                $ifNull: [
                  {
                    $concat: [
                      { $ifNull: ["$leadDoc.First_Name", ""] },
                      " ",
                      { $ifNull: ["$leadDoc.Last_Name", ""] }
                    ]
                  },
                  { $ifNull: ["$leadDoc.Deal_Name", ""] },
                  ""
                ]
              }
            }
          },
          to: 1,
          from: 1
        }
      }
    ];

    const match = buildCompanyScopeMatch(companyId, gigId);

    let rows = await Call.aggregate(buildPipeline(match, limit));
    let fallback = false;

    // Fallback: nothing on this company/gig → return the last 2 calls
    // globally so the dashboard always shows something concrete.
    if (rows.length === 0) {
      rows = await Call.aggregate(buildPipeline({}, 2));
      fallback = rows.length > 0;
    }

    res.json({ success: true, calls: rows, fallback });
  } catch (err) {
    console.error("Error in analytics/recent:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/calls/company/:companyId/analytics/rep-payouts
//  GET /api/rep-transactions/company/:companyId            (alias)
//
//  Source of truth: the `reptransactions` collection — one document per
//  paid rep commission (call validation OR signed sale). We $lookup the
//  associated call to enrich the row with duration/score/refusal reason.
//
//  Refused calls are surfaced from the calls collection only when no
//  rep-transaction was created (because the AI rejected the call) so
//  the "Refusés" tab still shows them. Validated/sale rows always come
//  from `reptransactions`.
//
//  Query params:
//    limit  — 1..100, default 30
//    gigId  — optional, "all" or omitted = whole company
//    status — "validated" | "refused" | "all" (default: "all")
// ─────────────────────────────────────────────────────────────────────────────
exports.repPayouts = async (req, res) => {
  try {
    const { companyId } = req.params;
    if (!validateCompanyId(companyId, res)) return;
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 30));
    const gigId = req.query.gigId;
    const status = String(req.query.status || "all").toLowerCase();

    const companyOid = new mongoose.Types.ObjectId(companyId);
    const gigOid =
      gigId && gigId !== "all" && mongoose.Types.ObjectId.isValid(gigId)
        ? new mongoose.Types.ObjectId(gigId)
        : null;

    // ─── 1) Validated payouts from `reptransactions` ────────────────────
    //  We hit the raw collection (no model) because the schema lives in
    //  another microservice. Fields used here ALL fall back via $ifNull
    //  so a schema rename in the future won't break this endpoint.
    let validatedRows = [];
    if (status === "validated" || status === "all") {
      const txMatch = { companyId: companyOid };
      if (gigOid) txMatch.gigId = gigOid;
      // Only count rep transactions that haven't been refused downstream
      // (validByCompany === false means the company manually rejected it).
      txMatch.$and = [
        { $or: [{ validByCompany: { $ne: false } }, { validByCompany: { $exists: false } }] },
      ];

      validatedRows = await mongoose.connection.db
        .collection("reptransactions")
        .aggregate([
          { $match: txMatch },
          { $sort: { createdAt: -1 } },
          { $limit: limit },
          // Resolve the underlying call (for duration / score / startTime).
          {
            $lookup: {
              from: "calls",
              let: { callId: { $ifNull: ["$call", "$callId"] } },
              pipeline: [
                { $match: { $expr: { $eq: ["$_id", "$$callId"] } } },
                {
                  $project: {
                    _id: 1,
                    startTime: 1,
                    duration: 1,
                    ai_call_score: 1,
                    ai_refusal_reason: 1,
                    ai_call_status: 1,
                    validByAI: 1,
                    userId: 1,
                    price: 1,
                    repCallCommission: 1,
                    platformCallCommission: 1,
                  },
                },
              ],
              as: "call",
            },
          },
          { $unwind: { path: "$call", preserveNullAndEmptyArrays: true } },
          // Resolve rep user from either rep-tx.userId/agentId or the call's userId.
          {
            $addFields: {
              _repId: {
                $ifNull: ["$userId", { $ifNull: ["$agentId", "$call.userId"] }],
              },
            },
          },
          {
            $lookup: {
              from: "users",
              localField: "_repId",
              foreignField: "_id",
              as: "user",
            },
          },
          { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
          {
            $lookup: {
              from: "gigs",
              localField: "gigId",
              foreignField: "_id",
              as: "gig",
            },
          },
          { $unwind: { path: "$gig", preserveNullAndEmptyArrays: true } },
          {
            $project: {
              _id: 1,
              createdAt: 1,
              startTime: { $ifNull: ["$call.startTime", "$createdAt"] },
              duration:  { $ifNull: ["$call.duration", 0] },
              score:     { $ifNull: ["$call.ai_call_score.overall.score", null] },
              gigId: 1,
              gigName: { $ifNull: ["$gig.title", null] },
              repId: "$_repId",
              repName: { $ifNull: ["$user.name", null] },
              price: { $ifNull: ["$call.price", 0] },
              // Per-row commissions — prefer the rep-tx values, fall back
              // to the call-level commissions for older docs.
              repCallCommission:        { $ifNull: ["$call.repCallCommission", 0] },
              platformCallCommission:   { $ifNull: ["$call.platformCallCommission", 0] },
              repTransactionCommission:      { $ifNull: ["$repTransactionCommission", 0] },
              platformTransactionCommission: { $ifNull: ["$platformTransactionCommission", 0] },
              validByAI:       { $ifNull: ["$validByAI", { $ifNull: ["$call.validByAI", true] }] },
              validByCompany:  { $ifNull: ["$validByCompany", null] },
              validByReps:     { $ifNull: ["$validByReps", null] },
              aiRefusalReason: { $ifNull: ["$call.ai_refusal_reason", null] },
              aiCallStatus:    { $ifNull: ["$call.ai_call_status", null] },
              source: "reptransactions",
              hasTransaction: {
                $gt: [{ $ifNull: ["$repTransactionCommission", 0] }, 0],
              },
            },
          },
          {
            $addFields: {
              totalCommission: { $add: ["$repCallCommission", "$repTransactionCommission"] },
              platformCommission: {
                $add: ["$platformCallCommission", "$platformTransactionCommission"],
              },
            },
          },
        ])
        .toArray();
    }

    // ─── 2) Refused calls from `calls` (no rep-tx ever created) ─────────
    let refusedRows = [];
    if (status === "refused" || status === "all") {
      const refusedMatch = { companyId: companyOid };
      if (gigOid) refusedMatch.gigId = gigOid;
      refusedMatch.validByAI = false;
      refusedMatch.ai_call_status = "scored";

      refusedRows = await Call.aggregate([
        { $match: refusedMatch },
        { $sort: { createdAt: -1 } },
        { $limit: limit },
        {
          $lookup: {
            from: "users",
            localField: "userId",
            foreignField: "_id",
            as: "user",
          },
        },
        { $unwind: { path: "$user", preserveNullAndEmptyArrays: true } },
        {
          $lookup: {
            from: "gigs",
            localField: "gigId",
            foreignField: "_id",
            as: "gig",
          },
        },
        { $unwind: { path: "$gig", preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            createdAt: 1,
            startTime: 1,
            duration: { $ifNull: ["$duration", 0] },
            score:    { $ifNull: ["$ai_call_score.overall.score", null] },
            gigId: 1,
            gigName: { $ifNull: ["$gig.title", null] },
            repId: "$userId",
            repName: { $ifNull: ["$user.name", null] },
            price: { $ifNull: ["$price", 0] },
            repCallCommission:        { $literal: 0 },
            platformCallCommission:   { $literal: 0 },
            repTransactionCommission:      { $literal: 0 },
            platformTransactionCommission: { $literal: 0 },
            validByAI:       { $literal: false },
            validByCompany:  { $literal: null },
            validByReps:     { $literal: null },
            aiRefusalReason: { $ifNull: ["$ai_refusal_reason", null] },
            aiCallStatus:    { $ifNull: ["$ai_call_status", null] },
            source: { $literal: "calls" },
            hasTransaction: { $literal: false },
            totalCommission: { $literal: 0 },
            platformCommission: { $literal: 0 },
          },
        },
      ]);
    }

    // Merge + sort + cap when status === "all".
    const rows =
      status === "validated"
        ? validatedRows
        : status === "refused"
        ? refusedRows
        : [...validatedRows, ...refusedRows]
            .sort((a, b) => {
              const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
              const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
              return tb - ta;
            })
            .slice(0, limit);

    res.json({
      success: true,
      source: "reptransactions",
      payouts: rows.map((r) => ({
        ...r,
        _id: String(r._id),
        gigId: r.gigId ? String(r.gigId) : null,
        repId: r.repId ? String(r.repId) : null,
      })),
    });
  } catch (err) {
    console.error("Error in analytics/rep-payouts:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
//  GET /api/calls/company/:companyId/analytics/callbacks
//
//  Counts for the "Rappels programmés" block in the Leads view.
// ─────────────────────────────────────────────────────────────────────────────
exports.callbacks = async (req, res) => {
  try {
    const { companyId } = req.params;
    if (!validateCompanyId(companyId, res)) return;
    const gigId = req.query.gigId;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const todayEnd = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
    const weekEnd = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000);

    const baseMatch = { companyId: new mongoose.Types.ObjectId(companyId) };
    if (gigId && gigId !== "all" && mongoose.Types.ObjectId.isValid(gigId)) {
      baseMatch.gigId = new mongoose.Types.ObjectId(gigId);
    }

    const [agg] = await Call.aggregate([
      { $match: baseMatch },
      {
        $facet: {
          callbacks: [
            { $match: { callbackAt: { $ne: null } } },
            {
              $group: {
                _id: null,
                today: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ["$callbackAt", todayStart] },
                          { $lt: ["$callbackAt", todayEnd] }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                },
                week: {
                  $sum: {
                    $cond: [
                      {
                        $and: [
                          { $gte: ["$callbackAt", todayStart] },
                          { $lt: ["$callbackAt", weekEnd] }
                        ]
                      },
                      1,
                      0
                    ]
                  }
                }
              }
            }
          ],
          appointments: [
            { $match: { appointmentAt: { $gte: now } } },
            { $group: { _id: null, confirmed: { $sum: 1 } } }
          ]
        }
      }
    ]);

    const cb = agg.callbacks[0] || { today: 0, week: 0 };
    const ap = agg.appointments[0] || { confirmed: 0 };

    res.json({
      success: true,
      today: cb.today,
      week: cb.week,
      appointmentsConfirmed: ap.confirmed
    });
  } catch (err) {
    console.error("Error in analytics/callbacks:", err);
    res.status(500).json({ success: false, error: err.message });
  }
};
