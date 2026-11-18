const express = require('express');
const { authenticateUser } = require('../middleware/companyScope');
const { requireCallerCompany } = require('../middleware/callsAccess');
const {
  getStats,
  getLiveCalls,
  getTopGigs,
  getTopReps
} = require('../controllers/dashboard');

const router = express.Router();

// Jeton exigé, lectures cantonnées à l'entreprise de l'appelant (résolue par le service d'inscription, jamais lue dans la requête).
router.use(authenticateUser, requireCallerCompany);

router.get('/stats', getStats);
router.get('/live-calls', getLiveCalls);
router.get('/top-gigs', getTopGigs);
router.get('/top-reps', getTopReps);

module.exports = router;