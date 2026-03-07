const express = require('express');
const { protect } = require('../middleware/auth');
const { getGig } = require('../controllers/gigs');

const router = express.Router();

router.use(protect);

router.route('/:id')
    .get(getGig);

module.exports = router;
