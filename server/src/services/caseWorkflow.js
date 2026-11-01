/**
 * Review case workflow (pure functions: no database).
 *
 * The BACKEND decides which status changes are allowed, who may make them, and what each needs. The frontend asks
 * `allowedActions()` and only shows those buttons, but it is never trusted: the service re-checks every request.
 *
 * Roles (the existing demo people):
 *   Analyst   = Operations Analyst   works the case they are assigned to
 *   Reviewer  = Compliance Reviewer  reviews escalated cases, approves or rejects resolutions
 *   Admin     = both, plus may act on any case
 *
 * Status flow
 *   Open -> Assigned -> In Progress -> (Pending Customer <-> In Progress) -> Resolved -> Closed
 *                        \-> Escalated (compliance reviewer) -> Resolved | back to In Progress
 *   Resolved / Closed -> reopened (recorded as a transition)
 *
 * Rules enforced here and in the database:
 *   - Resolved and Closed need resolution notes.
 *   - Cases that need compliance approval cannot be resolved by the analyst: they are submitted for review.
 *   - The person who proposed a resolution cannot approve it (segregation of duties).
 *   - A potential sanctions or PEP match is investigated: nothing here treats it as confirmed.
 */
const { APPROVAL_REQUIRED, ACTIVE_CASE_STATUSES } = require('../config/reviewRules');

/**
 * needs: payload fields the action requires.
 *   remarks          why (stored in the history)
 *   resolutionNotes  the resolution explanation (stored on the case)
 *   reviewer         a compliance reviewer must be assigned (already, or chosen in the request)
 */
const ACTIONS = {
  start: { label: 'Start investigation', from: ['Open', 'Assigned'], to: 'In Progress', needs: [] },
  request_customer: { label: 'Request information from customer', from: ['In Progress'], to: 'Pending Customer', needs: ['remarks'] },
  customer_responded: { label: 'Customer responded', from: ['Pending Customer'], to: 'In Progress', needs: ['remarks'] },
  escalate: { label: 'Escalate', from: ['Assigned', 'In Progress', 'Pending Customer'], to: 'Escalated', needs: ['remarks', 'reviewer'] },
  submit_for_review: { label: 'Submit for review', from: ['In Progress'], to: 'Escalated', needs: ['resolutionNotes', 'reviewer'] },
  approve: { label: 'Approve resolution', from: ['Escalated'], to: 'Resolved', needs: [] },
  reject: { label: 'Reject resolution', from: ['Escalated'], to: 'In Progress', needs: ['remarks'] },
  return_to_analyst: { label: 'Return to analyst', from: ['Escalated'], to: 'In Progress', needs: ['remarks'] },
  resolve: { label: 'Resolve', from: ['In Progress', 'Escalated'], to: 'Resolved', needs: ['resolutionNotes'] },
  close: { label: 'Close', from: ['Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated', 'Resolved'], to: 'Closed', needs: [] },
  reopen: { label: 'Reopen', from: ['Resolved', 'Closed'], to: null /* In Progress, or Open if nobody is assigned */, needs: ['remarks'] },
};

/** Which action a plain "status" request means, when only one action leads there from the current status. */
function actionForStatus(current, target) {
  const matches = Object.entries(ACTIONS).filter(([, a]) => a.from.includes(current) && (a.to === target || (a.to === null && ['In Progress', 'Open'].includes(target))));
  return matches.length === 1 ? matches[0][0] : null;
}

const isAdmin = (a) => a.role === 'Admin';
const isAnalyst = (a) => a.role === 'Analyst';
const isReviewer = (a) => a.role === 'Reviewer';

/** Works the case as the analyst: the assigned analyst, or an Admin. */
const analystOwner = (a, c) => isAdmin(a) || (isAnalyst(a) && c.assignedAnalystId === a.id);
/** Acts as the compliance reviewer: an Admin, or a Reviewer who is the assigned reviewer (or no reviewer is assigned yet). */
const reviewerOk = (a, c) => isAdmin(a) || (isReviewer(a) && (c.assignedReviewerId == null || c.assignedReviewerId === a.id));
const anyReviewerRole = (a) => isAdmin(a) || isReviewer(a);

/** Does this case need compliance reviewer approval before it can be resolved? */
function requiresApproval({ caseType, priority, customerRiskLevel }) {
  return (
    APPROVAL_REQUIRED.caseTypes.includes(caseType) ||
    APPROVAL_REQUIRED.priorities.includes(priority) ||
    (customerRiskLevel != null && APPROVAL_REQUIRED.customerRiskLevels.includes(customerRiskLevel))
  );
}

/**
 * May `actor` perform `action` on case `c` right now?
 * @returns {{ok:boolean, reason?:string}}
 */
function check(action, c, actor) {
  const def = ACTIONS[action];
  if (!def) return { ok: false, reason: `Unknown action "${action}"` };
  if (!def.from.includes(c.status)) return { ok: false, reason: `"${def.label}" is not possible while the case is ${c.status}` };

  const no = (reason) => ({ ok: false, reason });
  switch (action) {
    case 'start':
      // An analyst may take an unassigned case and start it in one step.
      if (analystOwner(actor, c) || (isAnalyst(actor) && c.assignedAnalystId == null)) return { ok: true };
      return no('Only the assigned analyst can start the investigation');
    case 'request_customer':
    case 'customer_responded':
    case 'submit_for_review':
      return analystOwner(actor, c) ? { ok: true } : no('Only the assigned analyst can do this');
    case 'escalate':
      return analystOwner(actor, c) || reviewerOk(actor, c) ? { ok: true } : no('Only the assigned analyst or a compliance reviewer can escalate');
    case 'approve':
    case 'reject':
      if (!c.proposalPending) return no('There is no proposed resolution waiting for approval');
      if (!reviewerOk(actor, c)) return no('Only a compliance reviewer can approve or reject a proposed resolution');
      if (c.proposedById === actor.id) return no('You proposed this resolution, so someone else must approve or reject it');
      return { ok: true };
    case 'return_to_analyst':
      if (c.proposalPending) return no('A resolution is proposed: approve or reject it instead');
      return reviewerOk(actor, c) ? { ok: true } : no('Only a compliance reviewer can return a case to the analyst');
    case 'resolve':
      if (c.status === 'Escalated') {
        if (c.proposalPending && c.proposedById === actor.id) return no('You proposed this resolution, so someone else must approve it');
        return reviewerOk(actor, c) ? { ok: true } : no('Only a compliance reviewer can resolve an escalated case');
      }
      if (!analystOwner(actor, c)) return no('Only the assigned analyst can resolve the case');
      if (c.requiresApproval) return no('This case needs compliance reviewer approval: submit it for review instead of resolving it');
      return { ok: true };
    case 'close':
      if (c.status === 'Resolved') return analystOwner(actor, c) || reviewerOk(actor, c) ? { ok: true } : no('Only the assigned analyst or a compliance reviewer can close the case');
      return anyReviewerRole(actor) ? { ok: true } : no('Only a compliance reviewer can close a case that has not been resolved');
    case 'reopen':
      if (c.status === 'Resolved' && (analystOwner(actor, c) || reviewerOk(actor, c))) return { ok: true };
      if (anyReviewerRole(actor)) return { ok: true };
      return no('Only a compliance reviewer can reopen a closed case');
    default:
      return no('Not allowed');
  }
}

/** Status a reopened case returns to. */
const reopenStatus = (c) => (c.assignedAnalystId != null ? 'In Progress' : 'Open');

/** The target status of an action for a given case. */
const targetStatus = (action, c) => (action === 'reopen' ? reopenStatus(c) : ACTIONS[action].to);

/** Buttons to show this person on this case. */
function allowedActions(c, actor) {
  if (!actor) return [];
  return Object.entries(ACTIONS)
    .filter(([action]) => check(action, c, actor).ok)
    .map(([action, def]) => ({
      action,
      label: def.label,
      to: targetStatus(action, c),
      needs: def.needs.filter((n) => !(n === 'reviewer' && c.assignedReviewerId != null)),
      // closing a case that was never resolved needs the explanation in the request
      needsResolutionNotes: action === 'close' && c.status !== 'Resolved',
    }));
}

// ---- Assignment, priority and notes ------------------------------------------------------------------

/** Who may assign what. `analyst`: 'any' | 'self' | 'none'. */
function assignmentRights(c, actor) {
  if (!actor || c.status === 'Closed') return { analyst: 'none', reviewer: false, priorityMax: null };
  const analyst = isAdmin(actor) || isReviewer(actor) ? 'any' : isAnalyst(actor) && (c.assignedAnalystId == null || c.assignedAnalystId === actor.id) ? 'self' : 'none';
  const reviewer = isAdmin(actor) || isReviewer(actor);
  // The analyst working the case may set Low to High. Critical needs a compliance reviewer.
  const priorityMax = anyReviewerRole(actor) ? 'Critical' : analystOwner(actor, c) ? 'High' : null;
  return { analyst, reviewer, priorityMax };
}

/** Internal notes: the assigned analyst, the assigned (or any, when escalated) reviewer, and Admins. Not on closed cases. */
function canAddNote(c, actor) {
  if (!actor || c.status === 'Closed') return false;
  if (isAdmin(actor)) return true;
  if (isAnalyst(actor)) return c.assignedAnalystId === actor.id;
  if (isReviewer(actor)) return c.assignedReviewerId === actor.id || c.status === 'Escalated' || c.assignedReviewerId == null;
  return false;
}

const isActive = (status) => ACTIVE_CASE_STATUSES.includes(status);

module.exports = { ACTIONS, check, allowedActions, actionForStatus, targetStatus, reopenStatus, requiresApproval, assignmentRights, canAddNote, isActive };
