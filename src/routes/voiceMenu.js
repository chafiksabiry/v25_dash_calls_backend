const express = require('express');
const { authenticateUser } = require('../middleware/companyScope');
const controller = require('../controllers/voiceMenu');

const router = express.Router();

// Appelées depuis le front avec le JWT utilisateur.
router.post('/suggest', authenticateUser, controller.suggest);
router.post('/tts', authenticateUser, controller.tts);

// Appelée par l'orchestrateur (jeton de service). Le corps brut n'est parsé que sur CETTE route
// (le express.json() global reste limité à 100 ko).
router.post(
  '/analyze-voicemail',
  controller.authenticateService,
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '8mb' }),
  controller.analyzeVoicemail
);

module.exports = router;
