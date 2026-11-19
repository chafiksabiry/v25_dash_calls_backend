const express = require('express');
const router = express.Router();
const vertexController = require('../controllers/vertexController');
const access = require('../middleware/callsAccess');

// Vertex AI / Speech-to-Text aux frais de HARX : jeton exigé (aucun appelant connu sans jeton), sauf evaluate-language,
// encore appelée sans jeton par le copilote de l'espace rep (groupe compat, voir CALLS_LEGACY_ANON).

// Summary routes
router.post('/audio/summarize', access.strictAuth, vertexController.summarizeAudio);
router.post('/summarize', access.strictAuth, vertexController.summarizeAudio); // Legacy path

// Transcription routes
router.post('/audio/transcribe', access.strictAuth, vertexController.getCallTranscription);
router.post('/transcribe-short', access.strictAuth, vertexController.transcribeShortAudio);
router.post('/transcribe-long', access.strictAuth, vertexController.transcribeLongAudio);

// Scoring and Actions
router.post('/call/score', access.strictAuth, vertexController.getCallScoring);
router.post('/call/post-actions', access.strictAuth, vertexController.getCallPostActions);

// Evaluation routes
router.post('/evaluate-language', access.compatAuth, vertexController.evaluateRepLanguage);

// Upload routes
router.post('/upload', access.strictAuth, vertexController.audioUpload);
router.post('/upload-buffer', access.strictAuth, vertexController.uploadAudioHandler);

module.exports = router;
