const express = require('express');
const { protect } = require('../middleware/auth');
const { authenticateUser } = require('../middleware/companyScope');
const access = require('../middleware/callsAccess');
const callController = require('../controllers/calls');
const {
  getCalls,
  getCall,
  createCall,
  updateCall,
  endCall,
  addNote,
  updateQualityScore,
  initiateCall
} = require('../controllers/calls');

const router = express.Router();
//console.log("router",router);
//router.use(protect);


//@twilio logic

// Contrôle d'accès : voir middleware/callsAccess.js (strict = jeton exigé ; compat = jeton contrôlé, anonyme toléré avec périmètre).
router.route('/')
  .get(access.compatAuth, access.guardCallsList, getCalls)
  .post(access.compatAuth, access.guardCreateCall, createCall);

router.get('/company/:companyId/fraud-stats', access.compatAuth, access.guardCompanyParam(), callController.getCompanyFraudStats);
router.get('/company/:companyId/fraud-calls', authenticateUser, callController.getCompanyFraudCalls);
router.get('/agent/:agentId/fraud-stats', access.compatAuth, access.guardAgentParam(), callController.getAgentFraudStats);
router.patch('/:id/fraud-review', authenticateUser, callController.overturnCallFraud);
router.get('/agent/:agentId', access.compatAuth, access.guardAgentParam({ restrictToCompany: true }), callController.getCallsByAgent);


router.post('/token', (req, res, next) => {
  console.log('Requête reçue sur la route');
  next();
}, callController.getTwilioToken);


router.get('/token', (req, res, next) => {
  console.log('Requête reçue sur la route');
  next();
}, callController.getTwilioToken);


router.post('/store-call', callController.saveCallToDB);
router.post('/center-call', access.userOrServiceAuth, access.guardCenterCallBody, callController.saveCenterCall);

// Resolve active gig phone line (provider + E.164) before Workspace dial.
// Must be registered before `/:id` so "line-for-lead" is not captured as an id.
router.get('/line-for-lead/:leadId', callController.getLineForLead);
router.post('/telnyx/finalize', callController.finalizeTelnyxCall);
router.post('/telnyx/record-start', callController.startTelnyxRecording);

router.route('/initiate')
  .post(initiateCall);

router.route('/:id')
  .get(access.compatAuth, access.guardCallId(), getCall)
  .put(access.compatAuth, access.guardCallId(), updateCall);

router.route('/:id/end')
  .post(access.compatAuth, access.guardCallId(), endCall);

router.route('/:id/notes')
  .post(access.compatAuth, access.guardCallId(), addNote);

router.route('/:id/quality-score')
  .put(access.compatAuth, access.guardCallId(), updateQualityScore);

// Analyse IA et calibrage : tous les appelants connus envoient le jeton -> groupe strict.
router.post('/:id/analyze', access.strictAuth, access.guardCallId(), callController.analyzeCall);
router.post('/:id/request-analysis-help', access.strictAuth, access.guardCallId(), callController.requestAnalysisHelp);
router.post('/:id/calibrate-score', access.strictAuth, access.guardCallId(), callController.calibrateCallScore);

// Route pour créer un Dialplan
router.post('/dialplan', callController.createDialplan);

// Route pour lancer un appel sortant
router.post('/call', callController.launchOutboundCall);
// Route pour suivre l'état de l'appel
//router.get('/call/status/:callId', callController.trackCallStatus);
//twilio
//twilio
router.all('/twilio-voice', (req, res, next) => {
  console.log(`[Twilio Route] ${req.method} request to /twilio-voice`);
  console.log('Body:', req.body);
  console.log('Query:', req.query);
  next();
}, callController.handleVoice);
router.post('/outgoing', callController.initiateCall);
//router.get('/status/:callSid', callController.trackCallStatus);
// routes/callRoutes.js
router.get('/status/:callSid', (req, res, next) => {
  console.log('Requête reçue sur la route');
  next();
}, callController.trackCallStatus);
router.post('/hangup/:callSid', callController.hangUpCall);
//router.get('/token', callController.getTwilioToken);
router.post('/end', callController.endCall);
router.post('/fetch-recording', callController.fetchRecording);
router.post('/call-details', callController.getCallDetails);
router.post('/recording/start', callController.startRecording);
router.post('/recording/stop', callController.stopRecording);

// Twilio Async AMD (Answering Machine Detection) webhook — no auth, called by Twilio directly
router.post('/amd-callback', callController.amdCallback);

//@qalqul logic

router.post('/store-call-in-db-at-start-call', callController.storeCallsInDBatStartingCall);
router.post('/store-call-in-db-at-end-call', callController.storeCallsInDBatEndingCall);
router.post('/ai-assist', callController.getAIAssistance);

// Route pour l'analyse de personnalité DISC
router.post('/personality-analysis', callController.getPersonalityAnalysis);

router.post('/get-login-token', callController.getLoginToken);
router.get('/get-login-token', callController.getLoginToken);

router.post('/ai-outbound', callController.startAiOutbound);
router.post('/ai-outbound/hangup', callController.hangupAiOutbound);
router.post('/webhooks/telnyx/ai-outbound', express.json(), callController.handleTelnyxAiOutboundWebhook);
router.post('/webhooks/telnyx/call-control', express.json(), callController.handleTelnyxCallControlWebhook);
// Twilio AI outbound (form-urlencoded by default from Twilio — express.urlencoded already applied upstream)
router.post('/webhooks/twilio/ai-outbound/voice', callController.handleTwilioAiOutboundVoice);
router.post('/webhooks/twilio/ai-outbound/status', callController.handleTwilioAiOutboundStatus);
router.post('/webhooks/twilio/ai-outbound/recording', callController.handleTwilioAiOutboundRecording);

module.exports = router;