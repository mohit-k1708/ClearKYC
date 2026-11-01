/**
 * HTTP layer for beneficial ownership, ownership validation and owner screening.
 */
const ownershipService = require('../services/ownershipService');
const screeningService = require('../services/screeningService');
const { parseId } = require('../services/requirementService');
const { ownerSchema, screeningSchema, ownershipOverviewQuerySchema } = require('../utils/ownershipValidation');
const { parse } = require('./requirementController');
const { CONTROL_TYPES, OWNERSHIP_TYPES, PEP_STATUSES, SCREENING_TYPES, SCREENING_RESULTS, OWNERSHIP_RULES } = require('../config/ownershipRules');
const { COUNTRIES } = require('../config/options');

// GET /api/customers/:customerId/beneficial-owners
async function listOwners(req, res) {
  res.json({ data: await ownershipService.listOwners(req.params.customerId) });
}

// POST /api/customers/:customerId/beneficial-owners   (any identified, active person)
async function createOwner(req, res) {
  const data = parse(ownerSchema, req.body);
  res.status(201).json({ data: await ownershipService.createOwner(req.params.customerId, data, req.reviewer) });
}

// GET /api/beneficial-owners/:id
async function getOwner(req, res) {
  res.json({ data: await ownershipService.getOwner(parseId(req.params.id)) });
}

// PUT /api/beneficial-owners/:id   (any identified, active person)
async function updateOwner(req, res) {
  const data = parse(ownerSchema, req.body);
  res.json({ data: await ownershipService.updateOwner(parseId(req.params.id), data, req.reviewer) });
}

// GET /api/customers/:customerId/ownership-validation
async function getValidation(req, res) {
  res.json({ data: await ownershipService.getOwnershipValidation(req.params.customerId) });
}

// POST /api/customers/:customerId/ownership-validation   (records the current result as a new check)
async function recordValidation(req, res) {
  res.status(201).json({ data: await ownershipService.recordOwnershipValidation(req.params.customerId, req.reviewer) });
}

// POST /api/beneficial-owners/:id/screening   (Reviewer or Admin)
async function createScreening(req, res) {
  const data = parse(screeningSchema, req.body);
  res.status(201).json({ data: await screeningService.createScreening(parseId(req.params.id), data, req.reviewer) });
}

// GET /api/beneficial-owners/:id/screening
async function listScreenings(req, res) {
  res.json({ data: await screeningService.listScreenings(parseId(req.params.id)) });
}

// GET /api/ownership/overview?search=&status=&page=&pageSize=   (Ownership Management page)
async function overview(req, res) {
  const query = parse(ownershipOverviewQuerySchema, req.query, 'Invalid query parameters');
  const result = await ownershipService.listOwnershipOverview(query);
  res.json({ data: result.items, pagination: result.pagination });
}

// GET /api/ownership/options   (values for the forms, so the frontend never hard-codes them)
function options(req, res) {
  res.json({
    data: {
      controlTypes: CONTROL_TYPES,
      ownershipTypes: OWNERSHIP_TYPES,
      pepStatuses: PEP_STATUSES,
      screeningTypes: SCREENING_TYPES,
      screeningResults: SCREENING_RESULTS,
      countries: Object.entries(COUNTRIES).map(([code, name]) => ({ code, name })),
      rules: {
        version: OWNERSHIP_RULES.version,
        ownerPoints: OWNERSHIP_RULES.ownerPoints,
        ownerBands: OWNERSHIP_RULES.ownerBands,
        overall: { scorePerOwnerPoint: OWNERSHIP_RULES.overall.scorePerOwnerPoint, ownershipUpliftCap: OWNERSHIP_RULES.overall.ownershipUpliftCap, validationUplift: OWNERSHIP_RULES.overall.validationUplift, thresholds: OWNERSHIP_RULES.overall.thresholds },
        complexity: OWNERSHIP_RULES.complexity,
        disclaimer: 'Illustrative prototype rules, not regulatory standards. Screening outcomes are synthetic: there is no connection to any real sanctions or PEP database.',
      },
    },
  });
}

// GET /api/dashboard/risk-summary
async function dashboard(req, res) {
  res.json({ data: await ownershipService.getRiskDashboard() });
}

module.exports = { listOwners, createOwner, getOwner, updateOwner, getValidation, recordValidation, createScreening, listScreenings, overview, options, dashboard };
