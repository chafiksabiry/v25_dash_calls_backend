const { CallService } = require('../services/CallService');
const ovhService= require('../services/integrations/ovh');
const twilioService= require('../services/integrations/twilio');
const callService = new CallService();
const qalqulService = require('../services/integrations/qaqlulService');
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

// @desc    Initiate new call using OVH
// @route   POST /api/calls/initiate
// @access  Private
/* exports.initiateCall = async (req, res) => {
  console.log("we are in the controller now");
  try {
    const { agentId, phoneNumber } = req.body;
console.log("agentId",agentId);
console.log("phoneNumber", phoneNumber);
    if (!agentId || !phoneNumber) {
      return res.status(400).json({
        success: false,
        error: 'Please provide agent ID and phone number'
      });
    }

    const call = await callService.initiateCall(agentId, phoneNumber);
    //console.log("call after service",call);

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
}; */


// Création du Dialplan
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

// Suivi de l'état de l'appel
/* exports.trackCallStatus = async (req, res) => {
  const { callId } = req.params;

  if (!callId) {
      return res.status(400).json({ error: 'callId est requis' });
  }

  try {
      const status = await ovhService.trackCallStatus(callId);
      res.status(200).json({ message: 'État de l\'appel récupéré', status });
  } catch (error) {
      console.error('Erreur dans trackCallStatus Controller:', error);
      res.status(500).json({ error: 'Erreur lors du suivi de l\'appel' });
  }
}; */

// Controller for handling voice call

/* exports.handleVoice = (req, res) => {
  const recipientPhoneNumber = req.body.to;

  // Vérification du numéro de téléphone
  if (!recipientPhoneNumber) {
      return res.status(400).json({ message: 'Numéro de téléphone requis' });
  }

  const response = twilioService.generateVoiceResponse(recipientPhoneNumber);
  res.type('text/xml');
  res.send(response);
}; */
/* exports.handleVoice = (req, res) => {
  console.log('Request received:', req.body);  // Log request body
  console.log('Query params:', req.query); // Log query parameters

  // Twilio sends 'To' as part of the query string or form data
  const recipientPhoneNumber = req.body.to || req.query.To;

  if (!recipientPhoneNumber) {
      return res.status(400).json({ message: 'Numéro de téléphone requis' });
  }

  const response = twilioService.generateVoiceResponse(recipientPhoneNumber);
  res.type('text/xml');
  res.send(response);
}; */
exports.handleVoice = async (req, res) => {
  /* console.log('Request received:', req.body);  // Log request body
  console.log('Form Params - To:', req.body.To); // Log the 'To' parameter

  // Get the recipient phone number from the form params
  const recipientPhoneNumber = req.body.To || req.body.to;

  if (!recipientPhoneNumber) {
      return res.status(400).json({ message: 'Numéro de téléphone requis' });
  }

  const response = await twilioService.generateVoiceResponse(recipientPhoneNumber);
  console.log("generate voice response",response);
  res.type('text/xml');
  res.send(response); */
  const { To } = req.body;
  console.log("To",To);

  try {
    const responseXml = await twilioService.generateTwimlResponse(To);
    res.type("text/xml");
    res.send(responseXml);
  } catch (error) {
    console.error("Error generating TwiML:", error);
    res.status(500).json({ error: "Erreur interne du serveur" });
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
// Contrôleur pour suivre l'état de l'appel
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

exports.getTwilioToken1 = async (req, res) => {
  const { userId } = req.body;

  if (!userId) {
    return res.status(400).json({ message: 'User ID is required' });
  }

  try {
    console.log("userId:", userId);
    const token = await twilioService.generateTwilioToken('platform-user', userId);
    console.log("token:", token);
    res.json({ token });
  } catch (error) {
    console.error('Error generating token:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
};

exports.getTwilioToken = async (req, res) => {
  console.log("start generating token");
  try {
    // Generate Twilio token using the service layer
    const token = await twilioService.generateTwilioToken('platform-user');
    
    // Send the token back to the client
    res.json({ token });
  } catch (error) {
    console.error('Error generating token:', error);
    res.status(500).json({ error: 'Failed to generate token' });
  }
};




exports.endCall= async (req, res) => {
  const callSid = req.body.CallSid;
  const callStatus = req.body.CallStatus;

  console.log(`Appel ${callSid} terminé avec le statut: ${callStatus}`);

  // Retourne une réponse vide pour indiquer que l'action est bien reçue
  res.send('');
};

exports.saveCallToDB = async (req, res) => {
  const { CallSid, agentId, leadId, call, cloudinaryrecord, userId } = req.body;

  if (!CallSid || !userId) {
    return res.status(400).json({ message: 'Call SID and User ID are required' });
  }

  try {
    const callDetails = await twilioService.saveCallToDB(CallSid, agentId, leadId, call, cloudinaryrecord);
    res.json(callDetails);
  } catch (error) {
    console.error('Error saving call:', error);
    res.status(500).json({ message: 'Failed to save call details', error: error.message });
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


//@qalqul logic

exports.storeCallsInDBatStartingCall = async (req, res) => {
  const { storeCall } = req.body;
  console.log("storeCall from qalqul:", storeCall);
  try {
    const callDetails = await qalqulService.storeCallsInDBatStartingCall(storeCall);
    
    // Return a properly formatted response
    res.status(200).json({
      success: true,
      data: callDetails
    });
  } catch (error) {
    console.error('Error storing call:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to store call details', 
      error: error.message 
    });
  }
};

exports.storeCallsInDBatEndingCall = async (req, res) => {
  const { phoneNumber, callSid } = req.body;
  console.log("callSid from qalqul:", callSid);
  try {
    const callDetails = await qalqulService.storeCallsInDBatEndingCall(phoneNumber, callSid);
    res.status(200).json({
      success: true,
      data: callDetails
    });
  } catch (error) {
    console.error('Error storing call:', error);
    res.status(500).json({ 
      success: false,
      message: 'Failed to store call details', 
      error: error.message 
    });
  }
};