/**
 * API integration tests. They run against the REAL database in DATABASE_URL, so start
 * `npm run db:local` first. Each test removes the customers it created; the dashboard test
 * compares before/after counts so existing data does not matter.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const app = require('../src/app');
const prisma = require('../src/utils/prisma');

let server;
let base;
const created = new Set(); // customer ids (CUS-...) to delete afterwards

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
});

test.after(async () => {
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    // Scene 5: customers write audit events; the ones the test created are removed with the customers
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id IN (SELECT id FROM "Customer" WHERE customer_id = ANY(${[...created]}::text[]))`,
    prisma.customer.deleteMany({ where: { customerCode: { in: [...created] } } }),
  ]);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

const api = async (method, path, body) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
};

// Synthetic, unique-per-call test identifiers (PAN prefix "QTE" is not used by the data generator).
const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const rndLetter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));

const individual = (over = {}) => ({
  customerType: 'Individual',
  fullName: 'Test Individual Synthetic',
  dateOfBirth: '1988-03-04',
  email: 'test.individual@example.com',
  phone: '9812345678',
  address: '5 Test Lane, Pune',
  panNumber: `QTEP${rndLetter()}${rnd(4)}${rndLetter()}`,
  aadhaarNumber: `9${rnd(11)}`,
  occupation: 'Engineer',
  country: 'IN',
  ...over,
});
const company = (over = {}) => ({
  customerType: 'Company',
  legalName: 'Test Company Synthetic Pvt Ltd',
  registrationNumber: `TEST-${rnd(10)}`,
  panNumber: `QTEC${rndLetter()}${rnd(4)}${rndLetter()}`,
  email: 'info@testco.example.com',
  phone: '+919812345678',
  address: '9 Test Park, Mumbai',
  country: 'IN',
  businessActivity: 'Information Technology',
  dateOfIncorporation: '2012-07-01',
  ...over,
});

const register = async (payload) => {
  const res = await api('POST', '/customers', payload);
  if (res.status === 201) created.add(res.body.data.customerId);
  return res;
};

test('registers an individual: generated CUS id, masked identifiers, stored risk with reasons', async () => {
  const payload = individual();
  const res = await register(payload);
  assert.equal(res.status, 201);
  const c = res.body.data;
  assert.match(c.customerId, /^CUS-\d{6}$/);
  assert.equal(c.customerType, 'Individual');
  assert.match(c.panMasked, /^X+\w{4}$/);
  assert.equal(c.aadhaarMasked, `XXXX XXXX ${payload.aadhaarNumber.slice(-4)}`);
  assert.ok(!JSON.stringify(res.body).includes(payload.panNumber), 'full PAN must never be returned');
  assert.ok(!JSON.stringify(res.body).includes(payload.aadhaarNumber), 'full Aadhaar must never be returned');
  assert.ok(c.currentRisk.reasons.length > 0);
  assert.ok(['Low', 'Medium', 'High'].includes(c.currentRisk.level));
  assert.equal(c.currentRisk.screening.simulated, true);
  assert.equal(c.registrationStatus, 'Registered');
});

test('database stores PAN and Aadhaar encrypted, not as plaintext', async () => {
  const payload = individual();
  const res = await register(payload);
  const row = await prisma.customer.findUnique({ where: { customerCode: res.body.data.customerId } });
  assert.ok(!row.panNumber.includes(payload.panNumber));
  assert.ok(!row.aadhaarNumber.includes(payload.aadhaarNumber));
});

test('registers a company with company-only fields', async () => {
  const res = await register(company());
  assert.equal(res.status, 201);
  const c = res.body.data;
  assert.equal(c.customerType, 'Company');
  assert.equal(c.aadhaarMasked, null);
  assert.equal(c.dateOfBirth, null);
  assert.equal(c.businessActivity, 'Information Technology');
});

test('rejects invalid input with per-field messages (400)', async () => {
  const res = await api('POST', '/customers', individual({ email: 'nope', panNumber: 'BAD', aadhaarNumber: '123', fullName: '' }));
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  for (const f of ['email', 'panNumber', 'aadhaarNumber', 'fullName']) assert.ok(res.body.error.details[f], f);

  const noType = await api('POST', '/customers', { fullName: 'x' });
  assert.equal(noType.status, 400);
});

test('duplicate PAN, Aadhaar and company registration number return 409', async () => {
  const first = individual();
  await register(first);
  const samePan = await register(individual({ panNumber: first.panNumber }));
  assert.equal(samePan.status, 409);
  assert.equal(samePan.body.error.code, 'DUPLICATE_CUSTOMER');
  assert.ok(samePan.body.error.details.panNumber);
  const sameAadhaar = await register(individual({ aadhaarNumber: first.aadhaarNumber }));
  assert.equal(sameAadhaar.status, 409);
  assert.ok(sameAadhaar.body.error.details.aadhaarNumber);

  const co = company();
  await register(co);
  const sameReg = await register(company({ registrationNumber: co.registrationNumber }));
  assert.equal(sameReg.status, 409);
  assert.ok(sameReg.body.error.details.registrationNumber);
});

test('simultaneous identical submissions create exactly one customer', async () => {
  const payload = individual();
  const results = await Promise.all(Array.from({ length: 5 }, () => register(payload)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 4);
});

test('parallel registrations all receive different Customer IDs', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => register(individual())));
  assert.ok(results.every((r) => r.status === 201));
  const ids = results.map((r) => r.body.data.customerId);
  assert.equal(new Set(ids).size, 12);
});

test('a Customer ID is never reused after the customer is deleted', async () => {
  const a = await register(individual());
  const idA = a.body.data.customerId;
  const rowA = await prisma.customer.findUnique({ where: { customerCode: idA } });
  await prisma.customer.delete({ where: { customerCode: idA } });
  // the audit trail outlives the customer (that is intended); this test removes the events it created itself
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id = ${rowA.id}`,
  ]);
  const b = await register(individual());
  assert.ok(Number(b.body.data.customerId.slice(4)) > Number(idA.slice(4)));
  assert.notEqual(b.body.data.customerId, idA);
});

test('risk is stored with reasons and potential PEP is flagged, not rejected', async () => {
  const res = await register(individual({ occupation: 'Politician / Elected Representative' }));
  assert.equal(res.status, 201);
  const risk = res.body.data.currentRisk;
  assert.equal(risk.requiresManualReview, true);
  assert.ok(risk.reasons.some((r) => r.simulated === true));
  const rows = await prisma.riskRating.findMany({ where: { customer: { customerCode: res.body.data.customerId } } });
  assert.equal(rows.length, 1);
  assert.ok(Array.isArray(rows[0].riskReasons.reasons));
});

test('GET /customers/:id returns profile by CUS id, 404 for unknown, 400 for malformed', async () => {
  const res = await register(individual());
  const id = res.body.data.customerId;
  const got = await api('GET', `/customers/${id}`);
  assert.equal(got.status, 200);
  assert.equal(got.body.data.customerId, id);
  assert.ok(got.body.data.currentRisk);
  assert.equal((await api('GET', '/customers/CUS-999999')).status, 404);
  assert.equal((await api('GET', '/customers/hello')).status, 400);
});

test('list: pagination, search by name and by ID, type and risk filters', async () => {
  const unique = `Zebulon${rnd(6)}`;
  const person = await register(individual({ fullName: `${unique} Person` }));
  const firm = await register(company({ legalName: `${unique} Holdings Ltd`, businessActivity: 'Casinos & Gaming', country: 'NG' }));
  const personId = person.body.data.customerId;

  const byName = await api('GET', `/customers?search=${unique}`);
  assert.equal(byName.body.pagination.totalItems, 2);

  const byId = await api('GET', `/customers?search=${personId.toLowerCase()}`);
  assert.deepEqual(byId.body.data.map((c) => c.customerId), [personId]);

  const onlyCompany = await api('GET', `/customers?search=${unique}&type=Company`);
  assert.deepEqual(onlyCompany.body.data.map((c) => c.customerId), [firm.body.data.customerId]);

  const level = firm.body.data.currentRisk.level;
  const byRisk = await api('GET', `/customers?search=${unique}&risk=${level}`);
  assert.ok(byRisk.body.data.some((c) => c.customerId === firm.body.data.customerId));
  assert.ok(byRisk.body.data.every((c) => c.riskLevel === level));

  const page1 = await api('GET', `/customers?search=${unique}&pageSize=1&page=1`);
  assert.equal(page1.body.data.length, 1);
  assert.equal(page1.body.pagination.totalPages, 2);

  // LIKE wildcards in the search box are treated as plain text.
  const wildcard = await api('GET', '/customers?search=%25');
  assert.equal(wildcard.status, 200);
  assert.ok(wildcard.body.data.every((c) => /%/.test(c.name + c.customerId)));

  assert.equal((await api('GET', '/customers?type=Bogus')).status, 400);
});

test('dashboard summary counts change with new records', async () => {
  const before = (await api('GET', '/dashboard/summary')).body.data;
  await register(individual());
  await register(company());
  const after = (await api('GET', '/dashboard/summary')).body.data;
  assert.equal(after.totalCustomers, before.totalCustomers + 2);
  assert.equal(after.individualCustomers, before.individualCustomers + 1);
  assert.equal(after.companyCustomers, before.companyCustomers + 1);
  assert.equal(after.lowRiskCustomers + after.mediumRiskCustomers + after.highRiskCustomers, after.totalCustomers);
});

test('database constraints reject bad rows even if the API is bypassed', async () => {
  const ok = await register(individual());
  const customer = await prisma.customer.findUnique({ where: { customerCode: ok.body.data.customerId } });

  // Invalid risk level / score
  await assert.rejects(prisma.riskRating.create({ data: { customerId: customer.id, riskScore: 10, riskLevel: 'Extreme', riskReasons: [], assessmentMethod: 'x' } }));
  await assert.rejects(prisma.riskRating.create({ data: { customerId: customer.id, riskScore: 500, riskLevel: 'High', riskReasons: [], assessmentMethod: 'x' } }));
  // RiskRating must reference a valid customer
  await assert.rejects(prisma.riskRating.create({ data: { customerId: 99999999, riskScore: 1, riskLevel: 'Low', riskReasons: [], assessmentMethod: 'x' } }));
  // Customer ID is immutable
  await assert.rejects(prisma.customer.update({ where: { id: customer.id }, data: { customerCode: 'CUS-777777' } }));
  // Company-only field on an individual violates the type CHECK
  await assert.rejects(prisma.customer.update({ where: { id: customer.id }, data: { businessActivity: 'Retail' } }));
});

test('unknown route returns a JSON 404 and /meta exposes the documented risk model', async () => {
  assert.equal((await api('GET', '/nope')).status, 404);
  const meta = (await api('GET', '/meta')).body.data;
  assert.ok(meta.countries.length > 5);
  assert.match(meta.riskModel.disclaimer, /not official regulatory rules/i);
});
