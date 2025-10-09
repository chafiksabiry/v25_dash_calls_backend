const { Call } = require('../models/Call');
const { CallService } = require('../services/CallService');
const ovhService = require('../services/integrations/ovh');
const twilioService = require('../services/integrations/twilio');
const callService = new CallService();
const qalqulService = require('../services/integrations/qaqlulService');
const telnyxService = require('../services/integrations/telnyxService');
const OpenAI = require('openai');
const { VertexAI } = require('@google-cloud/vertexai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Initialize Vertex AI
const vertex_ai = new VertexAI({
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: process.env.GOOGLE_CLOUD_LOCATION,
});

// Initialize the model
const model = 'gemini-1.5-flash-002';

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
// @param   {string} agentId - The ID of the agent to get calls for
exports.getCallsByAgent = async (req, res) => {
  try {
    const agentId = req.params.agentId; // Fixed incorrect destructuring

    if (!agentId) {
      return res.status(400).json({ 
        success: false,
        message: "Agent ID est requis" 
      });
    }

    const calls = await Call.find({ agent: agentId })
      .populate('agent')
      .populate('lead')
      .sort({ createdAt: -1 }); // Sort by most recent first

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
  console.log("To", To);

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




exports.endCall = async (req, res) => {
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

exports.getAIAssistance = async (req, res) => {
  try {
    const { transcription, context } = req.body;

    if (!transcription) {
      return res.status(400).json({
        success: false,
        message: 'Transcription is required'
      });
    }

    // Initialize the generative model
    const generativeModel = vertex_ai.preview.getGenerativeModel({
      model: model,
      generation_config: {
        max_output_tokens: 256,
        temperature: 0.7,
      },
    });

    // Enhanced prompt with automated message detection
    let prompt = `You are an AI assistant helping with a phone call.
    Your primary tasks:
    1. First, determine if this is an automated message/voicemail system by analyzing these patterns:
       - Standard voicemail greetings ("please leave a message", "we're not available")
       - Automated menu options ("press 1 for", "for X, press Y")
       - Out-of-office or business hours messages
       - Repetitive or pre-recorded message patterns
    2. If an automated system is detected:
       - Alert the agent immediately
       - Suggest appropriate actions (leave message, press specific numbers, wait for operator)
       - Recommend whether to continue or end the call
    3. If it's a real person:
       - Analyze customer sentiment
       - Suggest appropriate responses
       - Provide relevant product/service information
       - Help maintain professional communication

    Keep responses brief, clear, and actionable. Prioritize automated system detection first.

    Current conversation:
    ${context && Array.isArray(context) ? context.map(msg => `${msg.role}: ${msg.content}`).join('\n') : ''}
    Latest transcription: ${transcription}

    Please provide a brief, helpful response, starting with [AUTOMATED] if you detect an automated system or [HUMAN] if you detect a real person:`;

    console.log('Sending prompt to Vertex AI:', prompt);

    // Generate response
    const result = await generativeModel.generateContent(prompt);
    const response = await result.response;

    // Access the text content from the response parts
    const responseText = response.candidates[0].content.parts[0].text;

    console.log('Received response from Vertex AI:', responseText);

    res.json({
      success: true,
      suggestion: responseText
    });
  } catch (error) {
    console.error('Error getting AI assistance:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get AI assistance',
      error: error.message
    });
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

// @desc    Analyze personality during call and provide caller assistance
// @route   POST /api/calls/personality-analysis
// @access  Private
// @desc    Initiate a call using Telnyx
// @route   POST /api/calls/telnyx/initiate
// @access  Private
exports.initiateTelnyxCall = async (req, res) => {
  try {
    const { to, from, agentId } = req.body;

    if (!to || !from || !agentId) {
      return res.status(400).json({
        success: false,
        error: 'Please provide to, from, and agentId'
      });
    }

    const call = await telnyxService.makeCall(to, from, agentId);

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

// @desc    Handle Telnyx call webhook
// @route   POST /api/calls/telnyx/webhook
// @access  Public
exports.telnyxWebhook = async (req, res) => {
  try {
    // Parse the raw body to get the event data
    const rawBody = req.body;
    const event = JSON.parse(rawBody.toString());
    
    // Send a 200 response quickly to acknowledge the webhook
    res.status(200).json({ received: true });

    const eventType = event.data.event_type;
    console.log(`📞 Processing Telnyx event: ${eventType}`);

    // Process call and streaming events
    if (['call.initiated', 'call.answered', 'call.hangup', 'streaming.started', 'streaming.failed', 'streaming.stopped'].includes(eventType)) {
      // Import the broadcast function from test WebSocket
      const { broadcastCallEvent } = require('../websocket/testWebSocket');
      
      // Broadcast the event to all connected WebSocket clients
      broadcastCallEvent(event);

      // Log the event details
      console.log('Call Control ID:', event.data.payload.call_control_id);
      console.log('Event Timestamp:', event.data.occurred_at);
      
      // Update call status in database
      const callId = event.data.payload.call_control_id;
      const call = await Call.findOne({ call_id: callId });
      
      if (call) {
        switch(eventType) {
          case 'call.initiated':
            console.log('Call initiated to:', event.data.payload.to);
            call.status = 'initiated';
            break;
          case 'call.answered':
            console.log('Call answered at:', event.data.occurred_at);
            call.status = 'in-progress';
            call.startTime = new Date(event.data.occurred_at);
            break;
          case 'call.hangup':
            console.log('Call ended. Duration:', event.data.payload.duration_seconds, 'seconds');
            call.status = 'completed';
            call.endTime = new Date(event.data.occurred_at);
            call.duration = event.data.payload.duration_seconds || 
              Math.round((call.endTime - call.startTime) / 1000);
            break;
        }
        await call.save();
      }
    }

  } catch (err) {
    console.error('❌ Webhook processing error:', err);
    // Even if there's an error processing the event, we should acknowledge receipt
    res.status(200).json({ received: true });
  }
};

// @desc    End a Telnyx call
// @route   POST /api/calls/telnyx/:callId/end
// @access  Private
// @desc    Mute a Telnyx call
// @route   POST /api/calls/telnyx/:callId/mute
// @access  Private
exports.muteTelnyxCall = async (req, res) => {
  try {
    const { callId } = req.params;

    if (!callId) {
      return res.status(400).json({
        success: false,
        error: 'Please provide callId'
      });
    }

    const result = await telnyxService.muteCall(callId);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Unmute a Telnyx call
// @route   POST /api/calls/telnyx/:callId/unmute
// @access  Private
exports.unmuteTelnyxCall = async (req, res) => {
  try {
    const { callId } = req.params;

    if (!callId) {
      return res.status(400).json({
        success: false,
        error: 'Please provide callId'
      });
    }

    const result = await telnyxService.unmuteCall(callId);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};


exports.endTelnyxCall = async (req, res) => {
  try {
    const { callId } = req.params;

    if (!callId) {
      return res.status(400).json({
        success: false,
        error: 'Please provide callId'
      });
    }

    const result = await telnyxService.endCall(callId);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

exports.getPersonalityAnalysis = async (req, res) => {
  try {
    const { transcription, context, callDuration } = req.body;
    console.log("transcription from personality analysis:", transcription);

    if (!transcription) {
      return res.status(400).json({
        success: false,
        message: 'Transcription is required'
      });
    }

    // Initialize the generative model
    const generativeModel = vertex_ai.preview.getGenerativeModel({
      model: model,
      generation_config: {
        max_output_tokens: 1024,
        temperature: 0.3,
      },
    });

    // Optimized DISC personality analysis prompt for early detection
    const isEarlyAnalysis = transcription.length < 100;
    const prompt = `You are an expert DISC personality analyst helping sales agents during phone calls.

    ${isEarlyAnalysis ? 'IMPORTANT: This is an early analysis with limited text. Focus on immediate personality indicators and provide a preliminary assessment with appropriate confidence levels.' : ''}

    Analyze the customer's communication patterns and provide DISC personality insights with specific recommendations.

    DISC Framework:
    - D (Dominant): Direct, results-focused, decisive, competitive, impatient, authoritative
    - I (Influential): Enthusiastic, people-oriented, optimistic, persuasive, talkative, emotional
    - S (Steady): Patient, reliable, cooperative, calm, supportive, methodical
    - C (Conscientious): Analytical, precise, systematic, careful, detail-oriented, logical

    Key Early Indicators:
    - D: "I need", "Let's get to the point", "What's the bottom line", direct questions
    - I: "That's great!", "I love", "We should", enthusiastic language, personal stories
    - S: "Let me think", "I'm not sure", "Maybe", cautious language, questions for clarification
    - C: "Can you explain", "What are the details", "How does it work", analytical questions

    Analyze the following conversation and provide:
    1. Primary DISC type (D, I, S, or C) with confidence level (0-100)
    2. Secondary DISC type if applicable
    3. Key personality indicators found in the speech
    4. Specific communication recommendations for the agent
    5. Suggested approach strategies
    6. Potential objections and how to handle them
    7. Best closing techniques for this personality type

    Current conversation context:
    ${context && Array.isArray(context) ? context.map(msg => `${msg.role}: ${msg.content}`).join('\n') : ''}
    
    Latest transcription: ${transcription}
    Call duration: ${callDuration || 'Unknown'} minutes
    ${isEarlyAnalysis ? 'Text length: Short (early analysis)' : 'Text length: Sufficient for detailed analysis'}

    Respond in JSON format:
    {
      "primaryType": "D|I|S|C",
      "secondaryType": "D|I|S|C|null",
      "confidence": ${isEarlyAnalysis ? '60-80' : '70-95'},
      "personalityIndicators": ["direct language", "quick decisions", "results-focused"],
      "recommendations": ["Be direct and to the point", "Focus on results and outcomes"],
      "approachStrategy": "Get straight to business, avoid small talk",
      "potentialObjections": ["Price concerns", "Time constraints"],
      "objectionHandling": ["Emphasize ROI", "Respect their time"],
      "closingTechniques": ["Direct ask", "Limited time offer"],
      "communicationStyle": "Direct and professional",
      "emotionalTriggers": ["Success", "Achievement", "Recognition"],
      "riskFactors": ["May seem pushy", "Could rush decisions"],
      "successIndicators": ["Asks specific questions", "Shows interest in results"]
    }`;

    console.log('Sending personality analysis prompt to Vertex AI');

    // Generate response
    const result = await generativeModel.generateContent(prompt);
    const response = await result.response;
    const responseText = response.candidates[0].content.parts[0].text;

    console.log('Received personality analysis from Vertex AI:', responseText);

    // Try to parse JSON response
    let personalityData;
    try {
      personalityData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Error parsing JSON response:', parseError);
      // Fallback: create a basic structure from text response
      personalityData = {
        primaryType: 'S',
        confidence: 70,
        recommendations: ['Continue building rapport', 'Listen actively'],
        approachStrategy: 'Patient and supportive approach',
        communicationStyle: 'Professional and empathetic'
      };
    }

    // Validate and enhance the response
    const validatedData = {
      primaryType: personalityData.primaryType || 'S',
      secondaryType: personalityData.secondaryType || null,
      confidence: Math.min(100, Math.max(0, personalityData.confidence || 70)),
      personalityIndicators: personalityData.personalityIndicators || [],
      recommendations: personalityData.recommendations || [],
      approachStrategy: personalityData.approachStrategy || 'Adaptive approach',
      potentialObjections: personalityData.potentialObjections || [],
      objectionHandling: personalityData.objectionHandling || [],
      closingTechniques: personalityData.closingTechniques || [],
      communicationStyle: personalityData.communicationStyle || 'Professional',
      emotionalTriggers: personalityData.emotionalTriggers || [],
      riskFactors: personalityData.riskFactors || [],
      successIndicators: personalityData.successIndicators || [],
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      personalityProfile: validatedData,
      message: `Personality analysis completed. Primary type: ${validatedData.primaryType} (${validatedData.confidence}% confidence)`
    });

  } catch (error) {
    console.error('Error getting personality analysis:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get personality analysis',
      error: error.message
    });
  }
};