/**
 * Onboarding approval policy (decided by the product owner, see docs/phase6-features.md "Approval policy").
 *
 *   - An OPEN exception (status Open or In Review) with severity Critical or High BLOCKS approval.
 *   - Open Medium or Low exceptions do not block, but approving needs a recorded rationale (the decision's reason) AND a follow-up action.
 *   - With no open exception, approval follows the existing rule: every mandatory document verified and unexpired.
 *   - A Reviewer or Admin can WAIVE a blocking exception for one approval, only with a non-empty reason; the waiver is recorded in the
 *     audit trail in the same transaction as the decision. The exception itself is left as it is (it stays open until it is resolved).
 *   - Missing or invalid mandatory evidence can never be waived.
 *   - Rejecting is not affected by exceptions.
 */
const BLOCKING_SEVERITIES = ['Critical', 'High'];
const FOLLOW_UP_SEVERITIES = ['Medium', 'Low'];

const LIMITS = {
  reasonMax: 1000,
  followUpMax: 500,
  waiverReasonMax: 500,
  maxWaivers: 20,
};

module.exports = { BLOCKING_SEVERITIES, FOLLOW_UP_SEVERITIES, LIMITS };
