/**
 * Phase 6, item 1: onboarding decisions (approve / reject).
 * Runs against the dedicated TEST database (npm test). Everything created here is removed afterwards with the explicit maintenance
 * switch SET LOCAL app.allow_history_delete (decisions, verifications and audit events are insert-only).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearkyc-decisions-'));
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
});

test.after(async () => {
  const codes = [...created];
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id IN (SELECT id FROM "Customer" WHERE customer_id = ANY(${codes}::text[]))`,
    prisma.onboardingDecision.deleteMany({ where: { customer: { customerCode: { in: codes } } } }),
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
  const text = await res.text();
  return { status: res.status, text, body: (res.headers.get('content-type') || '').includes('json') ? JSON.parse(text) : null };
}

const newPerson = async () => {
  const res = await api('POST', '/customers', {
    customerType: 'Individual', fullName: 'Decision Test Person', dateOfBirth: '1988-03-04', email: 'decision.person@example.com', phone: '9812345678', address: '5 Test Lane, Pune',
    panNumber: `DECP${letter()}${rnd(4)}${letter()}`, aadhaarNumber: `9${rnd(11)}`, occupation: 'Engineer', country: 'IN',
  });
  assert.equal(res.status, 201, res.text);
  created.add(res.body.data.customerId);
  return res.body.data.customerId;
};
const NUMBERED = new Set(['PAN', 'Address Proof']);
async function uploadAndVerify(code, documentType, over = {}) {
  const form = new FormData();
  const fields = { customerId: code, documentType, issueDate: addDays(TODAY, -200), submissionDate: addDays(TODAY, -5), notes: 'synthetic decision test', ...over };
  if (NUMBERED.has(documentType)) fields.documentNumber = `SYN-${rnd(8)}`;
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob(['%PDF-1.4\n% synthetic\n%%EOF'], { type: 'application/pdf' }), 'doc.pdf');
  const doc = await api('POST', '/documents', form);
  assert.equal(doc.status, 201, doc.text);
  assert.equal((await api('POST', `/documents/${doc.body.data.id}/verifications`, { status: 'Verified', remarks: 'synthetic' }, reviewer)).status, 201);
}
const completeCustomer = async () => {
  const code = await newPerson();
  for (const type of ['PAN', 'Address Proof', 'Photograph']) await uploadAndVerify(code, type);
  return code;
};
const url = (code) => `/customers/${code}/onboarding-decisions`;

test('a new customer is Pending Review; an incomplete file cannot be approved but can be rejected', async () => {
  const code = await newPerson();
  const view = (await api('GET', url(code))).body.data;
  assert.equal(view.status, 'Pending Review');
  assert.deepEqual(view.history, []);
  assert.deepEqual(view.allowedDecisions, ['Rejected'], 'approval is not offered while evidence is missing');
  assert.equal(view.approvalBlockers.length, 3);

  const blocked = await api('POST', url(code), { decision: 'Approved', reason: 'Trying to approve early' }, reviewer);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'APPROVAL_NOT_PERMITTED');
  assert.equal(blocked.body.error.details.blockers.length, 3);
  assert.equal(await prisma.onboardingDecision.count({ where: { customer: { customerCode: code } } }), 0, 'nothing was recorded');

  const rejected = await api('POST', url(code), { decision: 'Rejected', reason: 'Documents not provided after repeated requests' }, reviewer);
  assert.equal(rejected.status, 201, rejected.text);
  assert.equal(rejected.body.data.status, 'Rejected');
  assert.equal(rejected.body.data.decision.decidedBy.id, reviewer.id);
  assert.equal(rejected.body.data.decision.reason, 'Documents not provided after repeated requests');
  assert.ok(!Number.isNaN(Date.parse(rejected.body.data.decision.decidedAt)));
});

test('a complete file is approved; the decision is final, history is kept and audited', async () => {
  const code = await completeCustomer();
  const before = (await api('GET', url(code))).body.data;
  assert.deepEqual(before.allowedDecisions, ['Rejected', 'Approved']);
  assert.deepEqual(before.approvalBlockers, []);

  const approved = await api('POST', url(code), { decision: 'Approved', reason: 'All mandatory documents verified' }, reviewer);
  assert.equal(approved.status, 201, approved.text);
  assert.equal(approved.body.data.status, 'Approved');
  assert.equal(approved.body.data.isFinal, true);
  assert.deepEqual(approved.body.data.allowedDecisions, []);

  // a second decision is refused and the first is not overwritten
  for (const decision of ['Rejected', 'Approved']) {
    const again = await api('POST', url(code), { decision, reason: 'Changing my mind' }, reviewer);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'DECISION_FINAL');
  }
  const history = (await api('GET', url(code))).body.data.history;
  assert.equal(history.length, 1);
  assert.equal(history[0].decision, 'Approved');
  assert.equal(history[0].reason, 'All mandatory documents verified');

  // insert-only at the database level
  await assert.rejects(prisma.$executeRaw`UPDATE "OnboardingDecision" SET decision = 'Rejected' WHERE id = ${history[0].id}`, /immutable|insert-only|cannot/i);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "OnboardingDecision" WHERE id = ${history[0].id}`, /immutable|insert-only|cannot|deleted/i);

  const events = await prisma.auditEvent.findMany({ where: { actionType: 'ONBOARDING_DECISION_RECORDED', entityId: history[0].id } });
  assert.equal(events.length, 1);
  assert.equal(events[0].userId, reviewer.id);
  assert.equal(events[0].reason, 'All mandatory documents verified');
  assert.deepEqual(events[0].newValues.decision, 'Approved');
});

test('permissions and validation: 404, 401, 403, missing reason, invalid decision', async () => {
  const code = await newPerson();
  assert.equal((await api('GET', url('CUS-999999'))).status, 404);
  assert.equal((await api('POST', url('CUS-999999'), { decision: 'Rejected', reason: 'x' }, reviewer)).status, 404);
  assert.equal((await api('GET', url('not-an-id'))).status, 400);
  assert.equal((await api('POST', url(code), { decision: 'Rejected', reason: 'x' })).status, 401);
  assert.equal((await api('POST', url(code), { decision: 'Rejected', reason: 'x' }, analyst)).status, 403);
  for (const body of [{ decision: 'Rejected' }, { decision: 'Rejected', reason: '   ' }, { decision: 'Maybe', reason: 'x' }, { decision: 'Pending Review', reason: 'x' }, { reason: 'x' }, {}]) {
    const r = await api('POST', url(code), body, reviewer);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal(await prisma.onboardingDecision.count({ where: { customer: { customerCode: code } } }), 0);
});

test('a document that is still valid (expires in 30 days) does not block approval', async () => {
  const code = await newPerson();
  for (const type of ['PAN', 'Photograph']) await uploadAndVerify(code, type);
  await uploadAndVerify(code, 'Address Proof', { issueDate: addDays(TODAY, -400), expiryDate: addDays(TODAY, 30) });
  assert.equal((await api('GET', url(code))).body.data.approvalBlockers.length, 0, 'valid for 30 more days');
  const k = (await api('GET', `/customers/${code}/kyc-completeness`)).body.data;
  assert.equal(k.status, 'Complete');
});

test('two decisions at the same moment: exactly one is recorded', async () => {
  const code = await completeCustomer();
  const results = await Promise.all([
    api('POST', url(code), { decision: 'Approved', reason: 'Approve (race)' }, reviewer),
    api('POST', url(code), { decision: 'Rejected', reason: 'Reject (race)' }, reviewer),
    api('POST', url(code), { decision: 'Approved', reason: 'Approve again (race)' }, reviewer),
  ]);
  assert.equal(results.filter((r) => r.status === 201).length, 1, results.map((r) => r.status).join());
  assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409), results.map((r) => `${r.status}:${r.body?.error?.code ?? 'ok'}:${(r.body?.error?.message ?? '').slice(0, 80)}`).join(' | '));
  assert.equal(await prisma.onboardingDecision.count({ where: { customer: { customerCode: code }, decision: { in: ['Approved', 'Rejected'] } } }), 1);
});

test('the database itself refuses a decision without a reason or from a non-reviewer', async () => {
  const code = await newPerson();
  const customer = await prisma.customer.findUnique({ where: { customerCode: code } });
  await assert.rejects(prisma.onboardingDecision.create({ data: { customerId: customer.id, decision: 'Rejected', decidedById: reviewer.id, notes: '  ' } }));
  await assert.rejects(prisma.onboardingDecision.create({ data: { customerId: customer.id, decision: 'Rejected', decidedById: analyst.id, notes: 'reason' } }));
});

test('APPROVAL POLICY (replaces the Phase 6 "exceptions never block" rule): an open Low exception is not an evidence blocker, but approval now needs a follow-up action', async () => {
  const code = await newPerson();
  for (const type of ['PAN', 'Photograph']) await uploadAndVerify(code, type);
  await uploadAndVerify(code, 'Address Proof', { issueDate: addDays(TODAY, -300), expiryDate: addDays(TODAY, 20) }); // verified, but expiring soon (Low)
  const detect = await api('POST', '/exceptions/detect', { customerId: code }, reviewer);
  assert.equal(detect.status, 200, detect.text);
  const exceptions = (await api('GET', `/exceptions?customerId=${code}&status=active&pageSize=50`)).body.data;
  assert.ok(exceptions.length >= 1, 'the customer has an active exception (document expiring soon)');

  const view = (await api('GET', url(code))).body.data;
  assert.deepEqual(view.approvalBlockers, [], 'an open exception is not an EVIDENCE blocker');
  const refused = await api('POST', url(code), { decision: 'Approved', reason: 'Evidence complete; expiry reminder is open' }, reviewer);
  assert.equal(refused.status, 400, 'a Low exception is open: a follow-up action is required');
  assert.ok(refused.body.error.details.followUpAction);
  const approved = await api('POST', url(code), { decision: 'Approved', reason: 'Evidence complete; expiry reminder is open', followUpAction: 'Ask for a renewed address proof' }, reviewer);
  assert.equal(approved.status, 201, approved.text);
});
