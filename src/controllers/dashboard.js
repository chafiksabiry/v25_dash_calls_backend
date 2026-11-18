const { DashboardService } = require('../services/DashboardService');
const { applyRecordingAccess } = require('../utils/recordingAccess');

const dashboardService = new DashboardService();

// @desc    Get dashboard stats
// @route   GET /api/dashboard/stats
// @access  Private
exports.getStats = async (req, res) => {
  try {
    const data = await dashboardService.getStats(req.callerCompanyId);

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

// @desc    Get live calls
// @route   GET /api/dashboard/live-calls
// @access  Private
exports.getLiveCalls = async (req, res) => {
  try {
    const data = await applyRecordingAccess(req, await dashboardService.getLiveCalls(req.callerCompanyId));

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

// @desc    Get top performing gigs
// @route   GET /api/dashboard/top-gigs
// @access  Private
exports.getTopGigs = async (req, res) => {
  try {
    const data = await dashboardService.getTopGigs(req.callerCompanyId);

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

// @desc    Get top performing reps
// @route   GET /api/dashboard/top-reps
// @access  Private
exports.getTopReps = async (req, res) => {
  try {
    const data = await dashboardService.getTopReps(req.callerCompanyId);

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