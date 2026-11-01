/**
 * How many issues of each kind are planted per scale. If a dataset has fewer eligible records than requested, fewer are planted and
 * the shortfall is reported in the manifest (nothing is forced).
 */
const PLAN = {
  starter: { EXPIRED_DOCUMENT_MARKED_VALID: 2, APPROVED_WITH_MISSING_EVIDENCE: 2, OWNERSHIP_OVER_100: 2, CLOSED_WITHOUT_RESOLUTION: 1, DOCUMENT_REUSED_ACROSS_CUSTOMERS: 2, DOCUMENT_NAME_MISMATCH: 3, legitimateSharedDocuments: 1 },
  medium: { EXPIRED_DOCUMENT_MARKED_VALID: 10, APPROVED_WITH_MISSING_EVIDENCE: 10, OWNERSHIP_OVER_100: 8, CLOSED_WITHOUT_RESOLUTION: 8, DOCUMENT_REUSED_ACROSS_CUSTOMERS: 8, DOCUMENT_NAME_MISMATCH: 12, legitimateSharedDocuments: 5 },
  full: { EXPIRED_DOCUMENT_MARKED_VALID: 60, APPROVED_WITH_MISSING_EVIDENCE: 50, OWNERSHIP_OVER_100: 40, CLOSED_WITHOUT_RESOLUTION: 50, DOCUMENT_REUSED_ACROSS_CUSTOMERS: 40, DOCUMENT_NAME_MISMATCH: 70, legitimateSharedDocuments: 20 },
};

module.exports = { PLAN };
