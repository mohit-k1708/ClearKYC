/**
 * Scene 2 unit tests for the KYC rule engine (no database needed).   npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/config/env');
const { expiryInfo, effectiveStatus, evaluateCustomerKyc, completenessFrom, isRequirementCurrent } = require('../src/services/kycEngine');
const { DEFAULT_REQUIREMENTS } = require('../src/config/kycRules');
const { addDays } = require('../src/utils/dates');

const ASOF = '2026-10-22';

// Build the sample requirement rows exactly as seeded.
let nextId = 1;
const REQUIREMENTS = DEFAULT_REQUIREMENTS.flatMap((g) =>
  g.documents.map((documentType) => ({
    id: nextId++,
    customerType: g.customerType,
    riskLevel: g.riskLevel,
    documentType,
    isMandatory: true,
    isActive: true,
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
  }))
);

let docId = 1;
const doc = (documentType, status, over = {}) => ({ id: docId++, documentType, status, expiryDate: null, submissionDate: '2026-09-01', ...over });
const evaluate = (documents, over = {}) =>
  evaluateCustomerKyc({ customerType: 'Individual', riskLevel: 'High', requirements: REQUIREMENTS, documents, asOf: ASOF, ...over });

test('sample requirements match the specification table', () => {
  const docs = (type, risk) => REQUIREMENTS.filter((r) => r.customerType === type && r.riskLevel === risk).map((r) => r.documentType);
  assert.deepEqual(docs('Individual', 'Low'), ['PAN', 'Address Proof', 'Photograph']);
  assert.equal(docs('Individual', 'Medium').length, 4);
  assert.equal(docs('Individual', 'High').length, 5);
  assert.deepEqual(docs('Company', 'Low'), ['Certificate of Incorporation', 'Business PAN', 'Address Proof']);
  assert.equal(docs('Company', 'Medium').length, 4);
  assert.equal(docs('Company', 'High').length, 6);
});

test('specification example: 3 of 5 mandatory documents verified = 60%', () => {
  const r = evaluate([
    doc('PAN', 'Verified'),
    doc('Address Proof', 'Verified'),
    doc('Photograph', 'Pending'),
    // Bank Statement: not submitted
    doc('Additional Evidence', 'Verified'),
  ]);
  assert.equal(r.totals.mandatory, 5);
  assert.equal(r.totals.verified, 3);
  assert.equal(r.totals.missing, 1);
  assert.equal(r.totals.pendingVerification, 1);
  assert.equal(r.percentage, 60);
  assert.equal(r.status, 'Partially Complete');
  const state = Object.fromEntries(r.requirements.map((x) => [x.documentType, x.state]));
  assert.equal(state['Bank Statement'], 'Missing');
  assert.equal(state.Photograph, 'Pending Verification');
});

test('completeness status bands: 100 Complete, 1-99 Partial, 0 Not Started, none defined', () => {
  assert.deepEqual(completenessFrom({ mandatory: 5, verified: 5 }), { percentage: 100, status: 'Complete' });
  assert.deepEqual(completenessFrom({ mandatory: 3, verified: 1 }), { percentage: 33.3, status: 'Partially Complete' });
  assert.deepEqual(completenessFrom({ mandatory: 5, verified: 0 }), { percentage: 0, status: 'Not Started' });
  assert.deepEqual(completenessFrom({ mandatory: 0, verified: 0 }), { percentage: null, status: 'No Requirements' });
});

test('no documents at all: every mandatory document is Missing, 0%, Not Started', () => {
  const r = evaluate([]);
  assert.equal(r.totals.missing, 5);
  assert.equal(r.percentage, 0);
  assert.equal(r.status, 'Not Started');
  assert.equal(r.exceptions.filter((e) => e.type === 'MISSING_DOCUMENT').length, 5);
});

test('all five verified = 100% Complete and no exceptions', () => {
  const r = evaluate(['PAN', 'Address Proof', 'Photograph', 'Bank Statement', 'Additional Evidence'].map((t) => doc(t, 'Verified')));
  assert.equal(r.percentage, 100);
  assert.equal(r.status, 'Complete');
  assert.equal(r.exceptions.length, 0);
});

test('an expired document with a Verified status does NOT count as currently valid', () => {
  const expired = doc('PAN', 'Verified', { expiryDate: addDays(ASOF, -1) });
  assert.equal(effectiveStatus(expired, ASOF), 'Expired');
  const r = evaluate([expired, doc('Address Proof', 'Verified'), doc('Photograph', 'Verified'), doc('Bank Statement', 'Verified'), doc('Additional Evidence', 'Verified')]);
  assert.equal(r.totals.verified, 4);
  assert.equal(r.totals.expired, 1);
  assert.equal(r.percentage, 80);
  assert.equal(r.requirements.find((x) => x.documentType === 'PAN').state, 'Expired');
  assert.ok(r.exceptions.some((e) => e.type === 'EXPIRED' && e.documentType === 'PAN'));
});

test('expiry boundaries: today is still valid, within 30 days is expiring soon, day 31 is valid, yesterday is expired', () => {
  assert.equal(expiryInfo(addDays(ASOF, -1), ASOF).expiryState, 'Expired');
  assert.equal(expiryInfo(ASOF, ASOF).expiryState, 'Expiring Soon');
  assert.equal(expiryInfo(addDays(ASOF, 30), ASOF).expiryState, 'Expiring Soon');
  assert.equal(expiryInfo(addDays(ASOF, 31), ASOF).expiryState, 'Valid');
  assert.equal(expiryInfo(null, ASOF).expiryState, 'No Expiry');
  assert.equal(expiryInfo(addDays(ASOF, 10), ASOF).daysToExpiry, 10);
});

test('a verified document expiring within 30 days still counts as verified but is flagged', () => {
  const r = evaluate([doc('PAN', 'Verified', { expiryDate: addDays(ASOF, 10) })]);
  const pan = r.requirements.find((x) => x.documentType === 'PAN');
  assert.equal(pan.state, 'Verified');
  assert.equal(pan.expiringSoon, true);
  assert.equal(r.totals.verified, 1);
  assert.equal(r.totals.expiringSoon, 1);
  assert.ok(r.exceptions.some((e) => e.type === 'EXPIRING_SOON'));
});

test('pending, in review, rejected and resubmission are all distinguished and none is counted as verified', () => {
  const r = evaluate([doc('PAN', 'Pending'), doc('Address Proof', 'In Review'), doc('Photograph', 'Rejected'), doc('Bank Statement', 'Requires Resubmission')]);
  assert.equal(r.totals.pendingVerification, 2);
  assert.equal(r.totals.rejected, 1);
  assert.equal(r.totals.requiresResubmission, 1);
  assert.equal(r.totals.missing, 1);
  assert.equal(r.totals.verified, 0);
  assert.equal(r.percentage, 0);
  const types = r.exceptions.map((e) => e.type);
  for (const t of ['PENDING_VERIFICATION', 'REJECTED', 'REQUIRES_RESUBMISSION', 'MISSING_DOCUMENT']) assert.ok(types.includes(t), t);
});

test('the best document wins: a verified replacement hides an older rejected copy', () => {
  const r = evaluate([
    doc('PAN', 'Rejected', { submissionDate: '2026-06-01' }),
    doc('PAN', 'Verified', { submissionDate: '2026-09-15' }),
  ]);
  assert.equal(r.requirements.find((x) => x.documentType === 'PAN').state, 'Verified');
  assert.ok(!r.exceptions.some((e) => e.documentType === 'PAN'));
});

test('every mandatory requirement is in exactly one bucket', () => {
  const r = evaluate([
    doc('PAN', 'Verified'),
    doc('Address Proof', 'Verified', { expiryDate: addDays(ASOF, -5) }),
    doc('Photograph', 'Pending'),
    doc('Bank Statement', 'Rejected'),
  ]);
  const t = r.totals;
  assert.equal(t.verified + t.missing + t.pendingVerification + t.rejected + t.requiresResubmission + t.expired, t.mandatory);
});

test('inactive, future and ended requirements are ignored; optional ones are not counted', () => {
  const custom = [
    { id: 1, customerType: 'Individual', riskLevel: 'High', documentType: 'PAN', isMandatory: true, isActive: true, effectiveFrom: '2026-01-01', effectiveTo: null },
    { id: 2, customerType: 'Individual', riskLevel: 'High', documentType: 'Photograph', isMandatory: true, isActive: false, effectiveFrom: '2026-01-01', effectiveTo: null },
    { id: 3, customerType: 'Individual', riskLevel: 'High', documentType: 'Bank Statement', isMandatory: true, isActive: true, effectiveFrom: '2027-01-01', effectiveTo: null },
    { id: 4, customerType: 'Individual', riskLevel: 'High', documentType: 'Address Proof', isMandatory: true, isActive: true, effectiveFrom: '2025-01-01', effectiveTo: '2026-06-30' },
    { id: 5, customerType: 'Individual', riskLevel: 'High', documentType: 'Additional Evidence', isMandatory: false, isActive: true, effectiveFrom: '2026-01-01', effectiveTo: null },
  ];
  const r = evaluateCustomerKyc({ customerType: 'Individual', riskLevel: 'High', requirements: custom, documents: [doc('PAN', 'Verified')], asOf: ASOF });
  assert.equal(r.totals.mandatory, 1);
  assert.equal(r.percentage, 100);
  assert.equal(r.requirements.length, 2); // PAN (mandatory) + Additional Evidence (optional, listed but not counted)
  assert.ok(!r.exceptions.some((e) => e.documentType === 'Additional Evidence')); // a missing OPTIONAL document is not an exception
  assert.equal(isRequirementCurrent(custom[3], ASOF), false);
});

test('requirements follow the customer type and risk level', () => {
  const low = evaluate([], { riskLevel: 'Low' });
  assert.equal(low.totals.mandatory, 3);
  const company = evaluate([], { customerType: 'Company', riskLevel: 'High' });
  assert.equal(company.totals.mandatory, 6);
  assert.ok(company.requirements.some((x) => x.documentType === 'Financial Statements'));
});

test('documents outside the requirements are reported as extra, not counted', () => {
  const r = evaluate([doc('PAN', 'Verified'), doc('Utility Letter', 'Verified')], { riskLevel: 'Low' });
  assert.equal(r.extraDocuments.length, 1);
  assert.equal(r.totals.mandatory, 3);
  assert.equal(r.totals.verified, 1);
});

test('the engine is deterministic for the same inputs and date', () => {
  const docs = [doc('PAN', 'Verified'), doc('Photograph', 'Pending')];
  assert.deepEqual(evaluate(docs), evaluate(docs));
});
