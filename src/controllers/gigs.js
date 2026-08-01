const mongoose = require('mongoose');
const Gig = require('../models/Gig');

async function persistVoiceAssistant(gigId, voiceAssistant, gigTitle) {
  const gigIdStr = String(gigId);
  const _id = mongoose.Types.ObjectId.isValid(gigIdStr)
    ? new mongoose.Types.ObjectId(gigIdStr)
    : gigIdStr;

  // Mongo forbids the same path in both $set and $setOnInsert.
  const $set = {
    voiceAssistant,
    updatedAt: new Date(),
  };
  const $setOnInsert = {
    status: 'active',
    createdAt: new Date(),
  };
  if (gigTitle) {
    $set.title = gigTitle;
  } else {
    $setOnInsert.title = 'Gig';
  }

  await mongoose.connection.db.collection('gigs').updateOne(
    { _id },
    { $set, $setOnInsert },
    { upsert: true }
  );

  await mongoose.connection.db.collection('gig_voice_assistants').updateOne(
    { gigId: gigIdStr },
    {
      $set: {
        gigId: gigIdStr,
        ...voiceAssistant,
        updatedAt: new Date(),
      },
    },
    { upsert: true }
  );
}

// @desc    Get single gig
// @route   GET /api/gigs/:id
// @access  Private
exports.getGig = async (req, res) => {
    try {
        const gig = await Gig.findById(req.params.id);

        if (!gig) {
            return res.status(404).json({
                success: false,
                error: 'Gig not found'
            });
        }

        res.status(200).json({
            success: true,
            data: gig
        });
    } catch (err) {
        res.status(400).json({
            success: false,
            error: err.message
        });
    }
};

/**
 * PUT /api/gigs/:id/voice-assistant
 * Link / enable OpenAI Realtime voice assistant on a gig (company telephony).
 * Body: { enabled, name?, voice?, model?, systemPrompt?, greeting? }
 */
exports.updateGigVoiceAssistant = async (req, res) => {
    try {
        const gigId = req.params.id;
        const body = req.body || {};
        const gigIdStr = String(gigId);
        const orId = [{ _id: gigIdStr }];
        if (mongoose.Types.ObjectId.isValid(gigIdStr)) {
            orId.push({ _id: new mongoose.Types.ObjectId(gigIdStr) });
        }

        const existing =
            (await mongoose.connection.db.collection('gigs').findOne({ $or: orId })) ||
            (await mongoose.connection.db.collection('gig_voice_assistants').findOne({ gigId: gigIdStr }));

        const prev =
            (existing?.voiceAssistant && typeof existing.voiceAssistant === 'object'
                ? existing.voiceAssistant
                : null) ||
            (existing?.enabled !== undefined
                ? {
                    enabled: existing.enabled,
                    name: existing.name,
                    voice: existing.voice,
                    model: existing.model,
                    systemPrompt: existing.systemPrompt,
                    greeting: existing.greeting,
                  }
                : {});

        const voiceAssistant = {
            ...prev,
            enabled: body.enabled !== undefined ? Boolean(body.enabled) : Boolean(prev.enabled),
            name: body.name !== undefined ? body.name : (prev.name || 'HARX AI Voice'),
            voice: body.voice !== undefined ? body.voice : (prev.voice || process.env.OPENAI_VOICE || 'alloy'),
            model: body.model !== undefined ? body.model : (prev.model || process.env.OPENAI_REALTIME_MODEL || null),
            systemPrompt: body.systemPrompt !== undefined ? body.systemPrompt : (prev.systemPrompt || prev.prompt || ''),
            greeting: body.greeting !== undefined ? body.greeting : (prev.greeting || ''),
            updatedAt: new Date(),
        };

        await persistVoiceAssistant(gigIdStr, voiceAssistant, body.gigTitle);
        console.log('[VoiceAssistant] saved', { gigId: gigIdStr, enabled: voiceAssistant.enabled });

        return res.status(200).json({
            success: true,
            data: { voiceAssistant, gigId: gigIdStr },
        });
    } catch (err) {
        console.error('[VoiceAssistant] save failed', err?.message || err);
        return res.status(400).json({ success: false, error: err.message });
    }
};
