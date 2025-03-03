const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getLeads,
  getLead,
  createLead,
  updateLead,
  deleteLead,
  analyzeLead,
  generateScript
} = require('../controllers/leads');

const router = express.Router();

router.use(protect);

router.route('/')
  .get(getLeads)
  .post(createLead);

router.route('/:id')
  .get(getLead)
  .put(updateLead)
  .delete(deleteLead);

router.route('/:id/analyze')
  .post(analyzeLead);

router.route('/:id/generate-script')
  .post(generateScript);

module.exports = router;