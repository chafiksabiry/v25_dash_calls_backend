const express = require('express');
const { authenticateUser } = require('../middleware/companyScope');
const access = require('../middleware/callsAccess');
const { twilioWebhook, telnyxWebhook } = require('../middleware/webhookSignature');
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
const body = (k) => (req) => (req.body && req.body[k]) || (req.query && req.query[k]) || null;
// Contrôle d'entreprise avec un jeton quand la requête désigne un prospect, un gig, une entreprise ou un appel
// (membre de l'entreprise, ou rep inscrit au gig) : voir callsAccess.guardResourceCompany.
const leadScope = access.guardResourceCompany({ leadId: (req) => req.params.leadId || body('leadId')(req), gigId: body('gigId'), companyId: body('companyId') });
const callScope = access.guardResourceCompany({
  leadId: body('leadId'), gigId: body('gigId'), companyId: body('companyId'),
  callControlId: (req) => body('callControlId')(req) || body('externalId')(req) || body('callId')(req),
});
const companyScope = access.guardResourceCompany({ gigId: body('gigId'), companyId: body('companyId') });


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


// Jeton Twilio (softphone) : réservé à un utilisateur connecté. Groupe compat : l'application entreprise historique
// (comporchestrator_front) le demande encore sans jeton (voir README de la PR et CALLS_LEGACY_ANON).
router.post('/token', access.compatAuth, companyScope, callController.getTwilioToken);
router.get('/token', access.compatAuth, companyScope, callController.getTwilioToken);


router.post('/store-call', access.compatAuth, callScope, callController.saveCallToDB);
router.post('/center-call', access.userOrServiceAuth, access.guardCenterCallBody, callController.saveCenterCall);
// Enregistrement d'un appel (offres Full Scope / Multi-clients / TaaS) : l'orchestrateur rattache l'URL au document d'appel, par CallSid.
router.post('/recording', access.callRecordingServiceAuth, callController.attachCallRecording);
// Décision d'enregistrement (idempotente par CallSid/société, avant ou après la création de l'appel) et signalement d'échec d'attache.
router.post('/recording/intent', access.callRecordingServiceAuth, callController.recordCallRecordingIntent);
router.post('/recording/failed', access.callRecordingServiceAuth, callController.reportCallRecordingFailure);

// Resolve active gig phone line (provider + E.164) before Workspace dial.
// Must be registered before `/:id` so "line-for-lead" is not captured as an id.
router.get('/line-for-lead/:leadId', access.compatAuth, leadScope, callController.getLineForLead);
router.post('/telnyx/finalize', access.compatAuth, callScope, callController.finalizeTelnyxCall);
router.post('/telnyx/record-start', access.compatAuth, callScope, callController.startTelnyxRecording);

// Aucun appelant connu : jeton exigé.
router.route('/initiate')
  .post(access.strictAuth, initiateCall);

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
// Anciennes routes OVH sans appelant connu : jeton exigé (à supprimer, voir état des lieux C1).
router.post('/dialplan', access.strictAuth, callController.createDialplan);

// Route pour lancer un appel sortant
router.post('/call', access.strictAuth, callController.launchOutboundCall);
// Route pour suivre l'état de l'appel
//router.get('/call/status/:callId', callController.trackCallStatus);
//twilio
//twilio
// Webhook Twilio (TwiML App) : public, signature X-Twilio-Signature vérifiée (middleware/webhookSignature.js).
router.all('/twilio-voice', twilioWebhook, (req, res, next) => {
  console.log(`[Twilio Route] ${req.method} request to /twilio-voice`);
  console.log('Body:', req.body);
  console.log('Query:', req.query);
  next();
}, callController.handleVoice);
router.post('/outgoing', access.compatAuth, callController.initiateCall);
//router.get('/status/:callSid', callController.trackCallStatus);
// routes/callRoutes.js
router.get('/status/:callSid', access.compatAuth, callController.trackCallStatus);
router.post('/hangup/:callSid', access.compatAuth, callController.hangUpCall);
// Aucun appelant connu : jeton exigé.
router.post('/end', access.strictAuth, callController.endCall);
router.post('/fetch-recording', access.compatAuth, callController.fetchRecording);
router.post('/call-details', access.compatAuth, callController.getCallDetails);
router.post('/recording/start', access.compatAuth, callController.startRecording);
router.post('/recording/stop', access.compatAuth, callController.stopRecording);

// Twilio Async AMD (Answering Machine Detection) webhook — public, appelé par Twilio, signature vérifiée
router.post('/amd-callback', twilioWebhook, callController.amdCallback);

//@qalqul logic

router.post('/store-call-in-db-at-start-call', access.compatAuth, callController.storeCallsInDBatStartingCall);
router.post('/store-call-in-db-at-end-call', access.compatAuth, callController.storeCallsInDBatEndingCall);
// IA (Gemini / Vertex) aux frais de HARX : utilisateur connecté.
router.post('/ai-assist', access.compatAuth, callController.getAIAssistance);

// Route pour l'analyse de personnalité DISC
router.post('/personality-analysis', access.compatAuth, callController.getPersonalityAnalysis);

// Jeton WebRTC Telnyx : utilisateur connecté (l'espace rep l'appelle encore sans jeton : groupe compat).
router.post('/get-login-token', access.compatAuth, companyScope, callController.getLoginToken);
router.get('/get-login-token', access.compatAuth, callController.getLoginToken);

// Appel IA sortant : avec un jeton, le prospect doit appartenir à l'entreprise de l'appelant.
router.post('/ai-outbound', access.compatAuth, access.guardLeadCompany(), callController.startAiOutbound);
router.post('/ai-outbound/hangup', access.compatAuth, access.guardAiOutboundCall, callController.hangupAiOutbound);
// Webhooks opérateurs : publics, signature vérifiée (Telnyx Ed25519, Twilio X-Twilio-Signature).
router.post('/webhooks/telnyx/ai-outbound', telnyxWebhook, callController.handleTelnyxAiOutboundWebhook);
router.post('/webhooks/telnyx/call-control', telnyxWebhook, callController.handleTelnyxCallControlWebhook);
// Twilio AI outbound (form-urlencoded by default from Twilio — express.urlencoded already applied upstream)
router.post('/webhooks/twilio/ai-outbound/voice', twilioWebhook, callController.handleTwilioAiOutboundVoice);
router.post('/webhooks/twilio/ai-outbound/status', twilioWebhook, callController.handleTwilioAiOutboundStatus);
router.post('/webhooks/twilio/ai-outbound/recording', twilioWebhook, callController.handleTwilioAiOutboundRecording);

module.exports = router;