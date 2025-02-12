const { Integration } = require('../models/Integration');

// @desc    Get all integrations
// @route   GET /api/integrations
// @access  Private
exports.getIntegrations = async (req, res) => {
  try {
    const integrations = await Integration.find();
    
    res.status(200).json({
      success: true,
      data: integrations
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Get single integration
// @route   GET /api/integrations/:id
// @access  Private
exports.getIntegration = async (req, res) => {
  try {
    const integration = await Integration.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({
        success: false,
        error: 'Integration not found'
      });
    }

    res.status(200).json({
      success: true,
      data: integration
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Connect integration
// @route   POST /api/integrations/:id/connect
// @access  Private
exports.connectIntegration = async (req, res) => {
  try {
    const integration = await Integration.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({
        success: false,
        error: 'Integration not found'
      });
    }

    integration.status = 'connected';
    await integration.save();

    res.status(200).json({
      success: true,
      data: integration
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Disconnect integration
// @route   POST /api/integrations/:id/disconnect
// @access  Private
exports.disconnectIntegration = async (req, res) => {
  try {
    const integration = await Integration.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({
        success: false,
        error: 'Integration not found'
      });
    }

    integration.status = 'pending';
    await integration.save();

    res.status(200).json({
      success: true,
      data: {}
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Configure integration
// @route   POST /api/integrations/:id/configure
// @access  Private
exports.configureIntegration = async (req, res) => {
  try {
    const integration = await Integration.findById(req.params.id);

    if (!integration) {
      return res.status(404).json({
        success: false,
        error: 'Integration not found'
      });
    }

    integration.config = req.body;
    await integration.save();

    res.status(200).json({
      success: true,
      data: integration
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};