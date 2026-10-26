const mongoose = require('mongoose');
const { Call } = require('../models/Call');
const { readFraudScore } = require('../utils/selfCallVoice');
const { assertCompanyAccess } = require('../middleware/companyScope');
const {
  buildCompanyFraudMatchQuery,
  isCallFraudDetected,
  fraudReviewState,
  resolveAgentId,
  resolveAgentName,
} = require('../utils/fraudStats');

// @desc    Company reviews a call flagged as fraud by the AI:
//          - decision "overturn" (default): false positive. Clears flags.fraud so the call stops counting toward
//            the rep's fraud total / blacklist-risk warnings (company and rep side alike, both read the same flag);
//          - decision "confirm": the reviewer checked the call and the fraud is real. The call stays counted and
//            leaves the "à examiner" queue.
//          The original AI flag and the decision are kept as an audit trail (fraudReview).
// @route   PATCH /api/calls/:id/fraud-review   body: { decision?, reviewedBy?, reason? }
const overturnCallFraud = async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};
    // The reviewer is the authenticated user, never a value sent by the client.
    const reviewedBy = req.auth && req.auth.userId;
    const decision = String(req.body?.decision || 'overturn').toLowerCase();

    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: 'Valid call id is required' });
    }
    if (!['overturn', 'confirm'].includes(decision)) {
      return res.status(400).json({ success: false, message: 'decision must be "overturn" or "confirm"' });
    }

    const call = await Call.findById(id);
    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' });
    }

    await assertCompanyAccess(req, call.companyId);

    // A reviewer can change their mind: a call already overturned may be confirmed afterwards.
    const wasOverturned = call.fraudReview?.overturned === true;
    if (!wasOverturned && !isCallFraudDetected(call)) {
      return res.status(400).json({ success: false, message: 'This call is not currently flagged as fraud' });
    }

    call.flags = call.flags || {};
    call.flags.fraud = decision === 'confirm';
    call.fraudReview = {
      overturned: decision === 'overturn',
      confirmed: decision === 'confirm',
      reviewedBy: reviewedBy && mongoose.Types.ObjectId.isValid(reviewedBy) ? reviewedBy : null,
      reviewedAt: new Date(),
      reason: reason ? String(reason).slice(0, 500) : null,
    };
    await call.save();

    res.status(200).json({ success: true, data: call });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error('Error in overturnCallFraud:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

const FRAUD_TRANSCRIPT_PREVIEW_TURNS = 8;
const FRAUD_REVIEW_SCAN_LIMIT = 500;

// @desc    Calls flagged as fraud for a company, with the evidence needed to review them
//          (AI reason, score, recording, transcript excerpt) and their review state.
// @route   GET /api/calls/company/:companyId/fraud-calls?status=pending|confirmed|overturned|all&gigId=&limit=
const getCompanyFraudCalls = async (req, res) => {
  try {
    const { companyId } = req.params;
    if (!companyId) {
      return res.status(400).json({ success: false, message: 'companyId is required' });
    }
    await assertCompanyAccess(req, companyId);
    const status = String(req.query.status || 'pending').toLowerCase();
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);

    const match = buildCompanyFraudMatchQuery(companyId);
    const gigId = String(req.query.gigId || '');
    if (gigId && gigId !== 'all' && mongoose.Types.ObjectId.isValid(gigId)) {
      match.gigId = new mongoose.Types.ObjectId(gigId);
    }

    const calls = await Call.find(match)
      .sort({ createdAt: -1 })
      .limit(FRAUD_REVIEW_SCAN_LIMIT)
      .populate('agent')
      .populate({ path: 'lead', select: 'Deal_Name First_Name Last_Name Phone phone' })
      .populate({ path: 'gigId', select: 'title' })
      .lean();

    const rows = [];
    const counts = { pending: 0, confirmed: 0, overturned: 0 };
    for (const call of calls) {
      const state = fraudReviewState(call);
      // Overturned calls no longer read as fraud but stay reviewable (a reviewer can change their mind).
      if (state !== 'overturned' && !isCallFraudDetected(call)) continue;
      counts[state] += 1;
      if (status !== 'all' && status !== state) continue;
      if (rows.length >= limit) continue;

      const rubric = call.ai_call_score?.['Fraud detection'] || {};
      const lead = call.lead || {};
      rows.push({
        id: String(call._id),
        createdAt: call.startTime || call.createdAt,
        duration: call.duration ?? null,
        agentId: resolveAgentId(call),
        agentName: resolveAgentName(call),
        leadName: lead.Deal_Name || `${lead.First_Name || ''} ${lead.Last_Name || ''}`.trim() || null,
        leadPhone: lead.Phone || lead.phone || null,
        gigId: call.gigId?._id ? String(call.gigId._id) : call.gigId ? String(call.gigId) : null,
        gigTitle: call.gigId?.title || null,
        fraudScore: readFraudScore(call.ai_call_score),
        selfCall: call.flags?.selfCall === true,
        reason: {
          fr: rubric.feedback_fr || rubric.feedback || null,
          en: rubric.feedback_en || rubric.feedback || null,
        },
        recordingUrl: call.recording_url_cloudinary || call.recording_url || null,
        transcriptPreview: (Array.isArray(call.transcript) ? call.transcript : [])
          .slice(0, FRAUD_TRANSCRIPT_PREVIEW_TURNS)
          .map((turn) => ({ speaker: turn.speaker, text: String(turn.text || '').slice(0, 400) })),
        review: {
          state,
          reviewedAt: call.fraudReview?.reviewedAt || null,
          reason: call.fraudReview?.reason || null,
        },
      });
    }

    res.status(200).json({
      success: true,
      data: { counts, calls: rows, truncated: calls.length >= FRAUD_REVIEW_SCAN_LIMIT },
    });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ success: false, message: error.message });
    console.error('Error in getCompanyFraudCalls:', error);
    res.status(500).json({ success: false, message: 'Server error', error: error.message });
  }
};

module.exports = { overturnCallFraud, getCompanyFraudCalls };
