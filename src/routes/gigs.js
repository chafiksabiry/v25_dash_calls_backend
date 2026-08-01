const express = require('express');
const { protect } = require('../middleware/auth');
const { getGig, updateGigVoiceAssistant } = require('../controllers/gigs');

const router = express.Router();

// Company telephony UI calls this without dash_calls JWT (same as /api/calls/ai-outbound).
router.put('/:id/voice-assistant', updateGigVoiceAssistant);
router.get('/:id/voice-assistant', async (req, res) => {
  try {
    const Gig = require('../models/Gig');
    const gig = await Gig.findById(req.params.id).lean();
    if (!gig) return res.status(404).json({ success: false, error: 'Gig not found' });
    return res.status(200).json({ success: true, data: { voiceAssistant: gig.voiceAssistant || null } });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

router.use(protect);

router.route('/:id')
    .get(getGig);

module.exports = router;
