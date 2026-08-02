const express = require("express");
const {
  overview,
  outcomes,
  reps,
  recent,
  repPayouts,
  callbacks
} = require("../controllers/callsAnalytics");

const router = express.Router();

/**
 * All routes are scoped to a company. Optional query params:
 *   gigId  — restrict to a single gig ("all" or omitted = whole company)
 *   from   — ISO date (inclusive). Default: 30 days ago.
 *   to     — ISO date (inclusive). Default: now.
 */
router.get("/company/:companyId/analytics/overview",  overview);
router.get("/company/:companyId/analytics/outcomes",  outcomes);
router.get("/company/:companyId/analytics/reps",      reps);
router.get("/company/:companyId/analytics/recent",      recent);
router.get("/company/:companyId/analytics/rep-payouts", repPayouts);
router.get("/company/:companyId/analytics/callbacks",   callbacks);

module.exports = router;
