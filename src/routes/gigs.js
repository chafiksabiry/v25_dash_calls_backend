const express = require('express');
const { protect } = require('../middleware/auth');
const { getGig, updateGigVoiceAssistant } = require('../controllers/gigs');
const access = require('../middleware/callsAccess');

const router = express.Router();

// Assistant vocal d'un gig : avec un jeton, l'appelant doit appartenir à l'entreprise du gig. Groupe compat : l'application
// entreprise historique (comporchestrator_front) appelle encore sans jeton (voir CALLS_LEGACY_ANON).
router.put('/:id/voice-assistant', access.compatAuth, access.guardGigCompany('id'), updateGigVoiceAssistant);
router.get('/:id/voice-assistant', access.compatAuth, access.guardGigCompany('id'), async (req, res) => {
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
