/**
 * Scene 4 routes (mounted under /api by routes/index.js): exceptions, review cases, periodic reviews.
 *
 * Authorisation (prototype: the acting person is sent as the X-Reviewer-Id header):
 *   optionalActor    reads are open; if a person is chosen the case details list the actions THEY may take
 *   requireActor     any active person: run detection, create cases, change cases, add notes, resolve exceptions
 *                    (the finer rules, such as "only the assigned analyst", are enforced in the services)
 *   requireReviewer  Reviewer or Admin: create and complete periodic review schedules
 */
const express = require('express');
const exceptions = require('../controllers/exceptionController');
const cases = require('../controllers/reviewCaseController');
const asyncHandler = require('../middleware/asyncHandler');
const requireActor = require('../middleware/requireActor');
const requireReviewer = require('../middleware/requireReviewer');
const optionalActor = require('../middleware/optionalActor');

const router = express.Router();

// Exceptions
router.get('/exceptions', asyncHandler(exceptions.listExceptions));
router.post('/exceptions/detect', requireActor, asyncHandler(exceptions.detect)); // before /exceptions/:id

// Phase 6: detection as a background job (start returns at once with a job ID; poll the job for progress)
router.post('/detection-jobs', requireActor, asyncHandler(exceptions.startDetectionJob));
router.get('/detection-jobs', asyncHandler(exceptions.listDetectionJobs));
router.get('/detection-jobs/:jobId', asyncHandler(exceptions.getDetectionJob));
router.get('/exceptions/:id', asyncHandler(exceptions.getException));
router.patch('/exceptions/:id/resolve', requireActor, asyncHandler(exceptions.resolveException));

// Review cases
router.get('/review-cases', asyncHandler(cases.listCases));
router.post('/review-cases', requireActor, asyncHandler(cases.createCase));
router.get('/review-cases/:id', optionalActor, asyncHandler(cases.getCase));
router.patch('/review-cases/:id/assign', requireActor, asyncHandler(cases.assignCase));
router.patch('/review-cases/:id/status', requireActor, asyncHandler(cases.changeStatus));
router.post('/review-cases/:id/notes', requireActor, asyncHandler(cases.addNote));
router.get('/review-cases/:id/history', asyncHandler(cases.getHistory));

// Periodic reviews
router.get('/review-schedules', asyncHandler(cases.listSchedules));
router.post('/review-schedules', requireReviewer, asyncHandler(cases.createSchedule));
router.post('/review-schedules/:id/complete', requireReviewer, asyncHandler(cases.completeSchedule));
router.get('/reviews/upcoming', asyncHandler(cases.upcoming));
router.get('/reviews/overdue', asyncHandler(cases.overdue));

// Dashboard and form options
router.get('/review-dashboard/summary', asyncHandler(exceptions.dashboardSummary));
router.get('/review-options', exceptions.options);

module.exports = router;
