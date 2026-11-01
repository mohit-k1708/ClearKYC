/**
 * Phase 6, item 3: the same beneficial owner across companies.
 * Runs against the dedicated TEST database (npm test). Customers it creates are removed afterwards (with the maintenance switch for
 * the insert-only history tables).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const app = require('../src/app');
const prisma = require('../src/utils/prisma');

let server;
let base;
let analyst;
const created = new Set();
const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const letter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  analyst = (await (await fetch(`${base}/reviewers`)).json()).data.find((p) => p.role === 'Analyst');
});

test.after(async () => {
  const codes = [...created];
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id IN (SELECT id FROM "Customer" WHERE customer_id = ANY(${codes}::text[]))`,
    prisma.customer.deleteMany({ where: { customerCode: { in: codes } } }),
  ]);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function api(method, url, body, who) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(who ? { 'x-reviewer-id': String(who.id) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const company = async (label) => {
  const res = await api('POST', '/customers', {
    customerType: 'Company', legalName: `Person View ${label} ${rnd(5)} Pvt Ltd`, registrationNumber: `PV-${rnd(10)}`, panNumber: `PERC${letter()}${rnd(4)}${letter()}`,
    email: 'ops@person-view.example.com', phone: '9812345678', address: '1 Test Park', country: 'IN', businessActivity: 'Information Technology', dateOfIncorporation: '2015-05-05',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  created.add(res.body.data.customerId);
  return res.body.data;
};
const addOwner = async (code, over = {}) => {
  const res = await api('POST', `/customers/${code}/beneficial-owners`, {
    fullName: 'Kavita Personview', dateOfBirth: '1971-08-19', countryOfResidence: 'IN', nationality: 'IN', ownershipPercentage: 40, ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'No', notes: 'synthetic', ...over,
  }, analyst);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

test('a person who owns several companies: all of them, with percentage and relationship', async () => {
  const a = await company('Alpha');
  const b = await company('Beta');
  const c = await company('Gamma');
  const oa = await addOwner(a.customerId, { ownershipPercentage: 60, controlType: 'Shareholding' });
  const ob = await addOwner(b.customerId, { fullName: 'KAVITA  PERSONVIEW', ownershipPercentage: 25.5, ownershipType: 'Indirect', controlType: 'Voting rights', pepStatus: 'Yes' });
  await addOwner(c.customerId, { ownershipPercentage: 10, controlType: 'Right to appoint or remove directors' });
  await addOwner(c.customerId, { fullName: 'Someone Else', dateOfBirth: '1980-01-01', ownershipPercentage: 90 });

  const view = await api('GET', `/beneficial-owners/${oa.id}/person`);
  assert.equal(view.status, 200, JSON.stringify(view.body));
  const { person, companies, summary } = view.body.data;
  assert.match(person.personRef, /^PER-[0-9a-f]{12}$/);
  assert.equal(person.birthYear, 1971);
  assert.equal(person.recognisedAcrossCompanies, true);
  assert.equal(person.declaredPep, true, 'declared PEP in one company shows on the person');
  assert.equal(summary.companyCount, 3);
  assert.deepEqual(companies.map((x) => x.company.customerId).sort(), [a.customerId, b.customerId, c.customerId].sort());

  const byCode = Object.fromEntries(companies.map((x) => [x.company.customerId, x]));
  assert.equal(byCode[a.customerId].ownershipPercentage, 60);
  assert.equal(byCode[a.customerId].controlType, 'Shareholding');
  assert.equal(byCode[b.customerId].ownershipPercentage, 25.5);
  assert.equal(byCode[b.customerId].ownershipType, 'Indirect');
  assert.equal(byCode[b.customerId].controlType, 'Voting rights');
  assert.equal(byCode[c.customerId].controlType, 'Right to appoint or remove directors');
  assert.equal(byCode[c.customerId].ownershipPercentage, 10, 'a different person of the same company is not mixed in');
  assert.ok(companies.every((x) => x.company.name && x.effectiveFrom && x.effectiveTo === null && x.ownerId > 0));

  // the same answer from any owner record of the person, and from the reference
  assert.equal((await api('GET', `/beneficial-owners/${ob.id}/person`)).body.data.person.personRef, person.personRef);
  assert.deepEqual((await api('GET', `/people/${person.personRef}`)).body.data.summary, summary);
});

test('a person with one company: one entry; an owner without a date of birth is not guessed across companies', async () => {
  const solo = await company('Solo');
  const o = await addOwner(solo.customerId, { fullName: 'Ishaan Soloperson', dateOfBirth: '1990-02-02', ownershipPercentage: 100 });
  const one = (await api('GET', `/beneficial-owners/${o.id}/person`)).body.data;
  assert.equal(one.summary.companyCount, 1);
  assert.equal(one.companies[0].company.customerId, solo.customerId);
  assert.equal(one.companies[0].ownershipPercentage, 100);
  assert.deepEqual(one.formerCompanies, []);

  const other = await company('NoDob');
  const n1 = await addOwner(other.customerId, { fullName: 'Nodob Person', dateOfBirth: null, ownershipPercentage: 5 });
  const view = (await api('GET', `/beneficial-owners/${n1.id}/person`)).body.data;
  assert.match(view.person.personRef, /^OWN-\d{6}$/);
  assert.equal(view.person.recognisedAcrossCompanies, false);
  assert.equal(view.summary.companyCount, 1);
  assert.match(view.note, /No date of birth/);
});

test('the same name with a different date of birth is a different person', async () => {
  const a = await company('DobA');
  const b = await company('DobB');
  const oa = await addOwner(a.customerId, { fullName: 'Rekha Samename', dateOfBirth: '1965-03-03' });
  await addOwner(b.customerId, { fullName: 'Rekha Samename', dateOfBirth: '1992-09-09' });
  assert.equal((await api('GET', `/beneficial-owners/${oa.id}/person`)).body.data.summary.companyCount, 1);
});

test('errors: unknown owner 404, unknown or malformed reference 404/400, bad id 400', async () => {
  assert.equal((await api('GET', '/beneficial-owners/99999999/person')).status, 404);
  assert.equal((await api('GET', '/beneficial-owners/abc/person')).status, 400);
  assert.equal((await api('GET', '/people/PER-000000000000')).status, 404);
  assert.equal((await api('GET', '/people/not-a-ref')).status, 400);
});

test('nothing is duplicated: the view is read from the existing relationship rows and changes no data', async () => {
  const counts = () => prisma.$queryRaw`SELECT (SELECT count(*) FROM "BeneficialOwner")::int AS owners, (SELECT count(*) FROM "CompanyOwnership")::int AS links, (SELECT count(*) FROM "AuditEvent")::int AS audit`;
  const before = await counts();
  const some = await prisma.beneficialOwner.findFirst({ orderBy: { id: 'asc' } });
  assert.ok(some, 'the test database has owners');
  assert.equal((await api('GET', `/beneficial-owners/${some.id}/person`)).status, 200);
  assert.deepEqual(await counts(), before);
});

test('adding a date of birth later links the owner to the same person in other companies (and the view follows)', async () => {
  const a = await company('LateA');
  const b = await company('LateB');
  const full = { fullName: 'Latika Latelinker', countryOfResidence: 'IN', nationality: 'IN', ownershipPercentage: 30, ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'No', notes: 'synthetic' };
  await addOwner(a.customerId, { ...full, dateOfBirth: '1966-06-06' });
  const ob = await addOwner(b.customerId, { ...full, dateOfBirth: null });
  const before = (await api('GET', `/beneficial-owners/${ob.id}/person`)).body.data;
  assert.match(before.person.personRef, /^OWN-\d{6}$/);
  assert.equal(before.summary.companyCount, 1, 'without a date of birth the owner is not matched with anyone');

  const edited = await api('PUT', `/beneficial-owners/${ob.id}`, { ...full, dateOfBirth: '1966-06-06' }, analyst);
  assert.equal(edited.status, 200, JSON.stringify(edited.body));
  const after = (await api('GET', `/beneficial-owners/${ob.id}/person`)).body.data;
  assert.match(after.person.personRef, /^PER-[0-9a-f]{12}$/);
  assert.equal(after.summary.companyCount, 2, 'now recognised in both companies');
});
