/**
 * HTTP layer for KYC requirements.
 */
const service = require('../services/requirementService');
const { requirementSchema, requirementStatusSchema, requirementQuerySchema } = require('../utils/kycValidation');
const { flattenZodError } = require('../utils/validation');
const { badRequest } = require('../utils/errors');
const { typeInfo } = require('../config/kycRules');

/** Validates input with a zod schema and throws a 400 with per-field messages on failure. */
function parse(schema, input, message = 'Please correct the highlighted fields') {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw badRequest(message, flattenZodError(parsed.error));
  return parsed.data;
}

// GET /api/kyc-requirements?customerType=&riskLevel=&isActive=&search=
async function listRequirements(req, res) {
  const filters = parse(requirementQuerySchema, req.query, 'Invalid query parameters');
  res.json({ data: await service.listRequirements(filters) });
}

// GET /api/kyc-requirements/document-types   (built-in types plus any custom type already used)
async function listDocumentTypes(req, res) {
  const names = await service.getKnownDocumentTypes();
  res.json({ data: names.map((name) => ({ name, requiresNumber: Boolean(typeInfo(name)?.requiresNumber) })) });
}

// POST /api/kyc-requirements
async function createRequirement(req, res) {
  res.status(201).json({ data: await service.createRequirement(parse(requirementSchema, req.body)) });
}

// PUT /api/kyc-requirements/:id
async function updateRequirement(req, res) {
  const id = service.parseId(req.params.id);
  res.json({ data: await service.updateRequirement(id, parse(requirementSchema, req.body)) });
}

// PATCH /api/kyc-requirements/:id/status   Body: { isActive: true | false }
async function setStatus(req, res) {
  const id = service.parseId(req.params.id);
  const { isActive } = parse(requirementStatusSchema, req.body);
  res.json({ data: await service.setRequirementActive(id, isActive) });
}

module.exports = { listRequirements, listDocumentTypes, createRequirement, updateRequirement, setStatus, parse };
