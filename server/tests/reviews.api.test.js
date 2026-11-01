/**
 * Scene 4 API integration tests (real database; start `npm run db:local` first).
 * Detection is always run for ONE test customer at a time, and everything created is removed afterwards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const app = require('../src/app');
const prisma = require('../src/utils/prisma');
const { addDays, addMonths, todayIso, parseIso } = require('../src/utils/dates');

let server;
let base;
const customerCodes = new Set();
const reviewerIds = new Set();
const TODAY = todayIso();
let aA; // operations analyst A
let aB; // operations analyst B
let rv; // compliance reviewer
let rv2; // second compliance reviewer
let adm; // administrator
let inactive;

const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const letter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const make = async (role, label, isActive = true) => {
    const r = await prisma.reviewer.create({ data: { name: `Test ${label}`, email: `qr.${label.toLowerCase()}.${rnd(8)}@example.com`, role, isActive } });
    reviewerIds.add(r.id);
    return r;
  };
  aA = await make('Analyst', 'AnalystA');
  aB = await make('Analyst', 'AnalystB');
  rv = await make('Reviewer', 'ReviewerOne');
  rv2 = await make('Reviewer', 'ReviewerTwo');
  adm = await make('Admin', 'Admin');
  inactive = await make('Analyst', 'Inactive', false);
});

test.after(async () => {
  const codes = [...customerCodes];
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    // Scene 5: the audit events the test created are removed with it (audit events are otherwise immutable)
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id IN (SELECT id FROM "Customer" WHERE customer_id = ANY(${codes}::text[])) OR user_id = ANY(${[...reviewerIds]}::int[])`,
    prisma.verification.deleteMany({ where: { OR: [{ document: { customer: { customerCode: { in: codes } } } }, { reviewerId: { in: [...reviewerIds] } }] } }),
    prisma.document.deleteMany({ where: { customer: { customerCode: { in: codes } } } }),
    prisma.customer.deleteMany({ where: { customerCode: { in: codes } } }), // cascades owners, ratings, exceptions, cases, history, notes, schedules
    prisma.riskRating.deleteMany({ where: { assessedById: { in: [...reviewerIds] } } }),
    prisma.reviewer.deleteMany({ where: { id: { in: [...reviewerIds] } } }),
  ]);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ---- helpers -------------------------------------------------------------------------------------------------------------
const api = async (method, url, body, who) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(who ? { 'x-reviewer-id': String(who.id) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

async function newIndividual() {
  const res = await api('POST', '/customers', {
    customerType: 'Individual', fullName: 'QR Test Person', dateOfBirth: '1988-03-04', email: 'qr.person@example.com', phone: '9812345679', address: '5 Test Lane',
    panNumber: `QRVP${letter()}${rnd(4)}${letter()}`, aadhaarNumber: `9${rnd(11)}`, occupation: 'Engineer', country: 'IN',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  customerCodes.add(res.body.data.customerId);
  return res.body.data.customerId;
}

async function newCompany(over = {}) {
  const res = await api('POST', '/customers', {
    customerType: 'Company', legalName: `QR Test Company ${rnd(5)} Pvt Ltd`, registrationNumber: `QR-${rnd(10)}`, panNumber: `QRVC${letter()}${rnd(4)}${letter()}`,
    email: 'ops@qr-test.example.com', phone: '9812345678', address: '1 Test Park', country: 'IN', businessActivity: 'Information Technology', dateOfIncorporation: '2015-05-05', ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  customerCodes.add(res.body.data.customerId);
  return res.body.data.customerId;
}

const detectFor = async (code, who = aA) => {
  const res = await api('POST', '/exceptions/detect', { customerId: code }, who);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const exceptionsOf = async (code, status = 'active') => (await api('GET', `/exceptions?customerId=${code}&status=${status}&pageSize=100`)).body.data;
const exOfType = async (code, type, status = 'active') => (await exceptionsOf(code, status)).filter((e) => e.exceptionType === type);
const typesOf = async (code) => (await exceptionsOf(code)).map((e) => e.exceptionType);

/** Inserts a document directly (as the seed does) so past dates and statuses can be tested. */
async function insertDoc(code, documentType, { status = 'Verified', expiry = null, submitted = addDays(TODAY, -20) } = {}) {
  const customer = await prisma.customer.findUnique({ where: { customerCode: code } });
  const doc = await prisma.document.create({ data: { customerId: customer.id, documentType, issueDate: parseIso(addDays(TODAY, -400)), submissionDate: parseIso(submitted), expiryDate: expiry ? parseIso(expiry) : null } });
  await prisma.verification.create({ data: { documentId: doc.id, status: 'Pending', remarks: 'seed' } });
  if (status !== 'Pending') await prisma.verification.create({ data: { documentId: doc.id, reviewerId: rv.id, status, remarks: 'seed decision' } });
  return doc;
}

const ownerBody = (over = {}) => ({ fullName: `Owner ${rnd(6)} Tester`, dateOfBirth: '1975-04-12', countryOfResidence: 'IN', nationality: 'IN', ownershipPercentage: 50, ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'No', ...over });
const addOwner = (code, over) => api('POST', `/customers/${code}/beneficial-owners`, ownerBody(over), aA);
const screen = (ownerId, body) => api('POST', `/beneficial-owners/${ownerId}/screening`, body, rv);

const mkCase = (body, who = aA) => api('POST', '/review-cases', body, who);
const act = (caseId, body, who) => api('PATCH', `/review-cases/${caseId}/status`, body, who);
const assign = (caseId, body, who) => api('PATCH', `/review-cases/${caseId}/assign`, body, who);
const getCase = async (caseId, who) => (await api('GET', `/review-cases/${caseId}`, undefined, who)).body.data;
const historyOf = async (caseId) => (await api('GET', `/review-cases/${caseId}/history`)).body.data.items;
const actions = (c) => c.allowedActions.map((a) => a.action);

/** A new Low-risk individual with an active "mandatory document missing" exception, and a case created from it. */
async function caseOnMissingDoc(who = aA) {
  const code = await newIndividual();
  await detectFor(code);
  const exc = (await exOfType(code, 'MANDATORY_DOCUMENT_MISSING'))[0];
  const created = await mkCase({ exceptionId: exc.id }, who);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { code, exc, caseId: created.body.data.caseId, row: created.body.data };
}

// ================================ DETECTION ==============================================================================
test('detects missing mandatory documents with all the required exception fields', async () => {
  const code = await newIndividual();
  const result = await detectFor(code);
  assert.equal(result.customersChecked, 1);
  assert.ok(result.created >= 3);
  const missing = await exOfType(code, 'MANDATORY_DOCUMENT_MISSING');
  assert.equal(missing.length, 3); // PAN, Address Proof, Photograph
  for (const e of missing) {
    assert.match(e.exceptionId, /^EXC-\d{6}$/);
    assert.equal(e.customerId, code);
    assert.ok(e.description.includes('has not been submitted'));
    assert.equal(e.severity, 'Medium');
    assert.ok(e.detectionDate);
    assert.equal(e.status, 'Open');
    assert.equal(e.sourceEntityType, 'KYCRequirement');
    assert.ok(Number.isInteger(e.sourceEntityId));
    assert.equal(e.typeLabel, 'Mandatory document missing');
  }
});

test('detects expired, rejected and resubmission-required documents and links them to the document', async () => {
  const code = await newIndividual();
  const pan = await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, -5) });
  const address = await insertDoc(code, 'Address Proof', { status: 'Rejected' });
  const photo = await insertDoc(code, 'Photograph', { status: 'Requires Resubmission' });
  await detectFor(code);

  const expired = (await exOfType(code, 'DOCUMENT_EXPIRED'))[0];
  assert.equal(expired.severity, 'High');
  assert.equal(expired.relatedDocumentId, pan.id);
  assert.equal(expired.sourceEntityType, 'Document');
  assert.match(expired.description, /although a reviewer had verified it/);
  assert.equal((await exOfType(code, 'DOCUMENT_REJECTED'))[0].relatedDocumentId, address.id);
  assert.equal((await exOfType(code, 'DOCUMENT_REQUIRES_RESUBMISSION'))[0].relatedDocumentId, photo.id);
  assert.equal((await exOfType(code, 'MANDATORY_DOCUMENT_MISSING')).length, 0); // all three types were submitted
});

test('detects documents expiring within 30 days and documents awaiting verification', async () => {
  const code = await newIndividual();
  await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, 12) });
  await insertDoc(code, 'Address Proof', { status: 'Pending', submitted: addDays(TODAY, -25) });
  await detectFor(code);
  const soon = (await exOfType(code, 'DOCUMENT_EXPIRING_SOON'))[0];
  assert.equal(soon.severity, 'Low');
  assert.match(soon.description, /in 12 days/);
  const waiting = (await exOfType(code, 'DOCUMENT_AWAITING_VERIFICATION'))[0];
  assert.equal(waiting.severity, 'Medium'); // waiting longer than 14 days
  assert.match(waiting.description, /25 days/);
});

test('detects ownership exceptions: none, above 100%, incomplete, requiring investigation', async () => {
  const code = await newCompany();
  await detectFor(code);
  assert.equal((await exOfType(code, 'OWNERSHIP_NO_OWNERS')).length, 1);

  const first = await addOwner(code, { fullName: 'Own One', ownershipPercentage: 60 });
  const second = await addOwner(code, { fullName: 'Own Two', dateOfBirth: '1980-01-01', ownershipPercentage: 50 });
  await detectFor(code);
  const exceeds = (await exOfType(code, 'OWNERSHIP_EXCEEDS_100'))[0];
  assert.equal(exceeds.severity, 'High');
  assert.match(exceeds.description, /110%/);
  assert.equal((await exOfType(code, 'OWNERSHIP_NO_OWNERS')).length, 0); // cleared by adding owners

  await api('PUT', `/beneficial-owners/${second.body.data.id}`, ownerBody({ fullName: 'Own Two', dateOfBirth: '1980-01-01', ownershipPercentage: 40 }), aA);
  await detectFor(code);
  assert.deepEqual((await typesOf(code)).filter((t) => t.startsWith('OWNERSHIP')), []);

  await api('PUT', `/beneficial-owners/${second.body.data.id}`, ownerBody({ fullName: 'Own Two', dateOfBirth: '1980-01-01', ownershipPercentage: 30 }), aA);
  await detectFor(code);
  const incomplete = (await exOfType(code, 'OWNERSHIP_INCOMPLETE'))[0];
  assert.match(incomplete.description, /not proof of wrongdoing/);

  await api('PUT', `/beneficial-owners/${first.body.data.id}`, ownerBody({ fullName: 'Own One', ownershipPercentage: 70, ownershipType: 'Indirect' }), aA);
  await detectFor(code);
  assert.equal((await exOfType(code, 'OWNERSHIP_REQUIRES_INVESTIGATION')).length, 1);
});

test('detects high-risk customers, manual review, and potential (never confirmed) PEP and sanctions matches', async () => {
  const code = await newCompany({ country: 'IR', businessActivity: 'Casinos & Gaming' });
  await detectFor(code);
  assert.equal((await exOfType(code, 'HIGH_RISK_CUSTOMER'))[0].severity, 'High');

  const sanc = (await addOwner(code, { fullName: 'Darius Demo Volkov', ownershipPercentage: 50 })).body.data;
  const pep = (await addOwner(code, { fullName: 'Anil Kapoor Demo', dateOfBirth: '1971-01-01', ownershipPercentage: 50 })).body.data;
  assert.equal((await screen(sanc.id, { screeningType: 'Sanctions', mode: 'simulated' })).status, 201);
  assert.equal((await screen(pep.id, { screeningType: 'PEP', mode: 'simulated' })).status, 201);
  assert.equal((await api('POST', `/customers/${code}/risk-assessments`, {}, rv)).body.data.status, 'Requires Manual Review');
  await detectFor(code);

  const s = (await exOfType(code, 'POTENTIAL_SANCTIONS_MATCH'))[0];
  assert.equal(s.severity, 'Critical');
  assert.equal(s.relatedOwnerId, sanc.id);
  assert.match(s.description, /NOT a confirmed match/);
  const p = (await exOfType(code, 'POTENTIAL_PEP_MATCH'))[0];
  assert.equal(p.relatedOwnerId, pep.id);
  assert.equal((await exOfType(code, 'RISK_MANUAL_REVIEW_REQUIRED')).length, 1);
  assert.equal((await exOfType(code, 'CONFIRMED_SANCTIONS_MATCH')).length, 0); // a potential match is never treated as confirmed

  // A confirmed result (recorded after investigation) is a different exception type
  await screen(sanc.id, { screeningType: 'Sanctions', screeningResult: 'Confirmed', remarks: 'Confirmed after investigation (synthetic)' });
  await detectFor(code);
  assert.equal((await exOfType(code, 'CONFIRMED_SANCTIONS_MATCH')).length, 1);
  assert.equal((await exOfType(code, 'POTENTIAL_SANCTIONS_MATCH')).length, 0); // the potential match is replaced by the confirmed record
});

// ================================ DUPLICATES, RESOLUTION, HISTORY =========================================================
test('never creates duplicate active exceptions: repeated and simultaneous detection', async () => {
  const code = await newIndividual();
  const first = await detectFor(code);
  const before = await exceptionsOf(code, 'all');
  const second = await detectFor(code);
  assert.equal(second.created, 0);
  assert.equal(second.unchanged, first.created);

  const runs = await Promise.all(Array.from({ length: 5 }, () => api('POST', '/exceptions/detect', { customerId: code }, aA)));
  assert.ok(runs.every((r) => r.status === 200));
  const after = await exceptionsOf(code, 'all');
  assert.equal(after.length, before.length);
  const keys = await prisma.exception.findMany({ where: { customer: { customerCode: code }, status: { not: 'Resolved' } }, select: { dedupeKey: true } });
  assert.equal(new Set(keys.map((k) => k.dedupeKey)).size, keys.length);

  // The database refuses a second active exception for the same condition, even if the API is bypassed.
  const existing = await prisma.exception.findFirst({ where: { customer: { customerCode: code } } });
  await assert.rejects(prisma.exception.create({ data: { customerId: existing.customerId, exceptionType: existing.exceptionType, description: 'dup', severity: 'Low', sourceEntityType: existing.sourceEntityType, sourceEntityId: existing.sourceEntityId, dedupeKey: existing.dedupeKey } }));
});

test('an exception is resolved automatically when its condition clears, with a recorded resolution, and kept as history', async () => {
  const code = await newIndividual();
  const pan = await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, -5) });
  await insertDoc(code, 'Address Proof');
  await insertDoc(code, 'Photograph');
  await detectFor(code);
  const exc = (await exOfType(code, 'DOCUMENT_EXPIRED'))[0];
  assert.equal(exc.relatedDocumentId, pan.id);

  await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, 400), submitted: addDays(TODAY, -1) }); // a current replacement
  const run = await detectFor(code);
  assert.ok(run.resolved >= 1);

  const detail = (await api('GET', `/exceptions/${exc.exceptionId}`)).body.data;
  assert.equal(detail.status, 'Resolved');
  assert.equal(detail.resolutionType, 'Condition cleared');
  assert.ok(detail.resolvedAt);
  assert.match(detail.resolutionNotes, /no longer show this condition/);
  assert.equal((await exOfType(code, 'DOCUMENT_EXPIRED')).length, 0); // not in the active list
  assert.equal((await exOfType(code, 'DOCUMENT_EXPIRED', 'Resolved')).length, 1); // still in the history

  // A resolved exception is final: the database refuses edits and deletion.
  const row = await prisma.exception.findUnique({ where: { id: exc.id } });
  await assert.rejects(prisma.exception.update({ where: { id: row.id }, data: { status: 'Open' } }));
  await assert.rejects(prisma.exception.update({ where: { id: row.id }, data: { severity: 'Low' } }));
  await assert.rejects(prisma.exception.delete({ where: { id: row.id } }));
});

test('a condition that returns after resolution creates a NEW exception and keeps the old one', async () => {
  const code = await newCompany();
  await addOwner(code, { fullName: 'Return One', ownershipPercentage: 60 });
  const second = (await addOwner(code, { fullName: 'Return Two', dateOfBirth: '1980-01-01', ownershipPercentage: 50 })).body.data;
  await detectFor(code);
  const first = (await exOfType(code, 'OWNERSHIP_EXCEEDS_100'))[0];
  const put = (pct) => api('PUT', `/beneficial-owners/${second.id}`, ownerBody({ fullName: 'Return Two', dateOfBirth: '1980-01-01', ownershipPercentage: pct }), aA);
  await put(40);
  await detectFor(code);
  assert.equal((await exOfType(code, 'OWNERSHIP_EXCEEDS_100')).length, 0);
  await put(55);
  await detectFor(code);
  const all = await exOfType(code, 'OWNERSHIP_EXCEEDS_100', 'all');
  assert.equal(all.length, 2);
  assert.equal(all.filter((e) => e.status === 'Resolved').length, 1);
  assert.equal(all.filter((e) => e.status !== 'Resolved').length, 1);
  assert.notEqual(all[0].exceptionId, all[1].exceptionId);
  assert.ok(all.some((e) => e.exceptionId === first.exceptionId && e.status === 'Resolved'));
});

test('manual resolution needs the condition to be cleared, notes, and the right role for the severity', async () => {
  const code = await newCompany();
  await addOwner(code, { fullName: 'Man One', ownershipPercentage: 60 });
  const second = (await addOwner(code, { fullName: 'Man Two', dateOfBirth: '1980-01-01', ownershipPercentage: 50 })).body.data;
  await detectFor(code);
  const exc = (await exOfType(code, 'OWNERSHIP_EXCEEDS_100'))[0];
  const resolve = (who, notes) => api('PATCH', `/exceptions/${exc.exceptionId}/resolve`, { resolutionNotes: notes }, who);

  assert.equal((await api('PATCH', `/exceptions/${exc.exceptionId}/resolve`, { resolutionNotes: 'Percentages corrected after review' })).status, 401); // nobody chosen
  const persists = await resolve(rv, 'Percentages corrected after review');
  assert.equal(persists.status, 409);
  assert.equal(persists.body.error.code, 'CONDITION_PERSISTS');

  await api('PUT', `/beneficial-owners/${second.id}`, ownerBody({ fullName: 'Man Two', dateOfBirth: '1980-01-01', ownershipPercentage: 40 }), aA);
  assert.equal((await resolve(rv, 'short')).status, 400);
  const forbidden = await resolve(aA, 'Percentages corrected after review'); // High severity: an analyst cannot
  assert.equal(forbidden.status, 403);
  const ok = await resolve(rv, 'Percentages corrected after review');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.status, 'Resolved');
  assert.equal(ok.body.data.resolutionType, 'Resolved manually');
  assert.match(ok.body.data.resolutionNotes, /corrected/);
  assert.equal(ok.body.data.resolvedBy.name, rv.name);
  assert.equal((await resolve(rv, 'Percentages corrected after review')).status, 409);
  assert.equal((await api('GET', '/exceptions/EXC-999999')).status, 404);
  assert.equal((await api('GET', '/exceptions/abc')).status, 400);
});

// ================================ CASES: CREATION =========================================================================
test('creates a review case from an exception with sensible defaults, and links them', async () => {
  const code = await newIndividual();
  await detectFor(code);
  const exc = (await exOfType(code, 'MANDATORY_DOCUMENT_MISSING'))[0];

  assert.equal((await api('POST', '/review-cases', { exceptionId: exc.id })).status, 401);
  const res = await mkCase({ exceptionId: exc.id });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const c = res.body.data;
  assert.match(c.caseId, /^CASE-\d{6}$/);
  assert.equal(c.customer.customerId, code);
  assert.equal(c.caseType, 'Missing Documents');
  assert.equal(c.priority, exc.severity);
  assert.equal(c.status, 'Open');
  assert.equal(c.dueDate, addDays(TODAY, 14)); // Medium priority SLA
  assert.equal(c.requiresApproval, false);
  assert.equal(c.createdBy.id, aA.id);
  assert.ok(c.exceptions.some((e) => e.isLinked && e.exceptionId === exc.exceptionId));
  assert.equal((await api('GET', `/exceptions/${exc.exceptionId}`)).body.data.status, 'In Review');
  const history = await historyOf(c.caseId);
  assert.equal(history.length, 1);
  assert.equal(history[0].action, 'CREATED');
  assert.match(history[0].remarks, new RegExp(exc.exceptionId));

  // The same exception cannot get a second active case
  const dup = await mkCase({ exceptionId: exc.id });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'CASE_EXISTS');
  assert.equal(dup.body.error.details.existingCaseCode, c.caseId);
});

test('cannot create a case for a resolved exception; manual creation is validated', async () => {
  const code = await newCompany();
  await addOwner(code, { fullName: 'Res One', ownershipPercentage: 100 });
  await detectFor(code);
  await addOwner(code, { fullName: 'Res Two', dateOfBirth: '1980-01-01', ownershipPercentage: 10 }); // exceeds
  await detectFor(code);
  const exc = (await exOfType(code, 'OWNERSHIP_EXCEEDS_100'))[0];
  const owners = (await api('GET', `/customers/${code}/beneficial-owners`)).body.data.owners;
  await api('PUT', `/beneficial-owners/${owners[1].id}`, ownerBody({ fullName: 'Res Two', dateOfBirth: '1980-01-01', ownershipPercentage: 1 }), aA); // still exceeds
  const resolvedRes = await prisma.exception.findUnique({ where: { id: exc.id } });
  assert.equal(resolvedRes.status, 'Open');

  const ind = await newIndividual();
  assert.equal((await mkCase({ customerId: ind })).status, 400); // title and type missing
  assert.equal((await mkCase({ customerId: ind, caseTitle: 'ab', caseType: 'Other' })).status, 400); // title too short
  assert.equal((await mkCase({ customerId: ind, caseTitle: 'Check', caseType: 'Nonsense' })).status, 400);
  assert.equal((await mkCase({ customerId: ind, caseTitle: 'Check this', caseType: 'Other', dueDate: addDays(TODAY, -2) })).status, 400);
  const nf = await mkCase({ customerId: 'CUS-999999', caseTitle: 'Check this', caseType: 'Other' });
  assert.equal(nf.status, 404);
  assert.equal(nf.body.error.code, 'CUSTOMER_NOT_FOUND');
  assert.equal((await mkCase({ exceptionId: 999999999 })).status, 404);

  const ok = await mkCase({ customerId: ind, caseTitle: 'Manual review of customer', caseType: 'Other', description: 'Created by hand', priority: 'Low' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.data.exceptionId, null);
  assert.equal(ok.body.data.dueDate, addDays(TODAY, 30)); // Low priority SLA

  // A cleared exception cannot get a case
  const code2 = await newIndividual();
  await insertDoc(code2, 'PAN', { status: 'Verified', expiry: addDays(TODAY, -3) });
  await insertDoc(code2, 'Address Proof');
  await insertDoc(code2, 'Photograph');
  await detectFor(code2);
  const expired = (await exOfType(code2, 'DOCUMENT_EXPIRED'))[0];
  await insertDoc(code2, 'PAN', { status: 'Verified', expiry: addDays(TODAY, 300), submitted: addDays(TODAY, -1) });
  await detectFor(code2);
  const late = await mkCase({ exceptionId: expired.id });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'EXCEPTION_RESOLVED');
});

// ================================ ASSIGNMENT & AUTHORISATION ==============================================================
test('assigns cases to analysts and compliance reviewers, with history and role checks', async () => {
  const { caseId } = await caseOnMissingDoc();
  // an analyst can claim an open case for themselves
  const claim = await assign(caseId, { assignedAnalystId: aA.id }, aA);
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  assert.equal(claim.body.data.status, 'Assigned');
  assert.equal(claim.body.data.assignedAnalyst.id, aA.id);

  // analysts cannot assign others, take someone else's case, or assign a reviewer
  assert.equal((await assign(caseId, { assignedAnalystId: aB.id }, aA)).status, 403);
  assert.equal((await assign(caseId, { assignedAnalystId: aB.id }, aB)).status, 403);
  assert.equal((await assign(caseId, { assignedReviewerId: rv.id }, aA)).status, 403);

  // a compliance reviewer assigns the analyst and a reviewer
  const re = await assign(caseId, { assignedAnalystId: aB.id, assignedReviewerId: rv.id, remarks: 'Rebalancing the workload' }, rv);
  assert.equal(re.status, 200, JSON.stringify(re.body));
  assert.equal(re.body.data.assignedAnalyst.id, aB.id);
  assert.equal(re.body.data.assignedReviewer.id, rv.id);
  assert.equal(re.body.data.assignedAnalyst.roleLabel, 'Operations Analyst');
  assert.equal(re.body.data.assignedReviewer.roleLabel, 'Compliance Reviewer');

  // role checks on the people being assigned
  const wrongAnalyst = await assign(caseId, { assignedAnalystId: rv.id }, rv);
  assert.equal(wrongAnalyst.status, 400);
  assert.ok(wrongAnalyst.body.error.details.assignedAnalystId);
  assert.equal((await assign(caseId, { assignedReviewerId: aA.id }, rv)).status, 400);
  assert.equal((await assign(caseId, { assignedAnalystId: inactive.id }, rv)).status, 400);
  assert.equal((await assign(caseId, { assignedAnalystId: 999999999 }, rv)).status, 400);
  assert.equal((await assign(caseId, {}, rv)).status, 400); // nothing to change
  assert.equal((await assign(caseId, { assignedAnalystId: aB.id }, rv)).status, 400); // same value

  const actionsLogged = (await historyOf(caseId)).map((h) => h.action);
  assert.ok(actionsLogged.includes('ASSIGNED_ANALYST') && actionsLogged.includes('ASSIGNED_REVIEWER'));
  assert.equal((await api('PATCH', `/review-cases/${caseId}/assign`, { assignedAnalystId: aA.id })).status, 401);
});

test('priority changes: the working analyst may set Low to High, only a reviewer may set Critical (which adds the approval rule)', async () => {
  const { caseId } = await caseOnMissingDoc();
  await assign(caseId, { assignedAnalystId: aA.id }, aA);
  assert.equal((await assign(caseId, { priority: 'Critical' }, aA)).status, 403);
  assert.equal((await assign(caseId, { priority: 'Low' }, aB)).status, 403); // not their case
  const high = await assign(caseId, { priority: 'High' }, aA);
  assert.equal(high.body.data.priority, 'High');
  const crit = await assign(caseId, { priority: 'Critical', remarks: 'Escalated by compliance' }, rv);
  assert.equal(crit.status, 200);
  assert.equal(crit.body.data.priority, 'Critical');
  assert.equal(crit.body.data.requiresApproval, true);
  const log = (await historyOf(caseId)).find((h) => h.action === 'PRIORITY_CHANGED');
  assert.match(log.remarks, /from High to Critical/);
});

test('unauthorised users cannot perform restricted actions', async () => {
  const { caseId } = await caseOnMissingDoc();
  await assign(caseId, { assignedAnalystId: aA.id }, aA);
  const patch = (who, body) => api('PATCH', `/review-cases/${caseId}/status`, body, who);

  assert.equal((await patch(undefined, { action: 'start' })).status, 401); // nobody
  assert.equal((await patch(inactive, { action: 'start' })).status, 401);
  assert.equal((await patch({ id: 999999999 }, { action: 'start' })).status, 401);
  assert.equal((await patch(aB, { action: 'start' })).status, 403); // another analyst
  assert.equal((await patch(rv, { action: 'start' })).status, 403); // a reviewer does not investigate
  const forbidden = await patch(aB, { action: 'start' });
  assert.equal(forbidden.body.error.code, 'FORBIDDEN_ACTION');
  assert.equal((await api('POST', `/review-cases/${caseId}/notes`, { note: 'Not my case but trying' }, aB)).status, 403);
  assert.equal((await api('POST', `/review-cases/${caseId}/notes`, { note: 'Anonymous note' })).status, 401);
  assert.equal((await patch(aA, { action: 'approve' })).status, 409); // not possible from Assigned
  assert.equal((await patch(aA, { action: 'fly' })).status, 400);
  assert.equal((await patch(aA, {})).status, 400);

  // The buttons offered depend on who is asking
  assert.deepEqual(actions(await getCase(caseId)), []); // nobody
  assert.ok(actions(await getCase(caseId, aA)).includes('start'));
  assert.ok(!actions(await getCase(caseId, aB)).includes('start'));
  assert.ok(!actions(await getCase(caseId, rv)).includes('start'));
  assert.ok(actions(await getCase(caseId, rv)).includes('close'));
});

// ================================ CASES: WORKFLOW & HISTORY ===============================================================
test('works a case from start to close and records every step in the history and timeline', async () => {
  const { caseId, code } = await caseOnMissingDoc();
  await assign(caseId, { assignedAnalystId: aA.id }, aA);

  const started = await act(caseId, { action: 'start' }, aA);
  assert.equal(started.body.data.status, 'In Progress');
  assert.equal((await act(caseId, { action: 'request_customer' }, aA)).status, 400); // what was requested?
  const pending = await act(caseId, { action: 'request_customer', remarks: 'Asked the customer to send a new PAN copy' }, aA);
  assert.equal(pending.body.data.status, 'Pending Customer');
  assert.ok(pending.body.data.allowedActions.some((a) => a.action === 'customer_responded'));
  const responded = await act(caseId, { action: 'customer_responded', remarks: 'Customer sent the document by post' }, aA);
  assert.equal(responded.body.data.status, 'In Progress');

  const noted = await api('POST', `/review-cases/${caseId}/notes`, { note: 'Checked the submitted copy against the profile' }, aA);
  assert.equal(noted.status, 201);
  assert.equal((await api('POST', `/review-cases/${caseId}/notes`, { note: 'x' }, aA)).status, 400);

  assert.equal((await act(caseId, { action: 'resolve' }, aA)).status, 400);
  assert.equal((await act(caseId, { action: 'resolve', resolutionNotes: 'short' }, aA)).status, 400);
  const resolved = await act(caseId, { action: 'resolve', resolutionNotes: 'Documents received and verified by the reviewer.' }, aA);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal(resolved.body.data.status, 'Resolved');
  assert.ok(resolved.body.data.resolvedAt);
  assert.match(resolved.body.data.resolutionNotes, /Documents received/);

  const closed = await act(caseId, { action: 'close' }, aA);
  assert.equal(closed.body.data.status, 'Closed');
  assert.ok(closed.body.data.closedAt);
  assert.equal((await api('POST', `/review-cases/${caseId}/notes`, { note: 'Late note on a closed case' }, aA)).status, 409);

  // Full history, oldest to newest, each step with the previous and new status
  const steps = (await historyOf(caseId)).reverse();
  assert.deepEqual(steps.map((s) => s.action), ['CREATED', 'ASSIGNED_ANALYST', 'STARTED', 'CUSTOMER_INFO_REQUESTED', 'CUSTOMER_RESPONDED', 'RESOLVED', 'CLOSED']);
  assert.deepEqual(steps.map((s) => s.newStatus), ['Open', 'Assigned', 'In Progress', 'Pending Customer', 'In Progress', 'Resolved', 'Closed']);
  assert.equal(steps[0].previousStatus, null);
  assert.equal(steps[5].previousStatus, 'In Progress');
  assert.ok(steps.slice(1).every((s) => s.changedBy && s.changedBy.id));

  // The timeline merges history and notes, newest first
  const detail = await getCase(caseId, aA);
  const kinds = detail.timeline.map((t) => t.kind);
  assert.ok(kinds.includes('note') && kinds.includes('history'));
  assert.equal(detail.timeline[0].action, 'CLOSED');
  assert.equal(detail.timeline.length, 8);
  assert.equal(detail.customer.customerId, code);
});

test('a case cannot be closed without resolution notes (API and database)', async () => {
  const { caseId } = await caseOnMissingDoc();
  await assign(caseId, { assignedAnalystId: aA.id }, aA);
  await act(caseId, { action: 'start' }, aA);

  assert.equal((await act(caseId, { action: 'close', resolutionNotes: 'Closing it' }, aA)).status, 403); // an analyst cannot close an unresolved case
  const noNotes = await act(caseId, { action: 'close' }, rv);
  assert.equal(noNotes.status, 400);
  assert.match(noNotes.body.error.details.resolutionNotes, /cannot be closed without resolution notes/);
  assert.equal((await act(caseId, { action: 'close', resolutionNotes: 'short' }, rv)).status, 400);

  // The database refuses it even if the API is bypassed
  await assert.rejects(prisma.reviewCase.update({ where: { caseCode: caseId }, data: { status: 'Closed', closedAt: new Date() } }));
  await assert.rejects(prisma.reviewCase.update({ where: { caseCode: caseId }, data: { status: 'Resolved', resolvedAt: new Date() } }));

  const closed = await act(caseId, { action: 'close', resolutionNotes: 'Duplicate of another case, closed by compliance.' }, rv);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.data.status, 'Closed');
  assert.match(closed.body.data.resolutionNotes, /Duplicate of another case/);
});

test('cases that need approval are submitted for review and approved or rejected by a different compliance reviewer', async () => {
  const code = await newIndividual();
  const created = await mkCase({ customerId: code, caseTitle: 'High-risk review of customer', caseType: 'High-Risk Review', priority: 'Medium' });
  const caseId = created.body.data.caseId;
  assert.equal(created.body.data.requiresApproval, true); // the type needs approval
  await assign(caseId, { assignedAnalystId: aA.id }, aA);
  await act(caseId, { action: 'start' }, aA);

  const direct = await act(caseId, { action: 'resolve', resolutionNotes: 'Resolved by the analyst alone' }, aA);
  assert.equal(direct.status, 403);
  assert.match(direct.body.error.message, /compliance reviewer approval/);
  assert.ok(!actions(await getCase(caseId, aA)).includes('resolve'));
  assert.ok(actions(await getCase(caseId, aA)).includes('submit_for_review'));

  assert.equal((await act(caseId, { action: 'submit_for_review' }, aA)).status, 400); // proposed notes needed
  const noReviewer = await act(caseId, { action: 'submit_for_review', resolutionNotes: 'Reviewed the profile and found no issue.' }, aA);
  assert.equal(noReviewer.status, 400);
  assert.ok(noReviewer.body.error.details.reviewerId);
  const submitted = await act(caseId, { action: 'submit_for_review', resolutionNotes: 'Reviewed the profile and found no issue.', reviewerId: rv.id }, aA);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  assert.equal(submitted.body.data.status, 'Escalated');
  assert.equal(submitted.body.data.proposalPending, true);
  assert.equal(submitted.body.data.assignedReviewer.id, rv.id);
  assert.equal(submitted.body.data.proposedBy.id, aA.id);

  assert.equal((await act(caseId, { action: 'approve' }, aA)).status, 403); // analysts cannot approve
  assert.equal((await act(caseId, { action: 'approve' }, rv2)).status, 403); // another reviewer is assigned
  assert.deepEqual(actions(await getCase(caseId, rv)).sort(), ['approve', 'close', 'reject', 'resolve']);
  const approved = await act(caseId, { action: 'approve', remarks: 'Agreed with the analyst' }, rv);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.status, 'Resolved');
  assert.equal(approved.body.data.proposalPending, false);
  assert.match(approved.body.data.resolutionNotes, /no issue/);
  assert.ok((await historyOf(caseId)).some((h) => h.action === 'RESOLUTION_APPROVED' && h.changedBy.id === rv.id));

  // Rejection sends the case back to the analyst with the reviewer's reasons
  const second = (await mkCase({ customerId: code, caseTitle: 'Another high-risk review', caseType: 'PEP Investigation' })).body.data.caseId;
  await assign(second, { assignedAnalystId: aA.id }, aA);
  await act(second, { action: 'start' }, aA);
  await act(second, { action: 'submit_for_review', resolutionNotes: 'Name differs, treated as a false positive.', reviewerId: rv.id }, aA);
  assert.equal((await act(second, { action: 'reject' }, rv)).status, 400); // reasons needed
  const rejected = await act(second, { action: 'reject', remarks: 'The date of birth was not compared. Please check it.' }, rv);
  assert.equal(rejected.body.data.status, 'In Progress');
  assert.equal(rejected.body.data.proposalPending, false);

  // Escalation without a proposal: the reviewer may return it or resolve it directly
  const esc = await act(second, { action: 'escalate', remarks: 'Needs a compliance decision on the match', reviewerId: rv.id }, aA);
  assert.equal(esc.body.data.status, 'Escalated');
  assert.equal(esc.body.data.proposalPending, false);
  const back = await act(second, { action: 'return_to_analyst', remarks: 'Please add the supporting evidence' }, rv);
  assert.equal(back.body.data.status, 'In Progress');
  await act(second, { action: 'escalate', remarks: 'Evidence attached, deciding needed' }, aA);
  const direct2 = await act(second, { action: 'resolve', resolutionNotes: 'Compliance reviewed the evidence: false positive.' }, rv);
  assert.equal(direct2.status, 200);
  assert.equal(direct2.body.data.status, 'Resolved');
});

test('segregation of duties: the person who proposed a resolution cannot approve it', async () => {
  const code = await newIndividual();
  const caseId = (await mkCase({ customerId: code, caseTitle: 'Sanctions check for customer', caseType: 'Sanctions Investigation' })).body.data.caseId;
  await assign(caseId, { assignedAnalystId: adm.id }, adm); // an administrator can also work as the analyst
  await act(caseId, { action: 'start' }, adm);
  assert.equal((await act(caseId, { action: 'submit_for_review', resolutionNotes: 'Treated as a false positive.', reviewerId: adm.id }, adm)).status, 400); // not yourself
  await act(caseId, { action: 'submit_for_review', resolutionNotes: 'Treated as a false positive.', reviewerId: rv.id }, adm);
  const self = await act(caseId, { action: 'approve' }, adm);
  assert.equal(self.status, 403);
  assert.match(self.body.error.message, /proposed this resolution/);
  assert.equal((await act(caseId, { action: 'approve' }, rv)).status, 200);
});

test('reopening a case creates a recorded status transition', async () => {
  const { caseId } = await caseOnMissingDoc();
  await assign(caseId, { assignedAnalystId: aA.id }, aA);
  await act(caseId, { action: 'start' }, aA);
  await act(caseId, { action: 'resolve', resolutionNotes: 'Resolved after the customer replied.' }, aA);

  assert.equal((await act(caseId, { action: 'reopen' }, rv)).status, 400); // remarks needed
  const reopened = await act(caseId, { action: 'reopen', remarks: 'The customer document turned out to be unreadable' }, rv);
  assert.equal(reopened.status, 200);
  assert.equal(reopened.body.data.status, 'In Progress'); // an analyst is assigned
  assert.equal(reopened.body.data.resolvedAt, null);
  let log = (await historyOf(caseId))[0];
  assert.equal(log.action, 'REOPENED');
  assert.equal(log.previousStatus, 'Resolved');
  assert.equal(log.newStatus, 'In Progress');
  assert.equal(log.changedBy.id, rv.id);
  assert.ok((await historyOf(caseId)).some((h) => h.action === 'RESOLVED'), 'the earlier resolution is still in the history');

  // A closed case can only be reopened by compliance, and returns to Open if nobody is assigned
  await act(caseId, { action: 'resolve', resolutionNotes: 'Resolved again with a new copy.' }, aA);
  await act(caseId, { action: 'close' }, aA);
  assert.equal((await act(caseId, { action: 'reopen', remarks: 'Trying to reopen it' }, aA)).status, 403);
  assert.equal((await act(caseId, { action: 'reopen', remarks: 'Reopened by compliance' }, rv)).status, 200);
  await assign(caseId, { assignedAnalystId: null }, rv);
  assert.equal((await getCase(caseId)).status, 'In Progress'); // unassigning does not move a case that is already in progress
});

test('case history and notes are immutable and cases are never deleted', async () => {
  const { caseId } = await caseOnMissingDoc();
  await assign(caseId, { assignedAnalystId: aA.id }, aA);
  await api('POST', `/review-cases/${caseId}/notes`, { note: 'An investigation note' }, aA);
  const row = await prisma.reviewCase.findUnique({ where: { caseCode: caseId } });
  const h = await prisma.caseHistory.findFirst({ where: { reviewCaseId: row.id } });
  const n = await prisma.caseNote.findFirst({ where: { reviewCaseId: row.id } });
  await assert.rejects(prisma.caseHistory.update({ where: { id: h.id }, data: { remarks: 'rewritten' } }));
  await assert.rejects(prisma.caseHistory.delete({ where: { id: h.id } }));
  await assert.rejects(prisma.caseNote.update({ where: { id: n.id }, data: { note: 'rewritten' } }));
  await assert.rejects(prisma.caseNote.delete({ where: { id: n.id } }));
  await assert.rejects(prisma.reviewCase.delete({ where: { id: row.id } }));
  await assert.rejects(prisma.reviewCase.update({ where: { id: row.id }, data: { status: 'Done' } })); // not a status
  await assert.rejects(prisma.reviewCase.update({ where: { id: row.id }, data: { caseCode: 'CASE-999999' } }));
  assert.equal((await prisma.caseHistory.count({ where: { reviewCaseId: row.id } })) >= 2, true);
});

test('a case closed while its exception is still active raises "previous review closed without proper resolution"', async () => {
  const { code, exc, caseId } = await caseOnMissingDoc();
  assert.equal((await api('GET', `/exceptions/${exc.exceptionId}`)).body.data.status, 'In Review');
  const closed = await act(caseId, { action: 'close', resolutionNotes: 'Closed without obtaining the document.' }, rv);
  assert.equal(closed.status, 200);

  await detectFor(code);
  const original = (await api('GET', `/exceptions/${exc.exceptionId}`)).body.data;
  assert.equal(original.status, 'Open'); // the case is closed, the issue is not
  const prev = (await exOfType(code, 'PREVIOUS_REVIEW_UNRESOLVED'))[0];
  assert.ok(prev, 'a follow-up exception is raised');
  assert.equal(prev.sourceEntityType, 'ReviewCase');
  assert.equal(prev.relatedReviewId, closed.body.data.id);
  assert.match(prev.description, new RegExp(caseId));
  assert.equal(prev.status, 'Open');

  // A new case for the original exception resolves the follow-up
  assert.equal((await mkCase({ exceptionId: exc.id })).status, 201);
  await detectFor(code);
  assert.equal((await exOfType(code, 'PREVIOUS_REVIEW_UNRESOLVED')).length, 0);
  assert.equal((await exOfType(code, 'PREVIOUS_REVIEW_UNRESOLVED', 'Resolved')).length, 1);
});

test('resolving a case whose issue is fixed resolves the exception automatically', async () => {
  const code = await newIndividual();
  await insertDoc(code, 'PAN');
  await insertDoc(code, 'Address Proof');
  const pending = await insertDoc(code, 'Photograph', { status: 'Pending', submitted: addDays(TODAY, -3) });
  await detectFor(code);
  const exc = (await exOfType(code, 'DOCUMENT_AWAITING_VERIFICATION'))[0];
  assert.equal(exc.relatedDocumentId, pending.id);
  const caseId = (await mkCase({ exceptionId: exc.id })).body.data.caseId;
  await assign(caseId, { assignedAnalystId: aA.id }, aA);
  await act(caseId, { action: 'start' }, aA);

  // A reviewer verifies the document (Scene 2 workflow): the underlying issue is now fixed
  assert.equal((await api('POST', `/documents/${pending.id}/verifications`, { status: 'Verified', remarks: 'ok' }, rv)).status, 201);
  const resolved = await act(caseId, { action: 'resolve', resolutionNotes: 'The document was verified by a reviewer.' }, aA);
  assert.equal(resolved.status, 200);
  const after = (await api('GET', `/exceptions/${exc.exceptionId}`)).body.data;
  assert.equal(after.status, 'Resolved');
  assert.equal(after.resolutionType, 'Condition cleared');
  assert.ok((await historyOf(caseId)).some((h) => h.action === 'EXCEPTION_RESOLVED'));
});

// ================================ PERIODIC REVIEWS ========================================================================
test('creates schedules with risk-based intervals, finds overdue and upcoming reviews, and creates one case per cycle', async () => {
  const overdueCode = await newIndividual();
  const last = addMonths(TODAY, -36); // Low risk: 36-month interval
  const lastOverdue = addDays(last, -20); // the review was due 20 days ago

  assert.equal((await api('POST', '/review-schedules', { customerId: overdueCode, lastReviewDate: lastOverdue }, aA)).status, 403); // analysts cannot
  assert.equal((await api('POST', '/review-schedules', { customerId: overdueCode, lastReviewDate: lastOverdue })).status, 401);
  assert.equal((await api('POST', '/review-schedules', { customerId: overdueCode, lastReviewDate: addDays(TODAY, 5) }, rv)).status, 400);
  const created = await api('POST', '/review-schedules', { customerId: overdueCode, lastReviewDate: lastOverdue }, rv);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const s = created.body.data;
  assert.equal(s.riskLevel, 'Low');
  assert.equal(s.reviewIntervalMonths, 36);
  assert.equal(s.lastReviewDate, lastOverdue);
  assert.equal(s.nextReviewDate, addMonths(lastOverdue, 36));
  assert.equal(s.state, 'Overdue');
  assert.equal(s.daysUntilDue, -20);
  assert.equal(s.cycleNumber, 1);
  const dup = await api('POST', '/review-schedules', { customerId: overdueCode }, rv);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'SCHEDULE_EXISTS');

  const upcomingCode = await newIndividual();
  await api('POST', '/review-schedules', { customerId: upcomingCode, lastReviewDate: addDays(last, 15) }, rv); // due in 15 days

  const overdue = (await api('GET', `/reviews/overdue?search=${overdueCode}`)).body.data;
  assert.deepEqual(overdue.map((x) => x.customerId), [overdueCode]);
  assert.equal((await api('GET', `/reviews/overdue?search=${upcomingCode}`)).body.data.length, 0);
  const upcoming = (await api('GET', `/reviews/upcoming?search=${upcomingCode}`)).body.data;
  assert.equal(upcoming.length, 1);
  assert.equal(upcoming[0].state, 'Due soon');
  assert.equal(upcoming[0].daysUntilDue, 15);
  assert.equal((await api('GET', `/reviews/upcoming?search=${overdueCode}`)).body.data.length, 0);

  // Detection raises the exceptions and creates the periodic review case for the overdue review
  const d1 = await detectFor(overdueCode);
  assert.equal(d1.casesCreated, 1);
  const exc = (await exOfType(overdueCode, 'PERIODIC_REVIEW_OVERDUE'))[0];
  assert.equal(exc.severity, 'Medium');
  assert.equal(exc.sourceEntityType, 'ReviewSchedule');
  assert.equal(exc.relatedReviewId, s.id);
  assert.match(exc.description, /20 days overdue/);
  const cases = (await api('GET', `/review-cases?customerId=${overdueCode}&caseType=Periodic KYC Review`)).body.data;
  assert.equal(cases.length, 1);
  assert.equal(cases[0].status, 'Open');
  assert.equal(cases[0].dueDate, s.nextReviewDate);
  assert.equal(cases[0].isOverdue, true);
  assert.equal(cases[0].exception.exceptionId, exc.exceptionId);
  assert.equal((await getCase(cases[0].caseId)).createdBy.name, 'System');
  assert.equal((await api('GET', `/exceptions/${exc.exceptionId}`)).body.data.status, 'In Review');

  // The upcoming review raises only a low-severity heads-up and no case
  const d2 = await detectFor(upcomingCode);
  assert.equal(d2.casesCreated, 0);
  assert.equal((await exOfType(upcomingCode, 'PERIODIC_REVIEW_DUE_SOON'))[0].severity, 'Low');

  // No duplicate periodic cases for the same customer and review cycle
  assert.equal((await detectFor(overdueCode)).casesCreated, 0);
  assert.equal((await detectFor(overdueCode)).created, 0);
  const manual = await mkCase({ customerId: overdueCode, caseTitle: 'Periodic review again', caseType: 'Periodic KYC Review', reviewScheduleId: s.id });
  assert.equal(manual.status, 409);
  assert.equal(manual.body.error.code, 'PERIODIC_CASE_EXISTS');
  const row = await prisma.reviewCase.findFirst({ where: { customer: { customerCode: overdueCode }, caseType: 'Periodic KYC Review' } });
  await assert.rejects(prisma.reviewCase.create({ data: { customerId: row.customerId, reviewScheduleId: row.reviewScheduleId, periodicCycle: row.periodicCycle, caseTitle: 'Duplicate', caseType: 'Periodic KYC Review', priority: 'Low', dueDate: new Date() } }));
  assert.equal((await prisma.reviewSchedule.count({ where: { customerId: row.customerId, status: 'Scheduled' } })), 1);
});

test('completing a review records it, resolves the case and exceptions, and recalculates the next due date', async () => {
  const code = await newIndividual();
  const lastOverdue = addDays(addMonths(TODAY, -36), -20);
  const sched = (await api('POST', '/review-schedules', { customerId: code, lastReviewDate: lastOverdue }, rv)).body.data;
  await detectFor(code);
  const periodicCase = (await api('GET', `/review-cases?customerId=${code}&caseType=Periodic KYC Review`)).body.data[0];

  assert.equal((await api('POST', `/review-schedules/${sched.id}/complete`, { notes: 'Reviewed the profile and documents' }, aA)).status, 403);
  assert.equal((await api('POST', `/review-schedules/${sched.id}/complete`, { notes: 'short' }, rv)).status, 400);
  assert.equal((await api('POST', `/review-schedules/${sched.id}/complete`, { notes: 'Reviewed the profile and documents', reviewDate: addDays(lastOverdue, -5) }, rv)).status, 400);
  assert.equal((await api('POST', `/review-schedules/${sched.id}/complete`, { notes: 'Reviewed the profile and documents', reviewDate: addDays(TODAY, 3) }, rv)).status, 400);
  assert.equal((await api('POST', '/review-schedules/999999999/complete', { notes: 'Reviewed the profile and documents' }, rv)).status, 404);

  const done = await api('POST', `/review-schedules/${sched.id}/complete`, { notes: 'Reviewed the profile and documents; all current.' }, rv);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.data.completed.status, 'Completed');
  assert.match(done.body.data.completed.completionNotes, /all current/);
  const next = done.body.data.next;
  assert.equal(next.status, 'Scheduled');
  assert.equal(next.cycleNumber, 2);
  assert.equal(next.lastReviewDate, TODAY);
  assert.equal(next.nextReviewDate, addMonths(TODAY, 36)); // recalculated from the completion date
  assert.deepEqual(done.body.data.resolvedCases, [periodicCase.caseId]);

  const resolved = await getCase(periodicCase.caseId);
  assert.equal(resolved.status, 'Resolved');
  assert.match(resolved.resolutionNotes, /Periodic review completed/);
  assert.ok((await historyOf(periodicCase.caseId)).some((h) => h.action === 'REVIEW_COMPLETED'));
  assert.equal((await exOfType(code, 'PERIODIC_REVIEW_OVERDUE')).length, 0); // cleared
  assert.equal((await exOfType(code, 'PERIODIC_REVIEW_OVERDUE', 'Resolved')).length, 1);

  const again = await api('POST', `/review-schedules/${sched.id}/complete`, { notes: 'Reviewed the profile and documents' }, rv);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'SCHEDULE_NOT_ACTIVE');

  // The customer keeps their schedule history
  const history = (await api('GET', `/review-schedules?customerId=${code}`)).body.data;
  assert.deepEqual(history.map((h) => [h.cycleNumber, h.status]), [[2, 'Scheduled'], [1, 'Completed']]);
  const row = await prisma.reviewSchedule.findUnique({ where: { id: sched.id } });
  await assert.rejects(prisma.reviewSchedule.update({ where: { id: row.id }, data: { nextReviewDate: new Date('2030-01-01') } })); // history is final
});

test('a change in risk level re-bases the review interval from the same last review date', async () => {
  const code = await newCompany();
  await detectFor(code); // creates the schedule at the Low interval
  let schedules = (await api('GET', `/review-schedules?customerId=${code}`)).body.data;
  assert.equal(schedules.length, 1);
  assert.equal(schedules[0].reviewIntervalMonths, 36);
  const lastReview = schedules[0].lastReviewDate;

  const owner = (await addOwner(code, { fullName: 'Rebase Owner', countryOfResidence: 'IR', nationality: undefined, ownershipPercentage: 70, ownershipType: 'Indirect' })).body.data;
  await screen(owner.id, { screeningType: 'PEP', screeningResult: 'Confirmed', remarks: 'Confirmed PEP (synthetic)' });
  const assessed = await api('POST', `/customers/${code}/risk-assessments`, {}, rv);
  assert.equal(assessed.body.data.riskLevel, 'High');

  const run = await detectFor(code);
  assert.equal(run.schedulesRebased, 1);
  schedules = (await api('GET', `/review-schedules?customerId=${code}`)).body.data;
  assert.deepEqual(schedules.map((s) => [s.status, s.riskLevel, s.reviewIntervalMonths]).sort(), [['Scheduled', 'High', 12], ['Superseded', 'Low', 36]].sort());
  const current = schedules.find((s) => s.status === 'Scheduled');
  assert.equal(current.lastReviewDate, lastReview);
  assert.equal(current.nextReviewDate, addMonths(lastReview, 12));
  assert.equal(current.cycleNumber, 1);
});

// ================================ DASHBOARD, LISTS, DETAILS ===============================================================
test('dashboard counts reflect open, in-progress, escalated, overdue and high-priority cases and upcoming reviews', async () => {
  const before = (await api('GET', '/review-dashboard/summary')).body.data;
  const { caseId } = await caseOnMissingDoc();
  let s = (await api('GET', '/review-dashboard/summary')).body.data;
  assert.equal(s.openCases, before.openCases + 1);

  await assign(caseId, { assignedAnalystId: aA.id, priority: 'High' }, rv);
  await act(caseId, { action: 'start' }, aA);
  s = (await api('GET', '/review-dashboard/summary')).body.data;
  assert.equal(s.inProgressCases, before.inProgressCases + 1);
  assert.equal(s.openCases, before.openCases);
  assert.equal(s.highPriorityCases, before.highPriorityCases + 1);

  await act(caseId, { action: 'escalate', remarks: 'Needs compliance attention', reviewerId: rv.id }, aA);
  s = (await api('GET', '/review-dashboard/summary')).body.data;
  assert.equal(s.escalatedCases, before.escalatedCases + 1);
  assert.equal(s.inProgressCases, before.inProgressCases);

  // an overdue periodic case and an upcoming review
  const a = await newIndividual();
  await api('POST', '/review-schedules', { customerId: a, lastReviewDate: addDays(addMonths(TODAY, -36), -10) }, rv);
  await detectFor(a);
  const b = await newIndividual();
  await api('POST', '/review-schedules', { customerId: b, lastReviewDate: addDays(addMonths(TODAY, -36), 20) }, rv);
  s = (await api('GET', '/review-dashboard/summary')).body.data;
  assert.equal(s.overdueCases, before.overdueCases + 1);
  assert.equal(s.upcomingPeriodicReviews, before.upcomingPeriodicReviews + 1);
  assert.equal(s.overduePeriodicReviews, before.overduePeriodicReviews + 1);
  assert.ok(s.exceptions.active > before.exceptions.active);
});

test('lists cases and exceptions with search, filters and pagination', async () => {
  const code = await newIndividual();
  const token = `Zq${rnd(6)}`;
  const c1 = (await mkCase({ customerId: code, caseTitle: `${token} first`, caseType: 'Other', priority: 'High' })).body.data;
  const c2 = (await mkCase({ customerId: code, caseTitle: `${token} second`, caseType: 'Missing Documents', priority: 'Low', assignedAnalystId: aA.id })).body.data;

  const bySearch = (await api('GET', `/review-cases?search=${token}`)).body;
  assert.equal(bySearch.pagination.totalItems, 2);
  assert.equal(bySearch.data[0].caseId, c1.caseId); // High priority is listed first
  assert.equal((await api('GET', `/review-cases?search=${c2.caseId.toLowerCase()}`)).body.data[0].caseId, c2.caseId);
  assert.equal((await api('GET', `/review-cases?customerId=${code}&priority=Low`)).body.data.length, 1);
  assert.equal((await api('GET', `/review-cases?customerId=${code}&caseType=Other`)).body.data[0].caseId, c1.caseId);
  assert.equal((await api('GET', `/review-cases?customerId=${code}&status=Assigned`)).body.data[0].caseId, c2.caseId);
  assert.equal((await api('GET', `/review-cases?customerId=${code}&status=Open,Assigned`)).body.pagination.totalItems, 2);
  assert.equal((await api('GET', `/review-cases?customerId=${code}&assignedAnalystId=${aA.id}`)).body.data.length, 1);
  assert.equal((await api('GET', `/review-cases?customerId=${code}&unassigned=true`)).body.data[0].caseId, c1.caseId);
  assert.equal((await api('GET', `/review-cases?customerId=${code}&overdue=true`)).body.data.length, 0);
  assert.equal((await api('GET', `/review-cases?customerId=${code}&pageSize=1&page=2`)).body.data.length, 1);
  assert.equal((await api('GET', '/review-cases?status=Bogus')).status, 400);
  assert.equal((await api('GET', '/review-cases?priority=Urgent')).status, 400);
  assert.equal((await api('GET', '/review-cases?search=%25')).status, 200);
  const listed = (await api('GET', `/review-cases?search=${token}`)).body.data[0];
  for (const f of ['caseId', 'customerId', 'caseType', 'priority', 'assignedAnalyst', 'assignedReviewer', 'dueDate', 'status']) assert.ok(f in listed, f);

  await detectFor(code);
  const exs = (await api('GET', `/exceptions?customerId=${code}&severity=Medium&type=MANDATORY_DOCUMENT_MISSING&group=Document&pageSize=2&page=2`)).body;
  assert.equal(exs.data.length, 1);
  assert.equal(exs.pagination.totalItems, 3);
  assert.equal((await api('GET', `/exceptions?customerId=${code}&withoutCase=true`)).body.data.length, 3);
  assert.equal((await api('GET', `/exceptions?search=${code.toLowerCase()}&status=Resolved`)).body.data.length, 0);
  assert.equal((await api('GET', '/exceptions?severity=Extreme')).status, 400);
  assert.equal((await api('GET', '/exceptions?type=NOPE')).status, 400);
  assert.ok((await api('GET', '/exceptions')).body.summary.active > 0);
});

test('the case details include customer, exceptions, documents, ownership, risk, assignments, notes and history', async () => {
  const code = await newCompany();
  await detectFor(code);
  const owner = (await addOwner(code, { fullName: 'Detail Owner', ownershipPercentage: 60 })).body.data;
  await insertDoc(code, 'Certificate of Incorporation', { status: 'Verified' });
  await detectFor(code);
  const exc = (await exOfType(code, 'OWNERSHIP_INCOMPLETE'))[0];
  const caseId = (await mkCase({ exceptionId: exc.id })).body.data.caseId;
  await assign(caseId, { assignedAnalystId: aA.id, assignedReviewerId: rv.id }, rv);
  await api('POST', `/review-cases/${caseId}/notes`, { note: 'Asked for the shareholder register' }, aA);

  const d = await getCase(caseId, aA);
  assert.equal(d.customer.customerType, 'Company');
  assert.ok(d.customer.name);
  assert.ok(d.exceptions.some((e) => e.isLinked && e.exceptionId === exc.exceptionId));
  assert.ok(d.documents.some((x) => x.documentType === 'Certificate of Incorporation'));
  assert.equal(d.ownership.ownerCount, 1);
  assert.equal(d.ownership.status, 'BELOW_100');
  assert.equal(d.ownership.owners[0].id, owner.id);
  assert.ok(d.risk && d.risk.riskLevel);
  assert.ok(d.kyc && typeof d.kyc.percentage === 'number');
  assert.equal(d.assignedAnalyst.id, aA.id);
  assert.equal(d.assignedReviewer.id, rv.id);
  assert.equal(d.caseType, 'Ownership Issues');
  assert.equal(d.requiresApproval, true); // ownership concerns need compliance approval
  assert.equal(d.permissions.addNote, true);
  assert.ok(d.timeline.some((t) => t.kind === 'note' && /shareholder register/.test(t.note)));
  assert.equal((await getCase(caseId, aB)).permissions.addNote, false);
  assert.equal((await api('GET', '/review-cases/CASE-999999')).status, 404);
  assert.equal((await api('GET', '/review-cases/xyz')).status, 400);
  assert.equal((await api('GET', '/review-options')).status, 200);
});

test('Scene 1, Scene 2 and Scene 3 still work with Scene 4 data present', async () => {
  const { code } = await caseOnMissingDoc();
  assert.equal((await api('GET', `/customers/${code}`)).status, 200);
  assert.equal((await api('GET', `/customers?search=${code}`)).body.pagination.totalItems, 1);
  const summary = (await api('GET', '/dashboard/summary')).body.data;
  assert.equal(summary.lowRiskCustomers + summary.mediumRiskCustomers + summary.highRiskCustomers, summary.totalCustomers);
  assert.equal((await api('GET', `/customers/${code}/kyc-completeness`)).status, 200);
  assert.equal((await api('GET', '/kyc/exceptions?pageSize=1')).status, 200);
  assert.equal((await api('GET', '/documents?pageSize=1')).status, 200);
  assert.equal((await api('GET', '/dashboard/risk-summary')).status, 200);
  assert.equal((await api('GET', `/customers/${code}/risk-summary`)).status, 200);
  assert.equal((await api('GET', '/risk-assessments?pageSize=1')).status, 200);
});
