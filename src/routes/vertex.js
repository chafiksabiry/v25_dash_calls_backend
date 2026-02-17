const express = require('express');
const router = express.Router();
const vertexController = require('../controllers/vertexController');

// Summary routes
router.post('/summarize', vertexController.summarizeAudio);

// Evaluation routes
router.post('/evaluate-language', vertexController.evaluateRepLanguage);

// STT routes
router.post('/transcribe-short', vertexController.transcribeShortAudio);
router.post('/transcribe-long', vertexController.transcribeLongAudio);

// Upload routes
router.post('/upload', vertexController.audioUpload);
router.post('/upload-buffer', vertexController.uploadAudioHandler);

module.exports = router;
