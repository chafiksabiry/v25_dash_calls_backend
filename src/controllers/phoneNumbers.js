const { PhoneNumber } = require('../models/PhoneNumber');
const mongoose = require('mongoose');

// @desc    Check if a gig has a phone number configured
// @route   GET /api/phone-numbers/gig/:gigId/check
// @access  Public (for now)
exports.checkGigPhoneNumber = async (req, res) => {
  try {
    const { gigId } = req.params;
    
    console.log('🔍 Checking phone number for gig:', gigId);
    
    // Convertir gigId en ObjectId si c'est une string valide, sinon utiliser tel quel
    let gigIdQuery = gigId;
    if (mongoose.Types.ObjectId.isValid(gigId)) {
      gigIdQuery = new mongoose.Types.ObjectId(gigId);
    }
    
    // Rechercher un numéro de téléphone pour ce gigId avec status 'success'
    // Essayer d'abord avec ObjectId, puis avec string si nécessaire
    let phoneNumberDoc = await PhoneNumber.findOne({
      gigId: gigIdQuery,
      status: 'success'
    }).lean();
    
    // Si pas trouvé avec ObjectId, essayer avec string
    if (!phoneNumberDoc) {
      phoneNumberDoc = await PhoneNumber.findOne({
        gigId: gigId,
        status: 'success'
      }).lean();
    }
    
    if (phoneNumberDoc) {
      console.log('✅ Phone number found for gig:', gigId, phoneNumberDoc.phoneNumber);
      return res.status(200).json({
        hasNumber: true,
        number: {
          phoneNumber: phoneNumberDoc.phoneNumber,
          provider: phoneNumberDoc.provider,
          status: phoneNumberDoc.status,
          features: phoneNumberDoc.features || {}
        },
        message: 'Phone number found'
      });
    }
    
    console.log('❌ No phone number found for gig:', gigId);
    res.status(200).json({
      hasNumber: false,
      message: 'No phone number configured for this gig'
    });
  } catch (error) {
    console.error('❌ Error checking gig phone number:', error);
    res.status(500).json({
      hasNumber: false,
      message: 'Error checking phone number configuration',
      error: error.message
    });
  }
};

// @desc    Configure voice feature for a phone number
// @route   POST /api/phone-numbers/:phoneNumber/configure-voice
// @access  Public (for now)
exports.configureVoiceFeature = async (req, res) => {
  try {
    const { phoneNumber } = req.params;
    
    console.log('📞 Configuring voice feature for:', phoneNumber);
    
    // TODO: Implement actual voice configuration logic
    
    res.status(200).json({
      success: true,
      message: 'Voice feature configuration not yet implemented',
      data: {
        phoneNumber,
        features: {
          voice: true
        },
        status: 'configured'
      }
    });
  } catch (error) {
    console.error('❌ Error configuring voice feature:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      message: 'Error configuring voice feature'
    });
  }
};

