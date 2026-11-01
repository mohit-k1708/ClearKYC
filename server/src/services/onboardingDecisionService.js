/**
 * Onboarding decisions: a Reviewer or Admin approves or rejects a customer's onboarding.
 *
 * Rules (documented in docs/phase6-features.md):
 *   - the customer must exist; the person must be an active Reviewer/Admin (requireReviewer, and a database trigger);
 *   - a reason is required for both decisions (also a database CHECK);
 *   - workflow: Pending Review -> Approved | Rejected. Both are FINAL: a customer has at most one final decision (unique index), so a
 *     second decision is refused with 409 instead of overwriting the first;
 *   - APPROVING needs every mandatory document to be verified and unexpired today (completeness "Complete"), which is the same standard
 *     the APPROVED_WITH_MISSING_EVIDENCE detector applies to existing approvals. This can never be waived. Rejecting never needs evidence;
 *   - APPROVAL POLICY for open exceptions (config/approvalPolicy.js):
 *       open Critical / High exception        blocks approval, unless a Reviewer / Admin WAIVES it with a reason (audited)
 *       open Medium / Low exception           does not block, but needs a follow-up action in addition to the reason (the rationale)
 *       no open exception                     the evidence rule above only
 *     Before an approval is judged, the customer's exceptions are refreshed (the same per-customer detection other flows run, without
 *     creating cases), so a problem that appeared since the last detection run cannot slip through;
 *   - history is insert-only: nothing is updated or deleted. Each decision writes an audit event in the same transaction (with the
 *     follow-up action and the exceptions open at that moment) and one ONBOARDING_EXCEPTION_WAIVED event per waiver. A waiver does not
 *     change the exception: its status and history stay as they are.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { AppError, badRequest, conflict } = require('../utils/errors');
const { findCustomer, getCompleteness } = require('./kycService');
const { syncCustomer } = require('./exceptionService');
const audit = require('./auditService');
const { AUTHORISED_ROLES } = require('../config/kycRules');
const { EXCEPTION_TYPES, ACTIVE_EXCEPTION_STATUSES, SEVERITY_RANK } = require('../config/reviewRules');
const { BLOCKING_SEVERITIES, FOLLOW_UP_SEVERITIES, LIMITS } = require('../config/approvalPolicy');

const FINAL = ['Approved', 'Rejected'];
const PENDING = 'Pending Review';

const dto = (d) => ({
  id: d.id,
  decision: d.decision,
  reason: d.notes,
  decidedAt: d.decidedAt,
  decidedBy: d.decidedBy ? { id: d.decidedBy.id, name: d.decidedBy.name, role: d.decidedBy.role } : null,
});

const exceptionDto = (e) => ({
  id: e.id,
  exceptionId: e.exceptionCode,
  exceptionType: e.exceptionType,
  typeLabel: EXCEPTION_TYPES[e.exceptionType]?.label ?? e.exceptionType,
  severity: e.severity,
  status: e.status,
  description: e.description,
  detectedAt: e.detectedAt,
});

/** What would stop an approval today because of the evidence: mandatory evidence that is not verified and valid, or a missing rating. NOT waivable. */
async function approvalBlockers(customer) {
  if (!customer.riskLevel) return ['The customer has no risk rating yet, so the required documents cannot be determined.'];
  const kyc = await getCompleteness(customer.customerId);
  return kyc.requirements
    .filter((r) => r.isMandatory && r.state !== 'Verified')
    .map((r) => `${r.documentType}: ${r.state === 'Missing' ? 'not submitted' : r.state === 'Expired' ? 'expired' : r.state.toLowerCase()}`);
}

/** The customer's open exceptions (status Open or In Review), most severe first. `db` may be a transaction client. */
async function loadOpenExceptions(db, customerDbId) {
  const rows = await db.exception.findMany({ where: { customerId: customerDbId, status: { in: ACTIVE_EXCEPTION_STATUSES } }, orderBy: { id: 'asc' } });
  return rows.sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) || a.id - b.id);
}

const isBlocking = (e) => BLOCKING_SEVERITIES.includes(e.severity);
const needsFollowUp = (e) => FOLLOW_UP_SEVERITIES.includes(e.severity);

/** The policy outcome for the screen: what blocks, what only needs a follow-up, and what a reviewer can do about it. */
function describePolicy({ evidenceBlockers, openExceptions }) {
  const blocking = openExceptions.filter(isBlocking).map(exceptionDto);
  const nonBlocking = openExceptions.filter(needsFollowUp).map(exceptionDto);
  let outcome = 'Approvable';
  let explanation = 'No open exception and the mandatory evidence is complete: the customer can be approved.';
  if (evidenceBlockers.length > 0) {
    outcome = 'Blocked by evidence';
    explanation = 'Approval is not available: mandatory KYC evidence is missing or not valid. This cannot be waived. Reject, or complete the evidence first.';
  } else if (blocking.length > 0) {
    outcome = 'Needs waiver';
    explanation = `Approval is blocked by ${blocking.length} open Critical or High exception${blocking.length === 1 ? '' : 's'}. Resolve ${blocking.length === 1 ? 'it' : 'them'}, or a Reviewer or Admin can waive ${blocking.length === 1 ? 'it' : 'each one'} for this approval with a reason that is recorded in the audit trail.`;
  } else if (nonBlocking.length > 0) {
    outcome = 'Needs follow-up';
    explanation = `${nonBlocking.length} Medium or Low exception${nonBlocking.length === 1 ? ' is' : 's are'} open. They do not block approval, but approving needs your rationale and a follow-up action.`;
  }
  return { outcome, explanation, evidenceBlockers, blockingExceptions: blocking, nonBlockingExceptions: nonBlocking, requiresFollowUp: nonBlocking.length > 0 };
}

/** What each decision recorded besides its reason (follow-up action, exceptions open at that time, waivers), read from the audit trail. */
async function decisionExtras(customerDbId, decisionIds) {
  if (decisionIds.length === 0) return new Map();
  const events = await prisma.auditEvent.findMany({
    where: { customerId: customerDbId, actionType: { in: ['ONBOARDING_DECISION_RECORDED', 'ONBOARDING_EXCEPTION_WAIVED'] } },
    orderBy: { id: 'asc' },
  });
  const map = new Map(decisionIds.map((id) => [id, { followUpAction: null, exceptionsAtDecision: [], waivers: [] }]));
  for (const e of events) {
    if (e.actionType === 'ONBOARDING_DECISION_RECORDED' && map.has(e.entityId)) {
      const v = e.newValues ?? {};
      Object.assign(map.get(e.entityId), { followUpAction: v.followUpAction ?? null, exceptionsAtDecision: v.openExceptions ?? [] });
    } else if (e.actionType === 'ONBOARDING_EXCEPTION_WAIVED' && map.has(e.newValues?.decisionId)) {
      map.get(e.newValues.decisionId).waivers.push({ exceptionId: e.entityRef, exceptionType: e.newValues.exceptionType, severity: e.newValues.severity, reason: e.reason, waivedAt: e.createdAt });
    }
  }
  return map;
}

/** The customer's decisions (newest first), the current status, the approval policy outcome and what can be done next. */
async function getDecisions(idParam) {
  const customer = await findCustomer(idParam);
  const rows = await prisma.onboardingDecision.findMany({ where: { customerId: customer.id }, orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }], include: { decidedBy: true } });
  const final = rows.find((r) => FINAL.includes(r.decision)) ?? null;
  const status = final ? final.decision : PENDING;
  const extras = await decisionExtras(customer.id, rows.map((r) => r.id));
  const history = rows.map((r) => ({ ...dto(r), ...extras.get(r.id) }));

  let policy = null;
  let blockers = [];
  if (!final) {
    blockers = await approvalBlockers(customer);
    policy = describePolicy({ evidenceBlockers: blockers, openExceptions: await loadOpenExceptions(prisma, customer.id) });
  }
  return {
    customer: { id: customer.id, customerId: customer.customerId, name: customer.name, customerType: customer.customerType, riskLevel: customer.riskLevel },
    status,
    current: history[0] ?? null,
    history,
    // Approve is offered unless the EVIDENCE blocks it; open Critical / High exceptions then need a waiver (see `policy`)
    allowedDecisions: final ? [] : ['Rejected', ...(blockers.length === 0 ? ['Approved'] : [])],
    approvalBlockers: blockers,
    policy,
    isFinal: Boolean(final),
  };
}

/** Checks the shape of the optional fields. Returns { followUpAction, waivers } or throws 400 with a message per field. */
function parseExtras(input, errors) {
  const followUpAction = typeof input?.followUpAction === 'string' ? input.followUpAction.trim() : '';
  if (followUpAction.length > LIMITS.followUpMax) errors.followUpAction = `Use at most ${LIMITS.followUpMax} characters.`;

  const waivers = [];
  if (input?.waivers !== undefined && input?.waivers !== null) {
    if (!Array.isArray(input.waivers)) errors.waivers = 'Waivers must be a list of { exceptionId, reason }.';
    else if (input.waivers.length > LIMITS.maxWaivers) errors.waivers = `Waive at most ${LIMITS.maxWaivers} exceptions in one approval.`;
    else {
      const seen = new Set();
      for (const w of input.waivers) {
        const ref = String(w?.exceptionId ?? '').trim().toUpperCase();
        const reason = typeof w?.reason === 'string' ? w.reason.trim() : '';
        if (!/^(EXC-\d+|\d{1,9})$/.test(ref)) errors.waivers = 'Each waiver needs the exception ID (for example EXC-000012).';
        else if (!reason) errors.waivers = `Give a reason for waiving ${ref}. A waiver without a reason is not accepted.`;
        else if (reason.length > LIMITS.waiverReasonMax) errors.waivers = `The reason for waiving ${ref} must be at most ${LIMITS.waiverReasonMax} characters.`;
        else if (seen.has(ref)) errors.waivers = `${ref} is waived more than once.`;
        if (errors.waivers) break;
        seen.add(ref);
        waivers.push({ ref, reason });
      }
    }
  }
  return { followUpAction, waivers };
}

const blockedByExceptions = (list) => conflict(
  'APPROVAL_BLOCKED_BY_EXCEPTIONS',
  `This customer cannot be approved: ${list.length} open Critical or High exception${list.length === 1 ? '' : 's'} (${list.map((e) => e.exceptionCode).join(', ')}) must be resolved, or waived by a Reviewer or Admin with a reason.`,
  { blockingExceptions: list.map(exceptionDto) }
);

/**
 * Records a decision.
 * @param {string} idParam   customer business ID or numeric id
 * @param {{ decision: string, reason: string, followUpAction?: string, waivers?: { exceptionId: string, reason: string }[] }} input
 * @param {{ id: number, role: string }} actor   from requireReviewer
 */
async function recordDecision(idParam, input, actor) {
  const customer = await findCustomer(idParam); // 404 when the customer does not exist
  const decision = typeof input?.decision === 'string' ? input.decision.trim() : '';
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  const errors = {};
  if (!FINAL.includes(decision)) errors.decision = `Choose ${FINAL.join(' or ')}.`;
  if (!reason) errors.reason = 'Give a reason for the decision.';
  else if (reason.length > LIMITS.reasonMax) errors.reason = `Use at most ${LIMITS.reasonMax} characters.`;
  const { followUpAction, waivers } = parseExtras(input, errors);
  if (decision === 'Rejected' && waivers.length > 0) errors.waivers = 'A waiver only applies to an approval.';
  if (waivers.length > 0 && !AUTHORISED_ROLES.includes(actor.role)) {
    throw new AppError(403, 'NOT_AUTHORISED', `Only ${AUTHORISED_ROLES.join(' or ')} users can waive an exception.`);
  }
  if (Object.keys(errors).length > 0) throw badRequest('The decision is not valid', errors);

  const existing = await prisma.onboardingDecision.findFirst({ where: { customerId: customer.id, decision: { in: FINAL } }, orderBy: { id: 'desc' } });
  if (existing) {
    throw conflict('DECISION_FINAL', `This customer was already ${existing.decision.toLowerCase()}. A final decision is not changed or overwritten.`, { decision: existing.decision });
  }

  let openAtDecision = [];
  const waivedRows = [];
  if (decision === 'Approved') {
    // 1. the evidence rule: never waivable
    const blockers = await approvalBlockers(customer);
    if (blockers.length > 0) {
      throw conflict('APPROVAL_NOT_PERMITTED', 'This customer cannot be approved yet: mandatory KYC evidence is not complete.', { blockers });
    }
    // 2. exceptions: refresh them first so the judgement uses the current records, then apply the policy
    await syncCustomer(customer.id, { createCases: false });
    const open = await loadOpenExceptions(prisma, customer.id);
    const blocking = open.filter(isBlocking);
    const byRef = new Map(blocking.flatMap((e) => [[e.exceptionCode, e], [String(e.id), e]]));
    for (const w of waivers) {
      const row = byRef.get(w.ref);
      if (!row) {
        throw badRequest('The decision is not valid', { waivers: `${w.ref} is not an open Critical or High exception of this customer, so it cannot be waived (it may be resolved, Medium or Low, or belong to another customer).` });
      }
      waivedRows.push({ row, reason: w.reason });
    }
    const waivedIds = new Set(waivedRows.map((w) => w.row.id));
    const unwaived = blocking.filter((e) => !waivedIds.has(e.id));
    if (unwaived.length > 0) throw blockedByExceptions(unwaived);
    // 3. Medium / Low exceptions: a follow-up action is required in addition to the reason (the rationale)
    if (open.some(needsFollowUp) && !followUpAction) {
      throw badRequest('The decision is not valid', { followUpAction: 'Open Medium or Low exceptions need a follow-up action: say what will be done about them and by when.' });
    }
    openAtDecision = open.map((e) => ({ exceptionId: e.exceptionCode, exceptionType: e.exceptionType, severity: e.severity, status: e.status, waived: waivedIds.has(e.id) }));
  }

  let row;
  try {
    row = await prisma.$transaction(async (tx) => {
      if (decision === 'Approved') {
        // judged again inside the transaction: an exception that became Critical / High in the meantime stops the approval
        const waivedIds = new Set(waivedRows.map((w) => w.row.id));
        const now = (await loadOpenExceptions(tx, customer.id)).filter(isBlocking).filter((e) => !waivedIds.has(e.id));
        if (now.length > 0) throw blockedByExceptions(now);
      }
      const created = await tx.onboardingDecision.create({ data: { customerId: customer.id, decision, decidedById: actor.id, notes: reason }, include: { decidedBy: true } });
      await audit.record(tx, {
        actionType: 'ONBOARDING_DECISION_RECORDED',
        entityType: 'OnboardingDecision',
        entityId: created.id,
        entityRef: customer.customerId,
        customerId: customer.id,
        previousValues: { decision: PENDING },
        newValues: { decision, decidedAt: created.decidedAt, ...(followUpAction ? { followUpAction } : {}), ...(openAtDecision.length > 0 ? { openExceptions: openAtDecision } : {}) },
        reason,
        actor,
      });
      for (const { row: e, reason: why } of waivedRows) {
        await audit.record(tx, {
          actionType: 'ONBOARDING_EXCEPTION_WAIVED',
          entityType: 'Exception',
          entityId: e.id,
          entityRef: e.exceptionCode,
          customerId: customer.id,
          newValues: { decisionId: created.id, exceptionType: e.exceptionType, severity: e.severity, status: e.status, waivedForApprovalOf: customer.customerId },
          reason: why,
          actor,
        });
      }
      return created;
    });
  } catch (err) {
    // two decisions at the same moment: the unique index lets only one through
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw conflict('DECISION_FINAL', 'This customer already has a final decision. A final decision is not changed or overwritten.');
    }
    throw err;
  }
  return { decision: dto(row), ...(await getDecisions(customer.customerId)) };
}

module.exports = { getDecisions, recordDecision, describePolicy, FINAL, PENDING };
