const jwt = require('jsonwebtoken');
const { config } = require('../config/env');
const { User } = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      error: 'Not authorized to access this route'
    });
  }

  // Aucun secret de repli : sans JWT_SECRET, tous les jetons sont refusés.
  if (!config.JWT_SECRET) {
    console.error('[auth] JWT_SECRET is not set: refusing every protected request');
    return res.status(500).json({ success: false, error: 'Authentication is not configured' });
  }

  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    req.user = await User.findById(decoded.id);
    next();
  } catch (err) {
    return res.status(401).json({
      success: false,
      error: 'Not authorized to access this route'
    });
  }
};

module.exports = { protect };