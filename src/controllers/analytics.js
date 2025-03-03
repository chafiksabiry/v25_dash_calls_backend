const { AnalyticsService } = require('../services/AnalyticsService');

const analyticsService = new AnalyticsService();

// @desc    Get overview analytics
// @route   GET /api/analytics/overview
// @access  Private
exports.getOverview = async (req, res) => {
  try {
    const data = await analyticsService.getOverview();

    res.status(200).json({
      success: true,
      data
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Get call metrics
// @route   GET /api/analytics/calls
// @access  Private
exports.getCallMetrics = async (req, res) => {
  try {
    const data = await analyticsService.getCallMetrics();

    res.status(200).json({
      success: true,
      data
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Get agent metrics
// @route   GET /api/analytics/agents
// @access  Private
exports.getAgentMetrics = async (req, res) => {
  try {
    const data = await analyticsService.getAgentMetrics();

    res.status(200).json({
      success: true,
      data
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};

// @desc    Get quality metrics
// @route   GET /api/analytics/quality
// @access  Private
exports.getQualityMetrics = async (req, res) => {
  try {
    const data = await analyticsService.getQualityMetrics();

    res.status(200).json({
      success: true,
      data
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
};