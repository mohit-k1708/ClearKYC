/**
 * Scene 5 routes (mounted under /api by routes/index.js): audit trail, alerts, analytics, data quality, exports.
 *
 * Authorisation (prototype: the acting person is sent as the X-Reviewer-Id header):
 *   open reads        analytics, alert lists, validation results (they contain record references, not personal data)
 *   optionalActor     alert details list the actions the chosen person may take
 *   requireActor      any active person: acknowledge / progress / resolve alerts, refresh alerts, request an export
 *                     (finer rules are in the services: for example who may dismiss an alert or export a sensitive report)
 *   Reviewer / Admin  read the audit trail, run data validation
 * Static paths ("/alerts/summary") are declared before paths with :id.
 */
const express = require('express');
const c = require('../controllers/reportingController');
const asyncHandler = require('../middleware/asyncHandler');
const requireActor = require('../middleware/requireActor');
const requireRole = require('../middleware/requireRole');
const optionalActor = require('../middleware/optionalActor');

const router = express.Router();
const COMPLIANCE = ['Reviewer', 'Admin'];

// Audit trail (read only: there is deliberately no POST, PUT, PATCH or DELETE)
router.get('/audit-events/options', requireRole(COMPLIANCE, 'view the audit trail'), asyncHandler(c.auditOptions));
router.get('/audit-events', requireRole(COMPLIANCE, 'view the audit trail'), asyncHandler(c.listAuditEvents));
router.get('/audit-events/:id', requireRole(COMPLIANCE, 'view the audit trail'), asyncHandler(c.getAuditEvent));

// Recent activity for the Overview (a limited view of the audit records, open to every role)
router.get('/activity/recent', asyncHandler(c.recentActivity));

// Alerts
router.get('/alerts/summary', asyncHandler(c.alertSummary));
router.get('/alerts/options', c.alertOptions);
router.post('/alerts/refresh', requireActor, asyncHandler(c.refreshAlerts));
router.get('/alerts', asyncHandler(c.listAlerts));
router.get('/alerts/:id', optionalActor, asyncHandler(c.getAlert));
router.patch('/alerts/:id/acknowledge', requireActor, asyncHandler(c.acknowledgeAlert));
router.patch('/alerts/:id/status', requireActor, asyncHandler(c.changeAlertStatus));
router.patch('/alerts/:id/resolve', requireActor, asyncHandler(c.resolveAlert));

// Analytics (calculated from the database on every request)
router.get('/analytics/overview', asyncHandler(c.analyticsOverview));
router.get('/analytics/customers', asyncHandler(c.analyticsCustomers));
router.get('/analytics/documents', asyncHandler(c.analyticsDocuments));
router.get('/analytics/risks', asyncHandler(c.analyticsRisks));
router.get('/analytics/review-cases', asyncHandler(c.analyticsReviewCases));
router.get('/analytics/ownership', asyncHandler(c.analyticsOwnership));

// Data quality
router.post('/data-validation/run', requireRole(COMPLIANCE, 'run data validation'), asyncHandler(c.runValidation));
router.get('/data-validation/checks', c.validationChecks);
router.get('/data-validation/runs', asyncHandler(c.listRuns));
router.get('/data-validation/runs/:id', asyncHandler(c.getRun));
router.get('/data-validation/issues', asyncHandler(c.listIssues));

// Reports & exports
router.get('/exports', optionalActor, c.exportCatalog);
for (const key of ['customers', 'documents', 'completeness', 'risks', 'ownership', 'review-cases', 'alerts', 'audit-events', 'seed-data', 'schema']) {
  router.get(`/exports/${key}`, requireActor, asyncHandler(c.exporter(key)));
}

module.exports = router;
