/**
 * Onboarding decision routes (mounted under /api by routes/index.js).
 *   GET  /customers/:customerId/onboarding-decisions   open: status, full history, what may be decided next
 *   POST /customers/:customerId/onboarding-decisions   Reviewer or Admin only (X-Reviewer-Id): { decision: 'Approved'|'Rejected', reason }
 */
const express = require('express');
const decisions = require('../controllers/onboardingDecisionController');
const asyncHandler = require('../middleware/asyncHandler');
const requireReviewer = require('../middleware/requireReviewer');

const router = express.Router();

router.get('/customers/:customerId/onboarding-decisions', asyncHandler(decisions.getDecisions));
router.post('/customers/:customerId/onboarding-decisions', requireReviewer, asyncHandler(decisions.createDecision));

module.exports = router;
