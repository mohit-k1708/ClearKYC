/**
 * HTTP layer for risk assessments (history, new assessments and the customer risk summary).
 */
const service = require('../services/riskAssessmentService');
const { assessmentSchema, riskAssessmentQuerySchema } = require('../utils/ownershipValidation');
const { parse } = require('./requirementController');

// POST /api/customers/:customerId/risk-assessments   (Reviewer or Admin)
async function createAssessment(req, res) {
  const body = parse(assessmentSchema, req.body);
  res.status(201).json({ data: await service.createAssessment(req.params.customerId, req.reviewer, body) });
}

// GET /api/customers/:customerId/risk-assessments   (this customer's history, newest first)
async function listCustomerAssessments(req, res) {
  res.json({ data: await service.listCustomerAssessments(req.params.customerId) });
}

// GET /api/risk-assessments?search=&riskLevel=&status=&customerType=&customerId=&from=&to=&page=&pageSize=
async function listAssessments(req, res) {
  const query = parse(riskAssessmentQuerySchema, req.query, 'Invalid query parameters');
  const result = await service.listAssessments(query);
  res.json({ data: result.items, pagination: result.pagination });
}

// GET /api/risk-assessments/:id   (RSK-000001 or numeric id)
async function getAssessment(req, res) {
  res.json({ data: await service.getAssessment(req.params.id) });
}

// GET /api/customers/:customerId/risk-summary
async function getSummary(req, res) {
  res.json({ data: await service.getRiskSummary(req.params.customerId) });
}

module.exports = { createAssessment, listCustomerAssessments, listAssessments, getAssessment, getSummary };
