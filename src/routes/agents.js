const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  updateAvailability,
  updateSkills
} = require('../controllers/agents');

const router = express.Router();

router.use(protect);

router.route('/')
  .get(getAgents)
  .post(createAgent);

router.route('/:id')
  .get(getAgent)
  .put(updateAgent)
  .delete(deleteAgent);

router.route('/:id/availability')
  .put(updateAvailability);

router.route('/:id/skills')
  .put(updateSkills);

module.exports = router;