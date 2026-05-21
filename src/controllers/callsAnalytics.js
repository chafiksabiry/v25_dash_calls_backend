/**
 * Call analytics controller.
 *
 * Serves the company OperationsDashboard:
 *   • GET /api/calls/company/:companyId/analytics/overview     → KPIs, status buckets, 7-day series
 *   • GET /api/calls/company/:companyId/analytics/outcomes     → donut + breakdown
 *   • GET /api/calls/company/:companyId/analytics/reps         → per-rep matrix
 *   • GET /api/calls/company/:companyId/analytics/recent       → enriched recent calls
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
          case: { $regexMatch: { input: reason, regex: "déjà assur|already insured" } },
          then: "already_insured"
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
                  regex: "refus|pas intéress|not interested|déjà assur|already insured|wrong|faux numéro"
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

// Build the $match for calls of a company, optionally scoped to a gig + a date range.
function buildCompanyMatch(companyId, { gigId, from, to } = {}) {
  const match = {
    companyId: new mongoose.Types.ObjectId(companyId)
  };
  if (gigId && gigId !== "all" && mongoose.Types.ObjectId.isValid(gigId)) {
    match.gigId = new mongoose.Types.ObjectId(gigId);
  }
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

    const [agg] = await Call.aggregate([
      { $match: baseMatch },
      { $addFields: { _outcome: derivedOutcomeExpr() } },
      {
        $facet: {
          totals: [
            { $match: periodMatch },
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
            { $match: periodMatch },
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
      }
    ]);

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
              $cond: [{ $in: ["$_outcome", ["refusal", "not_interested", "already_insured"]] }, 1, 0]
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

    const match = { companyId: new mongoose.Types.ObjectId(companyId) };
    if (gigId && gigId !== "all" && mongoose.Types.ObjectId.isValid(gigId)) {
      match.gigId = new mongoose.Types.ObjectId(gigId);
    }

    const rows = await Call.aggregate([
      { $match: match },
      { $sort: { createdAt: -1 } },
      { $limit: limit },
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
          repName: { $ifNull: ["$user.name", null] },
          leadName: {
            $ifNull: [
              "$leadDoc.name",
              {
                $concat: [
                  { $ifNull: ["$leadDoc.First_Name", ""] },
                  " ",
                  { $ifNull: ["$leadDoc.Last_Name", ""] }
                ]
              }
            ]
          },
          to: 1,
          from: 1
        }
      }
    ]);

    res.json({ success: true, calls: rows });
  } catch (err) {
    console.error("Error in analytics/recent:", err);
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
