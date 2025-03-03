const express = require('express');
const { protect } = require('../middleware/auth');
const { login, register, getProfile, logout } = require('../controllers/auth');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/logout', protect, logout);
router.get('/profile', protect, getProfile);

module.exports = router;