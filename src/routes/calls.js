
const express = require('express');
const { protect } = require('../middleware/auth');
const {
  getCalls,
  getCall,
  createCall,
  updateCall,
  endCall,
  addNote,
  updateQualityScore,
  initiateCall
} = require('../controllers/calls');

const router = express.Router();

//router.use(protect);

router.route('/')
  .get(getCalls)
  .post(createCall);

router.route('/initiate')
  .post(initiateCall);

router.route('/:id')
  .get(getCall)
  .put(updateCall);

router.route('/:id/end')
  .post(endCall);

router.route('/:id/notes')
  .post(addNote);

router.route('/:id/quality-score')
  .put(updateQualityScore);

module.exports = router;