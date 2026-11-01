/**
 * Request validation (zod) for Scene 2: requirements, documents, verifications and list queries.
 * Format checks only. A document number that passes these checks is NOT verified as genuine.
 */
const { z } = require('zod');
const { RISK_LEVELS, CUSTOMER_TYPES, VERIFICATION_STATUSES, REMARKS_REQUIRED } = require('../config/kycRules');
const { parseIso, todayIso } = require('./dates');

// ---- Building blocks -----------------------------------------------------------------------
// Forms send "" for empty optional inputs and multipart bodies are all strings: treat "" / null as "not provided".
const blankToUndefined = (v) => (v === '' || v === null ? undefined : v);
const optional = (schema) => z.preprocess(blankToUndefined, schema.optional());

const text = (label, { min = 1, max = 200 } = {}) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` })
    .trim()
    .min(min, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`);

/** "YYYY-MM-DD", must be a real calendar date. */
const dateText = (label) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be a date (YYYY-MM-DD)` })
    .trim()
    .refine((v) => parseIso(v) !== null, `${label} must be a valid date (YYYY-MM-DD)`);

/** Booleans arrive as real booleans (JSON) or "true"/"false" (multipart / query string). */
const booleanLike = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean({ invalid_type_error: 'Must be true or false' }));

// ---- KYC requirements -------------------------------------------------------------------------
const requirementSchema = z
  .object({
    customerType: z.enum(CUSTOMER_TYPES, { errorMap: () => ({ message: `Customer type must be one of: ${CUSTOMER_TYPES.join(', ')}` }) }),
    riskLevel: z.enum(RISK_LEVELS, { errorMap: () => ({ message: `Risk level must be one of: ${RISK_LEVELS.join(', ')}` }) }),
    documentType: text('Document type', { min: 2, max: 60 }),
    isMandatory: booleanLike.default(true),
    effectiveFrom: z.preprocess(blankToUndefined, dateText('Effective from').default(() => todayIso())),
    effectiveTo: z.preprocess(blankToUndefined, dateText('Effective to').nullish()),
    isActive: booleanLike.default(true),
  })
  .superRefine((v, ctx) => {
    if (v.effectiveTo && v.effectiveTo < v.effectiveFrom) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['effectiveTo'], message: 'Effective to must be on or after Effective from' });
    }
  });

const requirementStatusSchema = z.object({ isActive: booleanLike }).strict();

const requirementQuerySchema = z.object({
  customerType: optional(z.enum(CUSTOMER_TYPES)),
  riskLevel: optional(z.enum(RISK_LEVELS)),
  isActive: optional(booleanLike),
  search: optional(z.string().trim().max(60)),
});

// ---- Documents -----------------------------------------------------------------------------------
// Synthetic document numbers: letters, digits, dash, slash, space.
const DOCUMENT_NUMBER_FORMAT = /^[A-Za-z0-9][A-Za-z0-9\-/ ]{2,39}$/;

const documentFields = {
  documentType: text('Document type', { max: 60 }),
  documentNumber: optional(
    z.string().trim().regex(DOCUMENT_NUMBER_FORMAT, 'Document number must be 3-40 characters: letters, digits, dash, slash or space')
  ),
  issueDate: dateText('Issue date').refine((v) => !parseIso(v) || v <= todayIso(), 'Issue date cannot be in the future'),
  expiryDate: optional(dateText('Expiry date')),
  submissionDate: z.preprocess(blankToUndefined, dateText('Submission date').default(() => todayIso())),
  notes: optional(z.string().trim().max(1000, 'Notes must be at most 1000 characters')),
  // The name printed on the document. Absent = not given (an edit keeps the stored value); blank = not recorded (an edit clears it).
  nameOnDocument: z.preprocess((v) => (typeof v === 'string' ? v.trim() : v), z.string().max(200, 'Name on document must be at most 200 characters').optional()),
};

function documentDateRules(v, ctx) {
  if (v.submissionDate && v.submissionDate > todayIso()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['submissionDate'], message: 'Submission date cannot be in the future' });
  }
  if (v.submissionDate && v.issueDate && v.submissionDate < v.issueDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['submissionDate'], message: 'Submission date cannot be before the issue date' });
  }
  if (v.expiryDate && v.issueDate && v.expiryDate < v.issueDate) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['expiryDate'], message: 'Expiry date cannot be before the issue date' });
  }
}

const documentCreateSchema = z
  .object({
    // The business ID chosen in the customer picker, e.g. CUS-000001.
    customerId: z
      .string({ required_error: 'Customer is required' })
      .trim()
      .regex(/^CUS-\d{6,}$/i, 'Customer ID must look like CUS-000001')
      .transform((v) => v.toUpperCase()),
    ...documentFields,
  })
  .superRefine(documentDateRules);

// The owner of a document cannot be changed, so customerId is not part of the update schema.
const documentUpdateSchema = z.object(documentFields).superRefine(documentDateRules);

const EXPIRY_FILTERS = ['Valid', 'Expiring Soon', 'Expired', 'No Expiry'];
const documentQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  search: optional(z.string().trim().max(100)),
  status: optional(z.enum(VERIFICATION_STATUSES, { errorMap: () => ({ message: `Status must be one of: ${VERIFICATION_STATUSES.join(', ')}` }) })),
  expiry: optional(z.enum(EXPIRY_FILTERS, { errorMap: () => ({ message: `Expiry must be one of: ${EXPIRY_FILTERS.join(', ')}` }) })),
  documentType: optional(z.string().trim().max(60)),
  customerId: optional(z.string().trim().regex(/^CUS-\d{6,}$/i, 'Customer ID must look like CUS-000001')),
});

// ---- Verification --------------------------------------------------------------------------------------
const verificationSchema = z
  .object({
    status: z.string({ required_error: 'Status is required' }).trim(),
    remarks: optional(z.string().trim().max(1000, 'Remarks must be at most 1000 characters')),
  })
  .superRefine((v, ctx) => {
    if (!VERIFICATION_STATUSES.includes(v.status)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: `Status must be one of: ${VERIFICATION_STATUSES.join(', ')}` });
    } else if (v.status === 'Pending') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['status'], message: 'Pending is set by the system when a document is submitted. Choose In Review, Verified, Rejected or Requires Resubmission' });
    } else if (REMARKS_REQUIRED.includes(v.status) && !v.remarks) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['remarks'], message: `Remarks are required when the decision is ${v.status}` });
    }
  });

// ---- Exceptions ------------------------------------------------------------------------------------------
const exceptionQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(15),
  type: optional(z.enum(['MISSING_DOCUMENT', 'PENDING_VERIFICATION', 'REJECTED', 'REQUIRES_RESUBMISSION', 'EXPIRED', 'EXPIRING_SOON'])),
  customerType: optional(z.enum(CUSTOMER_TYPES)),
  risk: optional(z.enum(RISK_LEVELS)),
  search: optional(z.string().trim().max(100)),
});

module.exports = {
  requirementSchema,
  requirementStatusSchema,
  requirementQuerySchema,
  documentCreateSchema,
  documentUpdateSchema,
  documentQuerySchema,
  verificationSchema,
  exceptionQuerySchema,
  EXPIRY_FILTERS,
};
