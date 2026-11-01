/**
 * Phase 6 settings routes (mounted under /api by routes/index.js).
 *   GET /settings/expiry-alerts   open: the lead times in use, the defaults and the change history
 *   PUT /settings/expiry-alerts   Reviewer or Admin only (the simulated reviewer identity, X-Reviewer-Id header)
 */
const express = require('express');
const settings = require('../controllers/settingsController');
const asyncHandler = require('../middleware/asyncHandler');
const requireReviewer = require('../middleware/requireReviewer');

const router = express.Router();

router.get('/settings/expiry-alerts', asyncHandler(settings.getExpiryAlerts));
router.put('/settings/expiry-alerts', requireReviewer, asyncHandler(settings.updateExpiryAlerts));

module.exports = router;
