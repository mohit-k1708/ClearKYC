/**
 * Scene 3 routes (mounted under /api by routes/index.js): beneficial ownership, screening, risk assessment.
 *
 * Authorisation (prototype: the acting person is sent as the X-Reviewer-Id header):
 *   requireActor     any active person: add or edit owners, record an ownership check
 *   requireReviewer  Reviewer or Admin only: record screening outcomes, run risk assessments
 */
const express = require('express');
const ownership = require('../controllers/ownershipController');
const risk = require('../controllers/riskController');
const person = require('../controllers/personController');
const asyncHandler = require('../middleware/asyncHandler');
const requireActor = require('../middleware/requireActor');
const requireReviewer = require('../middleware/requireReviewer');

const router = express.Router();

// Beneficial owners
router.get('/customers/:customerId/beneficial-owners', asyncHandler(ownership.listOwners));
router.post('/customers/:customerId/beneficial-owners', requireActor, asyncHandler(ownership.createOwner));
router.get('/beneficial-owners/:id', asyncHandler(ownership.getOwner));
router.get('/beneficial-owners/:id/person', asyncHandler(person.getPersonOfOwner)); // Phase 6: the same person across companies
router.get('/people/:personRef', asyncHandler(person.getPerson));
router.put('/beneficial-owners/:id', requireActor, asyncHandler(ownership.updateOwner));

// Ownership validation
router.get('/customers/:customerId/ownership-validation', asyncHandler(ownership.getValidation));
router.post('/customers/:customerId/ownership-validation', requireActor, asyncHandler(ownership.recordValidation));

// Owner screening (synthetic outcomes)
router.post('/beneficial-owners/:id/screening', requireReviewer, asyncHandler(ownership.createScreening));
router.get('/beneficial-owners/:id/screening', asyncHandler(ownership.listScreenings));

// Overview, form options, dashboard
router.get('/ownership/overview', asyncHandler(ownership.overview));
router.get('/ownership/options', ownership.options);
router.get('/dashboard/risk-summary', asyncHandler(ownership.dashboard));

// Risk assessment
router.post('/customers/:customerId/risk-assessments', requireReviewer, asyncHandler(risk.createAssessment));
router.get('/customers/:customerId/risk-assessments', asyncHandler(risk.listCustomerAssessments));
router.get('/risk-assessments', asyncHandler(risk.listAssessments));
router.get('/risk-assessments/:id', asyncHandler(risk.getAssessment));
router.get('/customers/:customerId/risk-summary', asyncHandler(risk.getSummary));

module.exports = router;
