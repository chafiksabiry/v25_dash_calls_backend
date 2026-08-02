/**
 * Rep-transactions routes.
 *
 * Thin alias around `callsAnalytics.repPayouts` so the Wallet view can
 * hit a URL that reflects the underlying collection name
 * (`reptransactions`) instead of going through `/api/calls/...analytics/...`.
 *
 * Source of truth is documented in `controllers/callsAnalytics.js`.
 */
const express = require("express");
const { repPayouts } = require("../controllers/callsAnalytics");

const router = express.Router();

/**
 * GET /api/rep-transactions/company/:companyId
 *
 * Query params:
 *   limit  — 1..100, default 30
 *   gigId  — optional, "all" or omitted = whole company
 *   status — "validated" | "refused" | "all" (default: "all")
 */
router.get("/company/:companyId", repPayouts);

module.exports = router;
