const Gig = require('../models/Gig');

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
        let gig = await Gig.findById(gigId);
        // dash_calls may not hold the canonical gig doc — upsert a stub for voice config.
        if (!gig) {
            gig = new Gig({
                _id: gigId,
                title: req.body?.gigTitle || 'Gig',
                status: 'active',
            });
        }

        const body = req.body || {};
        const prev = (gig.voiceAssistant && typeof gig.voiceAssistant === 'object')
            ? gig.voiceAssistant
            : {};

        gig.voiceAssistant = {
            ...prev,
            enabled: body.enabled !== undefined ? Boolean(body.enabled) : Boolean(prev.enabled),
            name: body.name !== undefined ? body.name : (prev.name || 'HARX AI Voice'),
            voice: body.voice !== undefined ? body.voice : (prev.voice || process.env.OPENAI_VOICE || 'alloy'),
            model: body.model !== undefined ? body.model : (prev.model || process.env.OPENAI_REALTIME_MODEL || null),
            systemPrompt: body.systemPrompt !== undefined ? body.systemPrompt : (prev.systemPrompt || prev.prompt || ''),
            greeting: body.greeting !== undefined ? body.greeting : (prev.greeting || ''),
            updatedAt: new Date(),
        };

        await gig.save();

        return res.status(200).json({
            success: true,
            data: { voiceAssistant: gig.voiceAssistant },
        });
    } catch (err) {
        return res.status(400).json({ success: false, error: err.message });
    }
};
