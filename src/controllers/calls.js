const { Call } = require('../models/Call');
const { CallService } = require('../services/CallService');
const ovhService = require('../services/integrations/ovh');
const twilioService = require('../services/integrations/twilio');
const callService = new CallService();
const qalqulService = require('../services/integrations/qaqlulService');
const telnyxService = require('../services/integrations/telnyxService');
const vertexAIService = require('../services/vertexai.service');

// @desc    Get all calls
// @route   GET /api/calls
// @access  Private
exports.getCalls = async (req, res) => {
  try {
    const calls = await Call.find()
      .populate('agent')
      .populate('lead');

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
      .populate('lead')
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
      .populate('lead');

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
    const call = await Call.create(req.body);

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
    const call = await Call.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true
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

// @desc    End call
// @route   POST /api/calls/:id/end
// @access  Private
exports.endCall = async (req, res) => {
  try {
    const call = await Call.findByIdAndUpdate(
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
    const call = await Call.findByIdAndUpdate(
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
    const call = await Call.findByIdAndUpdate(
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
  const { To } = req.body;
  console.log("To", To);

  try {
    const responseXml = await twilioService.generateTwimlResponse(To);
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
  const { CallSid, callSid, agentId, leadId, call, cloudinaryrecord } = req.body;
  const actualCallSid = CallSid || callSid;

  if (!actualCallSid) {
    return res.status(400).json({ message: 'Call SID is required' });
  }

  try {
    const callDetails = await twilioService.saveCallToDB(actualCallSid, agentId, leadId, call, cloudinaryrecord);
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

exports.getLoginToken = async (req, res) => {
  try {
    const token = await telnyxService.generateLoginToken();
    res.json({ login_token: token });
  } catch (error) {
    console.error('Error in controller:', error);
    res.status(500).json({ error: 'Failed to get Telnyx login token' });
  }
};