const express = require('express');
const { protect } = require('../middleware/auth');
const { getGig, updateGigVoiceAssistant } = require('../controllers/gigs');

const router = express.Router();

// Company telephony UI calls this without dash_calls JWT (same as /api/calls/ai-outbound).
router.put('/:id/voice-assistant', updateGigVoiceAssistant);
router.get('/:id/voice-assistant', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    const gigIdStr = String(req.params.id);
    const orId = [{ _id: gigIdStr }];
    if (mongoose.Types.ObjectId.isValid(gigIdStr)) {
      orId.push({ _id: new mongoose.Types.ObjectId(gigIdStr) });
    }
    const raw = await mongoose.connection.db.collection('gigs').findOne({ $or: orId });
    let voiceAssistant = raw?.voiceAssistant || null;
    if (!voiceAssistant) {
      const cfg = await mongoose.connection.db
        .collection('gig_voice_assistants')
        .findOne({ gigId: gigIdStr });
      if (cfg) {
        const { gigId: _g, _id, updatedAt, ...rest } = cfg;
        voiceAssistant = rest.enabled !== undefined ? rest : null;
      }
    }
    return res.status(200).json({
      success: true,
      data: { voiceAssistant, gigId: gigIdStr },
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

router.use(protect);

router.route('/:id')
    .get(getGig);

module.exports = router;
