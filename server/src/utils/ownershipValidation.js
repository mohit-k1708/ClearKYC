/**
 * Request validation (zod) for Scene 3: beneficial owners, screening, assessments and list queries.
 */
const { z } = require('zod');
const { COUNTRIES } = require('../config/options');
const { RISK_LEVELS, CUSTOMER_TYPES } = require('../config/kycRules');
const { OWNERSHIP_TYPES, PEP_STATUSES, CONTROL_TYPES, SCREENING_TYPES, SCREENING_RESULTS, VALIDATION_STATUSES, ASSESSMENT_STATUSES } = require('../config/ownershipRules');
const { parseIso, todayIso } = require('./dates');

// Forms send "" for empty optional inputs: treat "" / null as "not provided".
const blankToUndefined = (v) => (v === '' || v === null ? undefined : v);
const optional = (schema) => z.preprocess(blankToUndefined, schema.optional());

const text = (label, { min = 1, max = 200 } = {}) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` })
    .trim()
    .min(min, min === 1 ? `${label} is required` : `${label} must be at least ${min} characters`)
    .max(max, `${label} must be at most ${max} characters`);

const countryCode = (label) =>
  optional(
    z
      .string()
      .trim()
      .toUpperCase()
      .refine((c) => Object.hasOwn(COUNTRIES, c), `${label} must be a supported country`)
  );

/** Ownership percentage: greater than 0 and at most 100, with at most two decimals. Blank = not yet known. */
const percentage = z.preprocess(
  (v) => {
    if (v === '' || v === null || v === undefined) return undefined;
    if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
    return v;
  },
  z
    .number({ invalid_type_error: 'Ownership percentage must be a number' })
    .gt(0, 'Ownership percentage must be greater than 0')
    .lte(100, 'Ownership percentage cannot be more than 100')
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, 'Ownership percentage can have at most 2 decimal places')
    .optional()
);

const oneOf = (label, values) => z.enum(values, { errorMap: () => ({ message: `${label} must be one of: ${values.join(', ')}` }) });

const ownerSchema = z.object({
  fullName: text('Owner full name', { min: 2, max: 150 }),
  dateOfBirth: optional(
    z
      .string()
      .trim()
      .refine((v) => parseIso(v) !== null, 'Date of birth must be a valid date (YYYY-MM-DD)')
      .refine((v) => !parseIso(v) || v <= todayIso(), 'Date of birth cannot be in the future')
      .refine((v) => !parseIso(v) || v >= '1900-01-01', 'Date of birth is not plausible')
  ),
  countryOfResidence: countryCode('Country of residence'),
  nationality: countryCode('Nationality'),
  ownershipPercentage: percentage,
  ownershipType: oneOf('Ownership type', OWNERSHIP_TYPES),
  controlType: oneOf('Control type', CONTROL_TYPES),
  pepStatus: z.preprocess(blankToUndefined, oneOf('PEP status', PEP_STATUSES).default('Unknown')),
  notes: optional(z.string().trim().max(1000, 'Notes must be at most 1000 characters')),
});

const screeningSchema = z
  .object({
    screeningType: oneOf('Screening type', SCREENING_TYPES),
    // "simulated" matches the owner's name against the fictional demo list. "manual" records a synthetic outcome you choose.
    mode: z.preprocess(blankToUndefined, z.enum(['simulated', 'manual'], { errorMap: () => ({ message: 'Mode must be simulated or manual' }) }).default('manual')),
    screeningResult: optional(oneOf('Screening result', SCREENING_RESULTS)),
    remarks: optional(z.string().trim().max(1000, 'Remarks must be at most 1000 characters')),
  })
  .superRefine((v, ctx) => {
    if (v.mode === 'manual' && !v.screeningResult) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['screeningResult'], message: `Choose a screening result: ${SCREENING_RESULTS.join(', ')}` });
    }
    if (v.mode === 'manual' && v.screeningResult && v.screeningResult !== 'No Match' && !v.remarks) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['remarks'], message: `Remarks are required when the result is ${v.screeningResult}` });
    }
  });

const booleanLike = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

const assessmentSchema = z.object({
  // Records a new assessment even if nothing changed since the last one.
  force: z.preprocess(blankToUndefined, booleanLike.default(false)),
  remarks: optional(z.string().trim().max(500, 'Remarks must be at most 500 characters')),
});

const paging = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
};

const ownershipOverviewQuerySchema = z.object({
  ...paging,
  search: optional(z.string().trim().max(100)),
  status: optional(oneOf('Status', VALIDATION_STATUSES)),
});

const dateOnly = (label) => optional(z.string().trim().refine((v) => parseIso(v) !== null, `${label} must be a date (YYYY-MM-DD)`));

const riskAssessmentQuerySchema = z.object({
  ...paging,
  search: optional(z.string().trim().max(100)),
  riskLevel: optional(oneOf('Risk level', RISK_LEVELS)),
  status: optional(oneOf('Status', ASSESSMENT_STATUSES)),
  customerType: optional(oneOf('Customer type', CUSTOMER_TYPES)),
  customerId: optional(z.string().trim().regex(/^CUS-\d{6,}$/i, 'Customer ID must look like CUS-000001')),
  from: dateOnly('From'),
  to: dateOnly('To'),
});

module.exports = { ownerSchema, screeningSchema, assessmentSchema, ownershipOverviewQuerySchema, riskAssessmentQuerySchema };
