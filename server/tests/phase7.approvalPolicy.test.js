/**
 * Onboarding approval policy: open Critical / High exceptions block approval (unless waived with a reason, audited), open Medium / Low
 * exceptions need a follow-up action, no open exception means the existing evidence rule. Runs against the dedicated TEST database
 * (npm test); everything created is removed afterwards with the maintenance switch SET LOCAL app.allow_history_delete.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearkyc-policy-'));
process.env.UPLOAD_DIR = uploadDir;
const app = require('../src/app');
const prisma = require('../src/utils/prisma');
const { addDays, todayIso } = require('../src/utils/dates');

const TODAY = todayIso();
let server;
let base;
let reviewer;
let admin;
let analyst;
const created = new Set();
const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const letter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));
const NUMBERED = new Set(['PAN', 'Address Proof', 'Business PAN', 'Bank Statement', 'Certificate of Incorporation']);

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const people = (await (await fetch(`${base}/reviewers`)).json()).data;
  reviewer = people.find((p) => p.role === 'Reviewer');
  admin = people.find((p) => p.role === 'Admin');
  analyst = people.find((p) => p.role === 'Analyst');
  assert.ok(reviewer && admin && analyst);
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
const url = (code) => `/customers/${code}/onboarding-decisions`;
const detect = (code) => api('POST', '/exceptions/detect', { customerId: code }, reviewer);
const view = async (code) => (await api('GET', url(code))).body.data;
const decide = (code, body, who = reviewer) => api('POST', url(code), body, who);
const decisionRows = (code) => prisma.onboardingDecision.count({ where: { customer: { customerCode: code } } });

// ---- synthetic customers -------------------------------------------------------------------------------------------
async function upload(code, documentType, over = {}) {
  const form = new FormData();
  const fields = { customerId: code, documentType, issueDate: addDays(TODAY, -200), submissionDate: addDays(TODAY, -5), notes: 'synthetic policy test', ...over };
  if (NUMBERED.has(documentType)) fields.documentNumber = `SYN-${rnd(8)}`;
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob(['%PDF-1.4\n% synthetic\n%%EOF'], { type: 'application/pdf' }), 'doc.pdf');
  const res = await api('POST', '/documents', form);
  assert.equal(res.status, 201, res.text);
  return res.body.data;
}
const verifyAll = async (code, over = {}) => {
  const k = (await api('GET', `/customers/${code}/kyc-completeness`)).body.data;
  for (const r of k.requirements.filter((x) => x.isMandatory)) {
    const doc = await upload(code, r.documentType, over[r.documentType] ?? {});
    assert.equal((await api('POST', `/documents/${doc.id}/verifications`, { status: 'Verified', remarks: 'synthetic' }, reviewer)).status, 201);
  }
};
async function person(over = {}) {
  const res = await api('POST', '/customers', {
    customerType: 'Individual', fullName: 'Policy Test Person', dateOfBirth: '1988-03-04', email: 'policy.person@example.com', phone: '9812345678', address: '5 Test Lane, Pune',
    panNumber: `PLCP${letter()}${rnd(4)}${letter()}`, aadhaarNumber: `9${rnd(11)}`, occupation: 'Engineer', country: 'IN', ...over,
  });
  assert.equal(res.status, 201, res.text);
  created.add(res.body.data.customerId);
  return res.body.data.customerId;
}
async function company() {
  const res = await api('POST', '/customers', {
    customerType: 'Company', legalName: `Policy Test Company ${rnd(5)} Pvt Ltd`, registrationNumber: `PL-${rnd(10)}`, panNumber: `PLCC${letter()}${rnd(4)}${letter()}`,
    email: 'ops@policy-test.example.com', phone: '9812345678', address: '1 Test Park', country: 'IN', businessActivity: 'Information Technology', dateOfIncorporation: '2015-05-05',
  });
  assert.equal(res.status, 201, res.text);
  created.add(res.body.data.customerId);
  return res.body.data.customerId;
}
let ownerSeq = 0;
const ownerBody = (percent) => {
  ownerSeq += 1;
  return { fullName: `Policy Owner ${String.fromCharCode(65 + (ownerSeq % 26))}${ownerSeq}`, dateOfBirth: `19${60 + (ownerSeq % 30)}-0${1 + (ownerSeq % 9)}-1${ownerSeq % 9}`, countryOfResidence: 'IN', nationality: 'IN', ownershipPercentage: percent, ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'No', notes: 'synthetic' };
};
const addOwner = async (code, percent) => {
  const body = ownerBody(percent);
  const res = await api('POST', `/customers/${code}/beneficial-owners`, body, analyst);
  assert.equal(res.status, 201, res.text);
  return { id: res.body.data.id, body };
};
/** A company with complete mandatory evidence and the given owner percentages. */
async function completeCompany(percents) {
  const code = await company();
  await verifyAll(code);
  const owners = [];
  for (const p of percents) owners.push(await addOwner(code, p));
  return { code, owners };
}
const activeExceptions = (code) => prisma.exception.findMany({ where: { customer: { customerCode: code }, status: { in: ['Open', 'In Review'] } }, orderBy: { id: 'asc' } });

// ---------------------------------------------------------------------------------------------------------------------------
test('a HIGH exception blocks approval: 409 with the blocking exceptions, nothing recorded, the screen data explains it', async () => {
  const { code } = await completeCompany([60, 60]); // 120%: ownership exceeds 100% (High)
  await detect(code);
  const v = await view(code);
  assert.equal(v.policy.outcome, 'Needs waiver');
  assert.equal(v.policy.blockingExceptions.length, 1);
  assert.equal(v.policy.blockingExceptions[0].exceptionType, 'OWNERSHIP_EXCEEDS_100');
  assert.equal(v.policy.blockingExceptions[0].severity, 'High');
  assert.match(v.policy.explanation, /blocked by 1 open Critical or High exception/);
  assert.deepEqual(v.approvalBlockers, [], 'the evidence is complete: the exception is the only reason');
  assert.ok(v.allowedDecisions.includes('Approved'), 'approval can still be given with a waiver');

  const r = await decide(code, { decision: 'Approved', reason: 'Trying to approve' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'APPROVAL_BLOCKED_BY_EXCEPTIONS');
  assert.equal(r.body.error.details.blockingExceptions[0].severity, 'High');
  assert.match(r.body.error.message, /EXC-\d+/);
  assert.equal(await decisionRows(code), 0);
});

test('a CRITICAL exception (potential sanctions match) blocks approval', async () => {
  const { code, owners } = await completeCompany([60, 40]); // reconciled: no ownership exception
  const shot = await api('POST', `/beneficial-owners/${owners[0].id}/screening`, { screeningType: 'Sanctions', mode: 'manual', screeningResult: 'Potential Match', remarks: 'synthetic potential match' }, reviewer);
  assert.equal(shot.status, 201, shot.text);
  await detect(code);
  const v = await view(code);
  assert.deepEqual(v.policy.blockingExceptions.map((e) => e.severity), ['Critical']);
  const r = await decide(code, { decision: 'Approved', reason: 'Trying to approve' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'APPROVAL_BLOCKED_BY_EXCEPTIONS');
  assert.equal(r.body.error.details.blockingExceptions[0].exceptionType, 'POTENTIAL_SANCTIONS_MATCH');
  assert.equal(await decisionRows(code), 0);
});

test('LOW exception: does not block, but approval needs a follow-up action (rationale = the decision reason); both are stored', async () => {
  const code = await person();
  await verifyAll(code, { 'Address Proof': { issueDate: addDays(TODAY, -300), expiryDate: addDays(TODAY, 20) } }); // verified, expiring in 20 days: Low
  await detect(code);
  const v = await view(code);
  assert.equal(v.policy.outcome, 'Needs follow-up');
  assert.deepEqual(v.policy.blockingExceptions, []);
  assert.deepEqual(v.policy.nonBlockingExceptions.map((e) => e.severity), ['Low']);
  assert.equal(v.policy.requiresFollowUp, true);

  const noFollowUp = await decide(code, { decision: 'Approved', reason: 'Evidence is complete' });
  assert.equal(noFollowUp.status, 400);
  assert.match(noFollowUp.body.error.details.followUpAction, /follow-up action/i);
  const blankFollowUp = await decide(code, { decision: 'Approved', reason: 'Evidence is complete', followUpAction: '   ' });
  assert.equal(blankFollowUp.status, 400);
  assert.equal(await decisionRows(code), 0, 'nothing was recorded');
  assert.equal((await decide(code, { decision: 'Approved', reason: '', followUpAction: 'Ask for a renewed address proof' })).status, 400, 'the rationale is required too');

  const ok = await decide(code, { decision: 'Approved', reason: 'Evidence is complete; only an expiry reminder is open', followUpAction: 'Request a renewed Address Proof within 14 days' });
  assert.equal(ok.status, 201, ok.text);
  const h = ok.body.data.history[0];
  assert.equal(h.reason, 'Evidence is complete; only an expiry reminder is open');
  assert.equal(h.followUpAction, 'Request a renewed Address Proof within 14 days');
  assert.equal(h.exceptionsAtDecision.length, 1);
  assert.deepEqual([h.exceptionsAtDecision[0].severity, h.exceptionsAtDecision[0].waived], ['Low', false]);
  assert.deepEqual(h.waivers, []);
  const ev = await prisma.auditEvent.findFirst({ where: { actionType: 'ONBOARDING_DECISION_RECORDED', entityId: h.id } });
  assert.equal(ev.newValues.followUpAction, 'Request a renewed Address Proof within 14 days');
  assert.equal((await activeExceptions(code)).length, 1, 'the exception is untouched and still open');
});

test('MEDIUM exception (ownership below 100%): does not block, needs a follow-up action', async () => {
  const { code } = await completeCompany([60]); // 60%: ownership incomplete (Medium)
  await detect(code);
  const v = await view(code);
  assert.deepEqual(v.policy.nonBlockingExceptions.map((e) => e.severity), ['Medium']);
  assert.equal((await decide(code, { decision: 'Approved', reason: 'Evidence complete' })).status, 400);
  const ok = await decide(code, { decision: 'Approved', reason: 'Evidence complete; ownership being completed', followUpAction: 'Collect the remaining 40% owner details' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.data.history[0].exceptionsAtDecision[0].severity, 'Medium');
});

test('no open exception: the existing evidence rule applies and no follow-up is needed', async () => {
  const code = await person();
  await verifyAll(code);
  await detect(code);
  const v = await view(code);
  assert.equal(v.policy.outcome, 'Approvable');
  assert.equal(v.policy.requiresFollowUp, false);
  const ok = await decide(code, { decision: 'Approved', reason: 'All mandatory documents verified' });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.data.history[0].followUpAction, null);
  // incomplete evidence is still refused (the old rule), whatever the exceptions
  const incomplete = await person();
  const r = await decide(incomplete, { decision: 'Approved', reason: 'No' });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'APPROVAL_NOT_PERMITTED');
});

test('RESOLVED exceptions do not block, and their history is kept', async () => {
  const { code, owners } = await completeCompany([60, 60]);
  await detect(code);
  const [high] = await activeExceptions(code);
  assert.equal(high.exceptionType, 'OWNERSHIP_EXCEEDS_100');
  assert.equal((await decide(code, { decision: 'Approved', reason: 'Trying' })).status, 409);

  // fix the data: the second owner is corrected to 40%, so the condition clears
  const fix = await api('PUT', `/beneficial-owners/${owners[1].id}`, { ...owners[1].body, ownershipPercentage: 40 }, analyst);
  assert.equal(fix.status, 200, fix.text);
  const ok = await decide(code, { decision: 'Approved', reason: 'Ownership corrected to 100%' });
  assert.equal(ok.status, 201, ok.text);
  const row = await prisma.exception.findUnique({ where: { id: high.id } });
  assert.equal(row.status, 'Resolved', 'the exception was resolved by detection and still exists');
  assert.equal(row.resolutionType, 'Condition cleared');
  assert.deepEqual(ok.body.data.history[0].exceptionsAtDecision, [], 'nothing was open at the decision');
});

test('WAIVER: only an authorised reviewer, only with a reason; audited; the exception and its history stay as they are', async () => {
  const { code } = await completeCompany([60, 60]);
  await detect(code);
  const [high] = await activeExceptions(code);
  const waive = (reason, id = high.exceptionCode) => [{ exceptionId: id, reason }];

  // who: not an analyst, not anonymous
  assert.equal((await decide(code, { decision: 'Approved', reason: 'x', waivers: waive('Accepted by compliance') }, analyst)).status, 403);
  assert.equal((await decide(code, { decision: 'Approved', reason: 'x', waivers: waive('Accepted by compliance') }, null)).status, 401);
  // what: a reason is required (missing, empty, blank), the exception must be a blocking one of this customer
  for (const bad of [[{ exceptionId: high.exceptionCode }], waive(''), waive('   '), [{ reason: 'no id' }], 'not a list']) {
    const r = await decide(code, { decision: 'Approved', reason: 'Approve with waiver', waivers: bad }, reviewer);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.body.error.details.waivers, JSON.stringify(bad));
  }
  assert.match((await decide(code, { decision: 'Approved', reason: 'x', waivers: waive('') })).body.error.details.waivers, /reason for waiving EXC-\d+/);
  const unknown = await decide(code, { decision: 'Approved', reason: 'x', waivers: waive('A reason', 'EXC-999999') });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error.details.waivers, /not an open Critical or High exception/);
  assert.equal(await decisionRows(code), 0, 'no refused attempt recorded anything');
  assert.equal(await prisma.auditEvent.count({ where: { actionType: 'ONBOARDING_EXCEPTION_WAIVED', customerId: high.customerId } }), 0, 'refused attempts recorded no waiver');

  // a Reviewer waives it
  const before = await prisma.exception.findUnique({ where: { id: high.id } });
  const ok = await decide(code, { decision: 'Approved', reason: 'Approved with the ownership exception waived', waivers: waive('The 120% is a data entry error being corrected by the registry; evidence is complete') });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.data.status, 'Approved');
  const h = ok.body.data.history[0];
  assert.equal(h.waivers.length, 1);
  assert.equal(h.waivers[0].exceptionId, high.exceptionCode);
  assert.equal(h.waivers[0].severity, 'High');
  assert.match(h.waivers[0].reason, /data entry error/);
  assert.deepEqual([h.exceptionsAtDecision[0].exceptionId, h.exceptionsAtDecision[0].waived], [high.exceptionCode, true]);

  // audit trail: one waiver event with the reason, the person and the exception; the decision event too
  const ev = await prisma.auditEvent.findMany({ where: { actionType: 'ONBOARDING_EXCEPTION_WAIVED', entityRef: high.exceptionCode } });
  assert.equal(ev.length, 1);
  assert.equal(ev[0].userId, reviewer.id);
  assert.equal(ev[0].entityType, 'Exception');
  assert.match(ev[0].reason, /data entry error/);
  assert.equal(ev[0].newValues.decisionId, h.id);
  const audited = await api('GET', `/audit-events?actionType=ONBOARDING_EXCEPTION_WAIVED&pageSize=100`, undefined, reviewer);
  assert.ok(audited.body.data.some((e) => e.entityRef === high.exceptionCode), 'visible in the Audit Trail');

  // exception history preserved: nothing about the exception itself changed, it is still open
  const after = await prisma.exception.findUnique({ where: { id: high.id } });
  assert.deepEqual([after.status, after.severity, after.resolvedAt, after.description], [before.status, before.severity, before.resolvedAt, before.description]);
  assert.equal(after.status, 'Open');
  // and the decision cannot be changed afterwards
  assert.equal((await decide(code, { decision: 'Rejected', reason: 'changed my mind' })).status, 409);
});

test('WAIVER: an Admin may waive too; every blocking exception needs its own waiver (partial waivers are refused)', async () => {
  const { code, owners } = await completeCompany([60, 60]); // High: exceeds 100%
  await api('POST', `/beneficial-owners/${owners[0].id}/screening`, { screeningType: 'Sanctions', mode: 'manual', screeningResult: 'Potential Match', remarks: 'synthetic potential match' }, reviewer); // Critical
  await detect(code);
  const blocking = (await activeExceptions(code)).filter((e) => ['High', 'Critical'].includes(e.severity));
  assert.deepEqual(blocking.map((e) => e.severity).sort(), ['Critical', 'High']);
  const high = blocking.find((e) => e.severity === 'High');
  const critical = blocking.find((e) => e.severity === 'Critical');

  const partial = await decide(code, { decision: 'Approved', reason: 'Waive only the High one', waivers: [{ exceptionId: high.exceptionCode, reason: 'Known data entry error' }] }, admin);
  assert.equal(partial.status, 409);
  assert.equal(partial.body.error.code, 'APPROVAL_BLOCKED_BY_EXCEPTIONS');
  assert.deepEqual(partial.body.error.details.blockingExceptions.map((e) => e.exceptionId), [critical.exceptionCode], 'only the unwaived Critical one is listed');
  assert.equal(await decisionRows(code), 0);
  assert.equal(await prisma.auditEvent.count({ where: { actionType: 'ONBOARDING_EXCEPTION_WAIVED', customerId: critical.customerId } }), 0, 'a refused approval records no waiver');

  const both = await decide(code, { decision: 'Approved', reason: 'Both blocking exceptions waived', waivers: [
    { exceptionId: high.exceptionCode, reason: 'Known data entry error' },
    { exceptionId: String(critical.id), reason: 'Potential match reviewed and cleared by compliance (false positive: different date of birth)' },
  ] }, admin);
  assert.equal(both.status, 201, both.text);
  assert.equal(both.body.data.history[0].waivers.length, 2);
  assert.equal(await prisma.auditEvent.count({ where: { actionType: 'ONBOARDING_EXCEPTION_WAIVED', customerId: critical.customerId, userId: admin.id } }), 2);
});

test('a waiver never bypasses missing or invalid MANDATORY EVIDENCE', async () => {
  const code = await company(); // no documents at all
  await addOwner(code, 60);
  await addOwner(code, 60);
  await detect(code);
  const high = (await activeExceptions(code)).find((e) => e.severity === 'High');
  assert.ok(high);
  const r = await decide(code, { decision: 'Approved', reason: 'Waive and approve', waivers: [{ exceptionId: high.exceptionCode, reason: 'Accepted' }] });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'APPROVAL_NOT_PERMITTED');
  assert.ok(r.body.error.details.blockers.length >= 1);
  const v = await view(code);
  assert.equal(v.policy.outcome, 'Blocked by evidence');
  assert.deepEqual(v.allowedDecisions, ['Rejected']);
  assert.equal(await decisionRows(code), 0);
});

test('rejecting is not affected by exceptions, and a waiver only applies to an approval', async () => {
  const { code } = await completeCompany([60, 60]);
  await detect(code);
  const high = (await activeExceptions(code))[0];
  const withWaiver = await decide(code, { decision: 'Rejected', reason: 'Rejecting', waivers: [{ exceptionId: high.exceptionCode, reason: 'n/a' }] });
  assert.equal(withWaiver.status, 400);
  assert.match(withWaiver.body.error.details.waivers, /only applies to an approval/);
  const rejected = await decide(code, { decision: 'Rejected', reason: 'Ownership cannot be reconciled' });
  assert.equal(rejected.status, 201, rejected.text);
  assert.equal(rejected.body.data.status, 'Rejected');
});

test('exceptions that appeared since the last detection run still count: the approval refreshes them first', async () => {
  const { code } = await completeCompany([60, 40]); // reconciled
  await detect(code);
  assert.equal((await activeExceptions(code)).length, 0);
  assert.equal((await view(code)).policy.outcome, 'Approvable', 'the stored exceptions say: nothing open');
  await addOwner(code, 20); // now 120%, not yet detected
  const r = await decide(code, { decision: 'Approved', reason: 'Looks complete' });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.body.error.code, 'APPROVAL_BLOCKED_BY_EXCEPTIONS');
  assert.equal(r.body.error.details.blockingExceptions[0].exceptionType, 'OWNERSHIP_EXCEEDS_100');
  assert.equal(await decisionRows(code), 0);
});

test('decision history is preserved: refused attempts leave no trace, the decision row is insert-only', async () => {
  const { code } = await completeCompany([60, 60]);
  await detect(code);
  const high = (await activeExceptions(code))[0];
  await decide(code, { decision: 'Approved', reason: 'x' }); // refused
  await decide(code, { decision: 'Approved', reason: 'x', waivers: [{ exceptionId: high.exceptionCode, reason: '' }] }); // refused
  assert.equal(await decisionRows(code), 0);
  const ok = await decide(code, { decision: 'Approved', reason: 'Approved with waiver', waivers: [{ exceptionId: high.exceptionCode, reason: 'Registry correction pending' }] });
  assert.equal(ok.status, 201, ok.text);
  const id = ok.body.data.history[0].id;
  await assert.rejects(prisma.$executeRaw`UPDATE "OnboardingDecision" SET notes = 'changed' WHERE id = ${id}`, /immutable|insert-only/i);
  await assert.rejects(prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE action_type = 'ONBOARDING_EXCEPTION_WAIVED' AND entity_ref = ${high.exceptionCode}`, /immutable|insert-only|cannot|deleted|permitted/i);
  assert.equal(await decisionRows(code), 1);
});

test('regression: concurrent detections and concurrent approvals for a NEW customer never fail (the first review schedule was a race)', async () => {
  for (let round = 0; round < 3; round += 1) {
    const code = await person(); // a new customer has no review schedule yet: every detection tries to create it
    const runs = await Promise.all([1, 2, 3, 4].map(() => detect(code)));
    assert.deepEqual(runs.map((r) => r.status), [200, 200, 200, 200], runs.map((r) => `${r.status}:${r.body?.error?.code}`).join(' '));
    assert.equal(await prisma.reviewSchedule.count({ where: { customer: { customerCode: code }, status: 'Scheduled' } }), 1, 'exactly one schedule');

    const fresh = await person();
    await verifyAll(fresh);
    const results = await Promise.all([1, 2, 3].map((n) => decide(fresh, { decision: n === 2 ? 'Rejected' : 'Approved', reason: `concurrent ${n}` })));
    const codes = results.map((r) => `${r.status}:${r.body?.error?.code ?? 'ok'}`);
    assert.equal(results.filter((r) => r.status === 201).length, 1, codes.join(' '));
    assert.ok(results.every((r) => r.status === 201 || r.status === 409), codes.join(' '));
    assert.equal(await prisma.reviewSchedule.count({ where: { customer: { customerCode: fresh }, status: 'Scheduled' } }), 1);
  }
});
