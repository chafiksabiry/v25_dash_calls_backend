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
