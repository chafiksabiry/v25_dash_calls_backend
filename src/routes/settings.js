const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getSettings,
  updateSettings,
  updateLogo
} = require('../controllers/settings');

const router = express.Router();

router.use(protect);

router.route('/')
  .get(getSettings)
  .put(updateSettings);

router.route('/logo')
  .put(updateLogo);

module.exports = router;