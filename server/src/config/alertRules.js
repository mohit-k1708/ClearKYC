/**
 * Scene 5 alert rules.
 *
 * Alerts are DERIVED from the conditions the exception engine finds in real records (documents, ownership, risk
 * assessments, screening results and the periodic review schedule). Nothing here invents an alert: an alert exists only
 * while (or because) the underlying condition exists.
 *
 * !! PROTOTYPE ASSUMPTIONS: titles, severities (taken from the condition) and who may dismiss an alert are illustrative !!
 */

// alertType -> the exception types (conditions) that raise it
const ALERT_TYPES = {
  DOCUMENT_EXPIRY: { label: 'Document Expiry Alert', conditions: ['DOCUMENT_EXPIRING_SOON'] },
  DOCUMENT_EXPIRED: { label: 'Document Expired Alert', conditions: ['DOCUMENT_EXPIRED'] },
  MISSING_MANDATORY_DOCUMENT: { label: 'Missing Mandatory Document Alert', conditions: ['MANDATORY_DOCUMENT_MISSING'] },
  VERIFICATION_PENDING: { label: 'Verification Pending Alert', conditions: ['DOCUMENT_AWAITING_VERIFICATION'] },
  HIGH_RISK_CUSTOMER: { label: 'High-Risk Customer Alert', conditions: ['HIGH_RISK_CUSTOMER'] },
  OWNERSHIP_ISSUE: {
    label: 'Ownership Issue Alert',
    conditions: ['OWNERSHIP_NO_OWNERS', 'OWNERSHIP_EXCEEDS_100', 'OWNERSHIP_INCOMPLETE', 'OWNERSHIP_REQUIRES_INVESTIGATION'],
  },
  PERIODIC_REVIEW_DUE: { label: 'Periodic Review Due Alert', conditions: ['PERIODIC_REVIEW_DUE_SOON'] },
  PERIODIC_REVIEW_OVERDUE: { label: 'Periodic Review Overdue Alert', conditions: ['PERIODIC_REVIEW_OVERDUE'] },
  POTENTIAL_PEP_MATCH: { label: 'Potential PEP Match Alert', conditions: ['POTENTIAL_PEP_MATCH'] },
  POTENTIAL_SANCTIONS_MATCH: { label: 'Potential Sanctions Match Alert', conditions: ['POTENTIAL_SANCTIONS_MATCH'] },
};

/** condition (exception type) -> alert type */
const ALERT_TYPE_FOR_CONDITION = Object.fromEntries(Object.entries(ALERT_TYPES).flatMap(([type, v]) => v.conditions.map((c) => [c, type])));

const ALERT_STATUSES = ['New', 'Acknowledged', 'In Progress', 'Resolved', 'Dismissed'];
const ACTIVE_ALERT_STATUSES = ['New', 'Acknowledged', 'In Progress'];
const CLOSED_ALERT_STATUSES = ['Resolved', 'Dismissed'];

// Manual status changes. Resolved and Dismissed are final: a returning condition raises a NEW alert.
const ALERT_TRANSITIONS = {
  New: ['Acknowledged', 'In Progress', 'Resolved', 'Dismissed'],
  Acknowledged: ['In Progress', 'Resolved', 'Dismissed'],
  'In Progress': ['Resolved', 'Dismissed'],
  Resolved: [],
  Dismissed: [],
};

// Alert types that are an open question, not a fact: a person must investigate and RESOLVE them. They can never be dismissed,
// and only a compliance reviewer or an administrator can close them. (A potential match is never treated as confirmed.)
const INVESTIGATION_ALERT_TYPES = ['POTENTIAL_PEP_MATCH', 'POTENTIAL_SANCTIONS_MATCH'];
// Alerts of these severities cannot be dismissed ("important alerts are not dismissed automatically or casually").
const UNDISMISSABLE_SEVERITIES = ['Critical'];
// Who may dismiss an alert at all.
const DISMISS_ROLES = ['Reviewer', 'Admin'];
// Roles that may resolve / dismiss a High or Critical alert, or an investigation alert.
const SENIOR_ROLES = ['Reviewer', 'Admin'];

const MIN_REMARKS_LENGTH = 10;

module.exports = {
  ALERT_TYPES,
  ALERT_TYPE_FOR_CONDITION,
  ALERT_STATUSES,
  ACTIVE_ALERT_STATUSES,
  CLOSED_ALERT_STATUSES,
  ALERT_TRANSITIONS,
  INVESTIGATION_ALERT_TYPES,
  UNDISMISSABLE_SEVERITIES,
  DISMISS_ROLES,
  SENIOR_ROLES,
  MIN_REMARKS_LENGTH,
};
