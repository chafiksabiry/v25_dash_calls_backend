const express = require('express');
const phoneNumberController = require('../controllers/phoneNumbers');

const router = express.Router();

// Check if a gig has a phone number configured
router.get('/gig/:gigId/check', phoneNumberController.checkGigPhoneNumber);

// Configure voice feature for a phone number
router.post('/:phoneNumber/configure-voice', phoneNumberController.configureVoiceFeature);

module.exports = router;

