/**
 * Phase 5: complete user workflows, end to end through the API, as a story with checks of the derived state at every step.
 * Runs against the dedicated TEST database (npm test). Everything it creates is removed afterwards (history tables are insert-only,
 * so cleanup uses the explicit maintenance switch SET LOCAL app.allow_history_delete).
 *
 *   1. individual customer: required KYC from upload to 100% completeness
 *   2. company customer: beneficial owners, ownership validation, risk history
 *   3. upload -> verify -> completeness changes
 *   4. review case: create, assign, work, resolve; timeline and audit trail preserved
 *   5. alert: raised by an expiring document, acknowledged and resolved
 *   6. missing, expired and invalid evidence
 *   7. exports are valid files
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearkyc-workflow-'));
process.env.UPLOAD_DIR = uploadDir;
const app = require('../src/app');
const prisma = require('../src/utils/prisma');
const { addDays, todayIso } = require('../src/utils/dates');

const TODAY = todayIso();
let server;
let base;
let reviewer;
let analyst;
const created = new Set();
const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const letter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const people = (await (await fetch(`${base}/reviewers`)).json()).data;
  reviewer = people.find((p) => p.role === 'Reviewer');
  analyst = people.find((p) => p.role === 'Analyst');
  assert.ok(reviewer && analyst, 'the test database has demo reviewers');
});

test.after(async () => {
  const codes = [...created];
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id IN (SELECT id FROM "Customer" WHERE customer_id = ANY(${codes}::text[]))`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE entity_type = 'Export' AND created_at > now() - interval '1 hour' AND reason LIKE '%workflow%'`,
    prisma.verification.deleteMany({ where: { document: { customer: { customerCode: { in: codes } } } } }),
    prisma.document.deleteMany({ where: { customer: { customerCode: { in: codes } } } }),
    prisma.customer.deleteMany({ where: { customerCode: { in: codes } } }),
  ]);
  fs.rmSync(uploadDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function api(method, url, body, who) {
  const isForm = body instanceof FormData;
  const res = await fetch(base + url, {
    method,
    headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...(who ? { 'x-reviewer-id': String(who.id) } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const bytes = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, bytes, text: bytes.toString('utf8'), body: type.includes('json') ? JSON.parse(bytes.toString('utf8')) : null };
}

const person = async (over = {}) => {
  const res = await api('POST', '/customers', {
    customerType: 'Individual', fullName: 'Workflow Test Person', dateOfBirth: '1988-03-04', email: 'workflow.person@example.com', phone: '9812345678', address: '5 Test Lane, Pune',
    panNumber: `WKFP${letter()}${rnd(4)}${letter()}`, aadhaarNumber: `9${rnd(11)}`, occupation: 'Engineer', country: 'IN', ...over,
  });
  assert.equal(res.status, 201, res.text);
  created.add(res.body.data.customerId);
  return res.body.data;
};
const company = async () => {
  const res = await api('POST', '/customers', {
    customerType: 'Company', legalName: `Workflow Test Company ${rnd(5)} Pvt Ltd`, registrationNumber: `WF-${rnd(10)}`, panNumber: `WKFC${letter()}${rnd(4)}${letter()}`,
    email: 'ops@workflow-test.example.com', phone: '9812345678', address: '1 Test Park', country: 'IN', businessActivity: 'Information Technology', dateOfIncorporation: '2015-05-05',
  });
  assert.equal(res.status, 201, res.text);
  created.add(res.body.data.customerId);
  return res.body.data;
};
const pdf = (tag = '') => new Blob([`%PDF-1.4\n% synthetic workflow document ${tag}\n%%EOF`], { type: 'application/pdf' });
const NUMBERED = new Set(['PAN', 'Business PAN', 'Address Proof', 'Bank Statement', 'Certificate of Incorporation']);

async function upload(code, documentType, over = {}) {
  const form = new FormData();
  const fields = { customerId: code, documentType, issueDate: addDays(TODAY, -200), submissionDate: addDays(TODAY, -5), notes: 'synthetic workflow document', ...over };
  if (NUMBERED.has(documentType)) fields.documentNumber = `SYN-${rnd(8)}`;
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.append(k, v);
  form.append('file', pdf(documentType), `${documentType.toLowerCase().replace(/\W+/g, '-')}.pdf`);
  const res = await api('POST', '/documents', form);
  assert.equal(res.status, 201, res.text);
  return res.body.data;
}
const decide = (docId, status, remarks, who = reviewer) => api('POST', `/documents/${docId}/verifications`, { status, remarks }, who);
const completeness = async (code) => (await api('GET', `/customers/${code}/kyc-completeness`)).body.data;
const stateOf = (c, type) => c.requirements.find((r) => r.documentType === type)?.state;

// ---------------------------------------------------------------------------------------------------------------------------
test('workflow 1 + 3: individual customer - upload, verify, and completeness follows the verified, valid documents only', async () => {
  const c = await person();
  assert.match(c.customerId, /^CUS-\d{6}$/);
  const level = c.currentRisk.level;
  assert.equal(level, 'Low');

  let k = await completeness(c.customerId);
  const required = k.requirements.filter((r) => r.isMandatory).map((r) => r.documentType);
  assert.deepEqual(required.sort(), ['Address Proof', 'PAN', 'Photograph'], 'Low-risk individuals must provide PAN, Address Proof and Photograph');
  assert.equal(k.percentage, 0);
  assert.equal(k.status, 'Not Started');
  assert.ok(k.requirements.every((r) => r.state === 'Missing'));

  const docs = {};
  for (const type of required) docs[type] = await upload(c.customerId, type);
  k = await completeness(c.customerId);
  assert.equal(k.percentage, 0, 'uploaded but not verified: nothing counts yet');
  assert.ok(required.every((t) => stateOf(k, t) === 'Pending Verification'));

  const seen = [];
  for (const [i, type] of required.entries()) {
    const before = (await api('GET', `/documents/${docs[type].id}/verifications`)).body.data.items.length;
    assert.equal((await decide(docs[type].id, 'In Review', 'review started')).status, 201);
    assert.equal((await decide(docs[type].id, 'Verified', 'Checked against the synthetic record')).status, 201);
    const history = (await api('GET', `/documents/${docs[type].id}/verifications`)).body.data.items;
    assert.equal(history.length, before + 2, 'each decision is a NEW record, earlier ones are kept');
    seen.push((await completeness(c.customerId)).percentage);
    assert.equal(stateOf(await completeness(c.customerId), type), 'Verified', `step ${i + 1}`);
  }
  assert.deepEqual(seen, [33.3, 66.7, 100]);
  k = await completeness(c.customerId);
  assert.equal(k.status, 'Complete');
  assert.deepEqual([k.totals.missing, k.totals.pendingVerification, k.totals.rejected, k.totals.expired], [0, 0, 0, 0]);
});

test('workflow 2: company customer - beneficial owners, ownership validation and risk history', async () => {
  const co = await company();
  const code = co.customerId;
  const validation = async () => (await api('GET', `/customers/${code}/ownership-validation`)).body.data.current;
  const owner = (pct, name) => api('POST', `/customers/${code}/beneficial-owners`, {
    fullName: name, dateOfBirth: '1975-04-12', countryOfResidence: 'IN', nationality: 'IN', ownershipPercentage: pct, ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'No', notes: 'synthetic',
  }, analyst);

  assert.equal((await validation()).status, 'NO_OWNERS');
  const first = await owner(60, 'Meera Workflow Owner');
  assert.equal(first.status, 201, first.text);
  assert.equal((await validation()).status, 'BELOW_100');
  assert.equal((await owner(40, 'Rohan Workflow Owner')).status, 201);
  assert.deepEqual([(await validation()).status, (await validation()).totalPercentage], ['RECONCILED', 100]);
  assert.equal((await owner(60, 'Meera Workflow Owner')).status, 409, 'the same person cannot be added twice to one company');
  assert.equal((await owner(150, 'Invalid Percentage')).status, 400, 'more than 100% for one owner is refused');
  assert.equal((await owner(20, 'Third Workflow Owner')).status, 201);
  assert.deepEqual([(await validation()).status, (await validation()).totalPercentage], ['EXCEEDS_100', 120], 'a total above 100% is flagged');

  // risk and ownership history are preserved, never overwritten
  const r1 = await api('POST', `/customers/${code}/risk-assessments`, {}, reviewer);
  assert.equal(r1.status, 201, r1.text);
  const r2 = await api('POST', `/customers/${code}/risk-assessments`, { force: true, remarks: 'second assessment recorded on purpose' }, reviewer);
  assert.equal(r2.status, 201, r2.text);
  const history = (await api('GET', `/customers/${code}/risk-assessments`)).body.data;
  const items = history.items ?? history;
  assert.ok(items.length >= 2, 'onboarding rating plus the new assessment');
  assert.ok(items.some((a) => a.assessmentId === r1.body.data.assessmentId), 'the earlier assessment is still there');
  assert.equal(await prisma.riskRating.count({ where: { customer: { customerCode: code } } }), items.length);
  const checks = await api('POST', `/customers/${code}/ownership-validation`, undefined, analyst);
  assert.equal(checks.status, 201);
  const kept = await prisma.ownershipValidation.count({ where: { customer: { customerCode: code } } });
  await api('POST', `/customers/${code}/ownership-validation`, undefined, analyst);
  assert.equal(await prisma.ownershipValidation.count({ where: { customer: { customerCode: code } } }), kept + 1, 'a recorded check is a new row each time');
});

test('workflow 4: review case - create, assign, work, resolve; the timeline and the audit trail keep every step', async () => {
  const c = await person();
  const made = await api('POST', '/review-cases', { customerId: c.customerId, caseTitle: 'Workflow case: confirm address', caseType: 'Verification Issues', priority: 'Medium', description: 'Manual case created by the workflow test' }, analyst);
  assert.equal(made.status, 201, made.text);
  const id = made.body.data.id;
  const code = made.body.data.caseId;
  assert.equal(made.body.data.status, 'Open');
  assert.equal((await api('PATCH', `/review-cases/${id}/assign`, { assignedAnalystId: analyst.id }, analyst)).status, 200);
  assert.equal((await api('PATCH', `/review-cases/${id}/status`, { action: 'start' }, analyst)).body.data.status, 'In Progress');
  assert.equal((await api('POST', `/review-cases/${id}/notes`, { note: 'Called the customer; waiting for a utility bill.' }, analyst)).status, 201);
  assert.equal((await api('PATCH', `/review-cases/${id}/status`, { action: 'resolve' }, analyst)).status, 400, 'resolving needs notes');
  const done = await api('PATCH', `/review-cases/${id}/status`, { action: 'resolve', resolutionNotes: 'Utility bill received and checked against the registered address.' }, analyst);
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.data.status, 'Resolved');

  const timeline = [...(await api('GET', `/review-cases/${id}/history`)).body.data.items].sort((a, b) => a.id - b.id); // the API lists newest first
  const order = ['CREATED', 'ASSIGNED_ANALYST', 'STARTED', 'RESOLVED'];
  const actionsInOrder = timeline.map((h) => h.action);
  let position = -1;
  for (const a of order) {
    const at = actionsInOrder.indexOf(a);
    assert.ok(at > position, `${a} comes after the previous step: ${actionsInOrder.join(', ')}`);
    position = at;
  }
  assert.ok(timeline.length >= 4 && timeline.every((h, i) => i === 0 || new Date(h.changedAt) >= new Date(timeline[i - 1].changedAt)), 'history is in time order');

  const audit = (await api('GET', `/audit-events?customerId=${c.customerId}&entityType=ReviewCase&pageSize=50`, null, reviewer)).body.data;
  const actions = audit.map((e) => e.actionType);
  for (const a of ['CASE_CREATED', 'CASE_ASSIGNED', 'CASE_RESOLVED', 'CASE_NOTE_ADDED']) assert.ok(actions.includes(a), `${a} is in the audit trail`);

  // the audit trail is append-only: no API route changes it, and the database refuses even a direct attempt
  for (const method of ['PUT', 'PATCH', 'DELETE', 'POST']) assert.ok([404, 405].includes((await api(method, `/audit-events/${audit[0].id}`, method === 'DELETE' ? undefined : {}, reviewer)).status), `${method} /audit-events/:id does not exist`);
  await assert.rejects(prisma.$executeRaw`UPDATE "AuditEvent" SET reason = 'edited' WHERE id = ${audit[0].id}`, /immutable|cannot|audit/i);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE id = ${audit[0].id}`, /immutable|cannot|audit/i);
  await assert.rejects(prisma.$executeRaw`UPDATE "CaseHistory" SET remarks = 'edited' WHERE review_case_id = ${id}`, /immutable|record/i);
  assert.equal(await prisma.auditEvent.count({ where: { id: audit[0].id } }), 1);
});

test('workflow 5: an expiring document raises an alert that is acknowledged and resolved, with history', async () => {
  const c = await person();
  const doc = await upload(c.customerId, 'Address Proof', { issueDate: addDays(TODAY, -300), expiryDate: addDays(TODAY, 20) });
  assert.equal((await decide(doc.id, 'Verified', 'Valid for now')).status, 201);
  const detect = await api('POST', '/exceptions/detect', { customerId: c.customerId }, analyst);
  assert.equal(detect.status, 200, detect.text);
  const alerts = (await api('GET', `/alerts?customerId=${c.customerId}&pageSize=50`)).body.data;
  const expiry = alerts.filter((a) => a.alertType === 'DOCUMENT_EXPIRY' && a.isActive);
  assert.equal(expiry.length, 1, 'one active expiry alert');
  assert.equal(expiry[0].threshold, 30, 'the 30-day lead time applies to a document expiring in 20 days');
  assert.equal((await api('POST', '/exceptions/detect', { customerId: c.customerId }, analyst)).body.data.alertsCreated, 0, 'detecting again creates no duplicate');
  const id = expiry[0].alertId;
  assert.equal((await api('PATCH', `/alerts/${id}/acknowledge`, { remarks: 'On my list' }, analyst)).status, 200);
  assert.equal((await api('PATCH', `/alerts/${id}/resolve`, { resolutionNotes: 'short' }, analyst)).status, 400, 'resolution remarks must be meaningful');
  const resolved = await api('PATCH', `/alerts/${id}/resolve`, { resolutionNotes: 'Customer will renew the address proof; follow-up booked.' }, analyst);
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(resolved.body.data.status, 'Resolved');
  const audit = (await api('GET', `/audit-events?customerId=${c.customerId}&entityType=Alert&pageSize=50`, null, reviewer)).body.data.map((e) => e.actionType);
  for (const a of ['ALERT_GENERATED', 'ALERT_ACKNOWLEDGED', 'ALERT_RESOLVED']) assert.ok(audit.includes(a), a);
  assert.equal((await api('PATCH', `/alerts/${id}/acknowledge`, {}, analyst)).status, 409, 'a closed alert cannot be reopened');
});

test('workflow 6: missing, expired and invalid evidence never count as valid KYC evidence', async () => {
  const c = await person();
  let k = await completeness(c.customerId);
  assert.equal(stateOf(k, 'PAN'), 'Missing');
  assert.ok((await api('GET', `/kyc/exceptions?customerId=${c.customerId}&pageSize=50`)).body.data.some((e) => e.type === 'MISSING_DOCUMENT' || /missing/i.test(JSON.stringify(e))));

  // expired evidence. First protection: a document that is ALREADY expired cannot be verified at all.
  const alreadyExpired = await upload(c.customerId, 'Address Proof', { issueDate: addDays(TODAY, -500), submissionDate: addDays(TODAY, -450), expiryDate: addDays(TODAY, -30) });
  const refused = await decide(alreadyExpired.id, 'Verified', 'Trying to verify an expired document');
  assert.equal(refused.status, 409, refused.text);
  assert.equal(refused.body.error.code, 'DOCUMENT_EXPIRED');
  // Second protection: a document verified while valid stops counting once its expiry date passes (time is simulated by moving the dates).
  const valid = await upload(c.customerId, 'Bank Statement', { issueDate: addDays(TODAY, -100), expiryDate: addDays(TODAY, 5) });
  assert.equal((await decide(valid.id, 'Verified', 'Valid for now')).status, 201);
  const mandatoryBank = (await completeness(c.customerId)).requirements.find((r) => r.documentType === 'Bank Statement');
  if (mandatoryBank) assert.equal(mandatoryBank.state, 'Verified', 'valid and verified: counts');
  await prisma.document.update({ where: { id: valid.id }, data: { issueDate: new Date(`${addDays(TODAY, -400)}T00:00:00Z`), expiryDate: new Date(`${addDays(TODAY, -35)}T00:00:00Z`) } });
  k = await completeness(c.customerId);
  const extra = [...k.requirements.map((r) => r.document), ...(k.extraDocuments ?? [])].filter(Boolean).find((d) => d.id === valid.id);
  assert.equal(extra?.effectiveStatus, 'Expired', 'Verified but past its expiry date: reported as Expired');
  assert.ok(extra.status === 'Verified' && extra.expiryState === 'Expired', 'the old Verified decision is kept as history, but never counts as valid');
  assert.equal(k.totals.verified, 0, 'an expired document is not counted as verified evidence');
  assert.equal(k.percentage, 0);

  // rejected and resubmission requested
  const pan = await upload(c.customerId, 'PAN');
  assert.equal((await decide(pan.id, 'Rejected', '')).status, 400, 'a rejection must be explained');
  assert.equal((await decide(pan.id, 'Rejected', 'The copy is unreadable')).status, 201);
  k = await completeness(c.customerId);
  assert.equal(stateOf(k, 'PAN'), 'Rejected');
  assert.equal(k.totals.verified, 0);
  const photo = await upload(c.customerId, 'Photograph');
  assert.equal((await decide(photo.id, 'Requires Resubmission', 'Please upload a recent photograph')).status, 201);
  assert.equal(stateOf(await completeness(c.customerId), 'Photograph'), 'Requires Resubmission');

  // invalid evidence is refused at the door
  const badType = new FormData();
  for (const [key, v] of Object.entries({ customerId: c.customerId, documentType: 'PAN', documentNumber: 'SYN-123456', issueDate: addDays(TODAY, -10), submissionDate: addDays(TODAY, -1) })) badType.append(key, v);
  badType.append('file', new Blob(['MZ not a document'], { type: 'application/x-msdownload' }), 'run.exe');
  assert.equal((await api('POST', '/documents', badType)).status, 400, 'an executable is not accepted');
  const badDates = await api('POST', '/documents', { customerId: c.customerId, documentType: 'PAN', documentNumber: 'SYN-777777', issueDate: addDays(TODAY, -10), expiryDate: addDays(TODAY, -20), submissionDate: addDays(TODAY, -1) });
  assert.equal(badDates.status, 400);
  assert.ok(badDates.body.error.details.expiryDate || badDates.body.error.details.issueDate, 'the expiry date before the issue date is explained');
  assert.equal((await api('POST', '/documents', { customerId: 'CUS-999999', documentType: 'PAN', documentNumber: 'SYN-888888', issueDate: addDays(TODAY, -10), submissionDate: addDays(TODAY, -1) })).status, 404);
  assert.equal((await decide(pan.id, 'Verified', 'trying as an analyst', analyst)).status, 403, 'an analyst cannot record a decision');
});

test('workflow 7: exports are valid files with masked identifiers', async () => {
  const c = await person();
  const csv = await api('GET', '/exports/customers', null, reviewer);
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.deepEqual([...csv.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 byte-order mark');
  const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.equal(lines[0], 'Customer ID,Customer Type,Full Name,Email (masked),Phone (masked),Country,PAN (masked),Aadhaar (masked),Registration Status,Risk Level,Risk Score,Created At');
  assert.equal(lines.length - 1, await prisma.customer.count(), 'one line per customer');
  assert.ok(lines.some((l) => l.startsWith(c.customerId)));
  assert.ok(!/\b[A-Z]{5}\d{4}[A-Z]\b/.test(csv.text), 'no full PAN in the file');
  assert.ok(!/\b\d{12}\b/.test(csv.text), 'no full Aadhaar in the file');

  const seed = await api('GET', '/exports/seed-data', null, reviewer);
  assert.equal(seed.status, 200);
  const json = JSON.parse(seed.text);
  assert.equal(json.meta.kind, 'Synthetic seed data export');
  assert.ok(Object.keys(json.data).length >= 5, 'seed data is valid JSON with several tables');

  const schema = await api('GET', '/exports/schema', null, reviewer);
  assert.equal(schema.status, 200);
  assert.match(schema.text, /CREATE TABLE/i);
  assert.ok(!/^INSERT INTO/m.test(schema.text), 'the schema export holds no data');
  for (const key of ['documents', 'completeness', 'review-cases', 'alerts']) {
    const r = await api('GET', `/exports/${key}`, null, analyst);
    assert.equal(r.status, 200, key);
    assert.ok(r.text.replace(/^﻿/, '').split(/\r?\n/)[0].includes(','), `${key} has a header row`);
  }
  assert.equal((await api('GET', '/exports/customers', null, analyst)).status, 403, 'sensitive exports need a compliance reviewer');
});
