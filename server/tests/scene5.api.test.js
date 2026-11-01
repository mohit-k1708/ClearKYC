/**
 * Scene 5 API integration tests (real database; start `npm run db:local` first).
 * They cover audit events, alerts, analytics, data quality and exports. Detection is run for ONE test customer at a time,
 * and everything the tests create (customers, people, audit events, alerts, validation runs) is removed afterwards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const app = require('../src/app');
const prisma = require('../src/utils/prisma');
const audit = require('../src/services/auditService');
const { addDays, todayIso, parseIso } = require('../src/utils/dates');

let server;
let base;
const customerCodes = new Set();
const reviewerIds = new Set();
const TODAY = todayIso();
let analyst;
let reviewer;
let admin;
const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const letter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));
const PANS = []; // every PAN / Aadhaar the tests register, to prove they never appear in audit events or exports
const AADHAARS = [];

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const make = async (role, label) => {
    const r = await prisma.reviewer.create({ data: { name: `Test S5 ${label}`, email: `s5.${label.toLowerCase()}.${rnd(8)}@example.com`, role } });
    reviewerIds.add(r.id);
    return r;
  };
  analyst = await make('Analyst', 'Analyst');
  reviewer = await make('Reviewer', 'Reviewer');
  admin = await make('Admin', 'Admin');
});

test.after(async () => {
  const codes = [...customerCodes];
  const ids = [...reviewerIds];
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "ValidationIssue" WHERE validation_run_id IN (SELECT id FROM "ValidationRun" WHERE created_by_id = ANY(${ids}::int[]))`,
    prisma.$executeRaw`DELETE FROM "ValidationRun" WHERE created_by_id = ANY(${ids}::int[])`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id IN (SELECT id FROM "Customer" WHERE customer_id = ANY(${codes}::text[])) OR user_id = ANY(${ids}::int[])`,
    prisma.verification.deleteMany({ where: { OR: [{ document: { customer: { customerCode: { in: codes } } } }, { reviewerId: { in: ids } }] } }),
    prisma.document.deleteMany({ where: { customer: { customerCode: { in: codes } } } }),
    prisma.customer.deleteMany({ where: { customerCode: { in: codes } } }), // cascades owners, ratings, exceptions, cases, alerts
    prisma.riskRating.deleteMany({ where: { assessedById: { in: ids } } }),
    prisma.reviewer.deleteMany({ where: { id: { in: ids } } }),
  ]);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ---- helpers -----------------------------------------------------------------------------------------------------------------
const as = (r) => (r ? { 'x-reviewer-id': String(r.id) } : {});
const api = async (method, url, body, who) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...as(who) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = bytes.toString('utf8'); // keeps the byte-order mark as a character, unlike res.text()
  return { status: res.status, headers: res.headers, text, bytes, body: type.includes('json') && text ? JSON.parse(text) : null };
};

async function newIndividual(who = analyst) {
  const pan = `QSVP${letter()}${rnd(4)}${letter()}`;
  const aadhaar = `9${rnd(11)}`;
  PANS.push(pan); AADHAARS.push(aadhaar);
  const res = await api('POST', '/customers', {
    customerType: 'Individual', fullName: 'QS Test Person', dateOfBirth: '1988-03-04', email: 'qs.person@example.com', phone: '9812345679', address: '5 Test Lane',
    panNumber: pan, aadhaarNumber: aadhaar, occupation: 'Engineer', country: 'IN',
  }, who);
  assert.equal(res.status, 201, res.text);
  customerCodes.add(res.body.data.customerId);
  return res.body.data.customerId;
}

async function newCompany(who = analyst) {
  const pan = `QSVC${letter()}${rnd(4)}${letter()}`;
  PANS.push(pan);
  const res = await api('POST', '/customers', {
    customerType: 'Company', legalName: `QS Test Company ${rnd(5)} Pvt Ltd`, registrationNumber: `QS-${rnd(10)}`, panNumber: pan,
    email: 'ops@qs-test.example.com', phone: '9812345678', address: '1 Test Park', country: 'IN', businessActivity: 'Information Technology', dateOfIncorporation: '2015-05-05',
  }, who);
  assert.equal(res.status, 201, res.text);
  customerCodes.add(res.body.data.customerId);
  return res.body.data.customerId;
}

const detectFor = async (code, who = analyst) => {
  const res = await api('POST', '/exceptions/detect', { customerId: code }, who);
  assert.equal(res.status, 200, res.text);
  return res.body.data;
};
const alertsOf = async (code, status = 'all') => (await api('GET', `/alerts?customerId=${code}&status=${status}&pageSize=100`)).body.data;
const alertOfType = async (code, type, status = 'all') => (await alertsOf(code, status)).filter((a) => a.alertType === type);
const dbCustomer = (code) => prisma.customer.findUnique({ where: { customerCode: code } });
const eventsFor = async (code, extra = {}) => {
  const c = await dbCustomer(code);
  return prisma.auditEvent.findMany({ where: { customerId: c.id, ...extra }, orderBy: { id: 'asc' }, include: { user: true } });
};
const types = (events) => events.map((e) => e.actionType);

/** Inserts a document straight into the database (as the seed does) so past dates and statuses can be tested. */
async function insertDoc(code, documentType, { status = 'Verified', expiry = null, submitted = addDays(TODAY, -20) } = {}) {
  const customer = await dbCustomer(code);
  const doc = await prisma.document.create({ data: { customerId: customer.id, documentType, issueDate: parseIso(addDays(TODAY, -400)), submissionDate: parseIso(submitted), expiryDate: expiry ? parseIso(expiry) : null } });
  await prisma.verification.create({ data: { documentId: doc.id, status: 'Pending', remarks: 'seed' } });
  if (status !== 'Pending') await prisma.verification.create({ data: { documentId: doc.id, reviewerId: reviewer.id, status, remarks: 'seed decision' } });
  return doc;
}

const ownerBody = (over = {}) => ({ fullName: `Owner ${rnd(6)} Tester`, dateOfBirth: '1975-04-12', countryOfResidence: 'IN', nationality: 'IN', ownershipPercentage: 50, ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'No', ...over });
const addOwner = (code, over, who = analyst) => api('POST', `/customers/${code}/beneficial-owners`, ownerBody(over), who);

// ================================ AUDIT EVENTS ==============================================================================
test('audit: onboarding writes customer and risk events, attributed to the acting person, without PAN, Aadhaar or contact details', async () => {
  const code = await newIndividual(analyst);
  const events = await eventsFor(code);
  assert.deepEqual(types(events), ['CUSTOMER_CREATED', 'RISK_ASSESSMENT_CREATED']);
  const [created, rating] = events;
  assert.equal(created.userId, analyst.id);
  assert.equal(created.userRole, 'Analyst');
  assert.equal(created.entityType, 'Customer');
  assert.equal(created.entityRef, code);
  assert.match(created.eventCode, /^AUD-\d{6,}$/);
  assert.ok(created.createdAt instanceof Date);
  assert.ok(created.ipAddress, 'the IP address is recorded when the request is known');
  assert.equal(rating.entityType, 'RiskRating');
  assert.match(rating.entityRef, /^RSK-\d{6}$/);
  assert.equal(rating.newValues.riskLevel, 'Low');

  const everything = JSON.stringify(events);
  assert.ok(!PANS.some((p) => everything.includes(p)), 'no PAN in audit events');
  assert.ok(!AADHAARS.some((a) => everything.includes(a)), 'no Aadhaar in audit events');
  assert.ok(!everything.includes('qs.person@example.com') && !everything.includes('9812345679') && !everything.includes('QS Test Person'));
});

test('audit: a customer registered without choosing a person is attributed to the system', async () => {
  const code = await newIndividual(null);
  const [created] = await eventsFor(code);
  assert.equal(created.userId, null);
  assert.equal(created.userRole, 'System');
  assert.equal(created.ipAddress, null);
});

test('audit: a failed change leaves no audit event (the audit event and the business change are one transaction)', async () => {
  const code = await newIndividual();
  const before = await prisma.auditEvent.count();
  // duplicate document submission is refused with 409 after the pre-check: nothing may be audited
  const body = { customerId: code, documentType: 'PAN', documentNumber: `SYN-PAN-${rnd(6)}`, issueDate: addDays(TODAY, -200), submissionDate: addDays(TODAY, -5) };
  assert.equal((await api('POST', '/documents', body, analyst)).status, 201);
  const afterFirst = await prisma.auditEvent.count();
  assert.equal(afterFirst, before + 1);
  assert.equal((await api('POST', '/documents', body, analyst)).status, 409);
  assert.equal(await prisma.auditEvent.count(), afterFirst);

  // and a rolled-back transaction removes the audit event written inside it
  await assert.rejects(() => prisma.$transaction(async (tx) => {
    await audit.record(tx, { actionType: 'CUSTOMER_UPDATED', entityType: 'Customer', entityRef: code, actor: null });
    throw new Error('boom');
  }), /boom/);
  assert.equal(await prisma.auditEvent.count(), afterFirst);
});

test('audit: document lifecycle - submitted, updated, verification started, verified, rejected, resubmission requested', async () => {
  const code = await newIndividual();
  const docNo = `SYN-PAN-${rnd(6)}`;
  const body = { customerId: code, documentType: 'PAN', documentNumber: docNo, issueDate: addDays(TODAY, -200), submissionDate: addDays(TODAY, -5), notes: 'first' };
  const doc = (await api('POST', '/documents', body, analyst)).body.data;
  const decide = (status, remarks, who = reviewer) => api('POST', `/documents/${doc.id}/verifications`, { status, remarks }, who);

  assert.equal((await decide('In Review', 'Started the review')).status, 201);
  assert.equal((await decide('Verified', 'Looks fine to me')).status, 201);
  // a material edit of a verified document resets it to Pending and is audited with the old and new dates
  const edit = await api('PUT', `/documents/${doc.id}`, { ...body, issueDate: addDays(TODAY, -210) }, analyst);
  assert.equal(edit.status, 200, edit.text);
  assert.equal((await decide('Requires Resubmission', 'Please send a clearer copy')).status, 201);
  assert.equal((await decide('Rejected', 'Still unreadable after resubmission')).status, 201);

  const events = await eventsFor(code, { entityType: 'Document' });
  assert.deepEqual(types(events), ['DOCUMENT_SUBMITTED', 'VERIFICATION_STARTED', 'DOCUMENT_VERIFIED', 'DOCUMENT_UPDATED', 'DOCUMENT_RESUBMISSION_REQUESTED', 'DOCUMENT_REJECTED']);
  const [submitted, started, verified, updated] = events;
  assert.equal(submitted.userRole, 'Analyst');
  assert.equal(started.userId, reviewer.id);
  assert.equal(started.userRole, 'Reviewer');
  assert.deepEqual(started.previousValues, { status: 'Pending' });
  assert.deepEqual(verified.previousValues, { status: 'In Review' });
  assert.equal(verified.reason, 'Looks fine to me');
  assert.equal(updated.previousValues.issueDate, addDays(TODAY, -200));
  assert.equal(updated.newValues.issueDate, addDays(TODAY, -210));
  assert.equal(updated.previousValues.status, 'Verified');
  assert.equal(updated.newValues.statusResetTo, 'Pending');
  assert.ok(!JSON.stringify(events).includes(docNo), 'the document number is never stored in the audit trail');
});

test('audit: ownership and risk - owner added and edited, percentage change, validation, screening, assessment and classification change', async () => {
  const code = await newCompany();
  const owner = (await addOwner(code, { ownershipPercentage: 40, fullName: 'Private Owner Name' })).body.data;
  const put = (over) => api('PUT', `/beneficial-owners/${owner.id}`, ownerBody({ fullName: 'Private Owner Name', dateOfBirth: '1975-04-12', ...over }), analyst);
  assert.equal((await put({ ownershipPercentage: 60 })).status, 200);
  assert.equal((await put({ ownershipPercentage: 60, controlType: 'Voting rights' })).status, 200);
  assert.equal((await api('POST', `/customers/${code}/ownership-validation`, {}, analyst)).status, 201);
  const screening = await api('POST', `/beneficial-owners/${owner.id}/screening`, { screeningType: 'Sanctions', mode: 'manual', screeningResult: 'Potential Match', remarks: 'Name similar to a listed entity - needs investigation' }, reviewer);
  assert.equal(screening.status, 201, screening.text);
  const first = await api('POST', `/customers/${code}/risk-assessments`, { remarks: 'After screening' }, reviewer);
  assert.equal(first.status, 201, first.text);

  const events = await eventsFor(code);
  const t = types(events);
  for (const expected of ['OWNER_ADDED', 'OWNERSHIP_PERCENTAGE_CHANGED', 'OWNER_UPDATED', 'OWNERSHIP_VALIDATED', 'SCREENING_RECORDED']) assert.ok(t.includes(expected), expected);
  const pct = events.find((e) => e.actionType === 'OWNERSHIP_PERCENTAGE_CHANGED');
  assert.deepEqual(pct.previousValues, { ownershipPercentage: 40 });
  assert.deepEqual(pct.newValues, { ownershipPercentage: 60 });
  assert.equal(pct.userId, analyst.id);
  assert.equal(events.filter((e) => e.actionType === 'OWNERSHIP_PERCENTAGE_CHANGED').length, 1); // the second edit did not change the percentage
  const screened = events.find((e) => e.actionType === 'SCREENING_RECORDED');
  assert.equal(screened.newValues.screeningResult, 'Potential Match'); // recorded as a potential match, never as confirmed
  assert.equal(screened.userRole, 'Reviewer');
  const assessed = events.filter((e) => e.actionType === 'RISK_ASSESSMENT_CREATED');
  const latest = assessed[assessed.length - 1];
  assert.equal(latest.userId, reviewer.id);
  assert.equal(latest.reason, 'After screening');
  const levelChanged = events.filter((e) => e.actionType === 'RISK_CLASSIFICATION_CHANGED');
  const levels = assessed.map((e) => e.newValues.riskLevel);
  assert.equal(levelChanged.length, levels.slice(1).filter((l, i) => l !== levels[i]).length);
  for (const e of levelChanged) assert.notEqual(e.previousValues.riskLevel, e.newValues.riskLevel);
  assert.ok(!JSON.stringify(events).includes('Private Owner Name') && !JSON.stringify(events).includes('1975-04-12'), 'owner name and date of birth are not in the audit trail');
});

test('audit: review case lifecycle - created, assigned, status changed, escalated, resolved, closed, reopened, note added', async () => {
  const code = await newIndividual();
  await detectFor(code);
  const exc = (await api('GET', `/exceptions?customerId=${code}&status=active&pageSize=50`)).body.data.find((e) => e.exceptionType === 'MANDATORY_DOCUMENT_MISSING');
  const created = await api('POST', '/review-cases', { exceptionId: exc.id }, analyst);
  assert.equal(created.status, 201, created.text);
  const id = created.body.data.caseId;
  const step = async (action, body, who) => { const r = await api('PATCH', `/review-cases/${id}/status`, { action, ...body }, who); assert.equal(r.status, 200, `${action}: ${r.text}`); };

  assert.equal((await api('PATCH', `/review-cases/${id}/assign`, { assignedAnalystId: analyst.id }, analyst)).status, 200);
  await step('start', {}, analyst);
  assert.equal((await api('POST', `/review-cases/${id}/notes`, { note: 'Called the customer' }, analyst)).status, 201);
  await step('escalate', { remarks: 'Needs a compliance opinion', reviewerId: reviewer.id }, analyst);
  await step('resolve', { resolutionNotes: 'Customer provided the missing documents' }, reviewer);
  await step('close', {}, reviewer);
  await step('reopen', { remarks: 'New information arrived' }, reviewer);

  const events = (await eventsFor(code, { entityType: 'ReviewCase' }));
  assert.deepEqual(types(events), ['CASE_CREATED', 'CASE_ASSIGNED', 'CASE_STATUS_CHANGED', 'CASE_NOTE_ADDED', 'CASE_ESCALATED', 'CASE_RESOLVED', 'CASE_CLOSED', 'CASE_REOPENED']);
  const escalated = events[4];
  assert.deepEqual(escalated.previousValues, { status: 'In Progress' });
  assert.equal(escalated.newValues.status, 'Escalated');
  assert.equal(escalated.reason, 'Needs a compliance opinion');
  assert.equal(escalated.userRole, 'Analyst');
  assert.equal(events[5].userRole, 'Reviewer');
  const note = events[3];
  assert.ok(!JSON.stringify(note).includes('Called the customer'), 'note text stays in the case, not in the audit trail');
  const history = (await api('GET', `/review-cases/${id}/history`)).body.data.items;
  assert.equal(history.length >= events.length - 1, true);
});

test('audit: exception detection and automatic resolution are recorded as System actions', async () => {
  const code = await newIndividual();
  await detectFor(code);
  const detected = await eventsFor(code, { actionType: 'EXCEPTION_DETECTED' });
  assert.ok(detected.length >= 3);
  assert.ok(detected.every((e) => e.userId === null && e.userRole === 'System' && /^EXC-\d{6}$/.test(e.entityRef)));
  // The customer submits and verifies PAN: the exception clears at the next detection and that is audited too.
  await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, 700) });
  await detectFor(code);
  const resolved = await eventsFor(code, { actionType: 'EXCEPTION_RESOLVED' });
  assert.ok(resolved.length >= 1);
  assert.equal(resolved[0].newValues.resolutionType, 'Condition cleared');
});

// ================================ AUDIT TRAIL API ==============================================================================
test('audit trail API: only compliance reviewers and administrators can read it', async () => {
  assert.equal((await api('GET', '/audit-events')).status, 401);
  const asAnalyst = await api('GET', '/audit-events', null, analyst);
  assert.equal(asAnalyst.status, 403);
  assert.equal(asAnalyst.body.error.code, 'NOT_AUTHORISED');
  assert.equal((await api('GET', '/audit-events', null, reviewer)).status, 200);
  assert.equal((await api('GET', '/audit-events', null, admin)).status, 200);
  assert.equal((await api('GET', '/audit-events/AUD-000001', null, analyst)).status, 403);
});

test('audit trail API: pagination, filters, search and detail', async () => {
  const code = await newCompany();
  await addOwner(code, { ownershipPercentage: 100 });
  const list = await api('GET', `/audit-events?customerId=${code}&pageSize=2`, null, reviewer);
  assert.equal(list.status, 200, list.text);
  assert.equal(list.body.data.length, 2);
  assert.ok(list.body.pagination.totalItems >= 3);
  assert.equal(list.body.pagination.pageSize, 2);
  assert.ok(list.body.data[0].id > list.body.data[1].id, 'newest first');
  for (const e of list.body.data) {
    assert.equal(e.customerCode, code);
    assert.ok(e.eventId && e.actionLabel && e.category && e.createdAt && 'ipAddress' in e && 'previousValues' in e && 'newValues' in e && 'reason' in e);
  }
  const byAction = await api('GET', `/audit-events?customerId=${code}&actionType=OWNER_ADDED`, null, reviewer);
  assert.equal(byAction.body.pagination.totalItems, 1);
  assert.equal(byAction.body.data[0].user.name, 'Test S5 Analyst');
  assert.equal((await api('GET', `/audit-events?customerId=${code}&category=Ownership`, null, reviewer)).body.pagination.totalItems, 1);
  assert.equal((await api('GET', `/audit-events?customerId=${code}&userId=${analyst.id}`, null, reviewer)).body.data.every((e) => e.user.id === analyst.id), true);
  const bySystem = await api('GET', `/audit-events?customerId=${code}&userId=0`, null, reviewer);
  assert.ok(bySystem.body.data.every((e) => e.user.role === 'System'));
  assert.equal((await api('GET', `/audit-events?customerId=${code}&entityType=BeneficialOwner`, null, reviewer)).body.pagination.totalItems, 1);
  assert.equal((await api('GET', `/audit-events?search=${code}`, null, reviewer)).body.pagination.totalItems >= 3, true);

  // date range: everything today, nothing in the past
  assert.ok((await api('GET', `/audit-events?customerId=${code}&from=${TODAY}&to=${TODAY}`, null, reviewer)).body.pagination.totalItems >= 3);
  assert.equal((await api('GET', `/audit-events?customerId=${code}&from=2020-01-01&to=2020-12-31`, null, reviewer)).body.pagination.totalItems, 0);
  assert.equal((await api('GET', `/audit-events?from=2026-12-31&to=2026-01-01`, null, reviewer)).status, 400);
  assert.equal((await api('GET', '/audit-events?actionType=NOPE', null, reviewer)).status, 400);
  assert.equal((await api('GET', '/audit-events?customerId=abc', null, reviewer)).status, 400);
  assert.equal((await api('GET', '/audit-events?customerId=CUS-999999', null, reviewer)).body.pagination.totalItems, 0);

  const one = list.body.data[0];
  const detail = await api('GET', `/audit-events/${one.eventId}`, null, reviewer);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.id, one.id);
  assert.equal((await api('GET', `/audit-events/${one.id}`, null, reviewer)).body.data.eventId, one.eventId);
  assert.equal((await api('GET', '/audit-events/AUD-999999999', null, reviewer)).status, 404);
  assert.equal((await api('GET', '/audit-events/xyz', null, reviewer)).status, 404);
  const options = (await api('GET', '/audit-events/options', null, reviewer)).body.data;
  assert.ok(options.actions.length >= 30 && options.users.length >= 3);
});

test('audit trail is immutable: no API can change or delete an event, and the database refuses it too', async () => {
  const code = await newIndividual();
  const [event] = await eventsFor(code);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const url of ['/audit-events', `/audit-events/${event.id}`, `/audit-events/${event.eventCode}`]) {
      const res = await api(method, url, { reason: 'tampered' }, admin);
      assert.equal(res.status, 404, `${method} ${url} must not exist`);
    }
  }
  await assert.rejects(() => prisma.auditEvent.update({ where: { id: event.id }, data: { reason: 'tampered' } }), /immutable|cannot be updated/);
  await assert.rejects(() => prisma.auditEvent.delete({ where: { id: event.id } }), /immutable|cannot be deleted/);
  await assert.rejects(() => prisma.auditEvent.deleteMany({ where: { id: event.id } }), /immutable|cannot be deleted/);
  await assert.rejects(() => prisma.$executeRaw`UPDATE "AuditEvent" SET new_values = '{}'::jsonb WHERE id = ${event.id}`, /immutable|cannot be updated/);
  const again = await prisma.auditEvent.findUnique({ where: { id: event.id } });
  assert.equal(again.reason, event.reason);
});

test('audit events keep referential integrity: valid users only, and the system has no user id', async () => {
  const base = { userRole: 'System', actionType: 'CUSTOMER_UPDATED', entityType: 'Customer' };
  await assert.rejects(() => prisma.auditEvent.create({ data: { ...base, userRole: 'Analyst', userId: 999999999 } }), /Foreign key|foreign key/);
  await assert.rejects(() => prisma.auditEvent.create({ data: { ...base, userId: analyst.id } }), /actor_check|check constraint/);
  await assert.rejects(() => prisma.auditEvent.create({ data: { ...base, userRole: 'Analyst', userId: null } }), /actor_check|check constraint/);
  await assert.rejects(() => prisma.auditEvent.create({ data: { ...base, userRole: 'Wizard' } }), /role_check|check constraint/);
  await assert.rejects(() => audit.record(prisma, { actionType: 'MADE_UP_ACTION', entityType: 'Customer' }), /Unknown audit action/);
});

// ================================ ALERTS =============================================================================================
test('alerts: generated from real records with the required fields, linked to the source record and the exception', async () => {
  const code = await newIndividual();
  const pan = await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, -5) });
  await insertDoc(code, 'Address Proof', { status: 'Verified', expiry: addDays(TODAY, 12) });
  await insertDoc(code, 'Photograph', { status: 'Pending', submitted: addDays(TODAY, -30) });
  const result = await detectFor(code);
  assert.ok(result.alertsCreated >= 3);

  const list = await alertsOf(code);
  assert.deepEqual(list.map((a) => a.alertType).sort(), ['DOCUMENT_EXPIRED', 'DOCUMENT_EXPIRY', 'VERIFICATION_PENDING']);
  const expired = list.find((a) => a.alertType === 'DOCUMENT_EXPIRED');
  assert.match(expired.alertId, /^ALT-\d{6}$/);
  assert.equal(expired.customerId, code);
  assert.equal(expired.status, 'New');
  assert.equal(expired.severity, 'High');
  assert.equal(expired.relatedEntityType, 'Document');
  assert.equal(expired.relatedEntityId, pan.id);
  assert.equal(expired.dueDate, addDays(TODAY, -5));
  assert.ok(expired.exceptionId, 'linked to the exception detected from the same condition');
  assert.ok(expired.createdAt && expired.title && expired.description);
  assert.equal(expired.acknowledgedBy, null);
  assert.equal(expired.acknowledgedAt, null);
  assert.equal(expired.resolvedBy, null);
  const expiring = list.find((a) => a.alertType === 'DOCUMENT_EXPIRY');
  assert.equal(expiring.dueDate, addDays(TODAY, 12));

  const generated = await eventsFor(code, { actionType: 'ALERT_GENERATED' });
  assert.equal(generated.length, 3);
  assert.ok(generated.every((e) => e.userRole === 'System' && /^ALT-\d{6}$/.test(e.entityRef)));
});

test('alerts: missing mandatory documents, high-risk customers and ownership issues raise the right alert types', async () => {
  const code = await newIndividual();
  await detectFor(code);
  const missing = await alertOfType(code, 'MISSING_MANDATORY_DOCUMENT');
  assert.equal(missing.length, 3); // PAN, Address Proof, Photograph
  assert.ok(missing.every((a) => a.relatedEntityType === 'KYCRequirement' && a.severity === 'Medium'));

  const company = await newCompany();
  await detectFor(company);
  const ownership = await alertOfType(company, 'OWNERSHIP_ISSUE');
  assert.equal(ownership.length, 1);
  assert.match(ownership[0].description, /no beneficial owners/i);
  await addOwner(company, { ownershipPercentage: 70 });
  await addOwner(company, { ownershipPercentage: 60 });
  await detectFor(company);
  const over = await alertOfType(company, 'OWNERSHIP_ISSUE', 'active');
  assert.equal(over.length, 1);
  assert.equal(over[0].severity, 'High');
  assert.match(over[0].description, /130/);
  assert.equal((await alertOfType(company, 'OWNERSHIP_ISSUE', 'Resolved')).length, 1); // the "no owners" alert resolved by itself
});

test('alerts: no duplicate active alerts - detecting again changes nothing, and the database refuses a second active alert', async () => {
  const code = await newIndividual();
  await detectFor(code);
  const first = await alertsOf(code);
  const second = await detectFor(code);
  assert.equal(second.alertsCreated, 0);
  const again = await alertsOf(code);
  assert.equal(again.length, first.length);
  assert.deepEqual(again.map((a) => a.alertId).sort(), first.map((a) => a.alertId).sort());
  await Promise.all([detectFor(code), detectFor(code), detectFor(code)]); // simultaneous detections
  assert.equal((await alertsOf(code)).length, first.length);

  const row = await prisma.alert.findFirst({ where: { customer: { customerCode: code } } });
  await assert.rejects(() => prisma.alert.create({ data: { customerId: row.customerId, alertType: row.alertType, title: 'dup', description: 'dup', severity: row.severity, relatedEntityType: row.relatedEntityType, relatedEntityId: row.relatedEntityId, dedupeKey: row.dedupeKey } }), /Unique constraint|unique/i);
});

test('alerts: acknowledge, start work, resolve with remarks - each step is audited and is the alert history', async () => {
  const code = await newIndividual();
  await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, 10) });
  await detectFor(code);
  const alert = (await alertOfType(code, 'DOCUMENT_EXPIRY'))[0];

  const ack = await api('PATCH', `/alerts/${alert.alertId}/acknowledge`, { remarks: 'On my list' }, analyst);
  assert.equal(ack.status, 200, ack.text);
  assert.equal(ack.body.data.status, 'Acknowledged');
  assert.equal(ack.body.data.acknowledgedBy.id, analyst.id);
  assert.ok(ack.body.data.acknowledgedAt);
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/acknowledge`, {}, analyst)).status, 409); // already acknowledged

  const progress = await api('PATCH', `/alerts/${alert.alertId}/status`, { status: 'In Progress', remarks: 'Asked the customer' }, analyst);
  assert.equal(progress.body.data.status, 'In Progress');

  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/resolve`, { resolutionNotes: '' }, analyst)).status, 400);
  const short = await api('PATCH', `/alerts/${alert.alertId}/resolve`, { resolutionNotes: 'done' }, analyst);
  assert.equal(short.status, 400);
  assert.ok(short.body.error.details.resolutionNotes);
  const resolved = await api('PATCH', `/alerts/${alert.alertId}/resolve`, { resolutionNotes: 'Customer will renew; follow-up booked' }, analyst);
  assert.equal(resolved.status, 200, resolved.text);
  assert.equal(resolved.body.data.status, 'Resolved');
  assert.equal(resolved.body.data.resolvedBy.id, analyst.id);
  assert.equal(resolved.body.data.resolutionType, 'Resolved manually');
  assert.equal(resolved.body.data.resolutionNotes, 'Customer will renew; follow-up booked');
  assert.deepEqual(resolved.body.data.allowedActions, []);

  // history = the audit events of the alert, oldest first
  const detail = (await api('GET', `/alerts/${alert.alertId}`, null, analyst)).body.data;
  assert.deepEqual(detail.history.map((h) => h.actionType), ['ALERT_GENERATED', 'ALERT_ACKNOWLEDGED', 'ALERT_STATUS_CHANGED', 'ALERT_RESOLVED']);
  assert.deepEqual(detail.history[2].previousValues, { status: 'Acknowledged' });
  assert.deepEqual(detail.history[2].newValues, { status: 'In Progress' });

  // a closed alert is history: it cannot be changed, by the API or the database
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/status`, { status: 'In Progress' }, admin)).status, 409);
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/resolve`, { resolutionNotes: 'resolving once more' }, admin)).status, 409);
  await assert.rejects(() => prisma.alert.update({ where: { id: alert.id }, data: { status: 'New' } }), /historical record/);
  await assert.rejects(() => prisma.alert.update({ where: { id: alert.id }, data: { resolutionNotes: 'edited' } }), /historical record/);
  await assert.rejects(() => prisma.alert.delete({ where: { id: alert.id } }), /cannot be deleted/);
});

test('alerts: starting work on a new alert acknowledges it; invalid requests are rejected', async () => {
  const code = await newIndividual();
  await detectFor(code);
  const alert = (await alertsOf(code))[0];
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/acknowledge`)).status, 401);
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/status`, { status: 'Bogus' }, analyst)).status, 400);
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/status`, { status: 'New' }, analyst)).status, 400);
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/status`, { status: 'Resolved' }, analyst)).status, 400); // use the resolve action
  assert.equal((await api('PATCH', '/alerts/ALT-999999999/acknowledge', {}, analyst)).status, 404);
  assert.equal((await api('GET', '/alerts/not-an-alert')).status, 404);
  const started = await api('PATCH', `/alerts/${alert.alertId}/status`, { status: 'In Progress' }, analyst);
  assert.equal(started.body.data.status, 'In Progress');
  assert.equal(started.body.data.acknowledgedBy.id, analyst.id);
});

test('alerts: important alerts are not dismissed casually - dismissal rules by role and severity', async () => {
  const code = await newIndividual();
  await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, 3) });
  await insertDoc(code, 'Address Proof', { status: 'Verified', expiry: addDays(TODAY, 400) });
  await insertDoc(code, 'Photograph', { status: 'Verified', expiry: addDays(TODAY, -2) });
  await detectFor(code);
  const low = (await alertOfType(code, 'DOCUMENT_EXPIRY'))[0];
  const high = (await alertOfType(code, 'DOCUMENT_EXPIRED'))[0];

  const byAnalyst = await api('PATCH', `/alerts/${low.alertId}/status`, { status: 'Dismissed', remarks: 'Not relevant' }, analyst);
  assert.equal(byAnalyst.status, 403);
  assert.equal(byAnalyst.body.error.code, 'FORBIDDEN_ACTION');
  assert.equal((await api('PATCH', `/alerts/${low.alertId}/status`, { status: 'Dismissed' }, reviewer)).status, 400); // remarks are required
  assert.equal((await api('PATCH', `/alerts/${high.alertId}/resolve`, { resolutionNotes: 'Customer will renew soon' }, analyst)).status, 403); // High needs a compliance reviewer
  const dismissed = await api('PATCH', `/alerts/${low.alertId}/status`, { status: 'Dismissed', remarks: 'Document renewed in person, file updated' }, reviewer);
  assert.equal(dismissed.status, 200, dismissed.text);
  assert.equal(dismissed.body.data.status, 'Dismissed');
  assert.equal(dismissed.body.data.resolutionType, 'Dismissed manually');
  assert.equal((await eventsFor(code, { actionType: 'ALERT_DISMISSED' })).length, 1);
  // dismissed while the condition still exists: detection does not raise it again straight away
  await detectFor(code);
  assert.equal((await alertOfType(code, 'DOCUMENT_EXPIRY', 'active')).length, 0);
  assert.equal((await alertOfType(code, 'DOCUMENT_EXPIRY')).length, 1);
  assert.equal((await api('PATCH', `/alerts/${high.alertId}/resolve`, { resolutionNotes: 'Reviewed with the customer' }, reviewer)).status, 200);
});

test('alerts: automatically resolved when the underlying issue is fixed, recorded as a System action; a returning issue raises a new alert', async () => {
  const code = await newIndividual();
  const doc = await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, -3) });
  await detectFor(code);
  const alert = (await alertOfType(code, 'DOCUMENT_EXPIRED'))[0];
  assert.equal(alert.status, 'New');

  await prisma.document.update({ where: { id: doc.id }, data: { expiryDate: parseIso(addDays(TODAY, 365)) } }); // the document is renewed
  const result = await detectFor(code);
  assert.ok(result.alertsResolved >= 1);
  const closed = (await api('GET', `/alerts/${alert.alertId}`, null, analyst)).body.data;
  assert.equal(closed.status, 'Resolved');
  assert.equal(closed.resolutionType, 'Condition cleared');
  assert.equal(closed.resolvedBy, null);
  assert.ok(closed.resolvedAt);
  assert.match(closed.resolutionNotes, /no longer show this condition/);
  const resolvedEvent = closed.history.find((h) => h.actionType === 'ALERT_RESOLVED');
  assert.equal(resolvedEvent.user.role, 'System');

  await prisma.document.update({ where: { id: doc.id }, data: { expiryDate: parseIso(addDays(TODAY, -1)) } }); // and it expires again
  await detectFor(code);
  const all = await alertOfType(code, 'DOCUMENT_EXPIRED');
  assert.equal(all.length, 2);
  assert.equal(all.filter((a) => a.isActive).length, 1);
});

test('alerts: a potential sanctions match stays a potential match - it cannot be dismissed, and only a reviewer can close it with remarks', async () => {
  const code = await newCompany();
  const owner = (await addOwner(code, { ownershipPercentage: 100 })).body.data;
  const screen = await api('POST', `/beneficial-owners/${owner.id}/screening`, { screeningType: 'Sanctions', mode: 'manual', screeningResult: 'Potential Match', remarks: 'Similar name on the demo list' }, reviewer);
  assert.equal(screen.status, 201, screen.text);
  await detectFor(code);
  const alert = (await alertOfType(code, 'POTENTIAL_SANCTIONS_MATCH'))[0];
  assert.ok(alert, 'a potential sanctions match raises an alert');
  assert.equal(alert.severity, 'Critical');
  assert.equal(alert.relatedEntityType, 'BeneficialOwner');
  assert.equal(alert.relatedEntityId, owner.id);
  assert.equal(alert.investigationRequired, true);
  assert.match(alert.description, /potential/i);
  assert.match(alert.description, /not a confirmed|NOT a confirmed|not confirmed/i);
  assert.ok(!/confirmed sanctions match/i.test(alert.title));

  // Only acknowledgement and progress are possible for an analyst; nobody can dismiss it.
  const detailAsAnalyst = (await api('GET', `/alerts/${alert.alertId}`, null, analyst)).body.data;
  assert.deepEqual(detailAsAnalyst.allowedActions, ['acknowledge', 'in_progress']);
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/status`, { status: 'Dismissed', remarks: 'Looks like a false positive' }, reviewer)).status, 403);
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/status`, { status: 'Dismissed', remarks: 'Looks like a false positive' }, admin)).status, 403);
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/resolve`, { resolutionNotes: 'I checked it myself, all good' }, analyst)).status, 403);
  assert.equal((await api('PATCH', `/alerts/${alert.alertId}/acknowledge`, {}, analyst)).status, 200);

  // detection never closes it while the owner's latest screening says "Potential Match"
  await detectFor(code);
  assert.equal((await alertOfType(code, 'POTENTIAL_SANCTIONS_MATCH', 'active')).length, 1);
  const closed = await api('PATCH', `/alerts/${alert.alertId}/resolve`, { resolutionNotes: 'Investigated: different person, date of birth differs' }, reviewer);
  assert.equal(closed.status, 200, closed.text);
  // closing the alert does not change the screening record: it is still a potential match until a new screening is recorded
  const latest = await prisma.ownerScreening.findFirst({ where: { beneficialOwnerId: owner.id, screeningType: 'Sanctions' }, orderBy: { id: 'desc' } });
  assert.equal(latest.screeningResult, 'Potential Match');
  await detectFor(code);
  assert.equal((await alertOfType(code, 'POTENTIAL_SANCTIONS_MATCH', 'active')).length, 0, 'not raised again straight away after a person investigated it');
});

test('alerts: list filters by severity, type, status, customer ID and search, with a summary and pagination', async () => {
  const code = await newIndividual();
  await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, -4) });
  await detectFor(code);
  const q = (s) => api('GET', `/alerts?customerId=${code}&${s}`);
  const all = await q('pageSize=100');
  assert.equal(all.status, 200);
  assert.ok(all.body.summary.total >= 3 && all.body.summary.bySeverity.High >= 1);
  assert.deepEqual((await q('severity=High')).body.data.map((a) => a.severity), ['High']);
  assert.ok((await q('severity=High,Medium')).body.data.every((a) => ['High', 'Medium'].includes(a.severity)));
  assert.equal((await q('alertType=DOCUMENT_EXPIRED')).body.data.length, 1);
  assert.equal((await q('status=Resolved')).body.data.length, 0);
  assert.equal((await q('status=active')).body.data.length, all.body.data.length);
  assert.equal((await q('status=New,Acknowledged')).body.data.length, all.body.data.length);
  assert.equal((await q('pageSize=1&page=2')).body.data.length, 1);
  assert.equal((await q('pageSize=1')).body.pagination.totalItems, all.body.data.length);
  assert.equal((await api('GET', `/alerts?search=${code.toLowerCase()}`)).body.data.every((a) => a.customerId === code), true);
  assert.equal((await api('GET', `/alerts?search=${all.body.data[0].alertId}`)).body.data.length, 1);
  assert.equal((await api('GET', '/alerts?severity=Huge')).status, 400);
  assert.equal((await api('GET', '/alerts?status=Sleeping')).status, 400);
  assert.equal((await api('GET', '/alerts?customerId=nope')).status, 400);
  assert.equal((await api('GET', '/alerts?alertType=NOPE')).status, 400);
  // the list puts the most severe active alerts first
  const order = all.body.data.map((a) => a.severity);
  const rank = { Low: 1, Medium: 2, High: 3, Critical: 4 };
  assert.deepEqual(order, [...order].sort((a, b) => rank[b] - rank[a]));
  const options = (await api('GET', '/alerts/options')).body.data;
  assert.equal(options.alertTypes.length, 10);
});

test('alerts: refresh endpoint runs detection for everyone and needs a chosen person', async () => {
  assert.equal((await api('POST', '/alerts/refresh')).status, 401);
  const res = await api('POST', '/alerts/refresh', {}, analyst);
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.customersChecked >= 1 && res.body.data.summary.totalAlerts >= 0);
  const summary = (await api('GET', '/alerts/summary')).body.data;
  assert.equal(summary.totalAlerts, await prisma.alert.count());
  assert.equal(summary.activeAlerts, await prisma.alert.count({ where: { status: { in: ['New', 'Acknowledged', 'In Progress'] } } }));
});

// ================================ ANALYTICS ======================================================================================
const n = (rows) => Number(rows[0].n);

test('analytics: every figure equals a direct count of the database records', async () => {
  await newIndividual();
  await newCompany();
  const res = await api('GET', '/analytics/overview?range=all');
  assert.equal(res.status, 200, res.text);
  const d = res.body.data;

  // customers
  assert.equal(d.customers.totalCustomers, await prisma.customer.count());
  assert.equal(d.customers.individualCustomers, await prisma.customer.count({ where: { customerType: { typeName: 'Individual' } } }));
  assert.equal(d.customers.companyCustomers, await prisma.customer.count({ where: { customerType: { typeName: 'Company' } } }));
  assert.equal(d.customers.individualCustomers + d.customers.companyCustomers, d.customers.totalCustomers);
  assert.equal(d.customers.recentlyOnboardedCustomers, d.customers.totalCustomers); // range=all
  const byRisk = d.customers.customersByRiskLevel;
  const latestLevels = await prisma.$queryRaw`SELECT rr.risk_level AS level, count(*)::int AS n FROM "Customer" c JOIN LATERAL (SELECT x.risk_level FROM "RiskRating" x WHERE x.customer_id = c.id ORDER BY x.assessment_date DESC, x.id DESC LIMIT 1) rr ON true GROUP BY 1`;
  for (const level of ['Low', 'Medium', 'High']) assert.equal(byRisk[level], latestLevels.find((r) => r.level === level)?.n ?? 0, level);
  assert.equal(d.customers.monthlyOnboarding.reduce((s, m) => s + m.total, 0), d.customers.totalCustomers);

  // documents
  assert.equal(d.documents.totalDocuments, await prisma.document.count());
  assert.equal(d.documents.verifiedDocuments, await prisma.document.count({ where: { status: 'Verified' } }));
  assert.equal(d.documents.pendingVerification, await prisma.document.count({ where: { status: { in: ['Pending', 'In Review'] } } }));
  assert.equal(d.documents.rejectedDocuments, await prisma.document.count({ where: { status: 'Rejected' } }));
  assert.equal(d.documents.expiredDocuments, n(await prisma.$queryRaw`SELECT count(*)::int n FROM "Document" WHERE expiry_date < ${TODAY}::date`));
  assert.equal(d.documents.documentsExpiringWithin30Days, n(await prisma.$queryRaw`SELECT count(*)::int n FROM "Document" WHERE expiry_date >= ${TODAY}::date AND expiry_date <= (${TODAY}::date + 30)`));
  assert.equal(Object.values(d.documents.statusDistribution).reduce((s, v) => s + v, 0), d.documents.totalDocuments);

  // risk
  assert.equal(d.risks.highRiskCustomers, byRisk.High);
  assert.equal(d.risks.customersRequiringManualReview, n(await prisma.$queryRaw`SELECT count(*)::int n FROM "Customer" c JOIN LATERAL (SELECT x.assessment_status FROM "RiskRating" x WHERE x.customer_id = c.id ORDER BY x.assessment_date DESC, x.id DESC LIMIT 1) r ON true WHERE r.assessment_status = 'Requires Manual Review'`));
  assert.ok(d.risks.potentialPepMatches >= 0 && d.risks.potentialSanctionsMatches >= 0);

  // review cases
  assert.equal(d.reviewCases.totalReviewCases, await prisma.reviewCase.count());
  assert.equal(d.reviewCases.escalatedCases, await prisma.reviewCase.count({ where: { status: 'Escalated' } }));
  assert.equal(d.reviewCases.resolvedCases, await prisma.reviewCase.count({ where: { status: 'Resolved' } }));
  assert.equal(d.reviewCases.openCases, await prisma.reviewCase.count({ where: { status: { in: ['Open', 'Assigned'] } } }));
  assert.equal(d.reviewCases.overdueCases, n(await prisma.$queryRaw`SELECT count(*)::int n FROM "ReviewCase" WHERE status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated') AND due_date < ${TODAY}::date`));
  assert.equal(Object.values(d.reviewCases.statusDistribution).reduce((s, v) => s + v, 0), d.reviewCases.totalReviewCases);

  // ownership
  assert.equal(d.ownership.totalBusinessCustomers, d.customers.companyCustomers);
  assert.equal(d.ownership.totalBeneficialOwners, await prisma.beneficialOwner.count());
  assert.equal(d.ownership.companiesWithoutOwners, n(await prisma.$queryRaw`SELECT count(*)::int n FROM "Customer" c JOIN "CustomerType" t ON t.id = c.customer_type_id AND t.type_name = 'Company' WHERE NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.customer_id = c.id)`));
  assert.equal(d.ownership.ownershipValidationIssues, (await api('GET', '/dashboard/risk-summary')).body.data.ownershipIssues);

  // dashboard additions: every document in exactly one health group, every company in exactly one ownership group
  const health = d.documents.health;
  assert.equal(health.verifiedAndValid + health.waitingForCheck + health.rejectedOrNeedsNewCopy + health.expired, d.documents.totalDocuments);
  assert.equal(health.expired, d.documents.expiredDocuments);
  assert.equal(health.verifiedAndValid, n(await prisma.$queryRaw`SELECT count(*)::int n FROM "Document" WHERE status = 'Verified' AND (expiry_date IS NULL OR expiry_date >= ${TODAY}::date)`));
  assert.equal(Object.values(d.ownership.validationStatusDistribution).reduce((s, v) => s + v, 0), d.ownership.totalBusinessCustomers);
  assert.equal(d.ownership.validationStatusDistribution.NO_OWNERS, d.ownership.companiesWithoutOwners);
  assert.equal(d.ownership.validationStatusDistribution.EXCEEDS_100, d.ownership.companiesExceeding100Percent);
  assert.ok(d.risks.manualReviewCustomers.length <= 6 && d.risks.manualReviewCustomers.length <= d.risks.customersRequiringManualReview);
  for (const m of d.risks.manualReviewCustomers) assert.match(m.customerId, /^CUS-\d{6}$/);
  assert.equal((await api('GET', '/review-dashboard/summary')).body.data.awaitingApprovalCases, await prisma.reviewCase.count({ where: { status: 'Escalated', proposalPending: true } }));

  // alerts
  assert.equal(d.alerts.alertsInPeriod, await prisma.alert.count());
  assert.equal(d.alerts.activeAlerts, await prisma.alert.count({ where: { status: { in: ['New', 'Acknowledged', 'In Progress'] } } }));
  assert.equal(d.alerts.bySeverity.reduce((s, x) => s + x.active + x.closed, 0), await prisma.alert.count());

  // KYC completeness
  const k = d.kyc;
  assert.equal(k.fullyCompleteCustomers + k.partiallyCompleteCustomers + k.notStartedCustomers + (k.distribution['No Requirements'] ?? 0), k.customersEvaluated);
  assert.equal(k.customersWithNoKycDocuments, n(await prisma.$queryRaw`SELECT count(*)::int n FROM "Customer" c WHERE NOT EXISTS (SELECT 1 FROM "Document" d WHERE d.customer_id = c.id)`));
  assert.ok(k.averageCompletenessPercentage === null || (k.averageCompletenessPercentage >= 0 && k.averageCompletenessPercentage <= 100));

  // the dashboard endpoints agree with the existing Scene 1 / Scene 4 summaries
  const scene1 = (await api('GET', '/dashboard/summary')).body.data;
  assert.equal(d.customers.totalCustomers, scene1.totalCustomers);
  assert.equal(d.risks.lowRiskCustomers, scene1.lowRiskCustomers);
  const scene4 = (await api('GET', '/review-dashboard/summary')).body.data;
  assert.equal(d.reviewCases.openCases, scene4.openCases);
  assert.equal(d.reviewCases.overdueCases, scene4.overdueCases);
});

test('analytics: short ranges also return a daily onboarding series that adds up; long ranges do not', async () => {
  await newIndividual();
  const d = (await api('GET', `/analytics/customers?from=${addDays(TODAY, -9)}&to=${TODAY}`)).body.data;
  assert.equal(d.dailyOnboarding.length, 10);
  assert.equal(d.dailyOnboarding[0].date, addDays(TODAY, -9));
  assert.equal(d.dailyOnboarding[9].date, TODAY);
  assert.equal(d.dailyOnboarding.reduce((s, x) => s + x.total, 0), d.recentlyOnboardedCustomers);
  assert.ok(d.dailyOnboarding.every((x) => x.individual + x.company === x.total));
  assert.ok(d.dailyOnboarding[9].total >= 1);
  assert.equal((await api('GET', '/analytics/customers?range=90d')).body.data.dailyOnboarding, null);
  assert.equal((await api('GET', '/analytics/customers?range=all')).body.data.dailyOnboarding, null);
});

test('recent activity: a limited feed of business actions from the audit records, open to every role', async () => {
  const code = await newIndividual(analyst);
  const res = await api('GET', '/activity/recent?limit=5'); // no person chosen at all
  assert.equal(res.status, 200, res.text);
  assert.ok(res.body.data.length >= 1 && res.body.data.length <= 5);
  const mine = (await api('GET', '/activity/recent?limit=20')).body.data.find((a) => a.customerCode === code);
  assert.equal(mine.actionType, 'CUSTOMER_CREATED');
  assert.equal(mine.actionLabel, 'Customer created');
  assert.equal(mine.user.role, 'Analyst');
  for (const a of res.body.data) {
    assert.deepEqual(Object.keys(a).sort(), ['actionLabel', 'actionType', 'category', 'createdAt', 'customerCode', 'entityId', 'entityRef', 'entityType', 'id', 'user']);
  }
  const text = JSON.stringify(res.body);
  assert.ok(!text.includes('previousValues') && !text.includes('newValues') && !text.includes('ipAddress') && !text.includes('reason'), 'values, reasons and IP addresses stay in the restricted audit trail');
  // system bookkeeping is not part of the feed
  assert.ok((await api('GET', '/activity/recent?limit=20')).body.data.every((a) => !['EXCEPTION_DETECTED', 'ALERT_GENERATED', 'EXPORT_GENERATED', 'DATA_VALIDATION_RUN'].includes(a.actionType)));
  assert.equal((await api('GET', '/activity/recent?limit=999')).body.data.length <= 20, true);
  assert.equal((await api('GET', '/activity/recent?limit=abc')).status, 200);
});

test('analytics: the section endpoints return the same figures as the overview', async () => {
  const [overview, customers, documents, risks, cases, ownership] = await Promise.all(
    ['overview', 'customers', 'documents', 'risks', 'review-cases', 'ownership'].map((s) => api('GET', `/analytics/${s}?range=all`))
  );
  for (const r of [overview, customers, documents, risks, cases, ownership]) assert.equal(r.status, 200, r.text);
  const d = overview.body.data;
  assert.equal(customers.body.data.totalCustomers, d.customers.totalCustomers);
  assert.equal(customers.body.data.kycCompleteness.fullyCompleteCustomers, d.kyc.fullyCompleteCustomers);
  assert.equal(documents.body.data.totalDocuments, d.documents.totalDocuments);
  assert.equal(risks.body.data.highRiskCustomers, d.risks.highRiskCustomers);
  assert.equal(cases.body.data.totalReviewCases, d.reviewCases.totalReviewCases);
  assert.equal(ownership.body.data.totalBeneficialOwners, d.ownership.totalBeneficialOwners);
});

test('analytics: date filters change the period figures only, and are validated', async () => {
  await newIndividual();
  const d7 = (await api('GET', '/analytics/overview?range=7d')).body.data;
  assert.equal(d7.period.key, '7d');
  assert.equal(d7.period.days, 7);
  assert.equal(d7.period.to, TODAY);
  assert.equal(d7.period.from, addDays(TODAY, -6));
  const inLast7 = n(await prisma.$queryRaw`SELECT count(*)::int n FROM "Customer" WHERE created_at >= ${addDays(TODAY, -6)}::timestamp`);
  assert.equal(d7.customers.recentlyOnboardedCustomers, inLast7);
  assert.ok(d7.customers.recentlyOnboardedCustomers >= 1);

  const old = (await api('GET', '/analytics/overview?from=2020-01-01&to=2020-01-31')).body.data;
  assert.equal(old.period.key, 'custom');
  assert.equal(old.customers.recentlyOnboardedCustomers, 0);
  assert.equal(old.documents.submittedInPeriod, 0);
  assert.equal(old.reviewCases.casesOpenedInPeriod, 0);
  assert.equal(old.alerts.alertsInPeriod, 0);
  assert.deepEqual(old.alerts.bySeverity.map((s) => s.active + s.closed), [0, 0, 0, 0]);
  assert.ok(old.customers.monthlyOnboarding.length >= 6 && old.customers.monthlyOnboarding.every((m) => m.total === 0));
  // snapshot figures do not move with the filter
  assert.equal(old.customers.totalCustomers, d7.customers.totalCustomers);
  assert.equal(old.documents.totalDocuments, d7.documents.totalDocuments);
  assert.deepEqual(old.customers.customersByRiskLevel, d7.customers.customersByRiskLevel);

  const today = (await api('GET', `/analytics/overview?from=${TODAY}&to=${TODAY}`)).body.data;
  assert.equal(today.period.days, 1);
  assert.ok(today.customers.recentlyOnboardedCustomers >= 1);
  const trend = today.customers.monthlyOnboarding;
  assert.equal(trend[trend.length - 1].month, TODAY.slice(0, 7));

  assert.equal((await api('GET', '/analytics/overview?range=1y')).status, 400);
  assert.equal((await api('GET', '/analytics/overview?from=2026-10-10')).status, 400);
  assert.equal((await api('GET', '/analytics/overview?from=2026-10-10&to=2026-10-01')).status, 400);
  assert.equal((await api('GET', '/analytics/overview?from=2026-10-10&to=2099-01-01')).status, 400);
  assert.equal((await api('GET', '/analytics/overview?from=banana&to=2026-10-01')).status, 400);
});

// ================================ DATA QUALITY ===================================================================================
test('data quality: running validation needs a compliance reviewer or administrator, and only reads business data', async () => {
  assert.equal((await api('POST', '/data-validation/run')).status, 401);
  const denied = await api('POST', '/data-validation/run', {}, analyst);
  assert.equal(denied.status, 403);

  const snapshot = async () => (await prisma.$queryRaw`SELECT
    (SELECT count(*) FROM "Customer")::int AS customers, (SELECT count(*) FROM "Document")::int AS documents, (SELECT count(*) FROM "ReviewCase")::int AS cases,
    (SELECT count(*) FROM "Alert")::int AS alerts, (SELECT count(*) FROM "RiskRating")::int AS ratings, (SELECT count(*) FROM "BeneficialOwner")::int AS owners,
    (SELECT coalesce(max(updated_at)::text, '') FROM "Customer") AS c_upd, (SELECT coalesce(max(updated_at)::text, '') FROM "Document") AS d_upd,
    (SELECT coalesce(max(updated_at)::text, '') FROM "ReviewCase") AS rc_upd, (SELECT coalesce(max(updated_at)::text, '') FROM "Alert") AS a_upd`)[0];
  const before = await snapshot();
  const ran = await api('POST', '/data-validation/run', {}, reviewer);
  assert.equal(ran.status, 201, ran.text);
  assert.deepEqual(await snapshot(), before, 'validation changed business data');

  const run = ran.body.data;
  assert.equal(run.status, 'Completed');
  assert.match(run.runId, /^VAL-\d{6}$/);
  assert.equal(run.totalChecks, run.passedChecks + run.failedChecks + run.warnings);
  assert.equal(run.totalChecks, run.results.length);
  assert.ok(run.totalChecks >= 30);
  assert.ok(run.validationRunDate && run.completedAt);
  assert.equal(run.createdBy.id, reviewer.id);
  assert.equal(run.passedChecks, run.results.filter((r) => r.outcome === 'Passed').length);
  assert.ok(run.results.every((r) => ['Passed', 'Failed', 'Warning'].includes(r.outcome)));
  assert.ok(Array.isArray(run.failedRecordIds));

  const logged = await prisma.auditEvent.findMany({ where: { actionType: 'DATA_VALIDATION_RUN', userId: reviewer.id } });
  assert.equal(logged.length, 1);
  assert.equal(logged[0].newValues.totalChecks, run.totalChecks);

  const runs = await api('GET', '/data-validation/runs?pageSize=5');
  assert.equal(runs.status, 200);
  assert.equal(runs.body.data[0].id, run.id);
  assert.equal((await api('GET', `/data-validation/runs/${run.id}`)).body.data.totalChecks, run.totalChecks);
  assert.equal((await api('GET', '/data-validation/runs/99999999')).status, 404);
  assert.equal((await api('GET', '/data-validation/runs/abc')).status, 404);
  const checks = (await api('GET', '/data-validation/checks')).body.data;
  assert.equal(checks.checks.length, run.totalChecks);
});

test('data quality: finds ownership over 100%, gives a recommended fix, and shows the issue as resolved once it is corrected through the workflow', async () => {
  const code = await newCompany();
  const a = (await addOwner(code, { ownershipPercentage: 70 })).body.data;
  await addOwner(code, { ownershipPercentage: 60 });
  const first = (await api('POST', '/data-validation/run', {}, admin)).body.data;
  assert.equal(first.results.find((r) => r.code === 'OWN_TOTAL_OVER_100').outcome, 'Failed');
  assert.ok(first.failedChecks >= 1);

  const issues = await api('GET', `/data-validation/issues?runId=${first.id}&checkCode=OWN_TOTAL_OVER_100&pageSize=100`);
  assert.equal(issues.status, 200, issues.text);
  const mine = issues.body.data.find((i) => i.entityRef === code);
  assert.ok(mine, 'the failing customer is listed');
  assert.equal(mine.severity, 'Error');
  assert.equal(mine.status, 'Open');
  assert.equal(mine.customerId, code);
  assert.equal(mine.category, 'Ownership');
  assert.match(mine.description, /130%/);
  assert.match(mine.recommendedFix, /ownership page/i);
  assert.ok(first.failedRecordIds.includes(code));

  // the data was NOT silently corrected
  const total = await prisma.beneficialOwner.aggregate({ _sum: { ownershipPercentage: true }, where: { customer: { customerCode: code } } });
  assert.equal(Number(total._sum.ownershipPercentage), 130);

  // a person corrects it through the ownership workflow, then validates again
  const put = await api('PUT', `/beneficial-owners/${a.id}`, ownerBody({ fullName: a.fullName, dateOfBirth: '1975-04-12', ownershipPercentage: 30 }), analyst);
  assert.equal(put.status, 200, put.text);
  const second = (await api('POST', '/data-validation/run', {}, reviewer)).body.data;
  assert.ok(second.id > first.id);
  const recheck = await api('GET', `/data-validation/issues?runId=${second.id}&checkCode=OWN_TOTAL_OVER_100&pageSize=100`);
  assert.ok(!recheck.body.data.some((i) => i.entityRef === code));
  const old = await prisma.validationIssue.findFirst({ where: { validationRunId: first.id, checkCode: 'OWN_TOTAL_OVER_100', entityRef: code } });
  assert.equal(old.status, 'Resolved');
  assert.ok(old.resolvedAt);

  const filtered = await api('GET', `/data-validation/issues?runId=${first.id}&severity=Error&category=Ownership&status=Resolved&search=${code}`);
  assert.equal(filtered.body.pagination.totalItems, 1);
  assert.equal((await api('GET', '/data-validation/issues?severity=Fatal')).status, 400);
  assert.equal((await api('GET', '/data-validation/issues?category=Nope')).status, 400);
  const latest = await api('GET', '/data-validation/issues'); // default: newest run
  assert.equal(latest.body.runId, second.id);
});

test('data quality: finds a missing ownership record, an overdue case and a stale active alert', async () => {
  const company = await newCompany(); // no owners
  const code = await newIndividual();
  const doc = await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, -3) });
  await detectFor(code);
  const alert = (await alertOfType(code, 'DOCUMENT_EXPIRED'))[0];
  await prisma.document.update({ where: { id: doc.id }, data: { expiryDate: parseIso(addDays(TODAY, 300)) } }); // fixed, but detection has not run yet

  const created = await api('POST', '/review-cases', { customerId: code, caseTitle: 'Overdue test case', caseType: 'Other', priority: 'Low' }, analyst);
  assert.equal(created.status, 201, created.text);
  await prisma.$executeRaw`UPDATE "ReviewCase" SET due_date = ${addDays(TODAY, -4)}::date WHERE case_code = ${created.body.data.caseId}`;

  const run = (await api('POST', '/data-validation/run', {}, reviewer)).body.data;
  const issues = (await api('GET', `/data-validation/issues?runId=${run.id}&pageSize=100&search=${alert.alertId}`)).body.data;
  const stale = issues.find((i) => i.checkCode === 'ALERT_ACTIVE_VALID');
  assert.ok(stale, 'active alert whose issue no longer exists');
  assert.equal(stale.entityRef, alert.alertId);
  assert.equal(stale.severity, 'Error');
  assert.match(stale.recommendedFix, /Refresh alerts|detection/i);
  const overdue = (await api('GET', `/data-validation/issues?runId=${run.id}&checkCode=CASE_OVERDUE_IDENTIFIED&search=${created.body.data.caseId}`)).body.data[0];
  assert.equal(overdue.severity, 'Warning');
  assert.match(overdue.description, /4 day\(s\) overdue/);
  assert.equal(run.results.find((r) => r.code === 'CASE_OVERDUE_IDENTIFIED').outcome, 'Warning');
  const noOwners = (await api('GET', `/data-validation/issues?runId=${run.id}&checkCode=OWN_MISSING_OWNERS&pageSize=100`)).body.data;
  assert.ok(noOwners.some((i) => i.entityRef === company && i.severity === 'Warning'));

  await detectFor(code); // the "workflow" that fixes the stale alert
  const after = (await api('POST', '/data-validation/run', {}, reviewer)).body.data;
  const again = (await api('GET', `/data-validation/issues?runId=${after.id}&checkCode=ALERT_ACTIVE_VALID&pageSize=100`)).body.data;
  assert.ok(!again.some((i) => i.entityRef === alert.alertId));
});

test('data quality: rules protected by database constraints cannot be violated through the database either', async () => {
  const code = await newIndividual();
  const customer = await dbCustomer(code);
  const make = (data) => prisma.document.create({ data: { customerId: customer.id, documentType: 'PAN', issueDate: parseIso(addDays(TODAY, -10)), submissionDate: parseIso(addDays(TODAY, -5)), ...data } });
  await assert.rejects(() => make({ issueDate: parseIso(addDays(TODAY, -1)), submissionDate: parseIso(addDays(TODAY, -9)) }), /check|constraint/i); // issue after submission
  await assert.rejects(() => make({ expiryDate: parseIso(addDays(TODAY, -30)) }), /check|constraint/i); // expiry before issue
  await assert.rejects(() => make({ status: 'Teleported' }), /check|constraint/i); // invalid status
  await assert.rejects(() => prisma.document.create({ data: { customerId: 999999999, documentType: 'PAN', issueDate: parseIso(addDays(TODAY, -10)), submissionDate: parseIso(addDays(TODAY, -5)) } }), /Foreign key/i); // no such customer
  await assert.rejects(() => prisma.alert.create({ data: { customerId: 999999999, alertType: 'DOCUMENT_EXPIRY', title: 'x', description: 'x', severity: 'Low', relatedEntityType: 'Document', dedupeKey: `x${rnd(8)}` } }), /Foreign key/i);
  await assert.rejects(() => prisma.alert.create({ data: { customerId: customer.id, alertType: 'MADE_UP', title: 'x', description: 'x', severity: 'Low', relatedEntityType: 'Document', dedupeKey: `x${rnd(8)}` } }), /check|constraint/i);
  await assert.rejects(() => prisma.alert.create({ data: { customerId: customer.id, alertType: 'DOCUMENT_EXPIRY', title: 'x', description: 'x', severity: 'Low', relatedEntityType: 'Document', dedupeKey: `x${rnd(8)}`, status: 'Resolved' } }), /check|constraint/i); // closed without how/why
});

// ================================ EXPORTS ==========================================================================================
const csvRows = (text) => text.replace(/^﻿/, '').split('\r\n').filter(Boolean);

test('exports: catalogue shows what each person may export; no person means nothing is allowed', async () => {
  const anon = (await api('GET', '/exports')).body.data;
  assert.equal(anon.length, 10);
  assert.ok(anon.every((e) => e.allowed === false));
  const asAnalyst = (await api('GET', '/exports', null, analyst)).body.data;
  assert.deepEqual(asAnalyst.filter((e) => e.allowed).map((e) => e.key).sort(), ['alerts', 'completeness', 'documents', 'review-cases']);
  const asReviewer = (await api('GET', '/exports', null, reviewer)).body.data;
  assert.ok(asReviewer.every((e) => e.allowed));
  assert.deepEqual(asReviewer.filter((e) => e.sensitive).map((e) => e.key).sort(), ['audit-events', 'customers', 'ownership', 'risks', 'schema', 'seed-data']);
});

test('exports: sensitive reports are refused for analysts and anonymous callers, operational reports are allowed', async () => {
  for (const key of ['customers', 'risks', 'ownership', 'audit-events', 'seed-data', 'schema']) {
    assert.equal((await api('GET', `/exports/${key}`)).status, 401, `${key} without a person`);
    const res = await api('GET', `/exports/${key}`, null, analyst);
    assert.equal(res.status, 403, `${key} for an analyst`);
    assert.equal(res.body.error.code, 'EXPORT_NOT_ALLOWED');
  }
  for (const key of ['documents', 'completeness', 'review-cases', 'alerts']) {
    const res = await api('GET', `/exports/${key}`, null, analyst);
    assert.equal(res.status, 200, `${key}: ${res.text.slice(0, 200)}`);
  }
});

test('exports: customer CSV has fixed columns, UTF-8, masked identifiers and honours filters', async () => {
  const person = await newIndividual();
  const company = await newCompany();
  const res = await api('GET', '/exports/customers', null, reviewer);
  assert.equal(res.status, 200, res.text);
  assert.match(res.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="clearkyc-customers-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.deepEqual([...res.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 byte-order mark');
  const rows = csvRows(res.text);
  assert.equal(rows[0], 'Customer ID,Customer Type,Full Name,Email (masked),Phone (masked),Country,PAN (masked),Aadhaar (masked),Registration Status,Risk Level,Risk Score,Created At');
  assert.equal(rows.length - 1, await prisma.customer.count());
  assert.equal(res.headers.get('x-export-rows'), String(rows.length - 1));

  const mine = rows.find((r) => r.startsWith(person));
  assert.ok(mine);
  assert.match(mine, /XXXXXX\w{4}/); // PAN masked
  assert.match(mine, /XXXX XXXX \d{4}/); // Aadhaar masked
  assert.ok(!PANS.some((p) => res.text.includes(p)), 'no full PAN anywhere in the export');
  assert.ok(!AADHAARS.some((a) => res.text.includes(a)), 'no full Aadhaar anywhere in the export');
  assert.ok(!res.text.includes('qs.person@example.com') && !res.text.includes('9812345679'), 'contact details are masked');
  assert.ok(res.text.includes('q***@example.com'));

  const companies = csvRows((await api('GET', '/exports/customers?customerType=Company', null, reviewer)).text).slice(1);
  assert.ok(companies.length >= 1 && companies.every((r) => r.split(',')[1] === 'Company'));
  assert.ok(companies.some((r) => r.startsWith(company)));
  const high = csvRows((await api('GET', '/exports/customers?riskLevel=High', null, reviewer)).text).slice(1);
  assert.equal(high.length, (await api('GET', '/analytics/overview?range=all')).body.data.customers.customersByRiskLevel.High);
  assert.equal(csvRows((await api('GET', '/exports/customers?from=2020-01-01&to=2020-12-31', null, reviewer)).text).length, 1); // header only
  assert.equal(csvRows((await api('GET', `/exports/customers?search=${person}`, null, reviewer)).text).length, 2);
  assert.equal((await api('GET', '/exports/customers?from=2026-12-31&to=2026-01-01', null, reviewer)).status, 400);
  assert.equal((await api('GET', '/exports/customers?riskLevel=Extreme', null, reviewer)).status, 400);
});

test('exports: documents, completeness, risk, ownership, case and alert reports are built from the records', async () => {
  const code = await newIndividual();
  const doc = await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, 20) });
  await prisma.document.update({ where: { id: doc.id }, data: { documentNumber: null } });
  await detectFor(code);
  const company = await newCompany();
  await addOwner(company, { ownershipPercentage: 100, fullName: 'Export Owner' });
  const caseRes = await api('POST', '/review-cases', { customerId: code, caseTitle: 'Export test case', caseType: 'Other', priority: 'Low' }, analyst);

  const docs = csvRows((await api('GET', `/exports/documents?customerId=${code}`, null, analyst)).text);
  assert.equal(docs[0], 'Document ID,Customer ID,Document Type,Document Number (masked),Issue Date,Expiry Date,Submission Date,Verification Status,Expiry State,File Attached,Created At');
  assert.equal(docs.length, 2);
  assert.ok(docs[1].includes(',Verified,Expiring Soon,No,'));
  assert.equal(csvRows((await api('GET', `/exports/documents?customerId=${code}&status=Rejected`, null, analyst)).text).length, 1);
  assert.equal(csvRows((await api('GET', `/exports/documents?customerId=${code}&expiry=Expiring%20Soon`, null, analyst)).text).length, 2);

  const completeness = csvRows((await api('GET', '/exports/completeness', null, analyst)).text);
  assert.ok(completeness[0].startsWith('Customer ID,Customer Type,Risk Level,Mandatory Requirements,Verified,'));
  const mine = completeness.find((r) => r.startsWith(code)).split(',');
  assert.equal(mine[3], '3'); // PAN, Address Proof, Photograph
  assert.equal(mine[4], '1'); // one verified
  assert.equal(mine[11], '33.3');
  assert.equal(mine[12], 'Partially Complete');

  const risks = csvRows((await api('GET', `/exports/risks?customerId=${code}`, null, reviewer)).text);
  assert.equal(risks.length, 2);
  assert.match(risks[1], /^RSK-\d{6},/);
  const owners = csvRows((await api('GET', `/exports/ownership?customerId=${company}`, null, reviewer)).text);
  assert.equal(owners.length, 2);
  assert.ok(owners[1].includes('Export Owner') && owners[1].includes('RECONCILED'));
  assert.ok(!owners[1].includes('1975-04-12'), 'date of birth is not exported');
  const cases = csvRows((await api('GET', `/exports/review-cases?customerId=${code}`, null, analyst)).text);
  assert.equal(cases.length, 2);
  assert.ok(cases[1].includes(caseRes.body.data.caseId));
  assert.equal(csvRows((await api('GET', `/exports/review-cases?customerId=${code}&priority=Critical`, null, analyst)).text).length, 1);
  const alertsCsv = csvRows((await api('GET', `/exports/alerts?customerId=${code}`, null, analyst)).text);
  assert.equal(alertsCsv.length - 1, (await alertsOf(code)).length);
  assert.equal(csvRows((await api('GET', `/exports/alerts?customerId=${code}&severity=Critical`, null, analyst)).text).length, 1);
});

test('exports: the audit trail export is complete, filtered, free of sensitive data, and every export is itself audited', async () => {
  const code = await newIndividual();
  await insertDoc(code, 'PAN', { status: 'Verified', expiry: addDays(TODAY, 900) });
  const res = await api('GET', `/exports/audit-events?customerId=${code}`, null, reviewer);
  assert.equal(res.status, 200, res.text);
  const rows = csvRows(res.text);
  assert.equal(rows[0], 'Audit Event ID,User,User Role,Action Type,Entity Type,Entity ID,Entity Reference,Customer ID,Previous Values,New Values,Reason,IP Address,Timestamp');
  assert.equal(rows.length - 1, (await eventsFor(code)).length);
  assert.ok(rows[1].includes('CUSTOMER_CREATED'));
  assert.ok(!PANS.some((p) => res.text.includes(p)) && !AADHAARS.some((a) => res.text.includes(a)));
  assert.equal(csvRows((await api('GET', `/exports/audit-events?customerId=${code}&actionType=DOCUMENT_VERIFIED`, null, reviewer)).text).length, 1);

  // every export request is recorded: who, which report, which filters, how many rows
  const logged = await prisma.auditEvent.findMany({ where: { actionType: 'EXPORT_GENERATED', userId: reviewer.id }, orderBy: { id: 'desc' } });
  const mine = logged.find((e) => e.newValues.report === 'audit-events' && e.newValues.filters.customerId === code && !e.newValues.filters.actionType);
  assert.ok(mine);
  assert.equal(mine.newValues.rows, rows.length - 1);
  assert.equal(mine.entityType, 'Export');
  assert.equal(mine.userRole, 'Reviewer');
  // a refused export is not logged as an export
  const beforeDenied = await prisma.auditEvent.count({ where: { actionType: 'EXPORT_GENERATED', userId: analyst.id } });
  assert.equal((await api('GET', '/exports/customers', null, analyst)).status, 403);
  assert.equal(await prisma.auditEvent.count({ where: { actionType: 'EXPORT_GENERATED', userId: analyst.id } }), beforeDenied);
});

test('exports: seed data (JSON) and database schema (SQL) are generated from the live database without secrets', async () => {
  const seed = await api('GET', '/exports/seed-data', null, admin);
  assert.equal(seed.status, 200, seed.text.slice(0, 300));
  assert.match(seed.headers.get('content-type'), /^application\/json; charset=utf-8/);
  const json = JSON.parse(seed.text);
  assert.equal(json.meta.seed, 20261022);
  assert.equal(json.meta.rowCounts.customers, await prisma.customer.count());
  assert.equal(json.data.customers.length, await prisma.customer.count());
  assert.equal(json.data.documents.length, await prisma.document.count());
  assert.equal(json.data.alerts.length, await prisma.alert.count());
  assert.ok(json.data.customers.every((c) => /^XXXXXX\w{4}$/.test(c.panMasked)));
  for (const secret of ['pan_number', 'panNumber', 'panHash', 'aadhaarHash', 'identityHash', 'documentNumberHash', 'dateOfBirth', 'encryption']) assert.ok(!seed.text.includes(`"${secret}"`), secret);
  assert.ok(!PANS.some((p) => seed.text.includes(p)));

  const schema = await api('GET', '/exports/schema', null, reviewer);
  assert.equal(schema.status, 200, schema.text.slice(0, 300));
  assert.match(schema.headers.get('content-type'), /^application\/sql; charset=utf-8/);
  for (const piece of ['CREATE TABLE "AuditEvent"', 'CREATE TABLE "Alert"', 'CREATE TABLE "ValidationRun"', 'CREATE TABLE "ValidationIssue"', 'CREATE TABLE "Customer"', 'AuditEvent_no_update', 'Alert_active_dedupe_key', 'FOREIGN KEY', 'CREATE SEQUENCE']) {
    assert.ok(schema.text.includes(piece), piece);
  }
  assert.ok(!schema.text.includes('_prisma_migrations'));
  assert.ok(!/^INSERT INTO/m.test(schema.text), 'structure only: no data statements (trigger bodies may contain INSERT)');
  const kinds = await prisma.auditEvent.findMany({ where: { actionType: 'EXPORT_GENERATED', userId: { in: [admin.id, reviewer.id] } } });
  assert.ok(kinds.some((e) => e.newValues.report === 'seed-data') && kinds.some((e) => e.newValues.report === 'schema'));
});

// ================================ INTEGRITY ==========================================================================================
test('referential integrity: after all of this, nothing points at records that do not exist', async () => {
  const q = async (sql) => Number((await prisma.$queryRawUnsafe(sql))[0].n);
  assert.equal(await q('SELECT count(*) n FROM "Alert" a LEFT JOIN "Customer" c ON c.id = a.customer_id WHERE c.id IS NULL'), 0);
  assert.equal(await q('SELECT count(*) n FROM "Alert" a WHERE a.exception_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Exception" e WHERE e.id = a.exception_id)'), 0);
  assert.equal(await q('SELECT count(*) n FROM "AuditEvent" a WHERE a.user_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Reviewer" r WHERE r.id = a.user_id)'), 0);
  assert.equal(await q('SELECT count(*) n FROM "ValidationIssue" i LEFT JOIN "ValidationRun" r ON r.id = i.validation_run_id WHERE r.id IS NULL'), 0);
  // no active alert points at a document / owner / schedule that no longer exists
  assert.equal(await q(`SELECT count(*) n FROM "Alert" a WHERE a.status IN ('New', 'Acknowledged', 'In Progress') AND a.related_entity_type = 'Document' AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d.id = a.related_entity_id)`), 0);
  assert.equal(await q(`SELECT count(*) n FROM "Alert" a WHERE a.status IN ('New', 'Acknowledged', 'In Progress') AND a.related_entity_type = 'BeneficialOwner' AND NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.id = a.related_entity_id)`), 0);
  // the test runs left no audit events of their own behind except through the cleanup that follows (checked by the next run)
  assert.equal(await q(`SELECT count(*) n FROM "AuditEvent" WHERE action_type = 'CUSTOMER_CREATED' AND customer_id IS NULL`), 0);
});
