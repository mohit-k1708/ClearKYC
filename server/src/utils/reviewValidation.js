/**
 * Request validation (zod) for Scene 4: exceptions, review cases, assignments, notes, schedules.
 */
const { z } = require('zod');
const { parseIso, todayIso } = require('./dates');
const { ACTIONS } = require('../services/caseWorkflow');
const { CASE_TYPES, CASE_STATUSES, PRIORITIES, SEVERITIES, EXCEPTION_TYPES, MIN_NOTE_LENGTH } = require('../config/reviewRules');
const { RISK_LEVELS, CUSTOMER_TYPES } = require('../config/kycRules');

const blankToUndefined = (v) => (v === '' ? undefined : v);
const optional = (schema) => z.preprocess(blankToUndefined, schema.optional());
const oneOf = (label, values) => z.enum(values, { errorMap: () => ({ message: `${label} must be one of: ${values.join(', ')}` }) });

const text = (label, { min = 1, max = 200 } = {}) =>
  z.string({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` }).trim().min(min, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`).max(max, `${label} must be at most ${max} characters`);

/** Whole-number id that may arrive as a string (query strings, forms). */
const id = (label) => z.preprocess((v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v), z.number({ invalid_type_error: `${label} must be a whole number` }).int().positive());
/** Like id(), but null means "remove the assignment". */
const nullableId = (label) => z.preprocess((v) => (v === '' ? null : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v), z.union([z.null(), z.number({ invalid_type_error: `${label} must be a whole number` }).int().positive()]).optional());

const customerCode = z.string().trim().regex(/^CUS-\d{6,}$/i, 'Customer ID must look like CUS-000001').transform((v) => v.toUpperCase());
const dateText = (label) => z.string().trim().refine((v) => parseIso(v) !== null, `${label} must be a valid date (YYYY-MM-DD)`);
const booleanLike = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const note = (label, min = MIN_NOTE_LENGTH) => text(label, { min, max: 2000 });

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
};

// ---- Exceptions ------------------------------------------------------------------------------------------
const detectSchema = z.object({ customerId: optional(customerCode) });

const exceptionResolveSchema = z.object({ resolutionNotes: note('Resolution notes') });

const EXCEPTION_STATUS_FILTERS = ['active', 'all', 'Open', 'In Review', 'Resolved'];
const exceptionQuerySchema = z.object({
  ...paging,
  search: optional(z.string().trim().max(100)),
  status: z.preprocess(blankToUndefined, oneOf('Status', EXCEPTION_STATUS_FILTERS).default('active')),
  severity: optional(oneOf('Severity', SEVERITIES)),
  type: optional(oneOf('Type', Object.keys(EXCEPTION_TYPES))),
  group: optional(oneOf('Group', ['Document', 'Ownership', 'Risk', 'Review'])),
  customerId: optional(customerCode),
  withoutCase: optional(booleanLike),
});

// ---- Review cases ---------------------------------------------------------------------------------------------
const caseCreateSchema = z
  .object({
    customerId: optional(customerCode),
    exceptionId: optional(id('Exception')),
    reviewScheduleId: optional(id('Review schedule')),
    caseTitle: optional(text('Case title', { min: 3, max: 150 })),
    caseType: optional(oneOf('Case type', CASE_TYPES)),
    description: optional(z.string().trim().max(2000, 'Description must be at most 2000 characters')),
    priority: optional(oneOf('Priority', PRIORITIES)),
    dueDate: optional(dateText('Due date')),
    assignedAnalystId: optional(id('Analyst')),
    assignedReviewerId: optional(id('Reviewer')),
  })
  .superRefine((v, ctx) => {
    if (!v.exceptionId && !v.customerId) ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'Choose a customer, or create the case from an exception' });
    if (!v.exceptionId && !v.caseTitle) ctx.addIssue({ code: 'custom', path: ['caseTitle'], message: 'Case title is required' });
    if (!v.exceptionId && !v.caseType) ctx.addIssue({ code: 'custom', path: ['caseType'], message: 'Case type is required' });
    if (v.dueDate && v.dueDate < todayIso()) ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Due date cannot be in the past' });
  });

const assignSchema = z
  .object({
    assignedAnalystId: nullableId('Analyst'),
    assignedReviewerId: nullableId('Reviewer'),
    priority: optional(oneOf('Priority', PRIORITIES)),
    remarks: optional(z.string().trim().max(500, 'Remarks must be at most 500 characters')),
  })
  .superRefine((v, ctx) => {
    if (v.assignedAnalystId === undefined && v.assignedReviewerId === undefined && v.priority === undefined) {
      ctx.addIssue({ code: 'custom', path: ['assignedAnalystId'], message: 'Choose an analyst, a reviewer or a priority to change' });
    }
  });

const statusSchema = z
  .object({
    action: optional(oneOf('Action', Object.keys(ACTIONS))),
    status: optional(oneOf('Status', CASE_STATUSES)),
    remarks: optional(z.string().trim().max(1000, 'Remarks must be at most 1000 characters')),
    resolutionNotes: optional(z.string().trim().max(2000, 'Resolution notes must be at most 2000 characters')),
    reviewerId: optional(id('Reviewer')),
  })
  .superRefine((v, ctx) => {
    if (!v.action && !v.status) ctx.addIssue({ code: 'custom', path: ['action'], message: 'Choose what to do with the case' });
  });

const noteSchema = z.object({ note: note('Note', 3) });

const caseQuerySchema = z.object({
  ...paging,
  search: optional(z.string().trim().max(100)),
  status: optional(z.string().trim().max(100)), // one status, "active" or a comma list; validated in the service
  priority: optional(
    z.string().trim().refine((v) => v.split(',').every((p) => PRIORITIES.includes(p.trim())), `Priority must be one or more of: ${PRIORITIES.join(', ')} (separated by commas)`)
  ),
  caseType: optional(oneOf('Case type', CASE_TYPES)),
  customerId: optional(customerCode),
  assignedAnalystId: optional(id('Analyst')),
  assignedReviewerId: optional(id('Reviewer')),
  unassigned: optional(booleanLike),
  overdue: optional(booleanLike),
});

// ---- Periodic reviews ------------------------------------------------------------------------------------------
const scheduleCreateSchema = z.object({
  customerId: customerCode,
  lastReviewDate: optional(dateText('Last review date').refine((v) => v <= todayIso(), 'Last review date cannot be in the future')),
});

const scheduleCompleteSchema = z.object({
  reviewDate: optional(dateText('Review date').refine((v) => v <= todayIso(), 'Review date cannot be in the future')),
  notes: note('Completion notes'),
});

const scheduleQuerySchema = z.object({
  ...paging,
  search: optional(z.string().trim().max(100)),
  status: optional(oneOf('Status', ['Scheduled', 'Completed', 'Superseded'])),
  riskLevel: optional(oneOf('Risk level', RISK_LEVELS)),
  customerType: optional(oneOf('Customer type', CUSTOMER_TYPES)),
  customerId: optional(customerCode),
});

module.exports = { detectSchema, exceptionResolveSchema, exceptionQuerySchema, caseCreateSchema, assignSchema, statusSchema, noteSchema, caseQuerySchema, scheduleCreateSchema, scheduleCompleteSchema, scheduleQuerySchema };
