/**
 * HTTP layer for review cases and periodic review schedules.
 */
const caseService = require('../services/reviewCaseService');
const scheduleService = require('../services/reviewScheduleService');
const { parseId } = require('../services/requirementService');
const { caseCreateSchema, assignSchema, statusSchema, noteSchema, caseQuerySchema, scheduleCreateSchema, scheduleCompleteSchema, scheduleQuerySchema } = require('../utils/reviewValidation');
const { parse } = require('./requirementController');

// ---- Cases -------------------------------------------------------------------------------------------
// GET /api/review-cases?status=active|closed|Open,...&priority=&caseType=&customerId=&assignedAnalystId=&assignedReviewerId=&unassigned=&overdue=&search=
async function listCases(req, res) {
  const query = parse(caseQuerySchema, req.query, 'Invalid query parameters');
  const result = await caseService.listCases(query);
  res.json({ data: result.items, pagination: result.pagination });
}

// POST /api/review-cases   (manual, or from an exception with exceptionId)
async function createCase(req, res) {
  res.status(201).json({ data: await caseService.createCase(parse(caseCreateSchema, req.body), req.reviewer) });
}

// GET /api/review-cases/:id   (CASE-000001 or numeric id). Includes the actions this person may take.
async function getCase(req, res) {
  res.json({ data: await caseService.getCase(req.params.id, req.reviewer) });
}

// PATCH /api/review-cases/:id/assign   Body: { assignedAnalystId?, assignedReviewerId?, priority?, remarks? }
async function assignCase(req, res) {
  res.json({ data: await caseService.assignCase(req.params.id, parse(assignSchema, req.body), req.reviewer) });
}

// PATCH /api/review-cases/:id/status   Body: { action | status, remarks?, resolutionNotes?, reviewerId? }
async function changeStatus(req, res) {
  res.json({ data: await caseService.transitionCase(req.params.id, parse(statusSchema, req.body), req.reviewer) });
}

// POST /api/review-cases/:id/notes   Body: { note }
async function addNote(req, res) {
  res.status(201).json({ data: await caseService.addNote(req.params.id, parse(noteSchema, req.body), req.reviewer) });
}

// GET /api/review-cases/:id/history
async function getHistory(req, res) {
  res.json({ data: await caseService.getHistory(req.params.id) });
}

// ---- Periodic reviews --------------------------------------------------------------------------------------
// GET /api/review-schedules?status=&riskLevel=&customerType=&customerId=&search=
async function listSchedules(req, res) {
  const result = await scheduleService.listSchedules(parse(scheduleQuerySchema, req.query, 'Invalid query parameters'), 'all');
  res.json({ data: result.items, pagination: result.pagination });
}

// POST /api/review-schedules   Body: { customerId, lastReviewDate? }   (Reviewer or Admin)
async function createSchedule(req, res) {
  const { customerId, lastReviewDate } = parse(scheduleCreateSchema, req.body);
  res.status(201).json({ data: await scheduleService.createSchedule(customerId, { lastReviewDate }) });
}

// POST /api/review-schedules/:id/complete   Body: { notes, reviewDate? }   (Reviewer or Admin)
async function completeSchedule(req, res) {
  const body = parse(scheduleCompleteSchema, req.body);
  res.json({ data: await scheduleService.completeSchedule(parseId(req.params.id), req.reviewer, body) });
}

// GET /api/reviews/upcoming   reviews due within the next 30 days
async function upcoming(req, res) {
  const result = await scheduleService.listSchedules(parse(scheduleQuerySchema, req.query, 'Invalid query parameters'), 'upcoming');
  res.json({ data: result.items, pagination: result.pagination });
}

// GET /api/reviews/overdue   reviews whose due date has passed
async function overdue(req, res) {
  const result = await scheduleService.listSchedules(parse(scheduleQuerySchema, req.query, 'Invalid query parameters'), 'overdue');
  res.json({ data: result.items, pagination: result.pagination });
}

module.exports = { listCases, createCase, getCase, assignCase, changeStatus, addNote, getHistory, listSchedules, createSchedule, completeSchedule, upcoming, overdue };
