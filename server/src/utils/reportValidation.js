/**
 * Request validation (zod) for Scene 5: audit trail, alerts, analytics, data validation and exports.
 */
const { z } = require('zod');
const { parseIso } = require('./dates');
const { AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_ENTITY_TYPES } = require('../config/auditRules');
const { ALERT_TYPES, ALERT_STATUSES } = require('../config/alertRules');
const { SEVERITIES } = require('../config/reviewRules');
const { CATEGORIES } = require('../services/dataQualityChecks');
const { RISK_LEVELS, CUSTOMER_TYPES, DOCUMENT_TYPES } = require('../config/kycRules');
const { CASE_TYPES, PRIORITIES } = require('../config/reviewRules');

const blankToUndefined = (v) => (v === '' ? undefined : v);
const optional = (schema) => z.preprocess(blankToUndefined, schema.optional());
const oneOf = (label, values) => z.enum(values, { errorMap: () => ({ message: `${label} must be one of: ${values.join(', ')}` }) });
const dateText = (label) => z.string().trim().refine((v) => parseIso(v) !== null, `${label} must be a valid date (YYYY-MM-DD)`);
const customerCode = z.string().trim().regex(/^CUS-\d{6,}$/i, 'Customer ID must look like CUS-000001').transform((v) => v.toUpperCase());
const idNumber = (label) => z.preprocess((v) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v), z.number({ invalid_type_error: `${label} must be a whole number` }).int().nonnegative());
const text = (label, { min = 1, max = 200 } = {}) => z.string({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` }).trim().min(min, `${label} must be at least ${min} characters`).max(max, `${label} must be at most ${max} characters`);

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(15),
};

const dates = {
  from: optional(dateText('From date')),
  to: optional(dateText('To date')),
};
const orderedDates = (v, ctx) => {
  if (v.from && v.to && v.from > v.to) ctx.addIssue({ code: 'custom', path: ['from'], message: 'The start date must not be after the end date' });
};

// ---- Audit trail
const auditQuerySchema = z
  .object({
    ...paging, ...dates,
    search: optional(z.string().trim().max(100)),
    actionType: optional(oneOf('Action', Object.keys(AUDIT_ACTIONS))),
    category: optional(oneOf('Category', AUDIT_CATEGORIES)),
    entityType: optional(oneOf('Entity type', AUDIT_ENTITY_TYPES)),
    entityId: optional(idNumber('Entity ID')),
    userId: optional(idNumber('User')), // 0 = System
    customerId: optional(customerCode),
  })
  .superRefine(orderedDates);

// ---- Alerts
const alertStatusFilter = z.string().trim().refine(
  (v) => ['all', 'active', 'closed'].includes(v) || v.split(',').every((s) => ALERT_STATUSES.includes(s.trim())),
  `Status must be all, active, closed or one or more of: ${ALERT_STATUSES.join(', ')} (separated by commas)`
);
const alertQuerySchema = z
  .object({
    ...paging, ...dates,
    search: optional(z.string().trim().max(100)),
    status: optional(alertStatusFilter),
    severity: optional(z.string().trim().refine((v) => v.split(',').every((s) => SEVERITIES.includes(s.trim())), `Severity must be one or more of: ${SEVERITIES.join(', ')}`)),
    alertType: optional(oneOf('Alert type', Object.keys(ALERT_TYPES))),
    customerId: optional(customerCode),
  })
  .superRefine(orderedDates);

const alertAcknowledgeSchema = z.object({ remarks: optional(z.string().trim().max(500, 'Remarks must be at most 500 characters')) });
const alertStatusSchema = z.object({
  status: oneOf('Status', ALERT_STATUSES),
  remarks: optional(z.string().trim().max(1000, 'Remarks must be at most 1000 characters')),
});
const alertResolveSchema = z.object({ resolutionNotes: text('Resolution notes', { min: 1, max: 2000 }) });

// ---- Analytics
const analyticsQuerySchema = z
  .object({ range: optional(oneOf('Range', ['7d', '30d', '90d', 'all'])), ...dates })
  .superRefine(orderedDates);

// ---- Data validation
const validationRunQuerySchema = z.object({ ...paging });
const validationIssueQuerySchema = z.object({
  ...paging,
  runId: optional(idNumber('Run')),
  severity: optional(oneOf('Severity', ['Error', 'Warning'])),
  category: optional(oneOf('Category', CATEGORIES)),
  checkCode: optional(z.string().trim().max(60)),
  status: optional(oneOf('Status', ['Open', 'Resolved'])),
  entityType: optional(z.string().trim().max(40)),
  search: optional(z.string().trim().max(100)),
});

// ---- Exports (one permissive schema: each report uses the filters that apply to it)
const exportQuerySchema = z
  .object({
    ...dates,
    search: optional(z.string().trim().max(100)),
    customerId: optional(customerCode),
    customerType: optional(oneOf('Customer type', CUSTOMER_TYPES)),
    riskLevel: optional(oneOf('Risk level', RISK_LEVELS)),
    assessmentStatus: optional(oneOf('Assessment status', ['Completed', 'Requires Manual Review'])),
    status: optional(z.string().trim().max(100)),
    documentType: optional(oneOf('Document type', DOCUMENT_TYPES)),
    expiry: optional(oneOf('Expiry state', ['No Expiry', 'Valid', 'Expiring Soon', 'Expired'])),
    completeness: optional(oneOf('Completeness', ['Complete', 'Partially Complete', 'Not Started', 'No Requirements'])),
    screening: optional(oneOf('Screening result', ['Confirmed', 'Potential Match', 'No Match', 'Not Screened'])),
    priority: optional(oneOf('Priority', PRIORITIES)),
    caseType: optional(oneOf('Case type', CASE_TYPES)),
    severity: optional(z.string().trim().refine((v) => v.split(',').every((s) => SEVERITIES.includes(s.trim())), `Severity must be one or more of: ${SEVERITIES.join(', ')}`)),
    alertType: optional(oneOf('Alert type', Object.keys(ALERT_TYPES))),
    actionType: optional(oneOf('Action', Object.keys(AUDIT_ACTIONS))),
    category: optional(oneOf('Category', AUDIT_CATEGORIES)),
    entityType: optional(oneOf('Entity type', AUDIT_ENTITY_TYPES)),
  })
  .superRefine(orderedDates);


module.exports = {
  auditQuerySchema, alertQuerySchema, alertAcknowledgeSchema, alertStatusSchema, alertResolveSchema, analyticsQuerySchema,
  validationRunQuerySchema, validationIssueQuerySchema, exportQuerySchema,
};
