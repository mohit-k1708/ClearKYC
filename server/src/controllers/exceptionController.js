/**
 * HTTP layer for exceptions and the review dashboard.
 */
const exceptionService = require('../services/exceptionService');
const dashboardService = require('../services/reviewDashboardService');
const { findCustomer } = require('../services/kycService');
const jobs = require('../services/detectionJobService');
const { detectSchema, exceptionResolveSchema, exceptionQuerySchema } = require('../utils/reviewValidation');
const { parse } = require('./requirementController');
const { EXCEPTION_TYPES, CASE_TYPES, CASE_STATUSES, PRIORITIES, SEVERITIES, ROLE_LABELS, APPROVAL_REQUIRED, SLA_DAYS, PERIODIC_REVIEW } = require('../config/reviewRules');
const workflow = require('../services/caseWorkflow');

// GET /api/exceptions?status=active|all|Open|In Review|Resolved&severity=&type=&group=&customerId=&search=&withoutCase=
async function listExceptions(req, res) {
  const query = parse(exceptionQuerySchema, req.query, 'Invalid query parameters');
  const result = await exceptionService.listExceptions(query);
  res.json({ data: result.items, summary: result.summary, pagination: result.pagination });
}

// GET /api/exceptions/:id   (EXC-000001 or numeric id)
async function getException(req, res) {
  res.json({ data: await exceptionService.getException(req.params.id) });
}

// POST /api/exceptions/detect   Body: { customerId? }   Safe to run repeatedly: never creates duplicate active exceptions.
async function detect(req, res) {
  const { customerId } = parse(detectSchema, req.body);
  const customer = customerId ? await findCustomer(customerId) : null;
  res.json({ data: await exceptionService.detect({ customerDbId: customer?.id ?? null }) });
}

// PATCH /api/exceptions/:id/resolve   Body: { resolutionNotes }
async function resolveException(req, res) {
  const { resolutionNotes } = parse(exceptionResolveSchema, req.body);
  res.json({ data: await exceptionService.resolveException(req.params.id, req.reviewer, resolutionNotes) });
}

// GET /api/review-dashboard/summary
async function dashboardSummary(req, res) {
  res.json({ data: await dashboardService.getSummary() });
}

// GET /api/review-options   (values for the forms and the documented rules)
function options(req, res) {
  res.json({
    data: {
      exceptionTypes: Object.entries(EXCEPTION_TYPES).map(([code, v]) => ({ code, ...v })),
      caseTypes: CASE_TYPES,
      caseStatuses: CASE_STATUSES,
      priorities: PRIORITIES,
      severities: SEVERITIES,
      roleLabels: ROLE_LABELS,
      actions: Object.entries(workflow.ACTIONS).map(([action, a]) => ({ action, label: a.label })),
      rules: {
        slaDays: SLA_DAYS,
        approvalRequired: APPROVAL_REQUIRED,
        periodicReview: PERIODIC_REVIEW,
        disclaimer: 'Review intervals, SLA days and severities are illustrative prototype settings, not legal requirements.',
      },
    },
  });
}

// POST /api/detection-jobs   Starts detection for every customer in the background and answers 202 with the job. 409 while one is running.
async function startDetectionJob(req, res) {
  res.status(202).json({ data: jobs.startJob(req.reviewer) });
}

// GET /api/detection-jobs   The running job (if any) and the most recent jobs, newest first.
async function listDetectionJobs(req, res) {
  res.json({ data: { running: jobs.currentJob(), items: jobs.recentJobs() } });
}

// GET /api/detection-jobs/:jobId   Status and progress of one job.
async function getDetectionJob(req, res) {
  res.json({ data: jobs.getJob(req.params.jobId) });
}

module.exports = { listExceptions, getException, detect, startDetectionJob, listDetectionJobs, getDetectionJob, resolveException, dashboardSummary, options };
