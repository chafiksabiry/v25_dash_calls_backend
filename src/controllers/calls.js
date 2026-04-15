const { Call } = require('../models/Call');
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

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseHHMMToMinutes(raw) {
  const m = String(raw || '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  if (h < 0 || h > 23 || mm < 0 || mm > 59) return null;
  return h * 60 + mm;
}

function isReservationForToday(rawDate, now) {
  const v = String(rawDate || '').trim();
  if (!v) return false;
  if (ISO_DATE_RE.test(v)) {
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return v === `${yyyy}-${mm}-${dd}`;
  }
  const todayName = now.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
  return v.toLowerCase() === todayName;
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
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const hasActiveWindow = (Array.isArray(rows) ? rows : []).some((r) => {
      if (String(r?.status || '').toLowerCase() !== 'reserved') return false;
      const d = r?.reservationDate || r?.date;
      if (!isReservationForToday(d, now)) return false;
      const start = parseHHMMToMinutes(r?.startTime);
      const end = parseHHMMToMinutes(r?.endTime);
      if (start == null || end == null || end <= start) return false;
      return nowMinutes >= start && nowMinutes < end;
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
    const calls = await Call.find()
      .populate('agent')
      .populate({
        path: 'lead',
        populate: {
          path: 'gigId',
          model: 'Gig'
        }
      });

    res.status(200).json({
      success: true,
      count: calls.length,
      data: calls
    });
  } catch (err) {
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
      });

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
      call = await Call.findById(call._id).populate('agent').populate('lead');
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
    let call = await Call.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
    });

    if (call) {
      call = await Call.findById(call._id).populate('agent').populate('lead');
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
  const { CallSid, callSid, agentId, leadId, call, cloudinaryrecord, transcript } = req.body;
  const actualCallSid = CallSid || callSid;

  if (!actualCallSid) {
    return res.status(400).json({ message: 'Call SID is required' });
  }

  try {
    const callDetails = await twilioService.saveCallToDB(actualCallSid, agentId, leadId, call, cloudinaryrecord, transcript);
    res.json(callDetails);
  } catch (error) {
    console.error('Error in saveCallToDB controller:', error);
    res.status(500).json({
      message: 'Failed to save call details',
      error: error.message
    });
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

exports.analyzeCall = async (req, res) => {
  try {
    const { id } = req.params;
    const call = await Call.findById(id).populate('lead');
    if (!call) {
      return res.status(404).json({ success: false, message: 'Call not found' });
    }

    // Attempt to get transcript.
    let transcriptData = call.transcript || [];
    
    // Real Audio Transcription if no transcript exists and recording is available
    if ((!transcriptData || (Array.isArray(transcriptData) && transcriptData.length === 0)) && call.recording_url_cloudinary) {
        console.log(`🎙️ [CallController] Attempting real audio transcription for call ${id}...`);
        try {
          const realTranscript = await vertexAIService.transcribeAudioFromUrl(call.recording_url_cloudinary);
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

    // Fallback if transcription failed or no recording
    if ((!transcriptData || (Array.isArray(transcriptData) && transcriptData.length === 0)) && !call.recording_url_cloudinary) {
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
    }

    if (!transcriptData || (Array.isArray(transcriptData) && transcriptData.length === 0)) {
        return res.status(400).json({ success: false, message: 'No transcript or recording available for analysis' });
    }

    // Prepare transcript string for AI scoring
    const transcriptText = Array.isArray(transcriptData) 
      ? transcriptData.map(t => `[${t.speaker}]: ${t.text}`).join("\n")
      : transcriptData;

    console.log(`🧠 [CallController] Triggering precision AI scoring for call ${id}...`);
    const scores = await vertexAIService.scoreCall(transcriptText);

    // Update the call with the new scores and ensure transcript is saved in structured format
    call.ai_call_score = scores;
    if (Array.isArray(transcriptData)) {
      call.transcript = transcriptData;
    }
    await call.save();

    res.json({ 
        success: true, 
        message: 'Call analysis completed', 
        data: scores,
        transcript: call.transcript
    });
  } catch (error) {
    console.error('Error in analyzeCall:', error);
    res.status(500).json({ success: false, message: 'Failed to analyze call', error: error.message });
  }
};

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