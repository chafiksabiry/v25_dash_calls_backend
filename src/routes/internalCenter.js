const express = require('express');
const c = require('../controllers/internalCenter');

const router = express.Router();
router.use(c.authenticateCenterService);
router.get('/:companyId/calls', c.listCalls);
router.get('/:companyId/contacts', c.listContacts);
router.post('/:companyId/leads/import', c.importLeads);

module.exports = router;
