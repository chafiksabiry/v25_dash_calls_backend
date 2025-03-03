
const express = require('express');
const { protect } = require('../middleware/auth');
const callController =require('../controllers/calls');
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
console.log("router",router);
//router.use(protect);




/* router.route('/')
 .get(getCalls)
  .post(createCall); */

//router.get('/fetch-recording/:recordingUrl', callController.fetchRecording);
 

  router.get('/token', (req, res, next) => {
    console.log('Requête reçue sur la route');
    next();
  }, callController.getTwilioToken);

  router.post('/store-call', callController.saveCallToDB);


/* router.route('/initiate')
  .post(initiateCall);

router.route('/:id')
  .get(getCall)
  .put(updateCall);

router.route('/:id/end')
  .post(endCall);

router.route('/:id/notes')
  .post(addNote);

router.route('/:id/quality-score')
  .put(updateQualityScore); */

// Route pour créer un Dialplan
router.post('/dialplan', callController.createDialplan);

// Route pour lancer un appel sortant
router.post('/call', callController.launchOutboundCall);

// Route pour suivre l'état de l'appel
//router.get('/call/status/:callId', callController.trackCallStatus);

//twilio
router.post('/twilio-voice', callController.handleVoice);
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

//router.get('/call-details', callController.getCallDetails);
/* router.post('/fetch-recording/:recordingUrl', (req, res, next) => {
  console.log('Requête reçue sur la route');
  next();
}, callController.fetchRecording);  */


router.post('/fetch-recording', callController.fetchRecording);
router.post('/call-details', callController.getCallDetails);

module.exports = router;