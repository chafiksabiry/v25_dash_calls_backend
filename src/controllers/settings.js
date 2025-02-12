const { SettingsService } = require('../services/SettingsService');

const settingsService = new SettingsService();

// @desc    Get settings
// @route   GET /api/settings
// @access  Private
exports.getSettings = async (req, res) => {
  try {
    const settings = await settingsService.getSettings();
    
    res.status(200).json({
      success: true,
      data: settings
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Update settings
// @route   PUT /api/settings
// @access  Private
exports.updateSettings = async (req, res) => {
  try {
    const settings = await settingsService.updateSettings(req.body);

    res.status(200).json({
      success: true,
      data: settings
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Update company logo
// @route   PUT /api/settings/logo
// @access  Private
exports.updateLogo = async (req, res) => {
  try {
    const { logo } = req.body;
    const settings = await settingsService.updateLogo(logo);

    res.status(200).json({
      success: true,
      data: settings
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};