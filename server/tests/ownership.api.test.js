/**
 * Scene 3 API integration tests. They use the REAL database (start `npm run db:local` first).
 * Everything they create (customers, owners, screenings, assessments, reviewers) is removed afterwards.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const app = require('../src/app');
const prisma = require('../src/utils/prisma');
const { addDays, todayIso } = require('../src/utils/dates');

let server;
let base;
const customerCodes = new Set();
const reviewerIds = new Set();
let reviewer; // Reviewer: may decide
let analyst; // Analyst: may enter ownership data but not decide
let inactive;

const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const letter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const make = async (role, isActive = true) => {
    const r = await prisma.reviewer.create({ data: { name: `Test ${role}`, email: `qo.${role.toLowerCase()}.${rnd(8)}@example.com`, role, isActive } });
    reviewerIds.add(r.id);
    return r;
  };
  reviewer = await make('Reviewer');
  analyst = await make('Analyst');
  inactive = await make('Reviewer', false);
});

test.after(async () => {
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    // Scene 5: the audit events the test created are removed with it (audit events are otherwise immutable)
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE customer_id IN (SELECT id FROM "Customer" WHERE customer_id = ANY(${[...customerCodes]}::text[])) OR user_id = ANY(${[...reviewerIds]}::int[])`,
    prisma.verification.deleteMany({ where: { OR: [{ document: { customer: { customerCode: { in: [...customerCodes] } } } }, { reviewerId: { in: [...reviewerIds] } }] } }),
    prisma.document.deleteMany({ where: { customer: { customerCode: { in: [...customerCodes] } } } }),
    prisma.customer.deleteMany({ where: { customerCode: { in: [...customerCodes] } } }), // cascades owners, screenings, ownership checks, ratings
    prisma.riskRating.deleteMany({ where: { assessedById: { in: [...reviewerIds] } } }),
    prisma.reviewer.deleteMany({ where: { id: { in: [...reviewerIds] } } }),
  ]);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

// ---- helpers ---------------------------------------------------------------------------------------------------
const api = async (method, url, body, headers = {}) => {
  const res = await fetch(base + url, { method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
};
const as = (r) => ({ 'x-reviewer-id': String(r.id) });

async function newCompany(over = {}) {
  const res = await api('POST', '/customers', {
    customerType: 'Company',
    legalName: `QO Test Company ${rnd(5)} Pvt Ltd`,
    registrationNumber: `QO-${rnd(10)}`,
    panNumber: `QOWC${letter()}${rnd(4)}${letter()}`,
    email: 'ops@qo-test.example.com',
    phone: '9812345678',
    address: '1 Test Park',
    country: 'IN',
    businessActivity: 'Information Technology',
    dateOfIncorporation: '2015-05-05',
    ...over,
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  customerCodes.add(res.body.data.customerId);
  return res.body.data.customerId;
}

async function newIndividual() {
  const res = await api('POST', '/customers', {
    customerType: 'Individual',
    fullName: 'QO Test Person',
    dateOfBirth: '1988-03-04',
    email: 'qo.person@example.com',
    phone: '9812345679',
    address: '5 Test Lane',
    panNumber: `QOWP${letter()}${rnd(4)}${letter()}`,
    aadhaarNumber: `9${rnd(11)}`,
    occupation: 'Engineer',
    country: 'IN',
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  customerCodes.add(res.body.data.customerId);
  return res.body.data.customerId;
}

const ownerBody = (over = {}) => ({
  fullName: `Owner ${rnd(6)} Tester`,
  dateOfBirth: '1975-04-12',
  countryOfResidence: 'IN',
  nationality: 'IN',
  ownershipPercentage: 50,
  ownershipType: 'Direct',
  controlType: 'Shareholding',
  pepStatus: 'No',
  notes: 'synthetic',
  ...over,
});
const addOwner = (code, over, who = analyst) => api('POST', `/customers/${code}/beneficial-owners`, ownerBody(over), as(who));
const validation = async (code) => (await api('GET', `/customers/${code}/ownership-validation`)).body.data;
const screen = (ownerId, body, who = reviewer) => api('POST', `/beneficial-owners/${ownerId}/screening`, body, as(who));
const assess = (code, body = {}, who = reviewer) => api('POST', `/customers/${code}/risk-assessments`, body, as(who));

// ---- beneficial owners ---------------------------------------------------------------------------------------------
test('adds beneficial owners to a company; the date of birth is encrypted and only the birth year is listed', async () => {
  const code = await newCompany();
  const body = ownerBody({ fullName: 'Person A Tester', ownershipPercentage: 50, dateOfBirth: '1971-08-23' });
  const res = await addOwner(code, body);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const o = res.body.data;
  assert.equal(o.fullName, 'Person A Tester');
  assert.equal(o.ownershipPercentage, 50);
  assert.equal(o.dateOfBirth, '1971-08-23'); // the owner's own detail view
  assert.equal(o.customer.customerId, code);

  const list = (await api('GET', `/customers/${code}/beneficial-owners`)).body.data;
  assert.equal(list.owners.length, 1);
  assert.equal(list.owners[0].birthYear, 1971);
  assert.ok(!('dateOfBirth' in list.owners[0]), 'lists never include the full date of birth');
  assert.ok(!JSON.stringify(list).includes('1971-08-23'));

  const row = await prisma.beneficialOwner.findUnique({ where: { id: o.id } });
  assert.ok(!row.dateOfBirth.includes('1971'), 'stored encrypted');
  assert.ok(row.createdById === analyst.id && row.updatedById === analyst.id);
});

test('beneficial owners cannot be added to an individual customer (API and database)', async () => {
  const ind = await newIndividual();
  const res = await addOwner(ind);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'NOT_A_COMPANY');
  assert.ok(res.body.error.details.customerId);
  assert.equal((await api('GET', `/customers/${ind}/beneficial-owners`)).status, 400);
  assert.equal((await api('GET', `/customers/${ind}/ownership-validation`)).status, 400);

  const customer = await prisma.customer.findUnique({ where: { customerCode: ind } });
  await assert.rejects(prisma.beneficialOwner.create({ data: { customerId: customer.id, fullName: 'Sneaky Owner', ownershipType: 'Direct', controlType: 'Shareholding' } })); // trigger
  assert.equal((await addOwner('CUS-999999')).status, 404);
});

test('only an identified, active person can change ownership data; decisions need a Reviewer or Admin', async () => {
  const code = await newCompany();
  const noHeader = await api('POST', `/customers/${code}/beneficial-owners`, ownerBody());
  assert.equal(noHeader.status, 401);
  assert.equal((await addOwner(code, {}, inactive)).status, 401);
  assert.equal((await api('POST', `/customers/${code}/beneficial-owners`, ownerBody(), { 'x-reviewer-id': '99999999' })).status, 401);
  const added = await addOwner(code, {}, analyst); // an Analyst may enter ownership data
  assert.equal(added.status, 201);

  assert.equal((await screen(added.body.data.id, { screeningType: 'PEP', screeningResult: 'No Match' }, analyst)).status, 403);
  const denied = await assess(code, {}, analyst);
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'NOT_AUTHORISED');
  assert.equal((await assess(code, {}, { id: 0 })).status, 401);
});

test('validates owner input with per-field messages (percentage, country, dates, types)', async () => {
  const code = await newCompany();
  for (const bad of [0, -5, 100.01, 101, 'abc', 33.333]) {
    const res = await addOwner(code, { ownershipPercentage: bad });
    assert.equal(res.status, 400, `percentage ${bad}`);
    assert.ok(res.body.error.details.ownershipPercentage, `percentage ${bad}`);
  }
  const res = await addOwner(code, { fullName: '', countryOfResidence: 'ZZ', nationality: 'XX', dateOfBirth: addDays(todayIso(), 10), ownershipType: 'Sideways', controlType: 'Magic', pepStatus: 'Maybe' });
  assert.equal(res.status, 400);
  for (const f of ['fullName', 'countryOfResidence', 'nationality', 'dateOfBirth', 'ownershipType', 'controlType', 'pepStatus']) assert.ok(res.body.error.details[f], f);
  assert.equal((await addOwner(code, { dateOfBirth: '1990-02-31' })).status, 400);
  // 100 and 0.01 are valid
  assert.equal((await addOwner(code, { fullName: 'Valid Hundred', ownershipPercentage: 100 })).status, 201);
  assert.equal((await addOwner(code, { fullName: 'Valid Tiny', dateOfBirth: '1970-01-01', ownershipPercentage: '0.01' })).status, 201);
  // Database-level guard too
  const customer = await prisma.customer.findUnique({ where: { customerCode: code } });
  const direct = { customerId: customer.id, fullName: 'Direct Insert', ownershipType: 'Direct', controlType: 'Shareholding' };
  await assert.rejects(prisma.beneficialOwner.create({ data: { ...direct, ownershipPercentage: 150 } }));
  await assert.rejects(prisma.beneficialOwner.create({ data: { ...direct, ownershipPercentage: 0 } }));
  await assert.rejects(prisma.beneficialOwner.create({ data: { ...direct, ownershipType: 'Sideways' } }));
});

test('an owner can be recorded with missing information, which is then flagged (not silently accepted)', async () => {
  const code = await newCompany();
  const res = await api('POST', `/customers/${code}/beneficial-owners`, { fullName: 'Partial Person', ownershipType: 'Direct', controlType: 'Shareholding' }, as(analyst));
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const o = res.body.data;
  assert.equal(o.ownershipPercentage, null);
  assert.ok(o.risk.missingFields.includes('ownership percentage'));
  assert.ok(o.risk.missingFields.includes('date of birth'));
  assert.equal(o.risk.points, 1); // missing mandatory information
  assert.equal((await validation(code)).current.status, 'MISSING_PERCENTAGE');
});

// ---- ownership validation -----------------------------------------------------------------------------------------
test('ownership totals: below 100%, above 100%, exactly 100%, and no owners', async () => {
  const empty = await newCompany();
  const none = (await validation(empty)).current;
  assert.equal(none.status, 'NO_OWNERS');
  assert.equal(none.totalPercentage, 0);

  const a = await newCompany(); // Company A: 60 + 50 = 110
  await addOwner(a, { fullName: 'A One', ownershipPercentage: 60 });
  const second = await addOwner(a, { fullName: 'A Two', dateOfBirth: '1980-01-01', ownershipPercentage: 50 });
  const aV = (await validation(a)).current;
  assert.equal(aV.status, 'EXCEEDS_100');
  assert.equal(aV.totalPercentage, 110);
  assert.match(aV.message, /Invalid ownership total/);

  // Correct the second owner to 40 -> Company B: 60 + 40 = 100
  const fixed = await api('PUT', `/beneficial-owners/${second.body.data.id}`, ownerBody({ fullName: 'A Two', dateOfBirth: '1980-01-01', ownershipPercentage: 40 }), as(analyst));
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  const bV = (await validation(a)).current;
  assert.equal(bV.status, 'RECONCILED');
  assert.match(bV.message, /reconciled/i);

  const c = await newCompany(); // Company C: 40 + 30 = 70
  await addOwner(c, { fullName: 'C One', ownershipPercentage: 40 });
  await addOwner(c, { fullName: 'C Two', ownershipPercentage: 30 });
  const cV = (await validation(c)).current;
  assert.equal(cV.status, 'BELOW_100');
  assert.equal(cV.totalPercentage, 70);
  assert.equal(cV.unaccountedPercentage, 30);
  assert.match(cV.message, /not proof of wrongdoing/i);

  // The structure example from the brief: 50 + 30 + 20
  const d = await newCompany();
  for (const [n, p] of [['Person A', 50], ['Person B', 30], ['Person C', 20]]) await addOwner(d, { fullName: n, ownershipPercentage: p });
  const dV = (await validation(d)).current;
  assert.equal(dV.status, 'RECONCILED');
  assert.equal(dV.ownerCount, 3);
  const list = (await api('GET', `/customers/${d}/beneficial-owners`)).body.data;
  assert.equal(list.validation.totalPercentage, 100);
  assert.deepEqual(list.owners.map((o) => o.ownershipPercentage), [50, 30, 20]);
});

test('duplicate owner records are refused (409), including simultaneous identical requests', async () => {
  const code = await newCompany();
  const first = await addOwner(code, { fullName: 'Dup Person', dateOfBirth: '1970-05-05', ownershipPercentage: 30 });
  assert.equal(first.status, 201);
  const same = await addOwner(code, { fullName: '  dup   PERSON ', dateOfBirth: '1970-05-05', ownershipPercentage: 30 });
  assert.equal(same.status, 409);
  assert.equal(same.body.error.code, 'DUPLICATE_OWNER');
  assert.equal(same.body.error.details.existingOwnerId, first.body.data.id);
  assert.equal((await addOwner(code, { fullName: 'Dup Person', dateOfBirth: undefined, ownershipPercentage: 30 })).status, 409); // birth date unknown: could be the same person
  assert.equal((await addOwner(code, { fullName: 'Dup Person', dateOfBirth: '1999-09-09', ownershipPercentage: 30 })).status, 201); // different birth date: a different person

  const race = await Promise.all(Array.from({ length: 4 }, () => addOwner(code, { fullName: 'Race Person', dateOfBirth: '1960-06-06', ownershipPercentage: 10 })));
  assert.equal(race.filter((r) => r.status === 201).length, 1);
  assert.equal(race.filter((r) => r.status === 409).length, 3);

  // Editing into a duplicate is refused too
  const other = await addOwner(code, { fullName: 'Another Person', dateOfBirth: '1955-01-01', ownershipPercentage: 5 });
  const clash = await api('PUT', `/beneficial-owners/${other.body.data.id}`, ownerBody({ fullName: 'Dup Person', dateOfBirth: '1970-05-05' }), as(analyst));
  assert.equal(clash.status, 409);
});

test('editing an owner updates the data, records who edited it, and a blank percentage becomes "missing"', async () => {
  const code = await newCompany();
  const created = await addOwner(code, { fullName: 'Editable Person', ownershipPercentage: 25, controlType: 'Voting rights' });
  const id = created.body.data.id;
  const res = await api('PUT', `/beneficial-owners/${id}`, ownerBody({ fullName: 'Editable Person', ownershipPercentage: 45, controlType: 'Shareholding', ownershipType: 'Indirect', pepStatus: 'Yes', notes: 'updated' }), as(reviewer));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.ownershipPercentage, 45);
  assert.equal(res.body.data.ownershipType, 'Indirect');
  assert.equal(res.body.data.pepStatus, 'Yes');
  const row = await prisma.beneficialOwner.findUnique({ where: { id } });
  assert.equal(row.updatedById, reviewer.id);
  assert.equal(row.createdById, analyst.id);

  const blank = await api('PUT', `/beneficial-owners/${id}`, ownerBody({ fullName: 'Editable Person', ownershipPercentage: '' }), as(reviewer));
  assert.equal(blank.body.data.ownershipPercentage, null);
  assert.equal((await validation(code)).current.status, 'MISSING_PERCENTAGE');

  assert.equal((await api('PUT', `/beneficial-owners/${id}`, ownerBody(), {})).status, 401);
  assert.equal((await api('PUT', '/beneficial-owners/999999999', ownerBody(), as(reviewer))).status, 404);
  assert.equal((await api('GET', '/beneficial-owners/abc')).status, 400);
  // An owner cannot be moved to another customer
  const other = await prisma.customer.findUnique({ where: { customerCode: await newCompany() } });
  await assert.rejects(prisma.beneficialOwner.update({ where: { id }, data: { customerId: other.id } }));
});

test('ownership checks are recorded as permanent history and show when they are out of date', async () => {
  const code = await newCompany();
  await addOwner(code, { fullName: 'Check One', ownershipPercentage: 60 });
  assert.equal((await validation(code)).recordedCheckOutdated, true); // nothing recorded yet

  const rec = await api('POST', `/customers/${code}/ownership-validation`, undefined, as(analyst));
  assert.equal(rec.status, 201, JSON.stringify(rec.body));
  assert.equal(rec.body.data.validationStatus, 'BELOW_100');
  assert.equal(rec.body.data.totalOwnershipPercentage, 60);
  assert.equal(rec.body.data.checkedBy.id, analyst.id);
  assert.equal((await validation(code)).recordedCheckOutdated, false);

  await addOwner(code, { fullName: 'Check Two', dateOfBirth: '1981-01-01', ownershipPercentage: 40 });
  assert.equal((await validation(code)).recordedCheckOutdated, true); // owners changed since the check
  await api('POST', `/customers/${code}/ownership-validation`, undefined, as(analyst));
  const v = await validation(code);
  assert.deepEqual(v.history.map((h) => h.validationStatus), ['RECONCILED', 'BELOW_100']); // newest first, nothing overwritten

  assert.equal((await api('POST', `/customers/${code}/ownership-validation`)).status, 401);
  const row = await prisma.ownershipValidation.findFirst({ where: { customer: { customerCode: code } } });
  await assert.rejects(prisma.ownershipValidation.update({ where: { id: row.id }, data: { validationStatus: 'RECONCILED' } }));
  await assert.rejects(prisma.ownershipValidation.delete({ where: { id: row.id } }));
});

// ---- screening ---------------------------------------------------------------------------------------------------------
test('screening records: Not Screened until recorded, points calculated by the server, history preserved and immutable', async () => {
  const code = await newCompany();
  const o = (await addOwner(code, { fullName: 'Screen Person', ownershipPercentage: 100 })).body.data;

  const before = (await api('GET', `/beneficial-owners/${o.id}/screening`)).body.data;
  assert.deepEqual(before.status, { PEP: 'Not Screened', Sanctions: 'Not Screened' });
  assert.equal(before.items.length, 0);

  // A match must be explained
  const noRemarks = await screen(o.id, { screeningType: 'Sanctions', screeningResult: 'Potential Match' });
  assert.equal(noRemarks.status, 400);
  assert.ok(noRemarks.body.error.details.remarks);
  assert.equal((await screen(o.id, { screeningType: 'Sanctions' })).status, 400); // manual needs a result
  assert.equal((await screen(o.id, { screeningType: 'Credit', screeningResult: 'No Match' })).status, 400);
  assert.equal((await screen(o.id, { screeningType: 'PEP', screeningResult: 'Maybe' })).status, 400);

  // Client-supplied points are ignored: the server calculates them from the rules
  const potential = await screen(o.id, { screeningType: 'Sanctions', screeningResult: 'Potential Match', remarks: 'Similar name on demo list', riskPoints: 99 });
  assert.equal(potential.status, 201, JSON.stringify(potential.body));
  assert.equal(potential.body.data.riskPoints, 3);
  assert.equal(potential.body.data.source, 'Manual entry (synthetic)');
  assert.equal(potential.body.data.screenedBy.id, reviewer.id);

  const clear = await screen(o.id, { screeningType: 'Sanctions', screeningResult: 'No Match' }); // later screening after investigation
  assert.equal(clear.status, 201);
  assert.equal(clear.body.data.riskPoints, 0);
  const confirmedPep = await screen(o.id, { screeningType: 'PEP', screeningResult: 'Confirmed', remarks: 'Confirmed after document review' });
  assert.equal(confirmedPep.body.data.riskPoints, 3);

  const after = (await api('GET', `/beneficial-owners/${o.id}/screening`)).body.data;
  assert.deepEqual(after.status, { PEP: 'Confirmed', Sanctions: 'No Match' }); // latest of each type
  assert.equal(after.items.length, 3); // the earlier Potential Match is still there
  assert.ok(after.items.some((s) => s.screeningResult === 'Potential Match'));

  const row = await prisma.ownerScreening.findFirst({ where: { beneficialOwnerId: o.id, screeningResult: 'Potential Match' } });
  await assert.rejects(prisma.ownerScreening.update({ where: { id: row.id }, data: { screeningResult: 'No Match' } }));
  await assert.rejects(prisma.ownerScreening.delete({ where: { id: row.id } }));
  await assert.rejects(prisma.ownerScreening.create({ data: { beneficialOwnerId: o.id, screeningType: 'PEP', screeningResult: 'Almost', riskPoints: 0, source: 'Manual entry (synthetic)' } })); // CHECK
  await assert.rejects(prisma.ownerScreening.create({ data: { beneficialOwnerId: o.id, screeningType: 'PEP', screeningResult: 'Potential Match', riskPoints: 2, source: 'Manual entry (synthetic)' } })); // remarks required
  assert.equal((await screen(999999999, { screeningType: 'PEP', screeningResult: 'No Match' })).status, 404);
});

test('a simulated screening only ever produces a POTENTIAL match from a fictional list, never a confirmed one', async () => {
  const code = await newCompany();
  const listed = (await addOwner(code, { fullName: 'Viktor Demo Petrov', ownershipPercentage: 50 })).body.data;
  const unlisted = (await addOwner(code, { fullName: 'Ordinary Person', dateOfBirth: '1982-02-02', ownershipPercentage: 50 })).body.data;

  const hit = await screen(listed.id, { screeningType: 'Sanctions', mode: 'simulated' });
  assert.equal(hit.status, 201, JSON.stringify(hit.body));
  assert.equal(hit.body.data.screeningResult, 'Potential Match');
  assert.notEqual(hit.body.data.screeningResult, 'Confirmed');
  assert.equal(hit.body.data.source, 'Simulated list match');
  assert.match(hit.body.data.remarks, /POTENTIAL match/);
  assert.match(hit.body.data.remarks, /not confirmed/);

  const miss = await screen(unlisted.id, { screeningType: 'Sanctions', mode: 'simulated' });
  assert.equal(miss.body.data.screeningResult, 'No Match');

  // The potential match shows in the owner's risk as "needs investigation", not "confirmed"
  const detail = (await api('GET', `/beneficial-owners/${listed.id}`)).body.data;
  const s = detail.risk.indicators.find((i) => i.indicator === 'Sanctions screening');
  assert.equal(s.outcome, 'Potential Match');
  assert.match(s.detail, /NOT a confirmed match/);
  assert.ok(detail.risk.reviewReasons.some((r) => r.code === 'SANCTIONS_POTENTIAL'));
  assert.ok(!detail.risk.reviewReasons.some((r) => r.code === 'SANCTIONS_CONFIRMED'));
});

// ---- owner risk and overall risk --------------------------------------------------------------------------------------
test('owner risk is calculated from the configured points and bands', async () => {
  const code = await newCompany();
  const owner = (await addOwner(code, { fullName: 'Risky Owner', countryOfResidence: 'IR', nationality: undefined, ownershipPercentage: 100 })).body.data;
  // high-risk country 2 + missing nationality 1 = 3 -> Medium
  assert.equal(owner.risk.points, 3);
  assert.equal(owner.risk.level, 'Medium');
  await screen(owner.id, { screeningType: 'PEP', screeningResult: 'Confirmed', remarks: 'Confirmed PEP (synthetic)' });
  const detail = (await api('GET', `/beneficial-owners/${owner.id}`)).body.data;
  // + confirmed PEP 3 = 6 -> High
  assert.equal(detail.risk.points, 6);
  assert.equal(detail.risk.level, 'High');
  assert.deepEqual(detail.risk.indicators.map((i) => i.indicator), ['PEP status', 'Country exposure', 'Sanctions screening', 'Owner information']);
  assert.ok(detail.risk.reviewReasons.some((r) => r.code === 'PEP_CONFIRMED' && /not an automatic rejection/i.test(r.message)));
  assert.equal(detail.screenings[0].screeningType, 'PEP');
});

test('records overall risk assessments as new rows with RSK ids, previous level, assessor, reasons and status', async () => {
  const code = await newCompany();
  await addOwner(code, { fullName: 'Clean One', ownershipPercentage: 60, pepStatus: 'No' });
  await addOwner(code, { fullName: 'Clean Two', dateOfBirth: '1982-02-02', ownershipPercentage: 40, pepStatus: 'No' });
  const customer = await prisma.customer.findUnique({ where: { customerCode: code } });
  const initial = await prisma.riskRating.findFirst({ where: { customerId: customer.id }, orderBy: { id: 'asc' } }); // the Scene 1 onboarding rating
  assert.match(initial.assessmentCode, /^RSK-\d{6}$/);
  assert.equal(initial.previousRiskLevel, null);
  assert.equal(initial.assessmentStatus, 'Completed');

  const res = await assess(code, { remarks: 'First ownership-aware assessment' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const a = res.body.data;
  assert.match(a.assessmentId, /^RSK-\d{6}$/);
  assert.notEqual(a.assessmentId, initial.assessmentCode);
  assert.equal(a.customerId, code);
  assert.equal(a.previousRiskLevel, initial.riskLevel);
  assert.equal(a.assessedBy.id, reviewer.id);
  assert.equal(a.method, 'RULES_V2_OWNERSHIP_PROTOTYPE');
  assert.ok(a.reasons.length >= 3 && a.reasons.every((r) => typeof r.points === 'number' && r.factor && r.description));
  assert.ok(['Low', 'Medium', 'High'].includes(a.riskLevel));
  assert.equal(a.ownerBreakdown.length, 2);
  assert.equal(a.ownershipValidation.status, 'RECONCILED');
  assert.equal(a.assessorNote, 'First ownership-aware assessment');

  // Nothing changed: a second assessment is refused unless forced
  const again = await assess(code);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'NO_CHANGE');
  assert.equal(again.body.error.details.existingAssessmentId, a.assessmentId);
  const forced = await assess(code, { force: true });
  assert.equal(forced.status, 201);
  assert.equal(forced.body.data.previousRiskLevel, a.riskLevel);
});

test('risk history is preserved: every assessment is a new row, old rows are never changed or deleted', async () => {
  const code = await newCompany();
  const owner = (await addOwner(code, { fullName: 'History Owner', ownershipPercentage: 100, pepStatus: 'No' })).body.data;
  const first = (await assess(code)).body.data;

  const snapshot = async () => JSON.stringify(await prisma.riskRating.findUnique({ where: { id: first.id } }));
  const before = await snapshot();

  await screen(owner.id, { screeningType: 'Sanctions', screeningResult: 'Potential Match', remarks: 'Demo potential match' });
  const second = (await assess(code)).body.data;
  await screen(owner.id, { screeningType: 'PEP', screeningResult: 'Confirmed', remarks: 'Demo confirmed PEP' });
  const third = (await assess(code)).body.data;

  assert.ok(second.riskScore > first.riskScore);
  assert.ok(third.riskScore >= second.riskScore);
  assert.equal(second.previousRiskLevel, first.riskLevel);
  assert.equal(third.previousRiskLevel, second.riskLevel);
  assert.equal(await snapshot(), before, 'the first assessment is unchanged');

  const history = (await api('GET', `/customers/${code}/risk-assessments`)).body.data;
  assert.equal(history.items.length, 4); // Scene 1 onboarding + three Scene 3 assessments
  assert.deepEqual(history.items.slice(0, 3).map((h) => h.assessmentId), [third.assessmentId, second.assessmentId, first.assessmentId]);
  assert.equal(history.items.at(-1).assessedBy.name, 'System (onboarding)');
  const codes = history.items.map((h) => h.assessmentId);
  assert.equal(new Set(codes).size, codes.length);

  // The database refuses to rewrite or remove history
  await assert.rejects(prisma.riskRating.update({ where: { id: first.id }, data: { riskLevel: 'Low' } }));
  await assert.rejects(prisma.riskRating.update({ where: { id: first.id }, data: { riskScore: 0 } }));
  await assert.rejects(prisma.riskRating.delete({ where: { id: first.id } }));
  assert.equal(await snapshot(), before);

  // Scene 1's profile reads the newest assessment as "current" and the rest as history
  const profile = (await api('GET', `/customers/${code}`)).body.data;
  assert.equal(profile.currentRisk.score, third.riskScore);
  assert.equal(profile.currentRisk.level, third.riskLevel);
  assert.equal(profile.riskHistory.length, 3);
  assert.ok(Array.isArray(profile.currentRisk.reasons) && profile.currentRisk.reasons.length > 0); // the shape Scene 1's page reads
});

test('a potential match requires manual review but does not reject the customer or change their registration status', async () => {
  const code = await newCompany();
  const owner = (await addOwner(code, { fullName: 'Darius Demo Volkov', ownershipPercentage: 100, pepStatus: 'No' })).body.data;
  await screen(owner.id, { screeningType: 'Sanctions', mode: 'simulated' });
  const a = (await assess(code)).body.data;
  assert.equal(a.status, 'Requires Manual Review');
  assert.equal(a.overallResult, 'Requires Manual Review');
  assert.ok(['Low', 'Medium', 'High'].includes(a.riskLevel), 'the score band is still Low, Medium or High');
  assert.ok(a.manualReviewReasons.some((m) => /not a confirmed match/i.test(m.message)));
  const customer = await prisma.customer.findUnique({ where: { customerCode: code } });
  assert.equal(customer.registrationStatus, 'Registered'); // not rejected, not suspended
});

test('overall risk combines the customer baseline, owner risk, complexity and ownership validation', async () => {
  const code = await newCompany({ country: 'AE', businessActivity: 'Construction', dateOfIncorporation: addDays(todayIso(), -60) }); // a Medium-looking company
  const baseline = (await api('GET', `/customers/${code}/risk-summary`)).body.data.customerRisk.wouldBe;
  assert.equal(baseline.baseline.level, 'Medium');
  assert.equal(baseline.ownershipValidation.status, 'NO_OWNERS'); // a company with no owners yet

  const high = (await addOwner(code, { fullName: 'High Risk Owner', countryOfResidence: 'IR', nationality: undefined, ownershipPercentage: 70, ownershipType: 'Indirect' })).body.data;
  await screen(high.id, { screeningType: 'PEP', screeningResult: 'Confirmed', remarks: 'Confirmed PEP (synthetic)' });
  await addOwner(code, { fullName: 'Second Owner', dateOfBirth: '1980-01-01', ownershipPercentage: 20 }); // 70 + 20 = 90: below 100

  const a = (await assess(code)).body.data;
  assert.equal(a.riskLevel, 'High');
  assert.equal(a.status, 'Requires Manual Review');
  assert.ok(a.components.baseline >= 30);
  assert.ok(a.components.ownership > 0 && a.components.complexity > 0 && a.components.validation > 0);
  assert.equal(a.riskScore, Math.min(100, a.components.baseline + a.components.ownership + a.components.complexity + a.components.validation));
  const factors = a.reasons.map((r) => r.factor);
  for (const f of ['Customer type', 'Beneficial owner risk', 'Ownership complexity', 'Ownership validation']) assert.ok(factors.includes(f), f);
  assert.ok(a.manualReviewReasons.length >= 3);
});

test('customer risk, KYC completeness and ownership validation are independent measures', async () => {
  const code = await newCompany();
  await addOwner(code, { fullName: 'Independent Owner', ownershipPercentage: 100 });
  const s0 = (await api('GET', `/customers/${code}/risk-summary`)).body.data;
  assert.ok(s0.kycCompleteness && s0.kycCompleteness.percentage === 0); // no documents yet
  assert.equal(s0.ownershipValidation.status, 'RECONCILED');
  assert.match(s0.separation, /three separate measures/);

  // Verifying documents raises KYC completeness but does NOT change the risk calculation
  const reqDocs = (await api('GET', `/customers/${code}/kyc-completeness`)).body.data.requirements.filter((r) => r.isMandatory).map((r) => r.documentType);
  for (const type of reqDocs) {
    const needsNumber = !['Photograph', 'Additional Evidence', 'Ownership Details', 'Financial Statements'].includes(type);
    const doc = await api('POST', '/documents', { customerId: code, documentType: type, ...(needsNumber ? { documentNumber: `SYN-${rnd(6)}` } : {}), issueDate: addDays(todayIso(), -100), submissionDate: addDays(todayIso(), -5) });
    assert.equal(doc.status, 201, JSON.stringify(doc.body));
    const v = await api('POST', `/documents/${doc.body.data.id}/verifications`, { status: 'Verified', remarks: 'ok' }, as(reviewer));
    assert.equal(v.status, 201, JSON.stringify(v.body));
  }
  const s1 = (await api('GET', `/customers/${code}/risk-summary`)).body.data;
  assert.equal(s1.kycCompleteness.percentage, 100);
  assert.equal(s1.customerRisk.wouldBe.riskScore, s0.customerRisk.wouldBe.riskScore, 'documents do not change the risk score');
  assert.equal(s1.customerRisk.wouldBe.riskLevel, s0.customerRisk.wouldBe.riskLevel);

  // And the reverse: a High-risk change does not touch completeness
  const owner = (await api('GET', `/customers/${code}/beneficial-owners`)).body.data.owners[0];
  await screen(owner.id, { screeningType: 'Sanctions', screeningResult: 'Confirmed', remarks: 'Confirmed (synthetic)' });
  const s2 = (await api('GET', `/customers/${code}/risk-summary`)).body.data;
  assert.ok(s2.customerRisk.wouldBe.riskScore > s1.customerRisk.wouldBe.riskScore);
  assert.equal(s2.kycCompleteness.percentage, 100, 'still 100% KYC complete');
});

test('the risk summary recommends reassessment when inputs change, and not afterwards', async () => {
  const code = await newCompany();
  const o = (await addOwner(code, { fullName: 'Summary Owner', ownershipPercentage: 100 })).body.data;
  await assess(code);
  assert.equal((await api('GET', `/customers/${code}/risk-summary`)).body.data.customerRisk.reassessmentRecommended, false);
  await screen(o.id, { screeningType: 'Sanctions', screeningResult: 'Potential Match', remarks: 'demo' });
  const s = (await api('GET', `/customers/${code}/risk-summary`)).body.data;
  assert.equal(s.customerRisk.reassessmentRecommended, true);
  assert.ok(s.customerRisk.wouldBe.riskScore > s.customerRisk.current.riskScore);
  await assess(code);
  assert.equal((await api('GET', `/customers/${code}/risk-summary`)).body.data.customerRisk.reassessmentRecommended, false);
  assert.equal((await api('GET', `/customers/${code}/risk-summary`)).body.data.history.length >= 2, true);
  assert.equal((await api('GET', '/customers/CUS-999999/risk-summary')).status, 404);
});

test('an individual customer can be assessed on the baseline, with no ownership section', async () => {
  const ind = await newIndividual();
  const summary = (await api('GET', `/customers/${ind}/risk-summary`)).body.data;
  assert.equal(summary.ownershipValidation.applicable, false);
  assert.equal(summary.customerRisk.wouldBe.components.ownership, 0);
  const a = await assess(ind, { force: true });
  assert.equal(a.status, 201);
  assert.deepEqual(a.body.data.ownerBreakdown, []);
});

// ---- lists, search, dashboard -------------------------------------------------------------------------------------------
test('risk assessment history list: filters, search by RSK id, dates, pagination and detail', async () => {
  const code = await newCompany({ legalName: `Zyxwv${rnd(5)} Holdings Ltd` });
  const o = (await addOwner(code, { fullName: 'List Owner', ownershipPercentage: 100 })).body.data;
  const a1 = (await assess(code)).body.data;
  await screen(o.id, { screeningType: 'Sanctions', screeningResult: 'Potential Match', remarks: 'demo' });
  const a2 = (await assess(code)).body.data;

  const byCustomer = (await api('GET', `/risk-assessments?customerId=${code}&pageSize=10`)).body;
  assert.equal(byCustomer.pagination.totalItems, 3);
  assert.deepEqual(byCustomer.data.slice(0, 2).map((r) => r.assessmentId), [a2.assessmentId, a1.assessmentId]);
  assert.equal((await api('GET', `/risk-assessments?search=${a1.assessmentId.toLowerCase()}`)).body.data[0].assessmentId, a1.assessmentId);
  assert.equal((await api('GET', `/risk-assessments?search=Zyxwv`)).body.pagination.totalItems >= 3, true);
  assert.equal((await api('GET', `/risk-assessments?customerId=${code}&status=Requires%20Manual%20Review`)).body.data.every((r) => r.status === 'Requires Manual Review'), true);
  assert.equal((await api('GET', `/risk-assessments?customerId=${code}&riskLevel=${a2.riskLevel}`)).body.data.every((r) => r.riskLevel === a2.riskLevel), true);
  assert.equal((await api('GET', `/risk-assessments?customerId=${code}&customerType=Company`)).body.pagination.totalItems, 3);
  assert.equal((await api('GET', `/risk-assessments?customerId=${code}&from=${todayIso()}&to=${todayIso()}`)).body.pagination.totalItems, 3);
  assert.equal((await api('GET', `/risk-assessments?customerId=${code}&from=2000-01-01&to=2000-01-02`)).body.pagination.totalItems, 0);
  const page = (await api('GET', `/risk-assessments?customerId=${code}&pageSize=1&page=3`)).body;
  assert.equal(page.data.length, 1);
  assert.equal(page.data[0].assessedBy.name, 'System (onboarding)');
  assert.equal((await api('GET', '/risk-assessments?riskLevel=Extreme')).status, 400);
  assert.equal((await api('GET', '/risk-assessments?from=yesterday')).status, 400);

  const detail = (await api('GET', `/risk-assessments/${a2.assessmentId}`)).body.data;
  assert.equal(detail.customerId, code);
  assert.ok(detail.reasons.length > 0);
  assert.equal((await api('GET', '/risk-assessments/RSK-999999')).status, 404);
  assert.equal((await api('GET', '/risk-assessments/nope')).status, 400);
});

test('the ownership overview supports search by company ID, company name and owner name, and status filters', async () => {
  const name = `Qwertz${rnd(5)}`;
  const code = await newCompany();
  await addOwner(code, { fullName: `${name} Owner`, ownershipPercentage: 70 });
  const byOwner = (await api('GET', `/ownership/overview?search=${name}`)).body;
  assert.equal(byOwner.pagination.totalItems, 1);
  assert.equal(byOwner.data[0].customerId, code);
  assert.equal(byOwner.data[0].validationStatus, 'BELOW_100');
  assert.equal(byOwner.data[0].totalPercentage, 70);
  assert.equal(byOwner.data[0].ownerCount, 1);
  assert.equal((await api('GET', `/ownership/overview?search=${code.toLowerCase()}`)).body.data[0].customerId, code);
  assert.equal((await api('GET', `/ownership/overview?search=${name}&status=RECONCILED`)).body.pagination.totalItems, 0);
  assert.equal((await api('GET', `/ownership/overview?search=${name}&status=BELOW_100`)).body.pagination.totalItems, 1);
  assert.equal((await api('GET', '/ownership/overview?status=BOGUS')).status, 400);
  assert.equal((await api('GET', '/ownership/overview?search=%25')).status, 200); // wildcards typed by a user are plain text
  assert.ok((await api('GET', '/ownership/options')).body.data.controlTypes.length >= 4);
});

test('dashboard risk counts reflect the database', async () => {
  const before = (await api('GET', '/dashboard/risk-summary')).body.data;
  const code = await newCompany(); // a company with no owners is an ownership issue
  const after1 = (await api('GET', '/dashboard/risk-summary')).body.data;
  assert.equal(after1.totalBusinessCustomers, before.totalBusinessCustomers + 1);
  assert.equal(after1.ownershipIssues, before.ownershipIssues + 1);
  assert.equal(after1.companiesWithoutOwners, before.companiesWithoutOwners + 1);

  await addOwner(code, { fullName: 'Dash One', ownershipPercentage: 60 });
  await addOwner(code, { fullName: 'Dash Two', dateOfBirth: '1980-01-01', ownershipPercentage: 40 });
  const after2 = (await api('GET', '/dashboard/risk-summary')).body.data;
  assert.equal(after2.totalBeneficialOwners, before.totalBeneficialOwners + 2);
  assert.equal(after2.ownershipIssues, before.ownershipIssues); // reconciled again

  const o = (await api('GET', `/customers/${code}/beneficial-owners`)).body.data.owners[0];
  await screen(o.id, { screeningType: 'Sanctions', mode: 'manual', screeningResult: 'Potential Match', remarks: 'demo' });
  await assess(code);
  const after3 = (await api('GET', '/dashboard/risk-summary')).body.data;
  assert.equal(after3.customersRequiringManualReview, before.customersRequiringManualReview + 1);
});

test('Scene 1 and Scene 2 still work after Scene 3 assessments exist', async () => {
  const code = await newCompany();
  await addOwner(code, { fullName: 'Compat Owner', ownershipPercentage: 100 });
  await assess(code);

  const profile = await api('GET', `/customers/${code}`);
  assert.equal(profile.status, 200);
  assert.ok(profile.body.data.currentRisk.reasons.length > 0);
  assert.equal((await api('GET', `/customers?search=${code}`)).body.pagination.totalItems, 1);
  const summary = (await api('GET', '/dashboard/summary')).body.data;
  assert.equal(summary.lowRiskCustomers + summary.mediumRiskCustomers + summary.highRiskCustomers, summary.totalCustomers); // levels stay Low/Medium/High

  const k = await api('GET', `/customers/${code}/kyc-completeness`); // Scene 2 reads the newest risk level
  assert.equal(k.status, 200);
  assert.equal(k.body.data.customer.riskLevel, profile.body.data.currentRisk.level);
  assert.equal((await api('GET', '/documents?pageSize=1')).status, 200);
  assert.equal((await api('GET', '/kyc/exceptions?pageSize=1')).status, 200);
});
