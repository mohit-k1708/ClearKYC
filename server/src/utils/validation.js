/**
 * Request validation (zod schemas) for the two registration forms.
 *
 * IMPORTANT: these checks only verify the *format* of PAN / Aadhaar. A well-formed value
 * does NOT prove that the identifier exists or belongs to the customer - that needs
 * verification against the issuing authority, which is outside Scene 1.
 */
const { z } = require('zod');
const { COUNTRIES, BUSINESS_ACTIVITIES } = require('../config/options');

// ---- Format rules (configurable) ----------------------------------------------------
// Indian PAN: 5 letters, 4 digits, 1 letter. The 4th letter is the holder type.
const PAN_FORMAT = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const INDIVIDUAL_PAN_HOLDER_TYPES = ['P']; // P = individual person
const COMPANY_PAN_HOLDER_TYPES = ['C', 'F', 'H', 'A', 'T', 'B', 'L', 'J', 'G']; // company, firm, HUF, AOP, trust ...
const AADHAAR_FORMAT = /^[0-9]{12}$/;
const EMAIL_FORMAT = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MIN_ADULT_AGE = 18;

// ---- Small reusable pieces ------------------------------------------------------------
const requiredText = (label, max = 200) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` })
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be at most ${max} characters`);

const email = (label) =>
  requiredText(label, 254)
    .regex(EMAIL_FORMAT, `${label} must be in a valid format (name@example.com)`)
    .transform((v) => v.toLowerCase());

/**
 * Phone: Indian mobile (10 digits starting 6-9, optional +91/91/0 prefix) or an international
 * number in E.164 style (+ followed by 8-15 digits). Spaces and dashes are ignored.
 * Normalised to "+91XXXXXXXXXX" for Indian numbers.
 */
function normalisePhone(raw) {
  const cleaned = raw.replace(/[\s-]/g, '');
  const indian = cleaned.match(/^(?:\+91|91|0)?([6-9][0-9]{9})$/);
  if (indian) return `+91${indian[1]}`;
  if (/^\+[1-9][0-9]{7,14}$/.test(cleaned)) return cleaned;
  return null;
}
const phone = (label) =>
  requiredText(label, 30).transform((value, ctx) => {
    const normalised = normalisePhone(value);
    if (!normalised) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} is not valid (use a 10-digit Indian mobile number or +<country code><number>)`,
      });
      return z.NEVER;
    }
    return normalised;
  });

const country = z
  .string({ required_error: 'Country is required' })
  .trim()
  .toUpperCase()
  .refine((code) => Object.hasOwn(COUNTRIES, code), 'Country is not a supported country code');

/** Parses "YYYY-MM-DD" into a UTC Date and rejects impossible dates such as 2020-02-31. */
function parseDateOnly(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}
const dateField = (label) =>
  requiredText(label, 10).transform((value, ctx) => {
    const date = parseDateOnly(value);
    if (!date) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} must be a valid date (YYYY-MM-DD)` });
      return z.NEVER;
    }
    if (date.getTime() > Date.now()) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label} cannot be in the future` });
      return z.NEVER;
    }
    return date;
  });

function ageInYears(dob, now = new Date()) {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < dob.getUTCMonth() ||
    (now.getUTCMonth() === dob.getUTCMonth() && now.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}

const panFor = (label, holderTypes, holderDescription) =>
  requiredText(label, 20)
    .transform((v) => v.toUpperCase())
    .refine((v) => PAN_FORMAT.test(v), `${label} must follow the PAN format AAAAA9999A (5 letters, 4 digits, 1 letter)`)
    .refine((v) => !PAN_FORMAT.test(v) || holderTypes.includes(v[3]), `${label}: the 4th letter should be ${holderDescription}`);

// ---- Schemas --------------------------------------------------------------------------
const individualSchema = z.object({
  fullName: requiredText('Full name', 150),
  dateOfBirth: dateField('Date of birth').refine(
    // A failed date transform yields a non-Date value here; that error is already reported.
    (dob) => !(dob instanceof Date) || ageInYears(dob) >= MIN_ADULT_AGE,
    `Customer must be at least ${MIN_ADULT_AGE} years old`
  ),
  email: email('Email address'),
  phone: phone('Phone number'),
  address: requiredText('Residential address', 500),
  panNumber: panFor('PAN number', INDIVIDUAL_PAN_HOLDER_TYPES, `"P" for an individual`),
  aadhaarNumber: requiredText('Aadhaar number', 20)
    .transform((v) => v.replace(/[\s-]/g, ''))
    .refine((v) => AADHAAR_FORMAT.test(v), 'Aadhaar number must contain exactly 12 digits'),
  occupation: requiredText('Occupation', 100),
  country,
});

const companySchema = z.object({
  legalName: requiredText('Legal company name', 200),
  registrationNumber: requiredText('Company registration number', 50).transform((v) => v.toUpperCase()),
  panNumber: panFor('Business PAN', COMPANY_PAN_HOLDER_TYPES, `one of ${COMPANY_PAN_HOLDER_TYPES.join(', ')} for a non-individual entity`),
  email: email('Business email'),
  phone: phone('Business phone'),
  address: requiredText('Registered office address', 500),
  country,
  businessActivity: requiredText('Business activity', 100).refine(
    (v) => BUSINESS_ACTIVITIES.includes(v),
    'Business activity must be one of the listed options'
  ),
  dateOfIncorporation: dateField('Date of incorporation'),
});

/** Turns a ZodError into { fieldName: "first message" } for the API response. */
function flattenZodError(error) {
  const fields = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    if (!fields[key]) fields[key] = issue.message;
  }
  return fields;
}

module.exports = {
  individualSchema,
  companySchema,
  flattenZodError,
  ageInYears,
  PAN_FORMAT,
  AADHAAR_FORMAT,
  COMPANY_PAN_HOLDER_TYPES,
};
