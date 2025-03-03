
const { CallService } = require('../services/CallService');
const ovhService= require('../services/integrations/ovh');
const twilioService= require('../services/integrations/twilio');
const callService = new CallService();

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
  const { to } = req.body;
  
  await twilioService.makeCall(to)
      .then(callSid => {
          res.status(200).json({ message: 'Call initiated', callSid });
      })
      .catch(err => {
          console.error('Error:', err);
          res.status(500).json({ message: 'Failed to initiate call', error: err });
      });
};
// Contrôleur pour suivre l'état de l'appel
exports.trackCallStatus = async (req, res) => {
  console.log('in controller');
  const callSid = req.params.callSid;
  console.log('callsid in controller',callSid);

  // Vérifier que le callSid est fourni
  if (!callSid) {
      return res.status(400).json({ message: 'Call SID requis' });
  }

  // Appel au service Twilio pour obtenir l'état de l'appel
  await twilioService.trackCallStatus(callSid)
      .then(callStatus => {
          res.status(200).json({ callSid, status: callStatus });
      })
      .catch(err => {
          console.error('Erreur lors du suivi de l\'appel:', err);
          res.status(500).json({ message: 'Impossible de suivre l\'état de l\'appel', error: err });
      });
};

exports.hangUpCall = async (req, res) => {
  const callSid = req.params.callSid;
  
  // Verify callSid is provided
  if (!callSid) {
      return res.status(400).json({ message: 'Call SID is required' });
  }

  try {
      const call = await twilioService.hangUpCall(callSid);
      res.status(200).json({ message: 'Call ended', callSid: call.sid, status: call.status });
  } catch (err) {
      console.error('Error hanging up call:', err);
      res.status(500).json({ message: 'Failed to hang up call', error: err });
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
  console.log("in the controller here");
  const {CallSid,agentId,leadId,call,cloudinaryrecord} = req.body;
console.log("CallSid",CallSid);
  if (!CallSid) {
    return res.status(400).send('CallSid is required');
  }

  try {
    // Fetch the call details from the service
    const callDetails = await twilioService.saveCallToDB(CallSid,agentId,leadId,call,cloudinaryrecord);
    res.json(callDetails);
  } catch (error) {
    console.error('Error in controller:', error);
    res.status(500).send('Error fetching call details');
  }
};


exports.fetchRecording = async (req, res) => {
  const { recordingUrl } = req.body;
console.log("recordingUrl",recordingUrl);
  try {
    const recording = await twilioService.fetchTwilioRecording(recordingUrl);

    if (!recording) {
      return res.status(500).json({ message: 'Error fetching the recording' });
    }

    res.set('Content-Type', 'audio/mpeg');
    res.send(recording);
  } catch (error) {
    console.error('Error in fetchRecording controller:', error);
    res.status(500).json({ message: 'Error fetching the recording' });
  }
};

exports.getCallDetails = async (req, res) => {
  const { callSid } = req.body;

  if (!callSid) {
      return res.status(400).json({ success: false, error: "Missing callSid parameter" });
  }

  try {
      const callDetails = await twilioService.getCallDetails(callSid);
      return res.status(200).json({ success: true, data: callDetails });
  } catch (error) {
      return res.status(500).json({ success: false, error: error.message });
  }
};