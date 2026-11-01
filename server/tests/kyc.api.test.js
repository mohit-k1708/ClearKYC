/**
 * Scene 2 API integration tests. They use the REAL database (start `npm run db:local` first).
 * Everything they create (customers, documents, verifications, reviewers, requirements, files)
 * is removed afterwards. Verification history is insert-only, so cleanup uses the database's
 * explicit maintenance switch (SET LOCAL app.allow_history_delete).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Uploaded test files go to a throw-away folder, set BEFORE the app loads.
const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearkyc-uploads-'));
process.env.UPLOAD_DIR = uploadDir;

const app = require('../src/app');
const prisma = require('../src/utils/prisma');
const { DEFAULT_REQUIREMENTS, EFFECTIVE_FROM_DEFAULT } = require('../src/config/kycRules');
const { addDays, todayIso, parseIso } = require('../src/utils/dates');

let server;
let base;
const customerCodes = new Set();
const reviewerIds = new Set();
const requirementIds = new Set();
const TODAY = todayIso();
let reviewer; // can decide
let reviewer2; // can decide (second person)
let analyst; // cannot decide
let inactive; // cannot decide

const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const letter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;

  // The sample requirements must exist (normally created by `npm run generate:kyc`).
  for (const group of DEFAULT_REQUIREMENTS) {
    for (const documentType of group.documents) {
      const key = { customerTypeId: group.customerType === 'Individual' ? 1 : 2, riskLevel: group.riskLevel, documentType, effectiveFrom: parseIso(EFFECTIVE_FROM_DEFAULT) };
      const found = await prisma.kYCRequirement.findUnique({ where: { customerTypeId_riskLevel_documentType_effectiveFrom: key } });
      if (!found) await prisma.kYCRequirement.create({ data: { ...key, isMandatory: true, isActive: true } });
    }
  }

  const make = async (role, isActive = true) => {
    const r = await prisma.reviewer.create({ data: { name: `Test ${role}`, email: `qk.${role.toLowerCase()}.${rnd(8)}@example.com`, role, isActive } });
    reviewerIds.add(r.id);
    return r;
  };
  reviewer = await make('Reviewer');
  reviewer2 = await make('Admin');
  analyst = await make('Analyst');
  inactive = await make('Reviewer', false);
});

test.after(async () => {
  const codes = [...customerCodes];
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    // Scene 5: the audit events the test created are removed with it (audit events are otherwise immutable)
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id IN (SELECT id FROM "Customer" WHERE customer_id = ANY(${codes}::text[])) OR user_id = ANY(${[...reviewerIds]}::int[]) OR (entity_type = 'KYCRequirement' AND entity_id = ANY(${[...requirementIds]}::int[]))`,
    prisma.verification.deleteMany({ where: { OR: [{ document: { customer: { customerCode: { in: codes } } } }, { reviewerId: { in: [...reviewerIds] } }] } }),
    prisma.document.deleteMany({ where: { customer: { customerCode: { in: codes } } } }),
    prisma.customer.deleteMany({ where: { customerCode: { in: codes } } }),
    prisma.reviewer.deleteMany({ where: { id: { in: [...reviewerIds] } } }),
    prisma.kYCRequirement.deleteMany({ where: { id: { in: [...requirementIds] } } }),
  ]);
  fs.rmSync(uploadDir, { recursive: true, force: true });
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ---- helpers -----------------------------------------------------------------------------------
const api = async (method, url, body, headers = {}) => {
  const isForm = body instanceof FormData;
  const res = await fetch(base + url, {
    method,
    headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()) };
};
const as = (r) => ({ 'x-reviewer-id': String(r.id) });

/** Registers a synthetic customer through the Scene 1 API. */
async function newCustomer(over = {}) {
  const res = await api('POST', '/customers', {
    customerType: 'Individual',
    fullName: 'QK Test Person',
    dateOfBirth: '1988-03-04',
    email: 'qk.test@example.com',
    phone: '9812345678',
    address: '5 Test Lane',
    panNumber: `QKYP${letter()}${rnd(4)}${letter()}`,
    aadhaarNumber: `9${rnd(11)}`,
    occupation: 'Engineer',
    country: 'IN',
    ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  customerCodes.add(res.body.data.customerId);
  return { code: res.body.data.customerId, riskLevel: res.body.data.currentRisk.level };
}

const docPayload = (customerId, over = {}) => ({
  customerId,
  documentType: 'PAN',
  documentNumber: `SYN-PAN-${rnd(6)}`,
  issueDate: addDays(TODAY, -200),
  submissionDate: addDays(TODAY, -5),
  notes: 'synthetic',
  ...over,
});
const addDoc = (customerId, over) => api('POST', '/documents', docPayload(customerId, over));
const decide = (docId, status, remarks, who = reviewer) => api('POST', `/documents/${docId}/verifications`, { status, remarks }, as(who));

/** Inserts a document straight into the database (as the seed does) so past dates can be tested. */
async function insertVerifiedDoc(customerCode, documentType, { expiryDate, status = 'Verified' }) {
  const customer = await prisma.customer.findUnique({ where: { customerCode } });
  const doc = await prisma.document.create({
    data: {
      customerId: customer.id,
      documentType,
      issueDate: parseIso(addDays(TODAY, -400)),
      submissionDate: parseIso(addDays(TODAY, -300)),
      expiryDate: expiryDate ? parseIso(expiryDate) : null,
    },
  });
  await prisma.verification.create({ data: { documentId: doc.id, status: 'Pending', remarks: 'seed' } });
  if (status !== 'Pending') await prisma.verification.create({ data: { documentId: doc.id, reviewerId: reviewer.id, status, remarks: 'seed decision' } });
  return doc;
}

const pdfFile = (extra = '') => new Blob([`%PDF-1.4\n% synthetic test document ${extra}\n%%EOF`], { type: 'application/pdf' });

// ---- adding documents ------------------------------------------------------------------------------------
test('adds a document for an existing customer: starts Pending with a system verification record, number masked', async () => {
  const c = await newCustomer();
  const payload = docPayload(c.code);
  const res = await addDoc(c.code, payload);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const d = res.body.data;
  assert.equal(d.status, 'Pending');
  assert.equal(d.customer.customerId, c.code);
  assert.match(d.documentNumberMasked, /^X+\w{4}$/);
  assert.ok(!JSON.stringify(res.body).includes(payload.documentNumber), 'the full document number must never be returned');
  assert.equal(d.verifications.length, 1);
  assert.equal(d.verifications[0].status, 'Pending');
  assert.equal(d.verifications[0].reviewer, null); // recorded by the system
  const row = await prisma.document.findUnique({ where: { id: d.id } });
  assert.ok(!row.documentNumber.includes(payload.documentNumber), 'stored encrypted');
});

test('rejects a document for a customer that does not exist (404 and a database foreign key)', async () => {
  const res = await addDoc('CUS-999999');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'CUSTOMER_NOT_FOUND');
  assert.ok(res.body.error.details.customerId);
  // Even bypassing the API, the foreign key refuses it.
  await assert.rejects(prisma.document.create({ data: { customerId: 99999999, documentType: 'PAN', issueDate: new Date('2025-01-01'), submissionDate: new Date('2025-01-02') } }));
});

test('validates document input with per-field messages', async () => {
  const c = await newCustomer();
  const res = await addDoc(c.code, { documentType: 'Not A Type', documentNumber: '!!', issueDate: addDays(TODAY, 5), expiryDate: addDays(TODAY, -900), submissionDate: 'tomorrow' });
  assert.equal(res.status, 400);
  for (const f of ['documentNumber', 'issueDate', 'submissionDate']) assert.ok(res.body.error.details[f], f);
  const unknown = await addDoc(c.code, { documentType: 'Not A Type' });
  assert.equal(unknown.status, 400);
  assert.ok(unknown.body.error.details.documentType);
  const noNumber = await addDoc(c.code, { documentNumber: undefined });
  assert.equal(noNumber.status, 400); // PAN needs a number
  const photo = await addDoc(c.code, { documentType: 'Photograph', documentNumber: undefined });
  assert.equal(photo.status, 201); // Photograph does not
  const before = await addDoc(c.code, { issueDate: addDays(TODAY, -10), submissionDate: addDays(TODAY, -20) });
  assert.equal(before.status, 400);
  assert.ok(before.body.error.details.submissionDate);
});

test('an identical resubmission is a 409, and simultaneous duplicates create one record', async () => {
  const c = await newCustomer();
  const payload = docPayload(c.code);
  assert.equal((await api('POST', '/documents', payload)).status, 201);
  const dup = await api('POST', '/documents', payload);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'DUPLICATE_DOCUMENT');

  const other = docPayload(c.code, { documentType: 'Address Proof' });
  const results = await Promise.all(Array.from({ length: 4 }, () => api('POST', '/documents', other)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 3);
});

// ---- verification workflow -------------------------------------------------------------------------------
test('uploading does not verify: a document with a file stays Pending and does not count toward completeness', async () => {
  const c = await newCustomer();
  const form = new FormData();
  Object.entries(docPayload(c.code)).forEach(([k, v]) => form.append(k, v));
  form.append('file', pdfFile(), 'pan-scan.pdf');
  const res = await api('POST', '/documents', form);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'Pending');
  assert.equal(res.body.data.hasFile, true);
  const k = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  assert.equal(k.totals.verified, 0);
  assert.equal(k.totals.pendingVerification, 1);
  assert.equal(k.percentage, 0);
  assert.equal(k.status, 'Not Started');
});

test('records verification decisions as new rows and preserves the full history', async () => {
  const c = await newCustomer();
  const docId = (await addDoc(c.code)).body.data.id;

  const inReview = await decide(docId, 'In Review');
  assert.equal(inReview.status, 201);
  const rejected = await decide(docId, 'Rejected', 'Name does not match');
  assert.equal(rejected.status, 201);
  const verified = await decide(docId, 'Verified', 'Corrected copy accepted', reviewer2);
  assert.equal(verified.status, 201);
  assert.equal(verified.body.data.reviewer.id, reviewer2.id);

  const history = (await api('GET', `/documents/${docId}/verifications`)).body.data;
  assert.deepEqual(history.items.map((v) => v.status), ['Verified', 'Rejected', 'In Review', 'Pending']); // newest first, nothing overwritten
  assert.equal(history.items.find((v) => v.status === 'Rejected').remarks, 'Name does not match');
  assert.equal(history.currentStatus, 'Verified');

  const doc = (await api('GET', `/documents/${docId}`)).body.data;
  assert.equal(doc.status, 'Verified');
  assert.equal(doc.currentVerification.id, verified.body.data.id);
  // The stored Document.status always equals the newest verification row.
  const newest = await prisma.verification.findFirst({ where: { documentId: docId }, orderBy: { id: 'desc' } });
  assert.equal((await prisma.document.findUnique({ where: { id: docId } })).status, newest.status);
});

test('rejects invalid verification status values and missing remarks', async () => {
  const c = await newCustomer();
  const docId = (await addDoc(c.code)).body.data.id;
  for (const status of ['Approved', 'verified', '', 'Expired', 'Pending']) {
    const res = await decide(docId, status);
    assert.equal(res.status, 400, `status "${status}"`);
    assert.ok(res.body.error.details.status);
  }
  const noRemarks = await decide(docId, 'Rejected', '');
  assert.equal(noRemarks.status, 400);
  assert.ok(noRemarks.body.error.details.remarks);
  assert.equal((await decide(docId, 'Requires Resubmission', '   ')).status, 400);
  // nothing was recorded by any rejected attempt
  assert.equal((await prisma.verification.count({ where: { documentId: docId } })), 1);
});

test('only authorised reviewers can record decisions (API and database)', async () => {
  const c = await newCustomer();
  const docId = (await addDoc(c.code)).body.data.id;

  assert.equal((await api('POST', `/documents/${docId}/verifications`, { status: 'Verified' })).status, 401); // nobody chosen
  assert.equal((await api('POST', `/documents/${docId}/verifications`, { status: 'Verified' }, { 'x-reviewer-id': '99999999' })).status, 401);
  assert.equal((await api('POST', `/documents/${docId}/verifications`, { status: 'Verified' }, as(inactive))).status, 401);
  const forbidden = await decide(docId, 'Verified', 'ok', analyst);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.body.error.code, 'NOT_AUTHORISED');
  assert.equal((await prisma.document.findUnique({ where: { id: docId } })).status, 'Pending');

  // The database refuses too, even if the API check were bypassed.
  await assert.rejects(prisma.verification.create({ data: { documentId: docId, reviewerId: analyst.id, status: 'Verified' } }));
  await assert.rejects(prisma.verification.create({ data: { documentId: docId, reviewerId: inactive.id, status: 'Verified' } }));
  await assert.rejects(prisma.verification.create({ data: { documentId: docId, status: 'Verified' } })); // decisions need a reviewer
});

test('verification history is immutable and status cannot be edited directly', async () => {
  const c = await newCustomer();
  const docId = (await addDoc(c.code)).body.data.id;
  await decide(docId, 'Verified', 'ok');
  const row = await prisma.verification.findFirst({ where: { documentId: docId, status: 'Verified' } });
  await assert.rejects(prisma.verification.update({ where: { id: row.id }, data: { status: 'Rejected', remarks: 'rewritten' } }));
  await assert.rejects(prisma.verification.delete({ where: { id: row.id } }));
  await assert.rejects(prisma.document.update({ where: { id: docId }, data: { status: 'Rejected' } })); // only a Verification insert changes status
  await assert.rejects(prisma.document.update({ where: { id: docId }, data: { status: 'Bogus' } }));
  assert.equal((await prisma.verification.findUnique({ where: { id: row.id } })).status, 'Verified');
});

test('a decision identical to the current status is a 409, and simultaneous identical decisions record one', async () => {
  const c = await newCustomer();
  const docId = (await addDoc(c.code)).body.data.id;
  const results = await Promise.all(Array.from({ length: 5 }, () => decide(docId, 'Verified', 'ok')));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 4);
  assert.equal(await prisma.verification.count({ where: { documentId: docId, status: 'Verified' } }), 1);
});

test('an expired document cannot be verified, but can be rejected', async () => {
  const c = await newCustomer();
  const doc = await insertVerifiedDoc(c.code, 'Address Proof', { expiryDate: addDays(TODAY, -3), status: 'Pending' });
  const blocked = await decide(doc.id, 'Verified', 'ok');
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error.code, 'DOCUMENT_EXPIRED');
  assert.equal((await decide(doc.id, 'Rejected', 'expired copy')).status, 201);
});

// ---- completeness and exceptions ---------------------------------------------------------------------------------
test('identifies missing mandatory documents (0%, Not Started) and lists them as exceptions', async () => {
  const c = await newCustomer();
  const k = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  assert.equal(k.customer.customerId, c.code);
  assert.ok(k.totals.mandatory >= 3);
  assert.equal(k.totals.missing, k.totals.mandatory);
  assert.equal(k.percentage, 0);
  assert.equal(k.status, 'Not Started');
  assert.match(k.disclaimer, /simulated manual review/i);

  const ex = (await api('GET', `/kyc/exceptions?search=${c.code}&type=MISSING_DOCUMENT&pageSize=100`)).body;
  assert.equal(ex.pagination.totalItems, k.totals.mandatory);
  assert.ok(ex.data.every((e) => e.customerId === c.code && e.type === 'MISSING_DOCUMENT'));
});

test('calculates completeness from verified mandatory documents only', async () => {
  const c = await newCustomer();
  const k0 = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  const mandatory = k0.requirements.filter((r) => r.isMandatory).map((r) => r.documentType);
  const n = mandatory.length;

  // Submit all; verify the first, leave the second pending, reject the third, leave the rest missing.
  const ids = [];
  for (const type of mandatory.slice(0, 3)) {
    const needsNumber = type !== 'Photograph';
    const res = await addDoc(c.code, { documentType: type, documentNumber: needsNumber ? `SYN-${rnd(6)}` : undefined });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    ids.push(res.body.data.id);
  }
  await decide(ids[0], 'Verified', 'ok');
  await decide(ids[2], 'Rejected', 'blurred');

  const k = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  assert.equal(k.totals.verified, 1);
  assert.equal(k.totals.pendingVerification, 1);
  assert.equal(k.totals.rejected, 1);
  assert.equal(k.totals.missing, n - 3);
  assert.equal(k.percentage, Math.round((1 / n) * 1000) / 10);
  assert.equal(k.status, 'Partially Complete');

  // Verify everything else: 100% Complete.
  await decide(ids[1], 'Verified', 'ok');
  await decide(ids[2], 'Requires Resubmission', 'send again');
  const rest = [];
  for (const type of mandatory.slice(3)) {
    const res = await addDoc(c.code, { documentType: type, documentNumber: type === 'Photograph' ? undefined : `SYN-${rnd(6)}` });
    rest.push(res.body.data.id);
    await decide(res.body.data.id, 'Verified', 'ok');
  }
  const fixed = await addDoc(c.code, { documentType: mandatory[2], documentNumber: mandatory[2] === 'Photograph' ? undefined : `SYN-${rnd(6)}`, submissionDate: TODAY });
  assert.equal(fixed.status, 201, JSON.stringify(fixed.body));
  await decide(fixed.body.data.id, 'Verified', 'ok');
  const done = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  assert.equal(done.percentage, 100);
  assert.equal(done.status, 'Complete');
  assert.equal(done.totals.verified, n);
  const t = done.totals;
  assert.equal(t.verified + t.missing + t.pendingVerification + t.rejected + t.requiresResubmission + t.expired, t.mandatory);
});

test('an expired document does not count as valid even though its status is Verified', async () => {
  const c = await newCustomer();
  const k0 = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  const type = k0.requirements.find((r) => r.documentType === 'Address Proof').documentType;
  const doc = await insertVerifiedDoc(c.code, type, { expiryDate: addDays(TODAY, -1) });

  const detail = (await api('GET', `/documents/${doc.id}`)).body.data;
  assert.equal(detail.status, 'Verified');
  assert.equal(detail.effectiveStatus, 'Expired');
  assert.equal(detail.expiryState, 'Expired');

  const k = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  assert.equal(k.totals.verified, 0);
  assert.equal(k.totals.expired, 1);
  assert.equal(k.requirements.find((r) => r.documentType === type).state, 'Expired');
  assert.equal(k.percentage, 0);

  const ex = (await api('GET', `/kyc/exceptions?search=${c.code}&type=EXPIRED`)).body;
  assert.equal(ex.pagination.totalItems, 1);
  const list = (await api('GET', `/documents?customerId=${c.code}&expiry=Expired`)).body;
  assert.equal(list.pagination.totalItems, 1);
});

test('identifies documents expiring within 30 days: still verified, flagged, and listed', async () => {
  const c = await newCustomer();
  const k0 = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  const type = k0.requirements.find((r) => r.documentType === 'Address Proof').documentType;
  const soon = await insertVerifiedDoc(c.code, type, { expiryDate: addDays(TODAY, 12) });

  const k = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  const row = k.requirements.find((r) => r.documentType === type);
  assert.equal(row.state, 'Verified');
  assert.equal(row.expiringSoon, true);
  assert.equal(row.document.daysToExpiry, 12);
  assert.equal(k.totals.verified, 1);
  assert.equal(k.totals.expiringSoon, 1);

  assert.equal((await api('GET', `/kyc/exceptions?search=${c.code}&type=EXPIRING_SOON`)).body.pagination.totalItems, 1);
  const filtered = (await api('GET', `/documents?customerId=${c.code}&expiry=Expiring%20Soon`)).body;
  assert.deepEqual(filtered.data.map((d) => d.id), [soon.id]);
  assert.equal((await api('GET', `/documents?customerId=${c.code}&expiry=Valid`)).body.pagination.totalItems, 0);
});

test('exceptions endpoint reports pending, rejected and resubmission and supports filters and pagination', async () => {
  const c = await newCustomer();
  const types = ['PAN', 'Address Proof', 'Photograph'];
  const ids = [];
  for (const t of types) ids.push((await addDoc(c.code, { documentType: t, documentNumber: t === 'Photograph' ? undefined : `SYN-${rnd(6)}` })).body.data.id);
  await decide(ids[1], 'Rejected', 'blurred');
  await decide(ids[2], 'Requires Resubmission', 'cropped');

  const all = (await api('GET', `/kyc/exceptions?search=${c.code}&pageSize=100`)).body;
  const kinds = new Set(all.data.map((e) => e.type));
  for (const kind of ['PENDING_VERIFICATION', 'REJECTED', 'REQUIRES_RESUBMISSION']) assert.ok(kinds.has(kind), kind);
  assert.ok(all.summary.byType.REJECTED >= 1);
  assert.ok(all.summary.submittedNotVerified >= 3);
  const paged = (await api('GET', `/kyc/exceptions?search=${c.code}&pageSize=1&page=2`)).body;
  assert.equal(paged.data.length, 1);
  assert.equal(paged.pagination.page, 2);
  assert.equal((await api('GET', '/kyc/exceptions?type=NOPE')).status, 400);
});

// ---- lists, details, edits ------------------------------------------------------------------------------------------
test('lists documents with search, status filter and pagination; customer documents endpoint', async () => {
  const c = await newCustomer({ fullName: `Zorblax${rnd(5)} Tester` });
  const a = (await addDoc(c.code, { documentType: 'PAN' })).body.data;
  const b = (await addDoc(c.code, { documentType: 'Address Proof' })).body.data;
  await decide(b.id, 'Verified', 'ok');

  const byCustomer = (await api('GET', `/documents?search=${c.code.toLowerCase()}`)).body;
  assert.equal(byCustomer.pagination.totalItems, 2);
  assert.equal((await api('GET', `/documents?search=address&customerId=${c.code}`)).body.pagination.totalItems, 1);
  const verifiedOnly = (await api('GET', `/documents?customerId=${c.code}&status=Verified`)).body;
  assert.deepEqual(verifiedOnly.data.map((d) => d.id), [b.id]);
  assert.equal((await api('GET', `/documents?customerId=${c.code}&status=Pending`)).body.data[0].id, a.id);
  assert.equal((await api('GET', `/documents?customerId=${c.code}&pageSize=1&page=2`)).body.data.length, 1);
  assert.equal((await api('GET', '/documents?status=Bogus')).status, 400);
  assert.equal((await api('GET', '/documents?search=%25')).status, 200); // wildcard typed by a user is plain text

  const mine = (await api('GET', `/customers/${c.code}/documents`)).body.data;
  assert.equal(mine.items.length, 2);
  assert.equal(mine.customer.customerId, c.code);
  assert.equal((await api('GET', '/customers/CUS-999999/documents')).status, 404);
  assert.equal((await api('GET', '/documents/999999999')).status, 404);
  assert.equal((await api('GET', '/documents/abc')).status, 400);
});

test('editing: notes keep the status, changing the expiry date resets to Pending and keeps history', async () => {
  const c = await newCustomer();
  const created = (await addDoc(c.code, { documentType: 'Address Proof', expiryDate: addDays(TODAY, 200) })).body.data;
  await decide(created.id, 'Verified', 'ok');
  const same = { documentType: 'Address Proof', issueDate: created.issueDate, expiryDate: created.expiryDate, submissionDate: created.submissionDate };

  const notesOnly = await api('PUT', `/documents/${created.id}`, { ...same, notes: 'updated note' });
  assert.equal(notesOnly.status, 200, JSON.stringify(notesOnly.body));
  assert.equal(notesOnly.body.data.status, 'Verified');
  assert.equal(notesOnly.body.data.notes, 'updated note');

  const changed = await api('PUT', `/documents/${created.id}`, { ...same, expiryDate: addDays(TODAY, 300), notes: 'new expiry' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.data.status, 'Pending');
  assert.equal(changed.body.data.expiryDate, addDays(TODAY, 300));
  const statuses = changed.body.data.verifications.map((v) => v.status);
  assert.deepEqual(statuses, ['Pending', 'Verified', 'Pending']); // the earlier decision is still there
  assert.match(changed.body.data.verifications[0].remarks, /Re-verification required/);

  assert.equal((await api('PUT', `/documents/${created.id}`, { ...same, issueDate: 'bad' })).status, 400);
  assert.equal((await api('PUT', '/documents/999999999', same)).status, 404);
});

test('file uploads: download works, and unsafe files are rejected', async () => {
  const c = await newCustomer();
  const body = '%PDF-1.4\n% bytes that must come back unchanged\n%%EOF';
  const form = new FormData();
  Object.entries(docPayload(c.code)).forEach(([k, v]) => form.append(k, v));
  form.append('file', new Blob([body], { type: 'application/pdf' }), '../../evil name.pdf');
  const created = await api('POST', '/documents', form);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const d = created.body.data;
  assert.equal(d.file.mimeType, 'application/pdf');
  assert.ok(!d.file.name.includes('..') && !d.file.name.includes('/'));

  // The database holds only a generated reference, never the file or its original path.
  const row = await prisma.document.findUnique({ where: { id: d.id } });
  assert.match(row.fileReference, /^[a-f0-9]{32}\.pdf$/);
  assert.ok(fs.existsSync(path.join(uploadDir, row.fileReference)));

  const dl = await api('GET', `/documents/${d.id}/file`);
  assert.equal(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(dl.body.toString(), body);
  assert.equal((await api('GET', `/documents/${(await addDoc(c.code, { documentType: 'Address Proof' })).body.data.id}/file`)).status, 404); // no file

  const attempt = async (blob, name) => {
    const f = new FormData();
    Object.entries(docPayload(c.code, { documentType: 'Bank Statement', documentNumber: `SYN-${rnd(6)}` })).forEach(([k, v]) => f.append(k, v));
    f.append('file', blob, name);
    return api('POST', '/documents', f);
  };
  assert.equal((await attempt(new Blob(['MZ fake program'], { type: 'application/pdf' }), 'invoice.pdf')).status, 400); // content is not a PDF
  assert.equal((await attempt(new Blob(['hello'], { type: 'text/plain' }), 'notes.txt')).status, 400); // wrong type
  assert.equal((await attempt(new Blob(['%PDF-1.4 x'], { type: 'application/x-msdownload' }), 'run.exe')).status, 400);
  const big = await attempt(new Blob(['%PDF-1.4\n', Buffer.alloc(2 * 1024 * 1024 + 10)], { type: 'application/pdf' }), 'big.pdf');
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'FILE_TOO_LARGE');
  // A rejected upload leaves no document and no stray file behind.
  assert.equal(await prisma.document.count({ where: { customer: { customerCode: c.code }, documentType: 'Bank Statement' } }), 0);
});

test('database constraints reject impossible document rows', async () => {
  const c = await newCustomer();
  const customer = await prisma.customer.findUnique({ where: { customerCode: c.code } });
  const base = { customerId: customer.id, documentType: 'PAN', issueDate: new Date('2025-01-10'), submissionDate: new Date('2025-01-11') };
  await assert.rejects(prisma.document.create({ data: { ...base, expiryDate: new Date('2024-01-01') } })); // expiry before issue
  await assert.rejects(prisma.document.create({ data: { ...base, submissionDate: new Date('2025-01-01') } })); // submitted before issue
  await assert.rejects(prisma.document.create({ data: { ...base, fileReference: 'abc.pdf' } })); // incomplete file metadata
  await assert.rejects(prisma.document.create({ data: { ...base, documentNumber: 'x' } })); // number without hash
  await assert.rejects(prisma.verification.create({ data: { documentId: 99999999, status: 'Pending' } })); // unknown document
  const ok = await prisma.document.create({ data: base });
  await assert.rejects(prisma.document.update({ where: { id: ok.id }, data: { customerId: customer.id + 99999 } })); // cannot move to another customer
});

// ---- requirements ---------------------------------------------------------------------------------------------------------
test('requirements: list and filter the sample rules', async () => {
  const all = (await api('GET', '/kyc-requirements')).body.data;
  assert.ok(all.length >= 22);
  const indHigh = (await api('GET', '/kyc-requirements?customerType=Individual&riskLevel=High&isActive=true')).body.data;
  assert.deepEqual(indHigh.map((r) => r.documentType).sort(), ['Additional Evidence', 'Address Proof', 'Bank Statement', 'PAN', 'Photograph']);
  assert.ok(indHigh.every((r) => r.isMandatory && r.inEffect));
  assert.equal((await api('GET', '/kyc-requirements?riskLevel=Extreme')).status, 400);
  const types = (await api('GET', '/kyc-requirements/document-types')).body.data;
  assert.equal(types.find((t) => t.name === 'PAN').requiresNumber, true);
  assert.equal(types.find((t) => t.name === 'Photograph').requiresNumber, false);
});

test('requirements: create, edit, deactivate, validate and prevent overlaps', async () => {
  const body = { customerType: 'Company', riskLevel: 'High', documentType: 'QK Test Licence', isMandatory: true, effectiveFrom: '2026-01-01', effectiveTo: '2026-12-31', isActive: true };
  const created = await api('POST', '/kyc-requirements', body);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.data.id;
  requirementIds.add(id);
  assert.equal(created.body.data.customerType, 'Company');

  // Overlapping active rule for the same document is refused; a later non-overlapping one is fine.
  const overlap = await api('POST', '/kyc-requirements', { ...body, effectiveFrom: '2026-06-01', effectiveTo: null });
  assert.equal(overlap.status, 409);
  assert.equal(overlap.body.error.code, 'REQUIREMENT_OVERLAP');
  const later = await api('POST', '/kyc-requirements', { ...body, effectiveFrom: '2027-01-01', effectiveTo: null });
  assert.equal(later.status, 201);
  requirementIds.add(later.body.data.id);

  // Exact duplicate (same start date, inactive so no overlap check) hits the unique constraint.
  assert.equal((await api('POST', '/kyc-requirements', { ...body, isActive: false })).status, 409);

  // Validation
  const bad = await api('POST', '/kyc-requirements', { ...body, documentType: 'x', riskLevel: 'Extreme' });
  assert.equal(bad.status, 400);
  for (const f of ['documentType', 'riskLevel']) assert.ok(bad.body.error.details[f], f);
  const backwards = await api('POST', '/kyc-requirements', { ...body, effectiveFrom: '2026-05-01', effectiveTo: '2026-01-01' });
  assert.equal(backwards.status, 400);
  assert.ok(backwards.body.error.details.effectiveTo); // end date before start date

  // Edit
  const edited = await api('PUT', `/kyc-requirements/${id}`, { ...body, isMandatory: false, effectiveTo: '2026-09-30' });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.isMandatory, false);
  assert.equal(edited.body.data.effectiveTo, '2026-09-30');

  // Deactivate / activate
  const off = await api('PATCH', `/kyc-requirements/${id}/status`, { isActive: false });
  assert.equal(off.body.data.isActive, false);
  assert.equal(off.body.data.inEffect, false);
  assert.equal((await api('PATCH', `/kyc-requirements/${id}/status`, { isActive: true })).body.data.isActive, true);
  assert.equal((await api('PATCH', `/kyc-requirements/${id}/status`, { isActive: 'maybe' })).status, 400);
  assert.equal((await api('PATCH', '/kyc-requirements/999999999/status', { isActive: true })).status, 404);
  assert.equal((await api('PUT', '/kyc-requirements/999999999', body)).status, 404);
});

test('a deactivated requirement stops affecting completeness', async () => {
  // A temporary rule for Individual / Low / "Photograph" would clash with the sample one, so use a custom document type.
  const created = await api('POST', '/kyc-requirements', { customerType: 'Individual', riskLevel: 'Low', documentType: 'QK Custom Evidence', isMandatory: true, effectiveFrom: '2026-01-01', isActive: true });
  assert.equal(created.status, 201);
  requirementIds.add(created.body.data.id);
  const c = await newCustomer();
  if (c.riskLevel !== 'Low') return; // the risk level of a new customer comes from the Scene 1 rules; only Low customers see this rule
  const before = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  assert.ok(before.requirements.some((r) => r.documentType === 'QK Custom Evidence'));
  await api('PATCH', `/kyc-requirements/${created.body.data.id}/status`, { isActive: false });
  const after = (await api('GET', `/customers/${c.code}/kyc-completeness`)).body.data;
  assert.ok(!after.requirements.some((r) => r.documentType === 'QK Custom Evidence'));
  assert.equal(after.totals.mandatory, before.totals.mandatory - 1);
});

// ---- Scene 1 still works ----------------------------------------------------------------------------------------------------
test('Scene 1 endpoints and totals are unaffected', async () => {
  const c = await newCustomer();
  const profile = await api('GET', `/customers/${c.code}`);
  assert.equal(profile.status, 200);
  assert.equal(profile.body.data.customerId, c.code);
  assert.ok(profile.body.data.currentRisk.reasons.length > 0);
  assert.equal((await api('GET', `/customers?search=${c.code}`)).body.pagination.totalItems, 1);
  const summary = (await api('GET', '/dashboard/summary')).body.data;
  assert.equal(summary.lowRiskCustomers + summary.mediumRiskCustomers + summary.highRiskCustomers, summary.totalCustomers);
  assert.equal((await api('GET', '/meta')).status, 200);
});
