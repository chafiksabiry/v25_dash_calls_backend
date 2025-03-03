const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getIntegrations,
  getIntegration,
  connectIntegration,
  disconnectIntegration,
  configureIntegration
} = require('../controllers/integrations');

const router = express.Router();

router.use(protect);

router.route('/')
  .get(getIntegrations);

router.route('/:id')
  .get(getIntegration);

router.route('/:id/connect')
  .post(connectIntegration);

router.route('/:id/disconnect')
  .post(disconnectIntegration);

router.route('/:id/configure')
  .post(configureIntegration);

module.exports = router;