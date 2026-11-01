/**
 * Phase 6, item 2: the name printed on a document versus the customer's registered legal name.
 * Runs against the dedicated TEST database (npm test). Everything created is removed afterwards (history tables are insert-only, so
 * cleanup uses the explicit maintenance switch SET LOCAL app.allow_history_delete).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearkyc-names-'));
process.env.UPLOAD_DIR = uploadDir;
const app = require('../src/app');
const prisma = require('../src/utils/prisma');
const { compareNames, nameCheck } = require('../src/utils/nameMatching');
const detectorMatcher = require('../../detector/nameMatcher');
const { CHECKS } = require('../src/services/dataQualityChecks');
const { addDays, todayIso } = require('../src/utils/dates');

const TODAY = todayIso();
let server;
let base;
let reviewer;
const created = new Set();
const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const letter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  reviewer = (await (await fetch(`${base}/reviewers`)).json()).data.find((p) => p.role === 'Reviewer');
});

test.after(async () => {
  const codes = [...created];
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id IN (SELECT id FROM "Customer" WHERE customer_id = ANY(${codes}::text[]))`,
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

const newPerson = async (fullName) => {
  const res = await api('POST', '/customers', {
    customerType: 'Individual', fullName, dateOfBirth: '1988-03-04', email: 'name.person@example.com', phone: '9812345678', address: '5 Test Lane, Pune',
    panNumber: `NAMP${letter()}${rnd(4)}${letter()}`, aadhaarNumber: `9${rnd(11)}`, occupation: 'Engineer', country: 'IN',
  });
  assert.equal(res.status, 201, res.text);
  created.add(res.body.data.customerId);
  return res.body.data.customerId;
};
const upload = async (code, fields = {}) => {
  const form = new FormData();
  const all = { customerId: code, documentType: 'Photograph', issueDate: addDays(TODAY, -100), submissionDate: addDays(TODAY, -5), ...fields };
  for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null) form.append(k, v);
  form.append('file', new Blob(['%PDF-1.4\n% synthetic\n%%EOF'], { type: 'application/pdf' }), 'doc.pdf');
  return api('POST', '/documents', form);
};
const mismatchEvents = (documentId) => prisma.auditEvent.findMany({ where: { actionType: 'DOCUMENT_NAME_MISMATCH_FLAGGED', entityId: documentId } });

// ---------------------------------------------------------------------------------------------------------------------------
test('matching rules: exact, case, whitespace, punctuation, titles, order, initials, company suffixes and genuine mismatches', () => {
  const same = (a, b, kind, opts) => {
    const r = compareNames(a, b, opts);
    assert.equal(r.match, true, `${a} ~ ${b}`);
    if (kind) assert.equal(r.kind, kind, `${a} ~ ${b}`);
  };
  const different = (a, b, opts) => assert.equal(compareNames(a, b, opts).match, false, `${a} !~ ${b}`);

  same('Amit Sharma', 'Amit Sharma', 'EXACT');
  same('Amit Sharma', 'AMIT SHARMA', 'NORMALIZED');
  same('Amit Sharma', 'amit sharma', 'NORMALIZED');
  same('Amit Sharma', '  Amit    Sharma  ', 'NORMALIZED');
  same('Amit Sharma', 'Amit\tSharma\n', 'NORMALIZED');
  same('Amit Sharma', 'Sharma, Amit', 'NORMALIZED');
  same('Amit Sharma', 'Shri Amit Sharma', 'NORMALIZED');
  same('Amit Sharma', 'A. Sharma', 'INITIALS');
  same('Amit Kumar Sharma', 'Amit Sharma');
  same('Amit Sharma', 'Amit Sharmaa', 'SIMILAR');
  same('Zoë Müller', 'Zoe Muller');
  same('Tata Consultancy Services Private Limited', 'TATA CONSULTANCY SERVICES PVT LTD', 'NORMALIZED', { isCompany: true });
  same('Acme Traders Pvt. Ltd.', 'Acme Traders', 'NORMALIZED', { isCompany: true });

  different('Amit Sharma', 'Rohan Verma');
  different('Amit Sharma', 'Amit Singh');
  different('Amit Sharma', 'Sunita Sharma');
  different('Amit Sharma', '');
  different('A. S.', 'Rahul Kumar');
  different('Acme Traders Pvt Ltd', 'Zenith Exports Pvt Ltd', { isCompany: true });
});

test('nameCheck: Match / Mismatch / Not recorded (a missing name is never a mismatch)', () => {
  assert.equal(nameCheck({ registeredName: 'Amit Sharma', nameOnDocument: 'AMIT  SHARMA' }).status, 'Match');
  const bad = nameCheck({ registeredName: 'Amit Sharma', nameOnDocument: 'Rohan Verma' });
  assert.equal(bad.status, 'Mismatch');
  assert.match(bad.message, /not rejected automatically/);
  for (const blank of [null, undefined, '', '   ']) assert.equal(nameCheck({ registeredName: 'Amit Sharma', nameOnDocument: blank }).status, 'Not recorded');
});

test('parity: the application matcher and the independent Phase 3 detector matcher agree on the same cases', () => {
  const pairs = [
    ['Amit Sharma', 'Amit Sharma', false], ['Amit Sharma', 'AMIT SHARMA', false], ['Amit Sharma', ' Amit  Sharma ', false], ['Amit Sharma', 'Sharma Amit', false],
    ['Amit Sharma', 'Mr Amit Sharma', false], ['Amit Kumar Sharma', 'A K Sharma', false], ['Amit Sharma', 'A. Sharma', false], ['Amit Sharma', 'Amit Sharmaa', false],
    ['Amit Sharma', 'Rohan Verma', false], ['Amit Sharma', 'Sunita Sharma', false], ['Priya Nair', 'Priya Menon', false], ['Meera Iyer', 'Meera Iyer-Rao', false],
    ['Acme Traders Private Limited', 'ACME TRADERS PVT LTD', true], ['Acme Traders Pvt Ltd', 'Zenith Exports Pvt Ltd', true], ['Acme Traders LLP', 'Acme Traders', true],
  ];
  for (const [a, b, isCompany] of pairs) {
    const mine = compareNames(a, b, { isCompany });
    const theirs = detectorMatcher.compareNames(a, b, { isCompany });
    assert.equal(mine.match, theirs.match, `${a} / ${b}`);
    assert.equal(mine.kind, theirs.kind, `${a} / ${b}`);
  }
});

test('parity on every harmless variant the dataset generator produces, and on swapped-in other names', () => {
  const { personName, companyName } = require('../../generator/utils/nameVariants');
  const people = ['Amit Sharma', 'Priya Nair Menon', 'Rohan Verma', 'Sunita Deshmukh', 'Neha Kulkarni'];
  const companies = ['Acme Traders Pvt Ltd', 'Zenith Exports Ltd', 'Blue Harbour Logistics LLP', 'Kaveri Foods Pvt Ltd'];
  const kinds = ['exact', 'upper', 'title', 'initial', 'reversed', 'spacing', 'typo', 'middle', 'long', 'dots'];
  let compared = 0;
  for (const kind of kinds) {
    // a stand-in random source that always picks the same option, so every kind of variant is produced once per name
    const r = { weighted: (list) => (list.find(([k]) => k === kind) ?? list[0])[0], pick: (a) => a[0], int: (a) => a };
    const cases = [...people.map((n) => [n, personName(n, r), false]), ...companies.map((n) => [n, companyName(n, r), true])];
    for (const [registered, printed, isCompany] of cases) {
      const mine = compareNames(registered, printed, { isCompany });
      const theirs = detectorMatcher.compareNames(registered, printed, { isCompany });
      assert.equal(mine.match, theirs.match, `${kind}: ${registered} / ${printed}`);
      assert.equal(mine.kind, theirs.kind, `${kind}: ${registered} / ${printed}`);
      assert.equal(mine.match, true, `a harmless ${kind} variant is not a mismatch: ${registered} / ${printed}`);
      compared += 1;
    }
  }
  assert.ok(compared >= 90);
  for (const a of people) for (const b of people) {
    if (a !== b) assert.equal(compareNames(a, b).match, detectorMatcher.compareNames(a, b).match, `${a} / ${b}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------
test('API: exact, case-different and whitespace-different names are a match and raise nothing', async () => {
  const code = await newPerson('Neha Kulkarni');
  for (const [name, kind] of [['Neha Kulkarni', 'EXACT'], ['NEHA KULKARNI', 'NORMALIZED'], ['  neha   kulkarni  ', 'NORMALIZED']]) {
    const res = await upload(code, { nameOnDocument: name, notes: `case ${name.length}` });
    assert.equal(res.status, 201, res.text);
    const d = res.body.data;
    assert.equal(d.nameCheck.status, 'Match', name);
    assert.equal(d.nameCheck.kind, kind, name);
    assert.equal(d.nameOnDocument, name.trim());
    assert.equal(d.status, 'Pending');
    assert.equal((await mismatchEvents(d.id)).length, 0);
  }
});

test('API: a genuine mismatch is flagged and audited, and the document is NOT rejected', async () => {
  const code = await newPerson('Neha Kulkarni');
  const res = await upload(code, { nameOnDocument: 'Pooja Deshmukh' });
  assert.equal(res.status, 201, res.text);
  const d = res.body.data;
  assert.equal(d.nameCheck.status, 'Mismatch');
  assert.equal(d.nameCheck.registeredName, 'Neha Kulkarni');
  assert.equal(d.nameCheck.nameOnDocument, 'Pooja Deshmukh');
  assert.equal(d.status, 'Pending', 'flagged, not rejected');
  assert.equal(d.effectiveStatus, 'Pending');
  const events = await mismatchEvents(d.id);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].newValues.nameOnDocument, 'Pooja Deshmukh');

  // it shows in the document list, the customer's document list and the details
  const list = (await api('GET', `/documents?customerId=${code}`)).body.data.find((x) => x.id === d.id);
  assert.equal(list.nameCheck.status, 'Mismatch');
  assert.equal((await api('GET', `/customers/${code}/documents`)).body.data.items.find((x) => x.id === d.id).nameCheck.status, 'Mismatch');
  assert.equal((await api('GET', `/documents/${d.id}`)).body.data.nameCheck.status, 'Mismatch');

  // a reviewer can still verify it (the flag informs the decision, it does not make it)
  assert.equal((await api('POST', `/documents/${d.id}/verifications`, { status: 'Verified', remarks: 'Name change confirmed with the customer' }, reviewer)).status, 201);
  assert.equal((await api('GET', `/documents/${d.id}`)).body.data.status, 'Verified');

  // the data quality check lists it
  const check = CHECKS.find((c) => c.code === 'DOC_NAME_MATCHES_CUSTOMER');
  assert.equal(check.severity, 'Warning');
  const violations = await check.run({ db: prisma });
  const mine = violations.filter((x) => x.customerId === d.customer.id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].entityId, d.id);
});

test('API: not recorded is allowed; editing the name re-checks, re-opens verification and audits only a new mismatch', async () => {
  const code = await newPerson('Neha Kulkarni');
  const first = (await upload(code)).body.data;
  assert.equal(first.nameCheck.status, 'Not recorded');
  assert.equal(first.nameOnDocument, null);

  const put = (fields) => {
    const form = new FormData();
    const all = { documentType: 'Photograph', issueDate: first.issueDate, submissionDate: first.submissionDate, ...fields };
    for (const [k, v] of Object.entries(all)) if (v !== undefined && v !== null) form.append(k, v);
    return api('PUT', `/documents/${first.id}`, form);
  };
  assert.equal((await api('POST', `/documents/${first.id}/verifications`, { status: 'Verified', remarks: 'ok' }, reviewer)).status, 201);

  const bad = await put({ nameOnDocument: 'Someone Else' });
  assert.equal(bad.status, 200, bad.text);
  assert.equal(bad.body.data.nameCheck.status, 'Mismatch');
  assert.equal(bad.body.data.status, 'Pending', 'a changed name needs a new review');
  assert.equal((await mismatchEvents(first.id)).length, 1);

  assert.equal((await put({ nameOnDocument: 'Someone Else', notes: 'only notes changed' })).status, 200);
  assert.equal((await mismatchEvents(first.id)).length, 1, 'an unchanged mismatch is not logged again');

  const fixed = await put({ nameOnDocument: 'NEHA KULKARNI' });
  assert.equal(fixed.body.data.nameCheck.status, 'Match');
  assert.equal((await mismatchEvents(first.id)).length, 1);

  const kept = await put({}); // field absent: the stored name is kept
  assert.equal(kept.body.data.nameOnDocument, 'NEHA KULKARNI');
  const cleared = await put({ nameOnDocument: '' }); // blank: cleared
  assert.equal(cleared.body.data.nameCheck.status, 'Not recorded');
  assert.equal((await upload(code, { nameOnDocument: 'x'.repeat(201) })).status, 400, 'too long');
});

test('API: company names ignore legal-form differences', async () => {
  const res = await api('POST', '/customers', {
    customerType: 'Company', legalName: `Name Check Traders Private Limited ${rnd(3)}`, registrationNumber: `NC-${rnd(10)}`, panNumber: `NAMC${letter()}${rnd(4)}${letter()}`,
    email: 'ops@name-check.example.com', phone: '9812345678', address: '1 Test Park', country: 'IN', businessActivity: 'Information Technology', dateOfIncorporation: '2015-05-05',
  });
  assert.equal(res.status, 201, res.text);
  const code = res.body.data.customerId;
  created.add(code);
  const legal = res.body.data.name ?? res.body.data.legalName ?? res.body.data.fullName;
  const ok = await upload(code, { documentType: 'Business PAN', documentNumber: `SYN-${rnd(8)}`, nameOnDocument: legal.replace('Private Limited', 'PVT LTD').toUpperCase() });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.body.data.nameCheck.status, 'Match');
});
