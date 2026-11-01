const express = require('express');
const { authenticateUser } = require('../middleware/companyScope');
const controller = require('../controllers/clientPortal');

/** Portail client : lecture seule (GET uniquement), jeton de connexion exigé, portée fixée par le serveur. */
const router = express.Router();
router.use(authenticateUser);
router.get('/me', controller.me);
router.get('/overview', controller.overview);
router.get('/calls', controller.calls);

module.exports = router;
