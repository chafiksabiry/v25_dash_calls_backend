const express = require('express');
const router = express.Router();
const vertexController = require('../controllers/vertexController');

// Summary routes
router.post('/audio/summarize', vertexController.summarizeAudio);
router.post('/summarize', vertexController.summarizeAudio); // Legacy path

// Transcription routes
router.post('/audio/transcribe', vertexController.getCallTranscription);
router.post('/transcribe-short', vertexController.transcribeShortAudio);
router.post('/transcribe-long', vertexController.transcribeLongAudio);

// Scoring and Actions
router.post('/call/score', vertexController.getCallScoring);
router.post('/call/post-actions', vertexController.getCallPostActions);

// Evaluation routes
router.post('/evaluate-language', vertexController.evaluateRepLanguage);

// Upload routes
router.post('/upload', vertexController.audioUpload);
router.post('/upload-buffer', vertexController.uploadAudioHandler);

module.exports = router;
