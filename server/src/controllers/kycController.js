/**
 * HTTP layer for KYC completeness, exceptions and the reviewer list.
 */
const kycService = require('../services/kycService');
const prisma = require('../utils/prisma');
const { exceptionQuerySchema } = require('../utils/kycValidation');
const { parse } = require('./requirementController');
const { AUTHORISED_ROLES } = require('../config/kycRules');

// GET /api/customers/:customerId/kyc-completeness
async function getCompleteness(req, res) {
  res.json({ data: await kycService.getCompleteness(req.params.customerId) });
}

// GET /api/kyc/exceptions?type=&customerType=&risk=&search=&page=&pageSize=
async function listExceptions(req, res) {
  const query = parse(exceptionQuerySchema, req.query, 'Invalid query parameters');
  const result = await kycService.listExceptions(query);
  res.json({ data: result.items, summary: result.summary, pagination: result.pagination, asOf: result.asOf });
}

// GET /api/reviewers   (active people the analyst can act as; `canDecide` says who may record decisions)
async function listReviewers(req, res) {
  const rows = await prisma.reviewer.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
  res.json({ data: rows.map((r) => ({ id: r.id, name: r.name, role: r.role, canDecide: AUTHORISED_ROLES.includes(r.role) })) });
}

module.exports = { getCompleteness, listExceptions, listReviewers };
