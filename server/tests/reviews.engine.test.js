/**
 * Scene 4 unit tests: exception detection engine, case workflow rules, review date arithmetic (no database).   npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/config/env');
const { detectConditions, keyOf } = require('../src/services/exceptionEngine');
const workflow = require('../src/services/caseWorkflow');
const { evaluateCustomerKyc } = require('../src/services/kycEngine');
const { validateOwnership, assessOwnerRisk, assessComplexity } = require('../src/services/ownershipEngine');
const { addMonths, addDays } = require('../src/utils/dates');
const { nextReviewFrom, scheduleState, intervalFor } = require('../src/services/reviewScheduleService');
const { PERIODIC_REVIEW, SLA_DAYS, EXCEPTION_TYPES, CASE_TYPES } = require('../src/config/reviewRules');
const { DEFAULT_REQUIREMENTS } = require('../src/config/kycRules');

const ASOF = '2026-10-22';
const customer = (over = {}) => ({ id: 7, code: 'CUS-000007', name: 'Demo Co', customerType: 'Individual', riskLevel: 'Low', ...over });

let rid = 1;
const REQS = DEFAULT_REQUIREMENTS.flatMap((g) => g.documents.map((documentType) => ({ id: rid++, customerType: g.customerType, riskLevel: g.riskLevel, documentType, isMandatory: true, isActive: true, effectiveFrom: '2026-01-01', effectiveTo: null })));
let did = 100;
const doc = (documentType, status, over = {}) => ({ id: did++, documentType, status, expiryDate: null, submissionDate: '2026-09-01', ...over });
const kycFor = (documents, c = customer()) => evaluateCustomerKyc({ customerType: c.customerType, riskLevel: c.riskLevel, requirements: REQS, documents, asOf: ASOF });
const detect = (over = {}) => detectConditions({ customer: customer(), kyc: null, ownership: null, rating: null, schedule: null, unresolvedClosedCases: [], asOf: ASOF, ...over });
const types = (conds) => conds.map((c) => c.type);

// ---- Document exceptions -------------------------------------------------------------------------------------------------
test('document exceptions come from the real evaluation: missing, expired, expiring, rejected, awaiting, resubmission', () => {
  const kyc = kycFor([
    doc('PAN', 'Verified', { expiryDate: addDays(ASOF, -5) }), // expired although verified
    doc('Address Proof', 'Rejected'),
    // Photograph: not submitted
  ]);
  const t = types(detect({ kyc }));
  assert.ok(t.includes('DOCUMENT_EXPIRED'));
  assert.ok(t.includes('DOCUMENT_REJECTED'));
  assert.ok(t.includes('MANDATORY_DOCUMENT_MISSING'));

  const kyc2 = kycFor([doc('PAN', 'Verified', { expiryDate: addDays(ASOF, 10) }), doc('Address Proof', 'Pending', { submissionDate: addDays(ASOF, -30) }), doc('Photograph', 'Requires Resubmission')]);
  const t2 = types(detect({ kyc: kyc2 }));
  assert.ok(t2.includes('DOCUMENT_EXPIRING_SOON'));
  assert.ok(t2.includes('DOCUMENT_AWAITING_VERIFICATION'));
  assert.ok(t2.includes('DOCUMENT_REQUIRES_RESUBMISSION'));
});

test('every condition has a stable dedupe key and links to its source record', () => {
  const kyc = kycFor([doc('PAN', 'Verified', { expiryDate: addDays(ASOF, -5) })]);
  const a = detect({ kyc });
  const b = detect({ kyc });
  assert.deepEqual(a.map((c) => c.key), b.map((c) => c.key)); // the same records give the same keys, so no duplicates
  const expired = a.find((c) => c.type === 'DOCUMENT_EXPIRED');
  assert.equal(expired.sourceType, 'Document');
  assert.ok(expired.sourceId >= 100);
  assert.equal(expired.key, keyOf(7, 'DOCUMENT_EXPIRED', 'Document', expired.sourceId));
  const missing = a.find((c) => c.type === 'MANDATORY_DOCUMENT_MISSING');
  assert.equal(missing.sourceType, 'KYCRequirement');
});

test('severity follows the documented rules', () => {
  const low = customer({ riskLevel: 'Low' });
  const high = customer({ riskLevel: 'High' });
  const sev = (c, type, docs) => detect({ customer: c, kyc: kycFor(docs, c) }).find((x) => x.type === type)?.severity;
  assert.equal(sev(low, 'MANDATORY_DOCUMENT_MISSING', []), 'Medium');
  assert.equal(sev(high, 'MANDATORY_DOCUMENT_MISSING', []), 'High'); // a High-risk customer raises it a step
  assert.equal(sev(low, 'DOCUMENT_EXPIRED', [doc('PAN', 'Verified', { expiryDate: addDays(ASOF, -1) })]), 'High');
  assert.equal(sev(low, 'DOCUMENT_EXPIRING_SOON', [doc('PAN', 'Verified', { expiryDate: addDays(ASOF, 20) })]), 'Low');
  assert.equal(sev(low, 'DOCUMENT_EXPIRING_SOON', [doc('PAN', 'Verified', { expiryDate: addDays(ASOF, 5) })]), 'Medium');
  assert.equal(sev(low, 'DOCUMENT_AWAITING_VERIFICATION', [doc('PAN', 'Pending', { submissionDate: addDays(ASOF, -3) })]), 'Low');
  assert.equal(sev(low, 'DOCUMENT_AWAITING_VERIFICATION', [doc('PAN', 'Pending', { submissionDate: addDays(ASOF, -20) })]), 'Medium');
});

// ---- Ownership exceptions ------------------------------------------------------------------------------------------------
const owner = (id, name, pct, over = {}) => ({ id, fullName: name, dateOfBirth: '1980-01-01', countryOfResidence: 'IN', nationality: 'IN', ownershipPercentage: pct, ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'No', ...over });
const analysis = (owners, screenings = {}) => {
  const entries = owners.map((o) => ({ row: { id: o.id, fullName: o.fullName }, owner: o, latest: screenings[o.id] || {}, risk: assessOwnerRisk(o, screenings[o.id] || {}) }));
  return { entries, validation: validateOwnership(owners), complexity: assessComplexity(owners) };
};
const company = customer({ customerType: 'Company', riskLevel: 'Low' });

test('ownership exceptions: no owners, above 100%, incomplete, and requiring investigation', () => {
  assert.ok(types(detect({ customer: company, ownership: analysis([]) })).includes('OWNERSHIP_NO_OWNERS'));
  assert.ok(types(detect({ customer: company, ownership: analysis([owner(1, 'A One', 60), owner(2, 'B Two', 50)]) })).includes('OWNERSHIP_EXCEEDS_100'));
  const incomplete = detect({ customer: company, ownership: analysis([owner(1, 'A One', 40), owner(2, 'B Two', 30)]) });
  assert.ok(types(incomplete).includes('OWNERSHIP_INCOMPLETE'));
  assert.match(incomplete.find((c) => c.type === 'OWNERSHIP_INCOMPLETE').description, /not proof of wrongdoing/);
  const complex = detect({ customer: company, ownership: analysis([owner(1, 'A One', 50, { ownershipType: 'Indirect' }), owner(2, 'B Two', 50)]) });
  assert.ok(types(complex).includes('OWNERSHIP_REQUIRES_INVESTIGATION'));
  assert.deepEqual(types(detect({ customer: company, ownership: analysis([owner(1, 'A One', 60), owner(2, 'B Two', 40, { dateOfBirth: '1990-02-02' })]) })).filter((t) => t.startsWith('OWNERSHIP')), []);
});

test('ownership exceptions never apply to an individual customer', () => {
  assert.deepEqual(detect({ customer: customer(), ownership: analysis([]) }).filter((c) => c.type.startsWith('OWNERSHIP')), []);
});

// ---- Risk exceptions -----------------------------------------------------------------------------------------------------
test('risk exceptions: high risk, manual review, potential PEP and sanctions (never "confirmed")', () => {
  const rating = { id: 1, code: 'RSK-000010', riskLevel: 'High', riskScore: 72, status: 'Requires Manual Review', screening: { pep: { potentialMatch: true }, sanctions: { potentialMatch: true } } };
  const conds = detect({ rating });
  for (const t of ['HIGH_RISK_CUSTOMER', 'RISK_MANUAL_REVIEW_REQUIRED', 'POTENTIAL_PEP_MATCH', 'POTENTIAL_SANCTIONS_MATCH']) assert.ok(types(conds).includes(t), t);
  const sanctions = conds.find((c) => c.type === 'POTENTIAL_SANCTIONS_MATCH');
  assert.equal(sanctions.severity, 'Critical');
  assert.match(sanctions.description, /must be investigated and is not a confirmed match/);
  assert.ok(!types(conds).includes('CONFIRMED_SANCTIONS_MATCH'));
});

test('owner screening produces one exception per owner, and a confirmed sanctions match is its own type', () => {
  const owners = [owner(1, 'Risky One', 50), owner(2, 'Risky Two', 50, { dateOfBirth: '1991-01-01' }), owner(3, 'Clean Three', 0.01, { dateOfBirth: '1992-02-02' })];
  const a = analysis(owners, {
    1: { PEP: { result: 'Potential Match' }, Sanctions: { result: 'Potential Match' } },
    2: { Sanctions: { result: 'Confirmed' } },
    3: { PEP: { result: 'No Match' }, Sanctions: { result: 'No Match' } },
  });
  const conds = detect({ customer: company, ownership: a });
  const own = conds.filter((c) => c.sourceType === 'BeneficialOwner');
  assert.equal(own.filter((c) => c.type === 'POTENTIAL_SANCTIONS_MATCH').length, 1);
  assert.equal(own.filter((c) => c.type === 'POTENTIAL_PEP_MATCH').length, 1);
  assert.equal(own.filter((c) => c.type === 'CONFIRMED_SANCTIONS_MATCH').length, 1);
  assert.ok(own.every((c) => [1, 2].includes(c.sourceId)), 'a clean owner raises nothing');
  assert.match(own.find((c) => c.type === 'POTENTIAL_SANCTIONS_MATCH').description, /NOT a confirmed match/);
});

test('a Low-risk customer with a clean record raises no risk exceptions', () => {
  const rating = { id: 1, code: 'RSK-000001', riskLevel: 'Low', riskScore: 5, status: 'Completed', screening: { pep: { potentialMatch: false }, sanctions: { potentialMatch: false } } };
  assert.deepEqual(detect({ rating }), []);
});

// ---- Review exceptions -----------------------------------------------------------------------------------------------------
test('periodic review exceptions: overdue (with escalating severity), approaching, and not yet due', () => {
  const sched = (next) => ({ id: 3, cycleNumber: 1, nextReviewDate: next });
  const overdue = detect({ schedule: sched(addDays(ASOF, -10)) }).find((c) => c.type === 'PERIODIC_REVIEW_OVERDUE');
  assert.equal(overdue.severity, 'Medium');
  assert.equal(detect({ schedule: sched(addDays(ASOF, -45)) })[0].severity, 'High');
  assert.equal(detect({ schedule: sched(addDays(ASOF, -120)) })[0].severity, 'Critical');
  const soon = detect({ schedule: sched(addDays(ASOF, 20)) })[0];
  assert.equal(soon.type, 'PERIODIC_REVIEW_DUE_SOON');
  assert.equal(soon.severity, 'Low');
  assert.equal(detect({ schedule: sched(addDays(ASOF, 31)) }).length, 0);
  assert.equal(detect({ schedule: sched(ASOF) })[0].type, 'PERIODIC_REVIEW_DUE_SOON'); // due today is not yet overdue
});

test('a case closed while its exception is still active raises "previous review closed without proper resolution"', () => {
  const conds = detect({ unresolvedClosedCases: [{ caseId: 5, caseCode: 'CASE-000005', exceptionCode: 'EXC-000009', exceptionType: 'DOCUMENT_EXPIRED', exceptionSeverity: 'High' }] });
  assert.equal(conds[0].type, 'PREVIOUS_REVIEW_UNRESOLVED');
  assert.equal(conds[0].sourceType, 'ReviewCase');
  assert.equal(conds[0].severity, 'High');
  assert.match(conds[0].description, /CASE-000005/);
});

test('every exception type has a label, a group and a matching case type', () => {
  for (const [code, t] of Object.entries(EXCEPTION_TYPES)) {
    assert.ok(t.label && t.group, code);
    assert.ok(CASE_TYPES.includes(t.caseType), code);
  }
});

// ---- Review dates ----------------------------------------------------------------------------------------------------------
test('configurable risk-based intervals and month arithmetic', () => {
  assert.deepEqual(PERIODIC_REVIEW.intervalMonths, { Low: 36, Medium: 24, High: 12 });
  assert.equal(intervalFor('High'), 12);
  assert.equal(nextReviewFrom('2026-01-15', 'Low'), '2029-01-15');
  assert.equal(nextReviewFrom('2026-01-15', 'Medium'), '2028-01-15');
  assert.equal(nextReviewFrom('2026-01-15', 'High'), '2027-01-15');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28'); // clamped to the end of the month
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29'); // leap year
  assert.equal(addMonths('2026-11-30', 3), '2027-02-28');
});

test('schedule state: overdue, due soon, scheduled; completed rows keep their status', () => {
  assert.equal(scheduleState('Scheduled', addDays(ASOF, -1), ASOF), 'Overdue');
  assert.equal(scheduleState('Scheduled', ASOF, ASOF), 'Due soon');
  assert.equal(scheduleState('Scheduled', addDays(ASOF, 30), ASOF), 'Due soon');
  assert.equal(scheduleState('Scheduled', addDays(ASOF, 31), ASOF), 'Scheduled');
  assert.equal(scheduleState('Completed', addDays(ASOF, -400), ASOF), 'Completed');
});

// ---- Case workflow ---------------------------------------------------------------------------------------------------------
const people = {
  analystA: { id: 1, role: 'Analyst', name: 'A' },
  analystB: { id: 2, role: 'Analyst', name: 'B' },
  reviewer: { id: 3, role: 'Reviewer', name: 'R' },
  reviewer2: { id: 4, role: 'Reviewer', name: 'R2' },
  admin: { id: 5, role: 'Admin', name: 'Admin' },
};
const kase = (over = {}) => ({ status: 'In Progress', assignedAnalystId: 1, assignedReviewerId: null, requiresApproval: false, proposalPending: false, proposedById: null, ...over });
const can = (action, c, who) => workflow.check(action, c, people[who]).ok;

test('only the assigned analyst works a case, and a reviewer cannot start one', () => {
  assert.equal(can('start', kase({ status: 'Assigned' }), 'analystA'), true);
  assert.equal(can('start', kase({ status: 'Assigned' }), 'analystB'), false);
  assert.equal(can('start', kase({ status: 'Assigned' }), 'reviewer'), false);
  assert.equal(can('start', kase({ status: 'Open', assignedAnalystId: null }), 'analystB'), true); // an unassigned case can be taken
  assert.equal(can('request_customer', kase(), 'analystA'), true);
  assert.equal(can('request_customer', kase(), 'analystB'), false);
});

test('statuses limit actions: no resolving an open case, no closing twice', () => {
  assert.equal(can('resolve', kase({ status: 'Open' }), 'analystA'), false);
  assert.equal(can('customer_responded', kase({ status: 'In Progress' }), 'analystA'), false);
  assert.equal(can('close', kase({ status: 'Closed' }), 'admin'), false);
  assert.equal(can('reopen', kase({ status: 'In Progress' }), 'admin'), false);
});

test('cases needing approval cannot be resolved by the analyst, but a reviewer can resolve an escalated one', () => {
  assert.equal(can('resolve', kase({ requiresApproval: true }), 'analystA'), false);
  assert.match(workflow.check('resolve', kase({ requiresApproval: true }), people.analystA).reason, /compliance reviewer approval/);
  assert.equal(can('resolve', kase({ requiresApproval: false }), 'analystA'), true);
  assert.equal(can('resolve', kase({ status: 'Escalated', requiresApproval: true }), 'reviewer'), true);
  assert.equal(can('resolve', kase({ status: 'Escalated', requiresApproval: true }), 'analystA'), false);
  assert.equal(can('submit_for_review', kase({ requiresApproval: true }), 'analystA'), true);
});

test('approve and reject need a proposal, a reviewer, and a different person from the proposer', () => {
  const escalated = kase({ status: 'Escalated', proposalPending: true, proposedById: 1, assignedReviewerId: 3 });
  assert.equal(can('approve', escalated, 'reviewer'), true);
  assert.equal(can('approve', escalated, 'reviewer2'), false); // another reviewer is assigned
  assert.equal(can('approve', escalated, 'analystA'), false);
  assert.equal(can('approve', kase({ ...escalated, proposalPending: false }), 'reviewer'), false);
  // segregation of duties: an Admin who proposed cannot approve their own proposal
  assert.equal(can('approve', { ...escalated, proposedById: 5 }, 'admin'), false);
  assert.match(workflow.check('approve', { ...escalated, proposedById: 5 }, people.admin).reason, /proposed this resolution/);
  assert.equal(can('reject', escalated, 'reviewer'), true);
  assert.equal(can('return_to_analyst', kase({ status: 'Escalated', assignedReviewerId: 3 }), 'reviewer'), true);
  assert.equal(can('return_to_analyst', escalated, 'reviewer'), false); // a proposal is pending: approve or reject
});

test('closing and reopening: analysts close their resolved cases, only reviewers close unresolved ones or reopen closed ones', () => {
  assert.equal(can('close', kase({ status: 'Resolved' }), 'analystA'), true);
  assert.equal(can('close', kase({ status: 'In Progress' }), 'analystA'), false);
  assert.equal(can('close', kase({ status: 'In Progress' }), 'reviewer'), true);
  assert.equal(can('reopen', kase({ status: 'Resolved' }), 'analystA'), true);
  assert.equal(can('reopen', kase({ status: 'Closed' }), 'analystA'), false);
  assert.equal(can('reopen', kase({ status: 'Closed' }), 'reviewer'), true);
  assert.equal(workflow.targetStatus('reopen', kase({ assignedAnalystId: 1 })), 'In Progress');
  assert.equal(workflow.targetStatus('reopen', kase({ assignedAnalystId: null })), 'Open');
});

test('allowed actions are what the UI shows: different for the analyst, the reviewer and nobody', () => {
  const names = (c, who) => workflow.allowedActions(c, who ? people[who] : null).map((a) => a.action);
  assert.deepEqual(names(kase(), null), []);
  const analystView = names(kase(), 'analystA');
  assert.ok(analystView.includes('request_customer') && analystView.includes('escalate') && analystView.includes('resolve'));
  assert.ok(!analystView.includes('approve') && !analystView.includes('reopen'));
  const proposal = kase({ status: 'Escalated', proposalPending: true, proposedById: 1, assignedReviewerId: 3 });
  assert.deepEqual(names(proposal, 'reviewer').sort(), ['approve', 'close', 'reject', 'resolve'].sort());
  assert.deepEqual(names(proposal, 'analystA'), []);
  assert.equal(workflow.allowedActions(kase({ requiresApproval: true }), people.analystA).find((a) => a.action === 'submit_for_review').needs.includes('reviewer'), true);
});

test('assignment, priority and notes permissions', () => {
  const c = kase({ status: 'Open', assignedAnalystId: null });
  assert.equal(workflow.assignmentRights(c, people.analystA).analyst, 'self');
  assert.equal(workflow.assignmentRights(c, people.reviewer).analyst, 'any');
  assert.equal(workflow.assignmentRights(c, people.analystA).reviewer, false);
  assert.equal(workflow.assignmentRights(kase({ assignedAnalystId: 2 }), people.analystA).analyst, 'none');
  assert.equal(workflow.assignmentRights(kase(), people.analystA).priorityMax, 'High');
  assert.equal(workflow.assignmentRights(kase(), people.reviewer).priorityMax, 'Critical');
  assert.equal(workflow.assignmentRights(kase({ status: 'Closed' }), people.admin).analyst, 'none');
  assert.equal(workflow.canAddNote(kase(), people.analystA), true);
  assert.equal(workflow.canAddNote(kase(), people.analystB), false);
  assert.equal(workflow.canAddNote(kase({ status: 'Closed' }), people.admin), false);
});

test('approval rules and SLA settings are configurable data', () => {
  assert.equal(workflow.requiresApproval({ caseType: 'PEP Investigation', priority: 'Low', customerRiskLevel: 'Low' }), true);
  assert.equal(workflow.requiresApproval({ caseType: 'Missing Documents', priority: 'Low', customerRiskLevel: 'High' }), true);
  assert.equal(workflow.requiresApproval({ caseType: 'Missing Documents', priority: 'Critical', customerRiskLevel: 'Low' }), true);
  assert.equal(workflow.requiresApproval({ caseType: 'Missing Documents', priority: 'Medium', customerRiskLevel: 'Low' }), false);
  assert.deepEqual(SLA_DAYS, { Critical: 3, High: 7, Medium: 14, Low: 30 });
});

test('a status request maps to an action only when that is unambiguous', () => {
  assert.equal(workflow.actionForStatus('In Progress', 'Pending Customer'), 'request_customer');
  assert.equal(workflow.actionForStatus('Assigned', 'In Progress'), 'start');
  assert.equal(workflow.actionForStatus('In Progress', 'Escalated'), null); // escalate or submit_for_review
  assert.equal(workflow.actionForStatus('Resolved', 'Closed'), 'close');
});
