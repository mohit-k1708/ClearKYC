/**
 * HTTP layer for customers: reads the request, validates it, calls the service, sends JSON.
 */
const { z } = require('zod');
const customerService = require('../services/customerService');
const { individualSchema, companySchema, flattenZodError } = require('../utils/validation');
const { badRequest } = require('../utils/errors');

// POST /api/customers
// Body: { customerType: "Individual" | "Company", ...fields of that form }
async function createCustomer(req, res) {
  const { customerType, ...fields } = req.body ?? {};
  const schema = { Individual: individualSchema, Company: companySchema }[customerType];
  if (!schema) {
    throw badRequest('customerType must be "Individual" or "Company"', { customerType: 'Choose Individual or Company' });
  }

  const parsed = schema.safeParse(fields);
  if (!parsed.success) {
    throw badRequest('Please correct the highlighted fields', flattenZodError(parsed.error));
  }

  const customer = await customerService.registerCustomer(customerType, parsed.data);
  res.status(201).json({ data: customer });
}

const listQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: z.string().trim().max(100).optional(),
  type: z.enum(['Individual', 'Company']).optional(),
  risk: z.enum(['Low', 'Medium', 'High']).optional(),
});

// GET /api/customers?page=1&pageSize=10&search=&type=&risk=
async function listCustomers(req, res) {
  // Empty strings from the UI filters mean "no filter".
  const cleaned = Object.fromEntries(Object.entries(req.query).filter(([, v]) => v !== ''));
  const parsed = listQuerySchema.safeParse(cleaned);
  if (!parsed.success) throw badRequest('Invalid query parameters', flattenZodError(parsed.error));

  const result = await customerService.listCustomers(parsed.data);
  res.json({ data: result.items, pagination: result.pagination });
}

// GET /api/customers/:id   (CUS-000001 or numeric id)
async function getCustomer(req, res) {
  const customer = await customerService.getCustomer(req.params.id);
  res.json({ data: customer });
}

module.exports = { createCustomer, listCustomers, getCustomer };
