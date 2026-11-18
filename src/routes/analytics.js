const express = require('express');
const { authenticateUser } = require('../middleware/companyScope');
const { requireCallerCompany } = require('../middleware/callsAccess');
const {
  getOverview,
  getCallMetrics,
  getAgentMetrics,
  getQualityMetrics
} = require('../controllers/analytics');

const router = express.Router();

// Jeton exigé, lectures cantonnées à l'entreprise de l'appelant (résolue par le service d'inscription, jamais lue dans la requête).
router.use(authenticateUser, requireCallerCompany);

router.get('/overview', getOverview);
router.get('/calls', getCallMetrics);
router.get('/agents', getAgentMetrics);
router.get('/quality', getQualityMetrics);

module.exports = router;