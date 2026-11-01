/**
 * Phase 2: synthetic data generator.
 *
 * Unit tests cover the pure pieces (seeded random numbers, ID formats, ownership splits, expiry lead times). The end-to-end test
 * runs the real generator at the "starter" scale in a CHILD PROCESS against its own test database (never the development
 * database), twice, and checks the exact counts, the validation result and that the same seed gives identical data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const TEST_DB = 'clearkyc_test_generator';

// the pure modules read the config only, so no database is needed
const { Rng, createRng } = require('../../generator/utils/seededRandom');
const ids = require('../../generator/utils/idGenerator');
const { SCALES, resolveConfig } = require('../../generator/config/generatorConfig');
const { leadTimeFor, EXPIRY_ALERT_CONFIG } = require('../src/config/expiryRules');
const { expiryLeadConditions, documentConditions } = require('../src/services/exceptionEngine');
const { deriveAlerts } = require('../src/services/alertEngine');

function runGenerator(args, reportDir) {
  return spawnSync(process.execPath, [path.join(ROOT, 'generator', 'index.js'), ...args, `--report-dir=${reportDir}`], { cwd: ROOT, encoding: 'utf8', timeout: 240000 });
}

async function dropTestDatabase() {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const { Client } = require('pg');
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = '/postgres';
  u.search = '';
  const client = new Client({ connectionString: u.toString() });
  await client.connect();
  try {
    await client.query(`DROP DATABASE IF EXISTS "${TEST_DB}" WITH (FORCE)`);
  } finally {
    await client.end();
  }
}

test('configuration: the four fixed volumes per scale', () => {
  assert.deepEqual(SCALES.full, { customers: 8000, companies: 1000, documents: 20000, reviewCases: 3000 });
  assert.deepEqual(SCALES.starter, { customers: 50, companies: 17, documents: 152, reviewCases: 15 });
  assert.deepEqual(SCALES.medium, { customers: 1000, companies: 125, documents: 2500, reviewCases: 300 });
  const cfg = resolveConfig(['--scale=full']);
  assert.equal(cfg.seed, 20261022);
  assert.equal(cfg.referenceDate, '2026-10-31');
  assert.equal(cfg.counts.individuals, 7000);
  assert.equal(cfg.databaseName, 'clearkyc_full');
  assert.throws(() => resolveConfig(['--scale=huge']), /Unknown scale/);
  assert.throws(() => resolveConfig(['--seed=abc']), /whole number/);
  assert.throws(() => resolveConfig(['--batch-size=0']), /batch-size/);
});

test('seeded random: same seed => same numbers, independent named streams', () => {
  const a = createRng(20261022);
  const b = createRng(20261022);
  assert.deepEqual(Array.from({ length: 20 }, () => a.next()), Array.from({ length: 20 }, () => b.next()));
  const c = createRng(1);
  assert.notEqual(c.next(), createRng(2).next());
  // a stage's numbers do not depend on how many numbers another stage used
  const root1 = createRng(7);
  const root2 = createRng(7);
  root1.fork('x').next();
  assert.equal(root1.fork('y').next(), root2.fork('y').next());
  const r = new Rng(5);
  for (let i = 0; i < 1000; i += 1) {
    const n = r.int(3, 9);
    assert.ok(n >= 3 && n <= 9);
  }
  assert.equal(r.digits(12).length, 12);
});

test('business IDs follow the required formats', () => {
  assert.match(ids.customerCode(1), ids.FORMATS.customer);
  assert.equal(ids.customerCode(1), 'CUS-000001');
  assert.equal(ids.requirementCode(2026, 1), 'KYC-2026-000001');
  assert.equal(ids.documentCode('CUS-000001', 1), 'DOC-CUS-000001-001');
  assert.equal(ids.reviewCode('CUS-000001', 2026), 'REV-CUS-000001-2026');
  assert.equal(ids.reviewCode('CUS-000001', 2026, 2), 'REV-CUS-000001-2026-02');
  assert.equal(ids.alertBusinessId(2026, 1), 'ALT-2026-000001');
  for (const [format, sample] of [[ids.FORMATS.requirement, 'KYC-2026-000001'], [ids.FORMATS.document, 'DOC-CUS-000001-001'], [ids.FORMATS.review, 'REV-CUS-000001-2026-02'], [ids.FORMATS.alert, 'ALT-2026-000001']]) {
    assert.match(sample, format);
  }
  const counter = new ids.ScopedCounter();
  assert.equal(counter.next('DOC:CUS-000001'), 1);
  assert.equal(counter.next('DOC:CUS-000001'), 2);
  assert.equal(counter.next('DOC:CUS-000002'), 1);
  assert.equal(counter.next('ALT', 2026), 1);
  assert.equal(counter.next('ALT', 2027), 1);
  assert.deepEqual(counter.rows().find((x) => x.scope === 'DOC:CUS-000001'), { scope: 'DOC:CUS-000001', period: 0, lastValue: 2 });
});

test('expiry alert lead times: thresholds 90 / 60 / 30 / 7 (boundaries)', () => {
  assert.deepEqual(EXPIRY_ALERT_CONFIG.expiryAlertDays, [90, 60, 30, 7]);
  const expected = { 91: null, 90: 90, 89: 90, 61: 90, 60: 60, 59: 60, 31: 60, 30: 30, 29: 30, 8: 30, 7: 7, 1: 7, 0: 7, [-1]: null };
  for (const [days, threshold] of Object.entries(expected)) assert.equal(leadTimeFor(Number(days)), threshold, `${days} days to expiry`);
  assert.equal(leadTimeFor(null), null);
  assert.equal(leadTimeFor(45, { enabled: false, expiryAlertDays: [90, 60, 30, 7] }), null, 'disabled => no lead-time alerts');
  assert.equal(leadTimeFor(45, { enabled: true, expiryAlertDays: [45, 10] }), 45, 'the thresholds are configuration, not code');
});

function kycWith(doc) {
  const summary = { id: 5, documentType: 'Address Proof', status: 'Verified', effectiveStatus: 'Verified', submissionDate: '2026-01-05', ...doc };
  return { asOf: '2026-10-31', requirements: [{ requirementId: 3, documentType: 'Address Proof', state: 'Verified', document: summary }], extraDocuments: [], exceptions: [] };
}
const customer = { id: 1, code: 'CUS-000001', name: 'Test Customer', customerType: 'Individual', riskLevel: 'Low' };

test('expiry alerts: one alert per document per threshold, only the closest threshold is active', () => {
  const at = (days) => ({ expiryDate: `2026-${days}`, daysToExpiry: days, expiryState: days <= 30 ? 'Expiring Soon' : 'Valid' });
  const lead = (days) => expiryLeadConditions(customer, kycWith(at(days)));
  assert.equal(lead(91).length, 0, 'more than 90 days: nothing');
  assert.equal(lead(90)[0].threshold, 90);
  assert.equal(lead(61)[0].threshold, 90);
  assert.equal(lead(60)[0].threshold, 60);
  assert.equal(lead(31)[0].threshold, 60);
  assert.ok(lead(31)[0].alertOnly, 'beyond 30 days it raises an alert but no exception');
  assert.equal(lead(30).length, 0, 'inside 30 days the exception condition takes over');

  // inside 30 days: the exception condition carries the threshold (30 or 7)
  const exceptionCondition = (days) => {
    const doc = { id: 5, status: 'Verified', expiryDate: '2026-11-15', daysToExpiry: days };
    return documentConditions(customer, { requirements: [{ documentType: 'Address Proof', requirementId: 3 }], exceptions: [{ type: 'EXPIRING_SOON', documentType: 'Address Proof', isMandatory: true, document: doc }], asOf: '2026-10-31' })[0];
  };
  assert.equal(exceptionCondition(30).threshold, 30);
  assert.equal(exceptionCondition(8).threshold, 30);
  assert.equal(exceptionCondition(7).threshold, 7);
  assert.equal(exceptionCondition(0).threshold, 7);

  // alerts: the key includes the threshold, so a document moving 60 -> 30 days is a NEW alert (the old one is resolved by the sync)
  const ctx = { customer, kyc: kycWith(at(45)), schedule: null };
  const a60 = deriveAlerts(ctx, lead(45));
  assert.equal(a60.length, 1);
  assert.match(a60[0].key, /\|T60$/);
  assert.equal(a60[0].conditionKey, '1|DOCUMENT_EXPIRING_SOON|Document|5');
  const a30 = deriveAlerts({ customer, kyc: kycWith(at(20)), schedule: null }, [exceptionCondition(20)]);
  assert.match(a30[0].key, /\|T30$/);
  assert.notEqual(a60[0].key, a30[0].key);
  assert.equal(a60[0].conditionKey, a30[0].conditionKey, 'the exception keeps one key for all thresholds');
  // the same state twice gives the same single alert (no duplicates)
  assert.deepEqual(deriveAlerts(ctx, lead(45)).map((a) => a.key), a60.map((a) => a.key));
});

test('an expired document is never a lead-time alert, even if its verification says Verified', () => {
  const expired = kycWith({ expiryDate: '2026-10-01', daysToExpiry: -30, expiryState: 'Expired', effectiveStatus: 'Expired' });
  assert.equal(expiryLeadConditions(customer, expired).length, 0);
});

test('ownership shares always add up to exactly 100.00', () => {
  const { splitShares } = require('../../generator/generators/ownershipGenerator');
  const r = createRng(99);
  for (let i = 0; i < 2000; i += 1) {
    const k = 1 + (i % 4);
    const shares = splitShares(k, r);
    assert.equal(shares.length, k);
    assert.equal(shares.reduce((s, x) => s + x, 0), 10000);
    assert.ok(shares.every((s) => s >= (k === 1 ? 10000 : 500)), 'every owner holds at least 5%');
  }
});

test('safety: the main development database is never replaced without both confirmations', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-guard-'));
  const noFlags = runGenerator(['--scale=starter', '--database=clearkyc'], dir);
  assert.notEqual(noFlags.status, 0);
  assert.match(noFlags.stderr + noFlags.stdout, /holds your development data/);
  const resetOnly = runGenerator(['--scale=starter', '--database=clearkyc', '--reset'], dir);
  assert.notEqual(resetOnly.status, 0);
  assert.match(resetOnly.stderr + resetOnly.stdout, /BOTH --reset and --confirm-reset-main-database/);
});

test('end to end (starter): exact counts, validation passes, same seed => identical data', { timeout: 600000 }, async (t) => {
  await dropTestDatabase();
  t.after(dropTestDatabase);
  const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-a-'));
  const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-b-'));

  const first = runGenerator(['--scale=starter', `--database=${TEST_DB}`], dirA);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const a = JSON.parse(fs.readFileSync(path.join(dirA, 'generation_summary.json'), 'utf8'));
  assert.equal(a.status, 'SUCCESS');
  assert.equal(a.validation.status, 'PASSED');
  assert.equal(a.validation.failed, 0);
  assert.equal(a.validation.applicationFailed, 0);
  assert.equal(a.checksums.Customer.rows, 50);
  assert.equal(a.checksums.Document.rows, 152);
  assert.equal(a.checksums.ReviewCase.rows, 15);
  assert.equal(a.checksums.CompanyOwnership.rows, a.checksums.BeneficialOwner.rows);
  assert.ok(a.checksums.AuditEvent.rows > 500);
  assert.equal(a.failedRecords, 0);

  // a second run into a database that already has data stops and changes nothing
  const refused = runGenerator(['--scale=starter', `--database=${TEST_DB}`], dirB);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr + refused.stdout, /already contains 50 customers/);

  // --reset regenerates the same data
  const second = runGenerator(['--scale=starter', `--database=${TEST_DB}`, '--reset'], dirB);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  const b = JSON.parse(fs.readFileSync(path.join(dirB, 'generation_summary.json'), 'utf8'));
  assert.equal(b.checksums.dataset, a.checksums.dataset, 'same seed + configuration => identical dataset');
  for (const table of Object.keys(a.checksums).filter((k) => k !== 'dataset')) assert.equal(b.checksums[table].checksum, a.checksums[table].checksum, `${table} is identical`);

  // a different seed gives different data (and still passes every check)
  const third = runGenerator(['--scale=starter', `--database=${TEST_DB}`, '--reset', '--seed=1'], dirB);
  assert.equal(third.status, 0, third.stdout + third.stderr);
  const c = JSON.parse(fs.readFileSync(path.join(dirB, 'generation_summary.json'), 'utf8'));
  assert.notEqual(c.checksums.dataset, a.checksums.dataset);
  assert.equal(c.validation.status, 'PASSED');
  assert.equal(c.checksums.Customer.rows, 50);
});
