const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getStats,
  getLiveCalls,
  getTopGigs,
  getTopReps
} = require('../controllers/dashboard');

const router = express.Router();

router.use(protect);

router.get('/stats', getStats);
router.get('/live-calls', getLiveCalls);
router.get('/top-gigs', getTopGigs);
router.get('/top-reps', getTopReps);

module.exports = router;