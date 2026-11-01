/**
 * Scene 2 configuration: document types, verification statuses, expiry window, upload limits
 * and the SAMPLE default KYC requirements.
 *
 * !! The default requirements are configurable sample business rules, NOT universal
 * regulatory requirements. They can be changed on the "KYC Requirements" page. !!
 */

// Known document types. `requiresNumber` = a (synthetic) document number must be supplied.
// `validityDays` is only used by the synthetic data generator.
const DOCUMENT_TYPES = [
  { name: 'PAN', abbr: 'PAN', requiresNumber: true, validityDays: null },
  { name: 'Business PAN', abbr: 'BPAN', requiresNumber: true, validityDays: null },
  { name: 'Address Proof', abbr: 'ADDR', requiresNumber: true, validityDays: 365 },
  { name: 'Photograph', abbr: 'PHOTO', requiresNumber: false, validityDays: null },
  { name: 'Bank Statement', abbr: 'BANK', requiresNumber: true, validityDays: 180 },
  { name: 'Additional Evidence', abbr: 'EVID', requiresNumber: false, validityDays: 365 },
  { name: 'Certificate of Incorporation', abbr: 'COI', requiresNumber: true, validityDays: null },
  { name: 'Ownership Details', abbr: 'OWN', requiresNumber: false, validityDays: 365 },
  { name: 'Financial Statements', abbr: 'FIN', requiresNumber: false, validityDays: 365 },
];

const RISK_LEVELS = ['Low', 'Medium', 'High'];
const CUSTOMER_TYPES = ['Individual', 'Company'];

// "Pending" is created by the system when a document is submitted; reviewers record the rest.
const VERIFICATION_STATUSES = ['Pending', 'In Review', 'Verified', 'Rejected', 'Requires Resubmission'];
const REVIEWER_DECISIONS = ['In Review', 'Verified', 'Rejected', 'Requires Resubmission'];
// These decisions must come with an explanation.
const REMARKS_REQUIRED = ['Rejected', 'Requires Resubmission'];
const AUTHORISED_ROLES = ['Reviewer', 'Admin'];

// A document is "expiring soon" when it expires within this many days (inclusive of the 30th day).
const EXPIRY_WARNING_DAYS = 30;

// File uploads (local development storage).
const UPLOAD = {
  maxBytes: 2 * 1024 * 1024, // 2 MB
  // extension -> { mime types that are accepted for it }
  types: {
    pdf: { mime: 'application/pdf', magic: [0x25, 0x50, 0x44, 0x46] }, // %PDF
    jpg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
    png: { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  },
};

const EFFECTIVE_FROM_DEFAULT = '2026-01-01';
const R = (customerType, riskLevel, documents) => ({ customerType, riskLevel, documents });

// Sample rules from the specification. Medium and High build on the level below.
const INDIVIDUAL_LOW = ['PAN', 'Address Proof', 'Photograph'];
const INDIVIDUAL_MEDIUM = [...INDIVIDUAL_LOW, 'Bank Statement'];
const INDIVIDUAL_HIGH = [...INDIVIDUAL_MEDIUM, 'Additional Evidence'];
const COMPANY_LOW = ['Certificate of Incorporation', 'Business PAN', 'Address Proof'];
const COMPANY_MEDIUM = [...COMPANY_LOW, 'Ownership Details'];
const COMPANY_HIGH = [...COMPANY_MEDIUM, 'Financial Statements', 'Additional Evidence'];

const DEFAULT_REQUIREMENTS = [
  R('Individual', 'Low', INDIVIDUAL_LOW),
  R('Individual', 'Medium', INDIVIDUAL_MEDIUM),
  R('Individual', 'High', INDIVIDUAL_HIGH),
  R('Company', 'Low', COMPANY_LOW),
  R('Company', 'Medium', COMPANY_MEDIUM),
  R('Company', 'High', COMPANY_HIGH),
];

// Synthetic reviewers (there is no login yet). Only Reviewer/Admin may record decisions.
const DEFAULT_REVIEWERS = [
  { name: 'Asha Reviewer (demo)', email: 'asha.reviewer@example.com', role: 'Reviewer' },
  { name: 'Rahul Reviewer (demo)', email: 'rahul.reviewer@example.com', role: 'Reviewer' },
  { name: 'Meera Admin (demo)', email: 'meera.admin@example.com', role: 'Admin' },
  { name: 'Vikram Analyst (demo)', email: 'vikram.analyst@example.com', role: 'Analyst' },
];

const typeInfo = (name) => DOCUMENT_TYPES.find((t) => t.name === name);

module.exports = {
  DOCUMENT_TYPES,
  RISK_LEVELS,
  CUSTOMER_TYPES,
  VERIFICATION_STATUSES,
  REVIEWER_DECISIONS,
  REMARKS_REQUIRED,
  AUTHORISED_ROLES,
  EXPIRY_WARNING_DAYS,
  UPLOAD,
  EFFECTIVE_FROM_DEFAULT,
  DEFAULT_REQUIREMENTS,
  DEFAULT_REVIEWERS,
  typeInfo,
};
