/**
 * HTTP layer for Scene 5: audit trail, alerts, analytics, data validation and exports.
 * Controllers stay thin: they validate the request and call a service.
 */
const audit = require('../services/auditService');
const alerts = require('../services/alertService');
const analytics = require('../services/analyticsService');
const dataQuality = require('../services/dataQualityService');
const exportService = require('../services/exportService');
const exceptionService = require('../services/exceptionService');
const { parse } = require('./requirementController');
const schemas = require('../utils/reportValidation');
const { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_ENTITY_TYPES } = require('../config/auditRules');
const { ALERT_TYPES, ALERT_STATUSES, MIN_REMARKS_LENGTH } = require('../config/alertRules');
const { SEVERITIES } = require('../config/reviewRules');
const { CATEGORIES, CHECKS } = require('../services/dataQualityChecks');
const prisma = require('../utils/prisma');

// ---- Audit trail ------------------------------------------------------------------------------------------
// GET /api/audit-events?search=&actionType=&category=&entityType=&entityId=&userId=&customerId=&from=&to=&page=&pageSize=
async function listAuditEvents(req, res) {
  res.json(await audit.listAuditEvents(parse(schemas.auditQuerySchema, req.query, 'Invalid query parameters')));
}

// GET /api/audit-events/:id   (AUD-000001 or numeric id)
async function getAuditEvent(req, res) {
  res.json({ data: await audit.getAuditEvent(req.params.id) });
}

// GET /api/audit-events/options   (filter values for the page)
async function auditOptions(req, res) {
  const users = await prisma.reviewer.findMany({ select: { id: true, name: true, role: true }, orderBy: { id: 'asc' } });
  res.json({
    data: {
      actions: Object.entries(AUDIT_ACTIONS).map(([code, a]) => ({ code, ...a })),
      categories: AUDIT_CATEGORIES,
      entityTypes: AUDIT_ENTITY_TYPES,
      users,
    },
  });
}

// GET /api/activity/recent?limit=8   Latest business activity from the audit records (no values or reasons). Open to every role.
async function recentActivity(req, res) {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit, 10) || 8, 1), 20);
  res.json({ data: await audit.recentActivity(limit) });
}

// ---- Alerts -----------------------------------------------------------------------------------------------
// GET /api/alerts?status=all|active|closed|New,...&severity=High,Critical&alertType=&customerId=CUS-000001&search=&from=&to=
async function listAlerts(req, res) {
  res.json(await alerts.listAlerts(parse(schemas.alertQuerySchema, req.query, 'Invalid query parameters')));
}

async function getAlert(req, res) {
  res.json({ data: await alerts.getAlert(req.params.id, req.reviewer ?? null) });
}

// PATCH /api/alerts/:id/acknowledge   Body: { remarks? }
async function acknowledgeAlert(req, res) {
  const body = parse(schemas.alertAcknowledgeSchema, req.body);
  res.json({ data: await alerts.acknowledgeAlert(req.params.id, req.reviewer, body) });
}

// PATCH /api/alerts/:id/status   Body: { status: Acknowledged | In Progress | Dismissed, remarks? }
async function changeAlertStatus(req, res) {
  const body = parse(schemas.alertStatusSchema, req.body);
  res.json({ data: await alerts.changeAlertStatus(req.params.id, req.reviewer, body) });
}

// PATCH /api/alerts/:id/resolve   Body: { resolutionNotes }
async function resolveAlert(req, res) {
  const body = parse(schemas.alertResolveSchema, req.body);
  res.json({ data: await alerts.resolveAlert(req.params.id, req.reviewer, body) });
}

// POST /api/alerts/refresh   Runs detection (exceptions + alerts) for every customer. Safe to repeat.
async function refreshAlerts(req, res) {
  const result = await exceptionService.detect({});
  res.json({ data: { ...result, summary: await alerts.getAlertSummary() } });
}

async function alertSummary(req, res) {
  res.json({ data: await alerts.getAlertSummary() });
}

function alertOptions(req, res) {
  res.json({
    data: {
      alertTypes: Object.entries(ALERT_TYPES).map(([code, a]) => ({ code, label: a.label })),
      statuses: ALERT_STATUSES,
      severities: SEVERITIES,
      minRemarksLength: MIN_REMARKS_LENGTH,
    },
  });
}

// ---- Analytics --------------------------------------------------------------------------------------------
const q = (req) => parse(schemas.analyticsQuerySchema, req.query, 'Invalid query parameters');
const analyticsOverview = async (req, res) => res.json({ data: await analytics.overview(q(req)) });
const analyticsCustomers = async (req, res) => res.json({ data: await analytics.customers(q(req)) });
const analyticsDocuments = async (req, res) => res.json({ data: await analytics.documents(q(req)) });
const analyticsRisks = async (req, res) => res.json({ data: await analytics.risks(q(req)) });
const analyticsReviewCases = async (req, res) => res.json({ data: await analytics.reviewCases(q(req)) });
const analyticsOwnership = async (req, res) => res.json({ data: await analytics.ownership() });

// ---- Data validation --------------------------------------------------------------------------------------
// POST /api/data-validation/run   Reviewer or Admin. Only reads business data; writes the run, its issues and an audit event.
async function runValidation(req, res) {
  res.status(201).json({ data: await dataQuality.runValidation(req.reviewer) });
}
async function listRuns(req, res) {
  res.json(await dataQuality.listRuns(parse(schemas.validationRunQuerySchema, req.query, 'Invalid query parameters')));
}
async function getRun(req, res) {
  res.json({ data: await dataQuality.getRun(req.params.id) });
}
async function listIssues(req, res) {
  res.json(await dataQuality.listIssues(parse(schemas.validationIssueQuerySchema, req.query, 'Invalid query parameters')));
}
function validationChecks(req, res) {
  res.json({ data: { categories: CATEGORIES, checks: CHECKS.map((c) => ({ code: c.code, category: c.category, title: c.title, severity: c.severity })) } });
}

// ---- Exports ----------------------------------------------------------------------------------------------
// GET /api/exports   the available reports and whether the chosen person may export each
function exportCatalog(req, res) {
  res.json({ data: exportService.catalog(req.reviewer ?? null) });
}

const exporter = (key) => async (req, res) => {
  const query = parse(schemas.exportQuerySchema, req.query, 'Invalid export filters');
  const file = await exportService.generateExport(key, query, req.reviewer);
  res.set({
    'Content-Type': file.contentType,
    'Content-Disposition': `attachment; filename="${file.filename}"`,
    'X-Export-Rows': String(file.rows),
    'Cache-Control': 'no-store',
  });
  res.send(file.body);
};

module.exports = {
  listAuditEvents, getAuditEvent, auditOptions, recentActivity,
  listAlerts, getAlert, acknowledgeAlert, changeAlertStatus, resolveAlert, refreshAlerts, alertSummary, alertOptions,
  analyticsOverview, analyticsCustomers, analyticsDocuments, analyticsRisks, analyticsReviewCases, analyticsOwnership,
  runValidation, listRuns, getRun, listIssues, validationChecks,
  exportCatalog, exporter,
};
