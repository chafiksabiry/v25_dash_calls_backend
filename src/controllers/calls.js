const { Call } = require('../models/Call');
const Transaction = require('../models/Transaction');
const { CallService } = require('../services/CallService');
const ovhService = require('../services/integrations/ovh');
const twilioService = require('../services/integrations/twilio');
const twilio = require('twilio');
const fetch = require('node-fetch');
const mongoose = require('mongoose');
const callService = new CallService();
const qalqulService = require('../services/integrations/qaqlulService');
const telnyxService = require('../services/integrations/telnyxService');
const vertexAIService = require('../services/vertexai.service');

const MATCHING_API_URL = (process.env.MATCHING_API_URL || 'https://v25matchingbackend-production.up.railway.app/api').replace(/\/$/, '');
const TRAINING_API_URL = (process.env.TRAINING_API_URL || 'https://v25platformtrainingbackend-production.up.railway.app').replace(/\/$/, '');
const KNOWLEDGEBASE_API_URL = (process.env.KNOWLEDGEBASE_API_URL || 'https://v25knowledgebasebackend-production.up.railway.app/api').replace(/\/$/, '');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// A call stuck in `processing` longer than this is considered dead (the worker
// hung or the process restarted mid-analysis). Such locks may be reclaimed so
// the analysis can be retried instead of spinning forever in the UI.
const STALE_PROCESSING_MS = 5 * 60 * 1000; // 5 minutes

// Hard caps for the external Vertex AI calls so a hung request surfaces as an
// `error` status instead of leaving the call frozen in `processing`.
const TRANSCRIPTION_TIMEOUT_MS = 4 * 60 * 1000; // 4 minutes
const SCORING_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/** Reject a promise if it does not settle within `ms`. */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label || 'Operation'} timed out after ${ms}ms`));
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function parseHHMMToMinutes(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

const SUPPORTED_TIMEZONES = ['Europe/Paris', 'Africa/Casablanca', 'UTC'];

function getTodayInTimezone(date, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      timeZone: timeZone
    });
    const parts = formatter.formatToParts(date);
    const yyyy = parts.find((p) => p.type === 'year').value;
    const mm = parts.find((p) => p.type === 'month').value;
    const dd = parts.find((p) => p.type === 'day').value;
    const iso = `${yyyy}-${mm}-${dd}`;

    const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      timeZone: timeZone
    });
    const dayName = weekdayFormatter.format(date).toLowerCase();

    return { iso, dayName };
  } catch (e) {
    return null;
  }
}

function getMinutesInTimezone(date, timeZone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timeZone
    });
    const parts = formatter.formatToParts(date);
    const hour = Number(parts.find((p) => p.type === 'hour').value);
    const minute = Number(parts.find((p) => p.type === 'minute').value);
    return hour * 60 + minute;
  } catch (e) {
    return null;
  }
}

function isReservationForToday(rawDate, now) {
  const v = String(rawDate || '').trim();
  if (!v) return false;

  for (const tz of SUPPORTED_TIMEZONES) {
    const info = getTodayInTimezone(now, tz);
    if (!info) continue;
    if (ISO_DATE_RE.test(v)) {
      if (v === info.iso) return true;
    } else {
      if (v.toLowerCase() === info.dayName) return true;
    }
  }
  return false;
}

async function validateCopilotCallEligibility({ agentId, gigId }) {
  if (!agentId) return { ok: false, reason: 'Missing agentId' };
  if (!gigId) return { ok: false, reason: 'Lead is not linked to a gig' };

  // 1) Enrollment in gig
  try {
    const enrolledRes = await fetch(
      `${MATCHING_API_URL}/gig-agents/agents/${encodeURIComponent(agentId)}/gigs?status=enrolled`
    );
    if (!enrolledRes.ok) {
      return { ok: false, reason: `Enrollment check failed (${enrolledRes.status})` };
    }
    const enrolledData = await enrolledRes.json();
    const gigs = Array.isArray(enrolledData?.gigs) ? enrolledData.gigs : [];
    const isEnrolled = gigs.some((row) => {
      const id = row?.gig?._id || row?.gig?.$oid || row?.gigId || '';
      return String(id) === String(gigId);
    });
    if (!isEnrolled) {
      return { ok: false, reason: 'Rep is not enrolled in this gig' };
    }
  } catch (error) {
    return { ok: false, reason: `Enrollment check error: ${error.message}` };
  }

  // 2) Trainings completion for this gig
  try {
    const gigTrainingsRes = await fetch(
      `${TRAINING_API_URL}/training_journeys/gig/${encodeURIComponent(gigId)}`
    );
    const gigTrainingsPayload = gigTrainingsRes.ok ? await gigTrainingsRes.json() : null;
    const gigTrainings = Array.isArray(gigTrainingsPayload?.data)
      ? gigTrainingsPayload.data
      : Array.isArray(gigTrainingsPayload)
        ? gigTrainingsPayload
        : [];

    const trainingRes = await fetch(
      `${TRAINING_API_URL}/training_journeys/rep/${encodeURIComponent(agentId)}/slide-progress-summary?gigId=${encodeURIComponent(gigId)}`
    );
    if (!trainingRes.ok) {
      return { ok: false, reason: `Training check failed (${trainingRes.status})` };
    }
    const summaryResponse = await trainingRes.json();
    const summary = summaryResponse?.data && typeof summaryResponse.data === 'object'
      ? summaryResponse.data
      : summaryResponse;
    const trainingCount = Number(summary?.trainingCount || 0);
    const overallPercent = Number(summary?.overallPercent || 0);
    const trainingComplete =
      gigTrainings.length > 0 ? overallPercent >= 100 : (trainingCount === 0 ? true : overallPercent >= 100);
    if (!trainingComplete) {
      return { ok: false, reason: 'Rep must complete all gig trainings before calling' };
    }
  } catch (error) {
    return { ok: false, reason: `Training check error: ${error.message}` };
  }

  // 3) Active reservation window now
  try {
    const resvRes = await fetch(
      `${MATCHING_API_URL}/slots/reservations?repId=${encodeURIComponent(agentId)}&gigId=${encodeURIComponent(gigId)}`
    );
    if (!resvRes.ok) {
      return { ok: false, reason: `Reservation check failed (${resvRes.status})` };
    }
    const rows = await resvRes.json();
    const now = new Date();
    const hasActiveWindow = (Array.isArray(rows) ? rows : []).some((r) => {
      if (String(r?.status || '').toLowerCase() !== 'reserved') return false;
      const d = r?.reservationDate || r?.date;
      if (!isReservationForToday(d, now)) return false;
      const start = parseHHMMToMinutes(r?.startTime);
      const end = parseHHMMToMinutes(r?.endTime);
      if (start == null || end == null || end <= start) return false;
      
      // Check if current time in ANY supported timezone matches the active slot (strictly)
      return SUPPORTED_TIMEZONES.some((tz) => {
        const mins = getMinutesInTimezone(now, tz);
        if (mins === null) return false;
        return mins >= start && mins < end;
      });
    });
    if (!hasActiveWindow) {
      return { ok: false, reason: 'No active reserved slot for this gig at current time' };
    }
  } catch (error) {
    return { ok: false, reason: `Reservation check error: ${error.message}` };
  }

  return { ok: true };
}

// @desc    Get all calls
// @route   GET /api/calls
// @access  Private
exports.getCalls = async (req, res) => {
  try {
    const { 
      userId, 
      agentId, 
      leadId, 
      gigId, 
      companyId, 
      startDate, 
      endDate,
      populate 
    } = req.query;

    let query = {};

    // Basic filters
    if (userId) query.userId = userId;
    if (agentId) query.agent = agentId;
    if (leadId) query.lead = leadId;
    if (gigId) query.gigId = gigId;
    if (companyId) query.companyId = companyId;

    // Date range filter
    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    let mongoQuery = Call.find(query);

    // Dynamic population
    if (populate === 'lead') {
      mongoQuery = mongoQuery.populate({
        path: 'lead',
        populate: {
          path: 'gigId',
          model: 'Gig'
        }
      }).populate('transaction');
    } else {
      mongoQuery = mongoQuery.populate('agent').populate({
        path: 'lead',
        populate: {
          path: 'gigId',
          model: 'Gig'
        }
      }).populate('transaction');
    }

    const calls = await mongoQuery.sort({ createdAt: -1 });

    // If filtering by company, negate the commissions to reflect costs
    let processedCalls = calls;
    if (companyId) {
      processedCalls = calls.map(call => {
        const callObj = call.toObject();
        if (callObj.repCallCommission) callObj.repCallCommission = -callObj.repCallCommission;
        if (callObj.platformCallCommission) callObj.platformCallCommission = -callObj.platformCallCommission;
        if (callObj.transaction) {
          if (callObj.transaction.repTransactionCommission) callObj.transaction.repTransactionCommission = -callObj.transaction.repTransactionCommission;
          if (callObj.transaction.platformTransactionCommission) callObj.transaction.platformTransactionCommission = -callObj.transaction.platformTransactionCommission;
        }
        return callObj;
      });
    }

    res.status(200).json({
      success: true,
      count: calls.length,
      data: processedCalls
    });
  } catch (err) {
    console.error('Error in getCalls:', err);
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Get all calls for a specific agent
// @route   GET /api/calls/agent/:agentId
// @access  Private
exports.getCallsByAgent = async (req, res) => {
  try {
    const agentId = req.params.agentId;

    if (!agentId) {
      return res.status(400).json({
        success: false,
        message: "Agent ID est requis"
      });
    }

    const calls = await Call.find({ agent: agentId })
      .populate('agent')
      .populate({
        path: 'lead',
        populate: {
          path: 'gigId',
          model: 'Gig'
        }
      })
      .populate('transaction')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: calls.length,
      data: calls
    });
  } catch (error) {
    console.error("Erreur lors de la récupération des appels :", error);
    res.status(500).json({
      success: false,
      message: "Erreur serveur",
      error: error.message
    });
  }
};

// @desc    Get single call
// @route   GET /api/calls/:id
// @access  Private
exports.getCall = async (req, res) => {
  try {
    const call = await Call.findById(req.params.id)
      .populate('agent')
      .populate({
        path: 'lead',
        populate: {
          path: 'gigId',
          model: 'Gig'
        }
      })
      .populate('transaction');

    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found'
      });
    }

    res.status(200).json({
      success: true,
      data: call
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Create new call
// @route   POST /api/calls
// @access  Private
exports.createCall = async (req, res) => {
  try {
    let call = await Call.create(req.body);
    
    // Populate after create to get full context
    if (call) {
      call = await Call.findById(call._id).populate('agent').populate('lead').populate('transaction');
    }

    res.status(201).json({
      success: true,
      data: call
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Update call
// @route   PUT /api/calls/:id
// @access  Private
exports.updateCall = async (req, res) => {
  try {
    const callId = req.params.id;

    if (req.body.transaction) {
      const transactionData = req.body.transaction;
      const callObj = await Call.findById(callId);
      if (callObj) {
        const existingTx = await Transaction.findOne({ call: callId });
        const validByReps = transactionData.validByReps !== undefined ? transactionData.validByReps : (existingTx ? existingTx.validByReps : null);
        const validByCompany = transactionData.validByCompany !== undefined ? transactionData.validByCompany : (existingTx ? existingTx.validByCompany : null);

        await Transaction.findOneAndUpdate(
          { call: callId },
          {
            call: callId,
            agent: callObj.agent,
            lead: callObj.lead,
            gigId: callObj.gigId || undefined,
            companyId: callObj.companyId || undefined,
            validByReps,
            validByCompany,
            updatedAt: new Date()
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        req.body.validByReps = validByReps;
        req.body.validByCompany = validByCompany;
        req.body.valid = valid;
      }
      delete req.body.transaction;
    }

    if (req.body['transaction.validByReps'] !== undefined || req.body['transaction.validByCompany'] !== undefined) {
      const callObj = await Call.findById(callId);
      if (callObj) {
        const existingTx = await Transaction.findOne({ call: callId });
        const validByReps = req.body['transaction.validByReps'] !== undefined ? req.body['transaction.validByReps'] : (existingTx ? existingTx.validByReps : null);
        const validByCompany = req.body['transaction.validByCompany'] !== undefined ? req.body['transaction.validByCompany'] : (existingTx ? existingTx.validByCompany : null);

        await Transaction.findOneAndUpdate(
          { call: callId },
          {
            call: callId,
            agent: callObj.agent,
            lead: callObj.lead,
            gigId: callObj.gigId || undefined,
            companyId: callObj.companyId || undefined,
            validByReps,
            validByCompany,
            updatedAt: new Date()
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );

        req.body.validByReps = validByReps;
        req.body.validByCompany = validByCompany;
        req.body.valid = valid;
      }
      delete req.body['transaction.validByReps'];
      delete req.body['transaction.validByCompany'];
      delete req.body['transaction.valid'];
    }

    let call = await Call.findByIdAndUpdate(callId, req.body, {
      new: true,
      runValidators: true
    });

    if (call) {
      call = await Call.findById(call._id).populate('agent').populate('lead').populate('transaction');
    }

    res.status(200).json({
      success: true,
      data: call
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    End call
// @route   POST /api/calls/:id/end
// @access  Private
exports.endCall = async (req, res) => {
  try {
    let call = await Call.findByIdAndUpdate(
      req.params.id,
      {
        status: 'completed',
        duration: req.body.duration || 0,
        updatedAt: new Date()
      },
      { new: true }
    );

    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found'
      });
    }

    // Populate lead data
    call = await Call.findById(call._id).populate('agent').populate('lead');

    // Trigger automatic background analysis
    if (call && call._id) {
      runAnalysisInBackground(call._id);
    }

    res.status(200).json({
      success: true,
      data: call
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Add note to call
// @route   POST /api/calls/:id/notes
// @access  Private
exports.addNote = async (req, res) => {
  try {
    let call = await Call.findByIdAndUpdate(
      req.params.id,
      { notes: req.body.note },
      { new: true }
    );

    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found'
      });
    }

    // Populate lead data
    call = await Call.findById(call._id).populate('agent').populate('lead');

    res.status(200).json({
      success: true,
      data: call
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Update call quality score
// @route   PUT /api/calls/:id/quality-score
// @access  Private
exports.updateQualityScore = async (req, res) => {
  try {
    let call = await Call.findByIdAndUpdate(
      req.params.id,
      { quality_score: req.body.score },
      { new: true }
    );

    if (!call) {
      return res.status(404).json({
        success: false,
        error: 'Call not found'
      });
    }

    // Populate lead data
    call = await Call.findById(call._id).populate('agent').populate('lead');

    res.status(200).json({
      success: true,
      data: call
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// OVH Dialplan
exports.createDialplan = async (req, res) => {
  const { callerNumber, calleeNumber } = req.body;

  if (!callerNumber || !calleeNumber) {
    return res.status(400).json({ error: 'callerNumber et calleeNumber sont requis' });
  }

  try {
    const result = await ovhService.createDialplan(callerNumber, calleeNumber);
    res.status(200).json({ message: 'Dialplan créé avec succès', result });
  } catch (error) {
    console.error('Erreur dans createDialplan Controller:', error);
    res.status(500).json({ error: 'Erreur lors de la création du Dialplan' });
  }
};

// Lancer un appel sortant
exports.launchOutboundCall = async (req, res) => {
  const { callerNumber, calleeNumber } = req.body;

  if (!callerNumber || !calleeNumber) {
    return res.status(400).json({ error: 'callerNumber et calleeNumber sont requis' });
  }

  try {
    const result = await ovhService.launchOutboundCall(callerNumber, calleeNumber);
    res.status(200).json({ message: 'Appel lancé avec succès', result });
  } catch (error) {
    console.error('Erreur dans launchOutboundCall Controller:', error);
    res.status(500).json({ error: 'Erreur lors du lancement de l\'appel' });
  }
};

// Handle Twilio Voice
exports.handleVoice = async (req, res) => {
  const { To, LeadId, AgentId } = req.body;

  console.log("📞 [TwilioVoice] Handling call - To:", To, "LeadId:", LeadId, "AgentId:", AgentId);

  let callerId = null;
  let leadGigId = null;

  if (LeadId && mongoose.Types.ObjectId.isValid(LeadId)) {
    try {
      // 1. Trouver le lead pour obtenir le gigId
      const lead = await mongoose.connection.db.collection('leads').findOne({
        _id: new mongoose.Types.ObjectId(LeadId)
      });

      if (lead && lead.gigId) {
        leadGigId = String(lead.gigId);
        console.log(`🔍 Found lead for gigId: ${lead.gigId}`);

        // 2. Trouver le numéro de téléphone associé à ce gigId
        // Note: gigId peut être stocké comme String ou ObjectId selon l'origine
        const phoneNumberDoc = await mongoose.connection.db.collection('phonenumbers').findOne({
          $or: [
            { gigId: lead.gigId },
            { gigId: lead.gigId.toString() }
          ],
          status: 'active'
        });

        if (phoneNumberDoc) {
          callerId = phoneNumberDoc.phoneNumber;
          console.log(`🚀 Using dynamic CallerID from Gig: ${callerId}`);
        } else {
          console.warn(`⚠️ No active phone number found for gigId: ${lead.gigId}`);
        }
      } else {
        console.warn(`⚠️ No lead or gigId found for LeadId: ${LeadId}`);
      }
    } catch (err) {
      console.error("❌ Error resolving gig phone number:", err);
    }
  }

  const eligibility = await validateCopilotCallEligibility({
    agentId: String(AgentId || '').trim(),
    gigId: leadGigId
  });
  if (!eligibility.ok) {
    console.warn('[TwilioVoice] Call blocked by backend eligibility guard:', {
      leadId: LeadId,
      agentId: AgentId,
      gigId: leadGigId,
      reason: eligibility.reason
    });
    const blockedTwiml = new twilio.twiml.VoiceResponse();
    blockedTwiml.say(
      { voice: 'alice' },
      'Call blocked. You must be enrolled, complete gig trainings, and call only during an active reserved slot.'
    );
    blockedTwiml.hangup();
    res.type("text/xml");
    return res.status(200).send(blockedTwiml.toString());
  }

  try {
    const responseXml = await twilioService.generateTwimlResponse(To, callerId);
    res.type("text/xml");
    res.send(responseXml);
  } catch (error) {
    console.error("Error generating TwiML:", error);
    const twiml = new (require('twilio').twiml.VoiceResponse)();
    twiml.say("An application error occurred.");
    res.type("text/xml");
    res.status(200).send(twiml.toString());
  }
};

exports.initiateCall = async (req, res) => {
  const { to, userId } = req.body;

  if (!userId) {
    return res.status(400).json({ message: 'User ID is required' });
  }

  try {
    const callSid = await twilioService.makeCall(to, userId);
    res.status(200).json({ message: 'Call initiated', callSid });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ message: 'Failed to initiate call', error: err.message });
  }
};

exports.trackCallStatus = async (req, res) => {
  const callSid = req.params.callSid;
  const { userId } = req.body;

  if (!callSid || !userId) {
    return res.status(400).json({ message: 'Call SID and User ID are required' });
  }

  try {
    const callStatus = await twilioService.trackCallStatus(callSid, userId);
    res.status(200).json({ callSid, status: callStatus });
  } catch (err) {
    console.error('Error tracking call:', err);
    res.status(500).json({ message: 'Failed to track call status', error: err.message });
  }
};

exports.hangUpCall = async (req, res) => {
  const callSid = req.params.callSid;
  const { userId } = req.body;

  if (!callSid || !userId) {
    return res.status(400).json({ message: 'Call SID and User ID are required' });
  }

  try {
    const call = await twilioService.hangUpCall(callSid, userId);
    res.status(200).json({ message: 'Call ended', callSid: call.sid, status: call.status });
  } catch (err) {
    console.error('Error hanging up call:', err);
    res.status(500).json({ message: 'Failed to hang up call', error: err.message });
  }
};

exports.getTwilioToken = async (req, res) => {
  try {
    const token = await twilioService.generateTwilioToken('platform-user');
    res.json({ token });
  } catch (error) {
    console.error('Error generating token:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
};

exports.saveCallToDB = async (req, res) => {
  const { CallSid, callSid, agentId, leadId, call, cloudinaryrecord, transcript, gigId, companyId, userId, transactionOccurred, isVoicemail, appointmentAt, callbackAt, ErrorCode, errorCode } = req.body;
  const actualCallSid = CallSid || callSid;
  // Twilio error code (21211 = invalid number, 21214 = unreachable, 13224 = cannot dial)
  const twilioErrorCode = ErrorCode || errorCode ? Number(ErrorCode || errorCode) : null;

  if (!actualCallSid) {
    return res.status(400).json({ message: 'Call SID is required' });
  }

  try {
    const callDetails = await twilioService.saveCallToDB(
      actualCallSid, 
      agentId, 
      leadId, 
      call, 
      cloudinaryrecord, 
      transcript,
      gigId,
      companyId,
      userId,
      transactionOccurred,
      isVoicemail,
      appointmentAt,
      callbackAt
    );

    // Persist Twilio error code if provided (available at call-end from Twilio webhook)
    if (callDetails?._id && twilioErrorCode) {
      await Call.updateOne({ _id: callDetails._id }, { $set: { twilioErrorCode } }).catch(() => {});
    }

    // Trigger automatic background analysis
    if (callDetails && callDetails._id) {
      runAnalysisInBackground(callDetails._id);
    }

    res.json(callDetails);
  } catch (error) {
    console.error('Error in saveCallToDB controller:', error);
    res.status(500).json({
      message: 'Failed to save call details',
      error: error.message
    });
  }
};

/**
 * POST /api/calls/amd-callback
 * Twilio Async AMD (Answering Machine Detection) webhook.
 * Fired automatically when Twilio determines whether the call was answered by
 * a human or a machine — no rep action required.
 *
 * Key fields sent by Twilio:
 *   CallSid       – parent call SID
 *   AnsweredBy    – "machine_start" | "machine_end_beep" | "machine_end_silence"
 *                   | "machine_end_other" | "human" | "fax" | "unknown"
 *   MachineDetectionDuration – ms taken to detect
 */
exports.amdCallback = async (req, res) => {
  // Always respond 200 immediately so Twilio doesn't retry
  res.sendStatus(200);

  const { CallSid, AnsweredBy } = req.body || {};
  if (!CallSid) return;

  const isMachine = AnsweredBy && AnsweredBy.startsWith('machine');
  const isFax = AnsweredBy === 'fax';

  console.log(`📠 [AMD] CallSid=${CallSid} AnsweredBy=${AnsweredBy} → isMachine=${isMachine}`);

  if (!isMachine && !isFax) {
    // Human answered — nothing to do, call flows normally
    return;
  }

  // Mark the call document as voicemail / auto-refused
  try {
    const outcome = isFax ? 'voicemail' : 'voicemail';
    const reason = isFax
      ? 'Fax détecté par Twilio AMD'
      : `Répondeur détecté automatiquement par Twilio AMD (${AnsweredBy})`;

    const updated = await Call.findOneAndUpdate(
      { sid: CallSid },
      {
        $set: {
          callOutcome: outcome,
          callOutcomeSource: 'system',
          validByAI: false,
          valid: false,
          ai_call_status: 'auto_refused',
          ai_refusal_reason: reason,
          updatedAt: new Date(),
        }
      },
      { new: true }
    );

    if (updated) {
      console.log(`✅ [AMD] Call ${CallSid} auto-marked as voicemail (doc _id=${updated._id})`);
    } else {
      // Document may not exist yet if store-call hasn't fired — that's fine,
      // saveCallToDB will pick up isVoicemail from the AMD flag later.
      console.warn(`⚠️  [AMD] No Call doc found for SID ${CallSid} yet — will be handled at store-call time`);
    }
  } catch (err) {
    console.error(`❌ [AMD] Failed to mark call ${CallSid} as voicemail:`, err.message);
  }
};

exports.fetchRecording = async (req, res) => {
  const { recordingUrl, userId } = req.body;

  if (!recordingUrl || !userId) {
    return res.status(400).json({ message: 'Recording URL and User ID are required' });
  }

  try {
    const recording = await twilioService.fetchTwilioRecording(recordingUrl, userId);
    if (!recording) {
      return res.status(500).json({ message: 'Error fetching the recording' });
    }
    res.json({ url: recording });
  } catch (error) {
    console.error('Error fetching recording:', error);
    res.status(500).json({ message: 'Error fetching the recording' });
  }
};

exports.getCallDetails = async (req, res) => {
  const { callSid, userId } = req.body;

  if (!callSid || !userId) {
    return res.status(400).json({ message: 'Call SID and User ID are required' });
  }

  try {
    const callDetails = await twilioService.getCallDetails(callSid, userId);
    return res.status(200).json({ success: true, data: callDetails });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
};

// Qalqul logic
exports.storeCallsInDBatStartingCall = async (req, res) => {
  const { storeCall } = req.body;
  try {
    const callDetails = await qalqulService.storeCallsInDBatStartingCall(storeCall);
    res.status(200).json({ success: true, data: callDetails });
  } catch (error) {
    console.error('Error storing call:', error);
    res.status(500).json({ success: false, message: 'Failed to store call details', error: error.message });
  }
};

exports.storeCallsInDBatEndingCall = async (req, res) => {
  const { phoneNumber, callSid } = req.body;
  try {
    const callDetails = await qalqulService.storeCallsInDBatEndingCall(phoneNumber, callSid);

    // Trigger automatic background analysis
    if (callDetails && callDetails._id) {
      runAnalysisInBackground(callDetails._id);
    }

    res.status(200).json({ success: true, data: callDetails });
  } catch (error) {
    console.error('Error storing call:', error);
    res.status(500).json({ success: false, message: 'Failed to store call details', error: error.message });
  }
};

// AI Assistance and DISC Analysis
exports.getAIAssistance = async (req, res) => {
  try {
    const { transcription, context } = req.body;
    if (!transcription) {
      return res.status(400).json({ success: false, message: 'Transcription is required' });
    }
    const suggestion = await vertexAIService.getAIAssistance(transcription, context);
    res.json({ success: true, suggestion: suggestion });
  } catch (error) {
    console.error('Error getting AI assistance:', error);
    res.status(500).json({ success: false, message: 'Failed to get AI assistance', error: error.message });
  }
};

exports.getPersonalityAnalysis = async (req, res) => {
  try {
    const { transcription, context, callDuration } = req.body;
    if (!transcription) {
      return res.status(400).json({ success: false, message: 'Transcription is required' });
    }
    const personalityProfile = await vertexAIService.getPersonalityAnalysis(transcription, context, callDuration);
    res.json({ success: true, personalityProfile: personalityProfile });
  } catch (error) {
    console.error('Error getting personality analysis:', error);
    res.status(500).json({ success: false, message: 'Failed to get personality analysis', error: error.message });
  }
};

// ────────────────────────────────────────────────────────────────────────────
//  Call-outcome classifier — deterministic mapping from analyzer signals to
//  the `callOutcome` enum on the Call schema. Used by `analyzeCall` (AI path
//  + auto-refused path). Keep this pure: no DB, no LLM, just inputs → outcome.
//  That way the same logic can be re-used by the lazy fallback in the
//  analytics aggregations.
//
//  Decision tree:
//    1. Telephony layer (Twilio status, hangup before connect).
//    2. If the AI has actually scored the call (`hasAiScoring === true`)
//       → drive the outcome from `ai_call_score` content EXCLUSIVELY.
//       We never fall back on duration in this branch — the LLM has more
//       context than seconds. A 23s call that the AI judged "unproductive"
//       is `connected_no_sale`, NOT `too_short`.
//    3. Otherwise (no LLM run yet, or auto-refused) → cheap heuristics
//       (duration, telephony status) for a best-effort label.
// ────────────────────────────────────────────────────────────────────────────
// Twilio error codes that explicitly indicate an invalid/unreachable number.
const TWILIO_WRONG_NUMBER_CODES = new Set([21211, 21214, 13224]);

function classifyCallOutcome({
  status,
  duration,
  hasRecording,
  hasAiScoring,
  validByAI,
  refusalDetected,
  transactionDetected,
  fraudScore,
  argumentationScore,
  scriptCoherence,
  sentimentScore,
  overallScore,
  refusalReason,
  twilioErrorCode,
}) {
  const s = String(status || '').toLowerCase();
  const dur = Number(duration) || 0;
  const reason = String(refusalReason || '').toLowerCase();
  const errCode = twilioErrorCode ? Number(twilioErrorCode) : null;

  // 1) Telephony-level outcomes — short-circuit before AI logic.
  if (s === 'busy') return 'busy';
  if (['no-answer', 'noanswer', 'canceled', 'cancelled'].includes(s)) return 'no_answer';
  if (s === 'failed') {
    // Twilio "failed" = call could not be placed at all (invalid number, no route,
    // carrier rejected). Always surface as wrong_number — distinct from no-answer
    // (which means the call rang but was not picked up).
    // Error codes 21211 (invalid number), 21214 (unreachable), 13224 (cannot dial)
    // all confirm wrong_number, but we treat all failed calls the same way.
    return 'wrong_number';
  }
  // Explicit Twilio error code for bad number even if status is not "failed"
  if (errCode && TWILIO_WRONG_NUMBER_CODES.has(errCode)) return 'wrong_number';
  // Completed with no audio and duration 0 → answering machine pickup.
  if (s === 'completed' && dur === 0 && !hasRecording) return 'voicemail';

  // 2) AI-content-driven outcomes — applied whenever the LLM ran. We
  //    intentionally do NOT consult `duration` here: a 12-second call that
  //    the AI scored with feedback is more reliably classified by content
  //    than by clock.
  if (hasAiScoring) {
    if (typeof fraudScore === 'number' && fraudScore < 50) return 'fraud';
    if (transactionDetected) return 'transaction';

    if (
      refusalDetected ||
      /refus|pas intéress|not interested|déjà équipé|already equipped|déjà engag|déjà assur|already insured|wrong|faux numéro/.test(reason)
    ) {
      if (/déjà équipé|already equipped|déjà engag|déjà assur|already insured/.test(reason)) return 'already_equipped';
      if (/wrong|faux numéro|invalid phone/.test(reason)) return 'wrong_number';
      if (/pas intéress|not interested/.test(reason)) return 'not_interested';
      return 'refusal';
    }

    // Engaged conversation — high argumentation AND the AI validated the call.
    if (
      typeof argumentationScore === 'number' &&
      argumentationScore >= 70 &&
      validByAI
    ) {
      return 'argued_interested';
    }

    // Customer leaned positive but no transaction nor strong argumentation
    // (e.g. polite curiosity). We still tag it as "argued" so the rep can
    // follow up — better than the catch-all bucket.
    if (
      typeof sentimentScore === 'number' &&
      sentimentScore >= 70 &&
      typeof argumentationScore === 'number' &&
      argumentationScore >= 50
    ) {
      return 'argued_interested';
    }

    // AI ran but no specific signal → connected without a clear outcome.
    // (e.g. agent silent, no engagement on either side, dead air, ...)
    return 'connected_no_sale';
  }

  // 3) No AI scoring available — fall back on heuristics.
  if (dur > 0 && dur < 30) return 'too_short';
  return 'connected_no_sale';
}

// Helper: have we got real AI scoring output for this call?
// We rely on the overall score being a real number > 0; the schema default
// is empty (the rubric is only populated by `vertexAIService.scoreCall`).
function detectAiScoring(scores) {
  return !!(scores && scores.overall && typeof scores.overall.score === 'number' && scores.overall.score > 0);
}
exports.detectAiScoring = detectAiScoring;

const runAnalysisInBackground = (callId) => {
  console.log(`🤖 [AutoAnalysis] Scheduling background analysis for call ${callId} in 5 seconds...`);
  setTimeout(async () => {
    try {
      const call = await Call.findById(callId);
      if (!call) {
        console.warn(`⚠️ [AutoAnalysis] Call ${callId} not found, aborting analysis.`);
        return;
      }
      const alreadyScored = call.validByAI === true || call.validByAI === false || 
                           call.ai_call_status === 'scored' || call.ai_call_status === 'auto_refused';
      if (alreadyScored) {
        console.log(`🤖 [AutoAnalysis] Call ${callId} is already scored or processed. Skipping.`);
        return;
      }

      console.log(`🤖 [AutoAnalysis] Running background analysis for call: ${callId}`);
      const mockReq = { params: { id: callId }, body: {} };
      const mockRes = {
        status: function(code) {
          this.statusCode = code;
          return this;
        },
        json: function(data) {
          console.log(`🤖 [AutoAnalysis] Background analysis finished for ${callId} with status ${this.statusCode || 200}:`, data.success ? 'Success' : data.message);
          return this;
        }
      };
      await exports.analyzeCall(mockReq, mockRes);
    } catch (err) {
      console.error(`❌ [AutoAnalysis] Background analysis failed for call ${callId}:`, err);
    }
  }, 5000);
};

exports.analyzeCall = async (req, res) => {
  try {
    const { id } = req.params;
    const call = await Call.findById(id).populate({
      path: 'lead',
      populate: {
        path: 'gigId'
      }
    });
    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' });
    }

    // Idempotent: return existing results when analysis already finished.
    if (call.ai_call_status === 'scored' || call.ai_call_status === 'auto_refused') {
      const hasScores = detectAiScoring(call.ai_call_score);
      if (hasScores || call.ai_call_status === 'auto_refused') {
        return res.json({
          success: true,
          message: 'Call already analyzed',
          alreadyAnalyzed: true,
          data: call.ai_call_score,
          transcript: call.transcript,
          validByAI: call.validByAI,
          callOutcome: call.callOutcome,
        });
      }
    }

    // Another worker (usually auto-analysis after store-call) is already
    // running — but only treat the lock as live if it is recent. A stale
    // `processing` lock (worker hung / process restarted mid-analysis) is
    // reclaimable so the call doesn't spin forever in the UI.
    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS);
    const lockIsStale = !call.updatedAt || new Date(call.updatedAt) < staleBefore;
    if (call.ai_call_status === 'processing' && !lockIsStale) {
      return res.status(202).json({
        success: true,
        inProgress: true,
        message: 'Analysis already in progress for this call.',
        ai_call_status: 'processing',
      });
    }
    if (call.ai_call_status === 'processing' && lockIsStale) {
      console.warn(`♻️ [CallController] Reclaiming stale processing lock for call ${id} (updatedAt=${call.updatedAt}).`);
    }

    // Atomically claim this call for analysis. Multiple triggers can fire for
    // the same call within seconds (the in-process background auto-analysis
    // and the frontend's manual /analyze POST). Running two analyses in
    // parallel made both load the document at the same version and the second
    // `save()` threw a Mongoose VersionError. The atomic findOneAndUpdate
    // below lets exactly one invocation win the lock; any concurrent caller
    // gets a clean 202 instead of crashing the analyzer. We also bump
    // `updatedAt` so the lock's freshness can be measured (the `$set` path
    // bypasses the pre-save hook that normally maintains it).
    const claimed = await Call.findOneAndUpdate(
      {
        _id: id,
        $or: [
          { ai_call_status: { $ne: 'processing' } },
          { updatedAt: { $lt: staleBefore } },
          { updatedAt: { $exists: false } },
        ],
      },
      { $set: { ai_call_status: 'processing', updatedAt: new Date() } }
    );
    if (!claimed) {
      // Race: status flipped to `processing` between the read above and the claim.
      return res.status(202).json({
        success: true,
        inProgress: true,
        message: 'Analysis already in progress for this call.',
        ai_call_status: 'processing',
      });
    }
    call.ai_call_status = 'processing';

    // ☎️  Auto-refuse calls that never reached a human. No transcript, no
    // audio → nothing for the LLM to score. We tag them as `validByAI=false`
    // so they stop showing up as "Analyse en cours" forever.
    const callStatus = (call.status || '').toString().toLowerCase();
    const noConnectStatuses = new Set(['no-answer', 'noanswer', 'busy', 'canceled', 'cancelled', 'failed']);
    const looksUnanswered =
      noConnectStatuses.has(callStatus) ||
      (callStatus === 'completed' && (call.duration || 0) === 0 && !call.recording_url_cloudinary);

    if (looksUnanswered) {
      const errCode = call.twilioErrorCode ? Number(call.twilioErrorCode) : null;
      const errSuffix = errCode ? `, ErrorCode: ${errCode}` : '';
      const refusalReason = `Appel non décroché (status: ${call.status || 'unknown'}${errSuffix})`;
      const callOutcome = classifyCallOutcome({
        status: callStatus,
        duration: call.duration,
        hasRecording: !!call.recording_url_cloudinary,
        hasAiScoring: false, // auto-refused: LLM never ran
        validByAI: false,
        refusalDetected: false,
        transactionDetected: false,
        fraudScore: null,
        argumentationScore: 0,
        scriptCoherence: 0,
        sentimentScore: 0,
        overallScore: 0,
        refusalReason,
        twilioErrorCode: errCode,
      });
      const updated = await Call.findByIdAndUpdate(
        id,
        {
          $set: {
            validByAI: false,
            valid: false,
            ai_refusal_reason: refusalReason,
            ai_call_status: 'auto_refused',
            callOutcome,
            callOutcomeSource: 'system',
            'flags.fraud': false,
            'flags.serious': false,
            'flags.transactionDetected': false,
            'flags.refusalDetected': false,
            repCallCommission: 0,
            platformCallCommission: 0
          }
        },
        { new: true }
      );
      console.log(`🚫 [CallController] Call ${id} auto-refused (${callStatus}) → outcome=${callOutcome}`);
      return res.status(200).json({
        success: true,
        message: refusalReason,
        validByAI: false,
        callOutcome,
        data: updated
      });
    }

    // Get Gig Script/Description - First attempt from collection
    let gigScript = call.lead?.gigId?.description || "";
    try {
      const gigId = call.lead?.gigId?._id || call.lead?.gigId;
      if (gigId) {
        console.log(`🔍 [CallController] Fetching script from collection for Gig ${gigId}...`);
        const scriptRes = await fetch(`${KNOWLEDGEBASE_API_URL}/scripts/gig/${gigId}`);
        if (scriptRes.ok) {
          const scriptData = await scriptRes.json();
          const scripts = scriptData.data || [];
          // Prioritize active script, fallback to most recent
          const activeScript = scripts.find(s => s.isActive) || scripts[0];
          
          if (activeScript && activeScript.script && activeScript.script.length > 0) {
            gigScript = activeScript.script.map(s => `[${s.phase}] ${s.actor}: ${s.replica}`).join("\n");
            console.log(`✅ [CallController] Script from collection loaded (${activeScript.script.length} replicas).`);
          } else {
            console.log(`⚠️ [CallController] No script replicas found in collection, using gig description.`);
          }
        }
      }
    } catch (scriptError) {
      console.error(`❌ [CallController] Failed to fetch script from KB:`, scriptError.message);
    }

    // Attempt to get transcript.
    let transcriptData = call.transcript || [];
    
    // Real Audio Transcription if no transcript exists and recording is available
    const hasRecording = call.recording_url_cloudinary || call.recording_url;
    if ((!transcriptData || (Array.isArray(transcriptData) && transcriptData.length === 0)) && hasRecording) {
        console.log(`🎙️ [CallController] Attempting real audio transcription for call ${id}...`);
        try {
          const recordingUrl = call.recording_url_cloudinary || call.recording_url;
          const realTranscript = await withTimeout(
            vertexAIService.transcribeAudioFromUrl(recordingUrl),
            TRANSCRIPTION_TIMEOUT_MS,
            'Audio transcription'
          );
          if (realTranscript && realTranscript.length > 0) {
            transcriptData = realTranscript;
            console.log(`✅ [CallController] Audio transcribed successfully: ${transcriptData.length} turns.`);
          } else {
            console.warn(`⚠️ [CallController] Transcription returned empty for call ${id}.`);
          }
        } catch (transcriptionError) {
          console.error(`❌ [CallController] Transcription failed:`, transcriptionError);
        }
    }

    // Fallback if transcription failed or no recording. Reset the lock so the
    // call doesn't stay frozen in `processing` (the UI would spin forever).
    if ((!transcriptData || (Array.isArray(transcriptData) && transcriptData.length === 0)) && !hasRecording) {
       await Call.updateOne({ _id: id }, { $set: { ai_call_status: 'error', updatedAt: new Date() } });
       return res.status(400).json({ success: false, message: 'No transcript or recording available for analysis' });
    }

    // Convert string transcript to array if it was stored as legacy string
    if (typeof transcriptData === 'string' && transcriptData.length > 0) {
      const parts = transcriptData.split(/\[(Agent|Customer|Speaker \d+)\]:/i).filter(Boolean);
      const structuredTranscript = [];
      for (let i = 0; i < parts.length; i += 2) {
        if (parts[i+1]) {
          structuredTranscript.push({
            speaker: parts[i].trim(),
            text: parts[i+1].trim()
          });
        }
      }
      transcriptData = structuredTranscript.length > 0 ? structuredTranscript : [{ speaker: "Unknown", text: transcriptData }];
      transcriptData = structuredTranscript.length > 0 ? structuredTranscript : [{ speaker: "Unknown", text: transcriptData }];
    }

    if (!transcriptData || (Array.isArray(transcriptData) && transcriptData.length === 0)) {
        await Call.updateOne({ _id: id }, { $set: { ai_call_status: 'error', updatedAt: new Date() } });
        return res.status(400).json({ success: false, message: 'No transcript or recording available for analysis' });
    }

    // Prepare transcript string for AI scoring
    const transcriptText = Array.isArray(transcriptData) 
      ? transcriptData.map(t => `[${t.speaker}]: ${t.text}`).join("\n")
      : transcriptData;

    console.log(`🧠 [CallController] Triggering precision AI scoring for call ${id}...`);
    const scores = await withTimeout(
      vertexAIService.scoreCall(transcriptText, gigScript),
      SCORING_TIMEOUT_MS,
      'AI scoring'
    );

    // ── Voicemail / non-productive guard ─────────────────────────────────
    //   On a call that never reached a human (voicemail pickup, dead-air,
    //   no agent dialogue), the LLM has nothing useful to score and tends
    //   to hallucinate per-rubric praise ("Agent fluency: 100% — message
    //   clair et concis") while its own executive summary correctly says
    //   "appel non productif, messagerie vocale, aucun élément exploitable".
    //
    //   We use the overall feedback as the trigger because:
    //     • The LLM is reliable at *summarising* the call type.
    //     • Scanning the raw transcript for voicemail boilerplate is
    //       brittle across languages / TTS variants.
    //   When the trigger fires we:
    //     • zero out every individual rubric score + force passed=false,
    //     • keep `Fraud detection` at 100 (a voicemail is NOT fraud),
    //     • preserve `overall.score` / `overall.feedback` so the modal still
    //       shows the truthful "Executive summary".
    //   `callOutcome` is forced to 'voicemail' a few lines below.
    const overallFeedback = String(scores?.overall?.feedback || '').toLowerCase();
    const VOICEMAIL_REGEX =
      /messagerie\s+(vocale|automatique)|r[ée]pondeur|laissez\s+(votre|un)\s+message|bo[îi]te\s+vocale|voicemail|answering\s+machine|leave\s+(a|your)\s+message|after\s+the\s+(tone|beep)|appel\s+non\s+productif|aucun\s+(?:él|el)[ée]ment\s+exploitable|n['']est\s+pas\s+disponible|votre\s+correspondant/i;
    const isNonProductiveCall = VOICEMAIL_REGEX.test(overallFeedback);

    if (isNonProductiveCall) {
      const NON_EVAL_FEEDBACK_FR =
        "Critère non évaluable — appel non productif (messagerie / aucun échange exploitable).";
      const NON_EVAL_FEEDBACK_EN =
        "Criterion not evaluable — non-productive call (voicemail / no exploitable exchange).";
      const NEUTRALISE_KEYS = [
        "Agent fluency",
        "Sentiment analysis",
        "Script coherence",
        "Argumentation",
        "Script adherence",
        "Transaction analysis",
        "PAS INTÉRESSÉS",
        "PAS AU COURANT",
        "DÉJÀ ÉQUIPÉS",
        "RDV",
        "A plus tard"
      ];
      for (const k of NEUTRALISE_KEYS) {
        if (scores[k] && typeof scores[k] === "object") {
          scores[k].score       = 0;
          scores[k].feedback    = NON_EVAL_FEEDBACK_FR;
          scores[k].feedback_fr = NON_EVAL_FEEDBACK_FR;
          scores[k].feedback_en = NON_EVAL_FEEDBACK_EN;
          scores[k].passed      = false;
        }
      }
      // Fraud detection follows reversed semantics (high = clean). A
      // voicemail must NOT raise the fraud flag, so we pin it at 100 / pass.
      if (scores["Fraud detection"] && typeof scores["Fraud detection"] === "object") {
        scores["Fraud detection"].score       = 100;
        scores["Fraud detection"].feedback    = "Aucun signal de fraude — appel non productif.";
        scores["Fraud detection"].feedback_fr = "Aucun signal de fraude — appel non productif.";
        scores["Fraud detection"].feedback_en = "No fraud signal — non-productive call.";
        scores["Fraud detection"].passed      = true;
      }
      scores.transaction_detected = false;
      scores.refusal_detected     = false;
      console.log(`📭 [CallController] Call ${id} flagged as non-productive (voicemail) — per-rubric scores neutralised.`);
    }

    // AI Validation Logic
    const scriptCoherence = scores["Script coherence"]?.score || 0;
    const argumentationScore = scores["Argumentation"]?.score || 0;
    const fraudScore = scores["Fraud detection"]?.score || 100;
    const transactionDetected = scores.transaction_detected || false;
    const refusalDetected = scores.refusal_detected || false;

    // Call is valid if:
    // 1. No significant fraud/insults (fraudScore >= 50)
    // AND
    // 2. Script coherence is good (>= 50)
    // AND
    // 3. Call duration is greater than 70 seconds (implies reached argumentation)
    const duration = call.duration || call._doc?.duration || 0;
    const isValidByAI = fraudScore >= 50 && scriptCoherence >= 50 && duration > 70;
    
    // Calculate Commissions (70% Rep / 30% Platform)
    const baseCallCommission = call.lead?.gigId?.commission?.commission_per_call || call.lead?.gigId?.rewardPerCall || 4;
    const baseTransactionCommission = call.lead?.gigId?.commission?.transactionCommission || call.lead?.gigId?.rewardPerSale || 30;

    const repCallCommission = isValidByAI ? baseCallCommission * 0.7 : 0;
    const platformCallCommission = isValidByAI ? baseCallCommission * 0.3 : 0;

    const repTransactionCommission = (isValidByAI && transactionDetected) ? baseTransactionCommission * 0.7 : 0;
    const platformTransactionCommission = (isValidByAI && transactionDetected) ? baseTransactionCommission * 0.3 : 0;

    // Compute a per-rubric Yes/No verdict next to each numeric score.
    //   passed = score >= PASS_THRESHOLD (50)
    // The verdicts are persisted on the Call doc so the rep modal and
    // dashboards never have to re-threshold on every read.
    const PASS_THRESHOLD = 50;
    const RUBRIC_KEYS = [
      "Agent fluency",
      "Sentiment analysis",
      "Fraud detection",
      "Script coherence",
      "Argumentation",
      "Script adherence",
      "Transaction analysis",
      "PAS INTÉRESSÉS",
      "PAS AU COURANT",
      "DÉJÀ ÉQUIPÉS",
      "RDV",
      "A plus tard",
      "overall"
    ];
    for (const k of RUBRIC_KEYS) {
      if (scores[k] && typeof scores[k] === "object") {
        const s = typeof scores[k].score === "number" ? scores[k].score : 0;
        scores[k].passed = s >= PASS_THRESHOLD;
      }
    }

    // Update the call with the new scores and ensure transcript is saved in structured format
    call.ai_call_score = scores;
    call.validByAI = isValidByAI;
    call.valid = isValidByAI; // Unified valid flag
    call.argumentation_score = argumentationScore;
    call.repCallCommission = repCallCommission;
    call.platformCallCommission = platformCallCommission;
    call.repTransactionCommission = repTransactionCommission;
    call.platformTransactionCommission = platformTransactionCommission;
    call.transaction_price = baseTransactionCommission;

    // ── Unified call-analysis layer ───────────────────────────────────────
    //  Persist denormalised signals so the company dashboard can group/filter
    //  without re-scanning ai_call_score on every request.
    //
    //  Voicemail short-circuit: the AI did run (we kept `overall` intact for
    //  the modal summary), but the per-rubric scores were neutralised above.
    //  Routing those zeros back through `classifyCallOutcome` would bucket
    //  this call as `connected_no_sale`, which is misleading on dashboards —
    //  force the `voicemail` outcome explicitly.
    const callOutcome = isNonProductiveCall
      ? 'voicemail'
      : classifyCallOutcome({
          status: callStatus,
          duration,
          hasRecording: !!call.recording_url_cloudinary,
          hasAiScoring: true, // LLM just ran successfully
          validByAI: isValidByAI,
          refusalDetected,
          transactionDetected,
          fraudScore,
          argumentationScore,
          scriptCoherence,
          sentimentScore: scores["Sentiment analysis"]?.score || 0,
          overallScore: scores.overall?.score || 0,
          refusalReason: call.ai_refusal_reason,
        });
    call.callOutcome = callOutcome;
    call.callOutcomeSource = 'ai';
    call.ai_call_status = 'scored';
    // Use the LLM's overall feedback as a starter summary. A dedicated
    // /audio/summarize prompt can replace this later without changing the
    // schema.
    if (scores && scores.overall) {
      call.ai_summary = scores.overall.feedback || scores.overall.feedback_fr || '';
      call.ai_summary_fr = scores.overall.feedback_fr || scores.overall.feedback || '';
      call.ai_summary_en = scores.overall.feedback_en || '';
    }
    call.flags = {
      fraud:               fraudScore < 50,
      serious:             isValidByAI,
      transactionDetected: !!transactionDetected,
      refusalDetected:     !!refusalDetected,
    };

    if (isValidByAI && call.companyId) {
      // Trigger reconciliation in orchestrator
      const orchestratorUrl = process.env.ORCHESTRATOR_API_URL || 'http://localhost:3003';
      fetch(`${orchestratorUrl}/api/escrow/reconcile/${call.companyId}`, { method: 'POST' })
        .then(res => res.json())
        .then(data => console.log(`✅ Triggered reconciliation for company ${call.companyId}:`, data))
        .catch(err => console.error('❌ Failed to trigger reconciliation:', err));
    }

    if (Array.isArray(transcriptData)) {
      call.transcript = transcriptData;
    }

    // Persist atomically via $set instead of `call.save()`. The loaded
    // document can become stale during the multi-second transcription +
    // scoring window (store-call upserts and other writers touch the same
    // call), which made `save()` fail with a Mongoose VersionError. An atomic
    // update bypasses the optimistic version check while writing the exact
    // fields we computed here.
    const analysisUpdate = {
      ai_call_score: call.ai_call_score,
      validByAI: call.validByAI,
      valid: call.valid,
      argumentation_score: call.argumentation_score,
      repCallCommission: call.repCallCommission,
      platformCallCommission: call.platformCallCommission,
      repTransactionCommission: call.repTransactionCommission,
      platformTransactionCommission: call.platformTransactionCommission,
      transaction_price: call.transaction_price,
      callOutcome: call.callOutcome,
      callOutcomeSource: call.callOutcomeSource,
      ai_call_status: call.ai_call_status,
      flags: call.flags,
    };
    if (scores && scores.overall) {
      analysisUpdate.ai_summary = call.ai_summary;
      analysisUpdate.ai_summary_fr = call.ai_summary_fr;
      analysisUpdate.ai_summary_en = call.ai_summary_en;
    }
    if (Array.isArray(transcriptData)) {
      analysisUpdate.transcript = call.transcript;
    }
    await Call.findByIdAndUpdate(id, { $set: analysisUpdate });

    // Update or Create Transaction
    // Rule: If call is rejected by AI (Fraud or Coherence), transaction is automatically REJECTED.
    // Otherwise, use detection signals.
    const transactionStatus = !isValidByAI ? false : (transactionDetected ? true : (refusalDetected ? false : null));

    const transactionUpdate = {
      call: id,
      agent: call.agent,
      lead: call.lead?._id,
      gigId: call.lead?.gigId?._id,
      companyId: call.companyId,
      validByAI: transactionStatus,
      argumentation_score: argumentationScore,
      transaction_score: scores.overall?.score || 0,
      repTransactionCommission: repTransactionCommission,
      platformTransactionCommission: platformTransactionCommission,
      updatedAt: new Date()
    };

    // Rule: If call is rejected by AI, transaction final validation is also automatically REJECTED.
    if (!isValidByAI) {
      transactionUpdate.validByCompany = false;
    }

    if (transactionDetected || refusalDetected || !isValidByAI) {
      await Transaction.findOneAndUpdate(
        { call: id },
        transactionUpdate,
        { upsert: true, new: true }
      );
    }

    res.json({ 
        success: true, 
        message: 'Call analysis completed', 
        data: scores,
        transcript: call.transcript,
        validByAI: isValidByAI
    });
  } catch (error) {
    console.error('Error in analyzeCall:', error);
    // Best-effort: mark the call as errored so the UI can surface a retry.
    try {
      if (req.params?.id) {
        await Call.updateOne(
          { _id: req.params.id },
          { $set: { ai_call_status: 'error', updatedAt: new Date() } }
        );
      }
    } catch (_) { /* swallow */ }
    res.status(500).json({ success: false, message: 'Failed to analyze call', error: error.message });
  }
};

// Re-export classifier so analytics aggregations can use the same logic.
exports.classifyCallOutcome = classifyCallOutcome;

exports.startRecording = async (req, res) => {
  const { callSid, userId } = req.body;
  if (!callSid || !userId) {
    return res.status(400).json({ message: 'Call SID and User ID are required' });
  }

  try {
    const recording = await twilioService.startRecording(callSid, userId);
    res.status(200).json({ success: true, recording });
  } catch (err) {
    console.error('Error starting recording:', err);
    res.status(500).json({ success: false, message: 'Failed to start recording', error: err.message });
  }
};

exports.stopRecording = async (req, res) => {
  const { callSid, userId } = req.body;
  if (!callSid || !userId) {
    return res.status(400).json({ message: 'Call SID and User ID are required' });
  }

  try {
    const results = await twilioService.stopRecording(callSid, userId);
    res.status(200).json({ success: true, results });
  } catch (err) {
    console.error('Error stopping recording:', err);
    res.status(500).json({ success: false, message: 'Failed to stop recording', error: err.message });
  }
};

exports.getLoginToken = async (req, res) => {
  try {
    const token = await telnyxService.generateLoginToken();
    res.json({ login_token: token });
  } catch (error) {
    console.error('Error in controller:', error);
    res.status(500).json({ error: 'Failed to get Telnyx login token' });
  }
};