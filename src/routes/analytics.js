const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getOverview,
  getCallMetrics,
  getAgentMetrics,
  getQualityMetrics
} = require('../controllers/analytics');

const router = express.Router();

router.use(protect);

router.get('/overview', getOverview);
router.get('/calls', getCallMetrics);
router.get('/agents', getAgentMetrics);
router.get('/quality', getQualityMetrics);

module.exports = router;