/**
 * Scene 5 audit rules: which actions are recorded, and which values must never be stored.
 *
 * Every action type used by the backend must be listed here (auditService.record refuses unknown ones), so the
 * Audit Trail page can offer a complete filter and a readable label for each.
 */

// category: the part of the KYC lifecycle the action belongs to (used for filtering and the labels in the UI)
const AUDIT_ACTIONS = {
  // Customer onboarding
  CUSTOMER_CREATED: { label: 'Customer created', category: 'Customer' },
  CUSTOMER_UPDATED: { label: 'Customer details updated', category: 'Customer' }, // reserved: no customer edit feature exists yet
  RISK_CLASSIFICATION_CHANGED: { label: 'Risk classification changed', category: 'Risk' },
  ONBOARDING_DECISION_RECORDED: { label: 'Onboarding decision recorded', category: 'Customer' },
  ONBOARDING_EXCEPTION_WAIVED: { label: 'Exception waived for an onboarding approval', category: 'Customer' },

  // Document management
  DOCUMENT_SUBMITTED: { label: 'Document submitted', category: 'Document' },
  DOCUMENT_UPDATED: { label: 'Document metadata updated', category: 'Document' },
  VERIFICATION_STARTED: { label: 'Verification started', category: 'Document' },
  DOCUMENT_VERIFIED: { label: 'Document verified', category: 'Document' },
  DOCUMENT_NAME_MISMATCH_FLAGGED: { label: 'Document name differs from registered name', category: 'Document' },
  DOCUMENT_REJECTED: { label: 'Document rejected', category: 'Document' },
  DOCUMENT_RESUBMISSION_REQUESTED: { label: 'Document resubmission requested', category: 'Document' },
  VERIFICATION_RESET: { label: 'Verification reset to pending', category: 'Document' },
  REQUIREMENT_CREATED: { label: 'KYC requirement created', category: 'Document' },
  REQUIREMENT_UPDATED: { label: 'KYC requirement updated', category: 'Document' },
  REQUIREMENT_STATUS_CHANGED: { label: 'KYC requirement activated or deactivated', category: 'Document' },

  // Ownership and risk
  OWNER_ADDED: { label: 'Beneficial owner added', category: 'Ownership' },
  OWNER_UPDATED: { label: 'Beneficial owner updated', category: 'Ownership' },
  OWNERSHIP_PERCENTAGE_CHANGED: { label: 'Ownership percentage changed', category: 'Ownership' },
  OWNERSHIP_VALIDATED: { label: 'Ownership validation performed', category: 'Ownership' },
  SCREENING_RECORDED: { label: 'Screening result recorded', category: 'Risk' },
  RISK_ASSESSMENT_CREATED: { label: 'Risk assessment created', category: 'Risk' },

  // Review cases
  CASE_CREATED: { label: 'Case created', category: 'Case' },
  CASE_ASSIGNED: { label: 'Case assigned', category: 'Case' },
  CASE_PRIORITY_CHANGED: { label: 'Case priority changed', category: 'Case' },
  CASE_STATUS_CHANGED: { label: 'Case status changed', category: 'Case' },
  CASE_ESCALATED: { label: 'Case escalated', category: 'Case' },
  CASE_RESOLVED: { label: 'Case resolved', category: 'Case' },
  CASE_CLOSED: { label: 'Case closed', category: 'Case' },
  CASE_REOPENED: { label: 'Case reopened', category: 'Case' },
  CASE_NOTE_ADDED: { label: 'Case note added', category: 'Case' },
  REVIEW_SCHEDULE_CREATED: { label: 'Periodic review scheduled', category: 'Case' },
  REVIEW_SCHEDULE_REBASED: { label: 'Periodic review re-scheduled after a risk change', category: 'Case' },
  PERIODIC_REVIEW_COMPLETED: { label: 'Periodic review completed', category: 'Case' },

  // Exceptions and alerts
  EXCEPTION_DETECTED: { label: 'Exception detected', category: 'Alert' },
  EXCEPTION_RESOLVED: { label: 'Exception resolved', category: 'Alert' },
  ALERT_GENERATED: { label: 'Alert generated', category: 'Alert' },
  DETECTION_JOB_FINISHED: { label: 'Detection run finished', category: 'Alert' },
  ALERT_ACKNOWLEDGED: { label: 'Alert acknowledged', category: 'Alert' },
  ALERT_STATUS_CHANGED: { label: 'Alert status changed', category: 'Alert' },
  ALERT_RESOLVED: { label: 'Alert resolved', category: 'Alert' },
  ALERT_DISMISSED: { label: 'Alert dismissed', category: 'Alert' },

  // Reporting
  DATA_VALIDATION_RUN: { label: 'Data quality validation run', category: 'Reporting' },
  EXPORT_GENERATED: { label: 'Report exported', category: 'Reporting' },
  SETTING_CHANGED: { label: 'Setting changed', category: 'Reporting' },
};

// The business actions shown in the "Recent activity" feed on the Overview. System bookkeeping (detection runs, alert generation,
// exports, validation runs, schedules) is left out so the feed reads as what people did to customers and cases.
const ACTIVITY_FEED_ACTIONS = [
  'CUSTOMER_CREATED', 'DOCUMENT_SUBMITTED', 'DOCUMENT_VERIFIED', 'DOCUMENT_REJECTED', 'DOCUMENT_RESUBMISSION_REQUESTED',
  'RISK_CLASSIFICATION_CHANGED', 'OWNER_ADDED', 'OWNERSHIP_PERCENTAGE_CHANGED', 'SCREENING_RECORDED',
  'CASE_CREATED', 'CASE_ASSIGNED', 'CASE_ESCALATED', 'CASE_RESOLVED', 'CASE_CLOSED', 'CASE_REOPENED',
  'PERIODIC_REVIEW_COMPLETED', 'ALERT_ACKNOWLEDGED', 'ALERT_RESOLVED', 'ALERT_DISMISSED',
];

const AUDIT_CATEGORIES = ['Customer', 'Document', 'Ownership', 'Risk', 'Case', 'Alert', 'Reporting'];

// Entity types an audit event can describe.
const AUDIT_ENTITY_TYPES = ['Customer', 'RiskRating', 'Document', 'Verification', 'KYCRequirement', 'BeneficialOwner', 'OnboardingDecision', 'OwnerScreening', 'OwnershipValidation', 'ReviewCase', 'ReviewSchedule', 'Exception', 'Alert', 'ValidationRun', 'Export', 'Setting', 'DetectionJob'];

const AUDIT_ROLES = ['Analyst', 'Reviewer', 'Admin', 'System'];

// Keys (compared in lower case, letters only) whose values are NEVER written to the audit trail.
const SENSITIVE_KEYS = new Set([
  'pan', 'pannumber', 'panhash', 'aadhaar', 'aadhaarnumber', 'aadhaarhash', 'passport', 'passportnumber',
  'password', 'passwordhash', 'authorization', 'cookie', 'apikey', 'documentnumber', 'documentnumberhash',
  'dateofbirth', 'dob', 'identityhash', 'encryptionkey', 'hashkey',
]);
const SENSITIVE_KEY_SUFFIXES = ['token', 'password', 'secret'];

// Free text is scanned too: anything that looks like a PAN or an Aadhaar number is masked.
const PAN_PATTERN = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;
const AADHAAR_PATTERN = /\b[0-9]{4}[ -]?[0-9]{4}[ -]?[0-9]{4}\b/g;

const MAX_TEXT_LENGTH = 500;

module.exports = { ACTIVITY_FEED_ACTIONS, AUDIT_ACTIONS, AUDIT_CATEGORIES, AUDIT_ENTITY_TYPES, AUDIT_ROLES, SENSITIVE_KEYS, SENSITIVE_KEY_SUFFIXES, PAN_PATTERN, AADHAAR_PATTERN, MAX_TEXT_LENGTH };
