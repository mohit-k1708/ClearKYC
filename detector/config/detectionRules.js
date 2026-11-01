/**
 * The anomaly categories the detector knows, with their severity and the rule parameters. This file is rule configuration only:
 * it contains no knowledge of any planted issue.
 */
const ISSUE_TYPES = {
  EXPIRED_DOCUMENT_MARKED_VALID: { entityType: 'Document', severity: 'HIGH', rule: 'expiredDocumentRule' },
  APPROVED_WITH_MISSING_EVIDENCE: { entityType: 'Customer', severity: 'HIGH', rule: 'missingEvidenceRule' },
  OWNERSHIP_OVER_100: { entityType: 'Customer', severity: 'HIGH', rule: 'ownershipRule' },
  CLOSED_WITHOUT_RESOLUTION: { entityType: 'ReviewCase', severity: 'MEDIUM', rule: 'closedCaseRule' },
  DOCUMENT_REUSED_ACROSS_CUSTOMERS: { entityType: 'Document', severity: 'HIGH', rule: 'duplicateDocumentRule' },
  DOCUMENT_NAME_MISMATCH: { entityType: 'Document', severity: 'MEDIUM', rule: 'nameMismatchRule' },
};

const PARAMETERS = {
  // A document shared between RELATED customers (companies with a common beneficial owner) is legitimate only for these types.
  // A PAN, a certificate of incorporation or a photograph belongs to exactly one customer and is never legitimately shared.
  shareableDocumentTypes: ['Address Proof', 'Bank Statement', 'Ownership Details', 'Financial Statements'],
};

module.exports = { ISSUE_TYPES, PARAMETERS, ORDER: Object.keys(ISSUE_TYPES) };
