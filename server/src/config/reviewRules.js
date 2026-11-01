/**
 * Scene 4 rules: exception types and severities, case types, workflow roles, SLA days, approval rules and the
 * periodic review intervals.
 *
 * !! PROTOTYPE ASSUMPTIONS - NOT REGULATORY REQUIREMENTS !!
 * The review intervals (36 / 24 / 12 months), the 30-day warning window, SLA days and severity choices are
 * illustrative and configurable. They are not legal requirements. Editing this file is the only change needed
 * to adjust them.
 */

// ---- Exceptions --------------------------------------------------------------------------------------
// group      which part of the system the exception comes from
// caseType   the case type suggested when a case is created from the exception
const EXCEPTION_TYPES = {
  MANDATORY_DOCUMENT_MISSING: { label: 'Mandatory document missing', group: 'Document', caseType: 'Missing Documents' },
  DOCUMENT_EXPIRED: { label: 'Document expired', group: 'Document', caseType: 'Expired Documents' },
  DOCUMENT_EXPIRING_SOON: { label: 'Document expiring within 30 days', group: 'Document', caseType: 'Expired Documents' },
  DOCUMENT_REJECTED: { label: 'Document rejected', group: 'Document', caseType: 'Verification Issues' },
  DOCUMENT_AWAITING_VERIFICATION: { label: 'Document awaiting verification', group: 'Document', caseType: 'Verification Issues' },
  DOCUMENT_REQUIRES_RESUBMISSION: { label: 'Mandatory document requires resubmission', group: 'Document', caseType: 'Verification Issues' },

  OWNERSHIP_NO_OWNERS: { label: 'Company has no beneficial owners', group: 'Ownership', caseType: 'Ownership Issues' },
  OWNERSHIP_EXCEEDS_100: { label: 'Ownership percentage exceeds 100%', group: 'Ownership', caseType: 'Ownership Issues' },
  OWNERSHIP_INCOMPLETE: { label: 'Ownership information incomplete', group: 'Ownership', caseType: 'Ownership Issues' },
  OWNERSHIP_REQUIRES_INVESTIGATION: { label: 'Ownership validation requires investigation', group: 'Ownership', caseType: 'Ownership Issues' },

  HIGH_RISK_CUSTOMER: { label: 'High-risk customer', group: 'Risk', caseType: 'High-Risk Review' },
  POTENTIAL_PEP_MATCH: { label: 'Potential PEP match', group: 'Risk', caseType: 'PEP Investigation' },
  POTENTIAL_SANCTIONS_MATCH: { label: 'Potential sanctions match', group: 'Risk', caseType: 'Sanctions Investigation' },
  CONFIRMED_SANCTIONS_MATCH: { label: 'Sanctions match recorded as confirmed', group: 'Risk', caseType: 'Sanctions Investigation' },
  RISK_MANUAL_REVIEW_REQUIRED: { label: 'Risk assessment requires manual review', group: 'Risk', caseType: 'High-Risk Review' },

  PERIODIC_REVIEW_OVERDUE: { label: 'Periodic review overdue', group: 'Review', caseType: 'Periodic KYC Review' },
  PERIODIC_REVIEW_DUE_SOON: { label: 'Periodic review approaching its due date', group: 'Review', caseType: 'Periodic KYC Review' },
  PREVIOUS_REVIEW_UNRESOLVED: { label: 'Previous review closed without proper resolution', group: 'Review', caseType: 'Other' },
};

const SEVERITIES = ['Low', 'Medium', 'High', 'Critical'];
const SEVERITY_RANK = { Low: 1, Medium: 2, High: 3, Critical: 4 };
const EXCEPTION_STATUSES = ['Open', 'In Review', 'Resolved'];
const ACTIVE_EXCEPTION_STATUSES = ['Open', 'In Review'];

// Days a document may wait for verification before the exception becomes Medium, and "expiring soon" escalation.
const SEVERITY_RULES = {
  awaitingVerificationDaysToMedium: 14,
  expiringSoonDaysToMedium: 7,
  periodicOverdueDaysToHigh: 30,
  periodicOverdueDaysToCritical: 90,
};

// ---- Cases ----------------------------------------------------------------------------------------------
const CASE_TYPES = [
  'Missing Documents',
  'Expired Documents',
  'Verification Issues',
  'Ownership Issues',
  'High-Risk Review',
  'PEP Investigation',
  'Sanctions Investigation',
  'Periodic KYC Review',
  'Other',
];
const CASE_STATUSES = ['Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated', 'Resolved', 'Closed'];
const ACTIVE_CASE_STATUSES = ['Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated'];
const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];

// Days from creation to the due date, by priority.
const SLA_DAYS = { Critical: 3, High: 7, Medium: 14, Low: 30 };

// Compliance reviewer approval is required before these cases can be resolved. A case also needs approval when the
// customer's current risk level is High, or the priority is Critical.
const APPROVAL_REQUIRED = {
  caseTypes: ['High-Risk Review', 'PEP Investigation', 'Sanctions Investigation', 'Ownership Issues'],
  customerRiskLevels: ['High'],
  priorities: ['Critical'],
};

// Minimum length of resolution notes and remarks that must be explained.
const MIN_NOTE_LENGTH = 10;

// ---- Roles --------------------------------------------------------------------------------------------------
// The existing demo people have a role of Analyst, Reviewer or Admin. Scene 4 names them like this:
const ROLE_LABELS = { Analyst: 'Operations Analyst', Reviewer: 'Compliance Reviewer', Admin: 'Administrator' };

// ---- Periodic KYC review ---------------------------------------------------------------------------------------
const PERIODIC_REVIEW = {
  // Illustrative intervals in months. Configurable. NOT legal requirements.
  intervalMonths: { Low: 36, Medium: 24, High: 12 },
  // "Upcoming" and the "due soon" exception: due within this many days.
  upcomingDays: 30,
};

// Extra demo people for the seed script (analysts to assign cases to, and a second compliance reviewer).
const SCENE4_DEMO_USERS = [
  { name: 'Priya Analyst (demo)', email: 'priya.analyst@example.com', role: 'Analyst' },
  { name: 'Arjun Analyst (demo)', email: 'arjun.analyst@example.com', role: 'Analyst' },
  { name: 'Neha Compliance (demo)', email: 'neha.compliance@example.com', role: 'Reviewer' },
];

/** Case type for a manual case or exception type (falls back to Other). */
const caseTypeForException = (type) => EXCEPTION_TYPES[type]?.caseType ?? 'Other';

module.exports = {
  EXCEPTION_TYPES,
  SEVERITIES,
  SEVERITY_RANK,
  EXCEPTION_STATUSES,
  ACTIVE_EXCEPTION_STATUSES,
  SEVERITY_RULES,
  CASE_TYPES,
  CASE_STATUSES,
  ACTIVE_CASE_STATUSES,
  PRIORITIES,
  SLA_DAYS,
  APPROVAL_REQUIRED,
  MIN_NOTE_LENGTH,
  ROLE_LABELS,
  PERIODIC_REVIEW,
  SCENE4_DEMO_USERS,
  caseTypeForException,
};
