/**
 * Phase 4: validation, export, checksums, final detection summary, reproducibility and packaging.
 * Everything runs at the "starter" scale in CHILD PROCESSES against its own test databases (never the development database).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const BASE = 'clearkyc_test_p4_base';
const EDGE = 'clearkyc_test_p4_edge';
const BAD = 'clearkyc_test_p4_bad';
const REF = '2026-10-31';

const { connectionString } = require('../../detector');
const { sqlLiteral, toCsv, toJson } = require('../../exporter/formats');
const { maskRow, fingerprint } = require('../../exporter/masking');
const { buildChecksumsText, verifyChecksums, generateChecksums } = require('../../packaging/checksums');
const { compareDatasets } = require('../../reproducibility/compareDatasets');
const { parseCsv } = require('../../exporter/verifyExport');

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `p4-${label}-`));
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const run = (script, args) => spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 290000, maxBuffer: 64 * 1024 * 1024 });
const ok = (res, label) => assert.equal(res.status, 0, `${label}\n${res.stdout}\n${res.stderr}`);

async function admin(fn) {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const c = new Client({ connectionString: connectionString('postgres') });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}
const dropAll = () => admin(async (c) => { for (const n of [BASE, EDGE, BAD, 'clearkyc_repro_a', 'clearkyc_repro_a_edge', 'clearkyc_repro_b', 'clearkyc_repro_b_edge', 'clearkyc_export_check']) await c.query(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`); });
async function query(database, sql, params = []) {
  const db = new Client({ connectionString: connectionString(database) });
  await db.connect();
  try {
    return (await db.query(sql, params)).rows;
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------------------------------------------------------
test('export formats are deterministic and safe', () => {
  assert.equal(toCsv(['a', 'b'], [{ a: 1, b: 'x,y' }, { a: null, b: 'he said "hi"\nnext' }]), 'a,b\n1,"x,y"\n,"he said ""hi""\nnext"\n');
  const tricky = 'he said "hi"\nnext';
  assert.deepEqual(parseCsv(toCsv(['a', 'b'], [{ a: 1, b: 'x,y' }, { a: null, b: tricky }])), [['a', 'b'], ['1', 'x,y'], ['', tricky]], 'CSV round trip');
  assert.equal(toJson(['a'], [{ a: 1 }]), '[\n  {\n    "a": 1\n  }\n]\n');
  assert.equal(sqlLiteral("O'Brien", 'text'), "'O''Brien'");
  assert.equal(sqlLiteral(null, 'text'), 'NULL');
  assert.equal(sqlLiteral({ a: 1 }, 'jsonb'), `'{"a":1}'::jsonb`);
  assert.equal(sqlLiteral(true, 'boolean'), 'TRUE');
  assert.equal(sqlLiteral('60.00', 'numeric'), "'60.00'");
});

test('sensitive identifiers are masked; equality is kept through fingerprints', () => {
  const { encryptDeterministic, blindIndex } = require('../../generator/utils/syntheticCrypto');
  const pan = 'ZABPC1234Q';
  const row = maskRow('Customer', { pan_number: encryptDeterministic(pan), aadhaar_number: encryptDeterministic('234567890123'), pan_hash: blindIndex('PAN', pan), aadhaar_hash: null, full_name: 'Amit Sharma' });
  assert.equal(row.pan_number, 'XXXXXX234Q', 'only the last four characters survive');
  assert.match(row.aadhaar_number, /^XXXX XXXX 0123$/);
  assert.equal(row.pan_hash, fingerprint(blindIndex('PAN', pan)));
  assert.equal(row.pan_hash.length, 24);
  assert.equal(row.aadhaar_hash, null);
  assert.equal(row.full_name, 'Amit Sharma');
  assert.equal(fingerprint('x'), fingerprint('x'));
  assert.notEqual(fingerprint('x'), fingerprint('y'));
  const owner = maskRow('BeneficialOwner', { date_of_birth: encryptDeterministic('1984-05-06'), identity_hash: 'abc' });
  assert.equal(owner.date_of_birth, '1984');
});

test('checksum file: stable order, three sections, ground truth kept apart, tampering is detected', () => {
  const dir = tmp('sums');
  for (const [f, text] of [['csv/a.csv', 'a\n'], ['json/a.json', '[]\n'], ['sql/schema.sql', 'x\n'], ['ground_truth.json', '{}\n'], ['detection_report.json', '{}\n'], ['documentation/README.md', '#\n'], ['validation_summary.json', '{}\n'], ['.DS_Store', 'junk'], ['scratch.tmp', 'junk']]) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  const first = buildChecksumsText(dir).text;
  assert.equal(buildChecksumsText(dir).text, first, 'repeatable');
  const lines = first.split('\n');
  const section = (n) => lines.slice(lines.findIndex((l) => l.startsWith(`# [${n}]`)) + 1, n < 3 ? lines.findIndex((l) => l.startsWith(`# [${n + 1}]`)) : undefined).filter((l) => /^[0-9a-f]{64}  /.test(l)).map((l) => l.slice(66));
  assert.deepEqual(section(1), ['csv/a.csv', 'json/a.json', 'sql/schema.sql']);
  assert.deepEqual(section(2), ['detection_report.json', 'ground_truth.json']);
  assert.deepEqual(section(3), ['documentation/README.md', 'validation_summary.json']);
  assert.ok(!first.includes('.DS_Store') && !first.includes('scratch.tmp') && !first.includes('checksums.txt  '), 'temporary files and itself are not listed');
  generateChecksums(dir);
  assert.equal(verifyChecksums(dir).status, 'VERIFIED');
  fs.appendFileSync(path.join(dir, 'csv/a.csv'), 'tampered\n');
  const bad = verifyChecksums(dir);
  assert.equal(bad.status, 'MISMATCH');
  assert.deepEqual(bad.changed, ['csv/a.csv']);
  fs.writeFileSync(path.join(dir, 'csv/new.csv'), 'x\n');
  assert.deepEqual(verifyChecksums(dir).unlisted, ['csv/new.csv']);
});

test('dataset comparison finds a one-value difference and ignores surrogate numbering', () => {
  const a = tmp('cmpA');
  const b = tmp('cmpB');
  const write = (dir, rows) => { fs.mkdirSync(path.join(dir, 'json'), { recursive: true }); fs.writeFileSync(path.join(dir, 'json', 'customers.json'), JSON.stringify(rows)); };
  write(a, [{ id: 1, customer_id: 'CUS-000001', full_name: 'A' }, { id: 2, customer_id: 'CUS-000002', full_name: 'B' }]);
  write(b, [{ id: 1, customer_id: 'CUS-000001', full_name: 'A' }, { id: 2, customer_id: 'CUS-000002', full_name: 'B' }]);
  assert.equal(compareDatasets({ dirA: a, dirB: b, files: ['customers'], foreignKeys: [] }).strictIdentical, true);
  write(b, [{ id: 7, customer_id: 'CUS-000001', full_name: 'A' }, { id: 9, customer_id: 'CUS-000002', full_name: 'B' }]); // only the internal numbers differ
  const numbering = compareDatasets({ dirA: a, dirB: b, files: ['customers'], foreignKeys: [] });
  assert.deepEqual([numbering.strictIdentical, numbering.logicalIdentical], [false, true]);
  write(b, [{ id: 1, customer_id: 'CUS-000001', full_name: 'A' }, { id: 2, customer_id: 'CUS-000002', full_name: 'CHANGED' }]);
  const changed = compareDatasets({ dirA: a, dirB: b, files: ['customers'], foreignKeys: [] });
  assert.equal(changed.logicalIdentical, false);
  assert.deepEqual(changed.differences[0], { table: 'customers', record: 'CUS-000002', column: 'full_name', run_a: 'B', run_b: 'CHANGED' });
});

// ---------------------------------------------------------------------------------------------------------------------------
// Pipeline tests
// ---------------------------------------------------------------------------------------------------------------------------
test('phase 4 pipeline: validation, final detection summary, export, checksums, reproducibility, packaging', { timeout: 1200000 }, async (t) => {
  await dropAll();
  t.after(dropAll);
  const dir = tmp('data');
  const common = ['--scale=starter'];
  ok(run('generator/edgeCases/index.js', [...common, `--source-database=${BASE}`, `--database=${EDGE}`, `--dataset-dir=${dir}`, `--baseline-report-dir=${path.join(dir, 'gen')}`]), 'injection');
  ok(run('detector/index.js', [`--database=${EDGE}`, `--dataset-dir=${dir}`]), 'detection');
  ok(run('evaluation/evaluateDetection.js', [...common, `--database=${EDGE}`, `--dataset-dir=${dir}`]), 'evaluation');
  const truth = readJson(dir, 'ground_truth.json');

  await t.test('final detection summary re-checks the Phase 3 report and passes', () => {
    ok(run('packaging/finalDetectionSummary.js', [`--database=${EDGE}`, `--dataset-dir=${dir}`]), 'final summary');
    const s = readJson(dir, 'final_detection_summary.json');
    assert.equal(s.status, 'PASS');
    assert.equal(s.totals.planted, truth.total_issues);
    assert.deepEqual([s.totals.fp, s.totals.fn], [0, 0]);
    assert.deepEqual(s.metric_differences, []);
    assert.equal(s.integrity_checks.length, 8);
    assert.ok(s.integrity_checks.every((c) => c.result === 'PASS'));
    assert.ok(fs.existsSync(path.join(dir, 'final_detection_summary.md')));
  });

  await t.test('final detection summary notices an edited answer key', () => {
    const copy = tmp('edited');
    for (const f of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, f)).isFile()) fs.copyFileSync(path.join(dir, f), path.join(copy, f));
    const edited = readJson(copy, 'ground_truth.json');
    edited.issues.pop(); // someone removes a label so the score looks different
    fs.writeFileSync(path.join(copy, 'ground_truth.json'), JSON.stringify(edited, null, 2));
    const res = run('packaging/finalDetectionSummary.js', [`--database=${EDGE}`, `--dataset-dir=${copy}`]);
    assert.notEqual(res.status, 0);
    const s = readJson(copy, 'final_detection_summary.json');
    assert.equal(s.status, 'FAIL');
    assert.equal(s.integrity_checks.find((c) => /not modified/.test(c.name)).result, 'FAIL');
  });

  await t.test('validation: planted anomalies are EXPECTED exceptions, nothing is unexpected, nothing is hidden', () => {
    ok(run('validation/index.js', [`--database=${EDGE}`, `--dataset-dir=${dir}`]), 'validation');
    const s = readJson(dir, 'validation_summary.json');
    const r = readJson(dir, 'validation_report.json');
    assert.equal(s.validation_status, 'PASSED');
    assert.equal(s.failed_checks, 0);
    assert.equal(s.unexpected_data_errors, 0);
    assert.ok(s.total_validation_checks >= 150);
    assert.equal(s.total_customers, 50);
    assert.equal(s.total_individual_customers + s.total_company_customers, 50);
    assert.equal(s.total_documents, 152);
    assert.equal(s.total_review_cases, 15);
    assert.equal(s.expected_planted_anomalies.labelled_issues, truth.total_issues);
    // the three checks that planted errors legitimately break are listed, with the issue IDs, not excluded
    const expected = r.checks.filter((c) => c.status === 'PASS_WITH_EXPECTED_EXCEPTIONS');
    assert.deepEqual(expected.map((c) => c.planted_issue_types[0]).sort(), ['CLOSED_WITHOUT_RESOLUTION', 'EXPIRED_DOCUMENT_MARKED_VALID', 'OWNERSHIP_OVER_100']);
    for (const c of expected) {
      assert.ok(c.expected > 0 && c.unexpected === 0);
      const ids = new Set(truth.issues.filter((i) => i.issue_type === c.planted_issue_types[0]).map((i) => i.issue_id));
      assert.ok(c.expected_issue_ids.every((id) => ids.has(id)));
    }
    for (const group of ['Primary keys', 'Foreign keys', 'Customers', 'Documents', 'Verifications', 'Ownership', 'Risk', 'Review cases', 'Alerts', 'Audit', 'Ground truth']) assert.ok(r.checks.some((c) => c.group === group), `${group} checks exist`);
    assert.ok(r.checks.filter((c) => c.group === 'Foreign keys').length >= 30, 'one check per foreign key plus the polymorphic references');
  });

  await t.test('validation: a clean baseline has no violations at all', () => {
    const empty = tmp('baseline-validate');
    run('validation/index.js', [`--database=${BASE}`, `--dataset-dir=${empty}`]);
    const r = readJson(empty, 'validation_report.json');
    const failing = r.checks.filter((c) => c.status === 'FAIL').map((c) => c.name);
    assert.deepEqual(failing, ['The answer key (ground_truth.json) is present and readable'], 'only the missing answer key (this folder has none)');
    assert.equal(r.checks.filter((c) => c.expected > 0).length, 0);
  });

  await t.test('validation: accidental corruption is reported as UNEXPECTED, even when it looks like a planted type', async () => {
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${BAD}" WITH (FORCE)`));
    await admin((c) => c.query(`CREATE DATABASE "${BAD}" TEMPLATE "${EDGE}"`));
    const planted = new Set(truth.issues.map((i) => i.entity_id));
    const [doc] = await query(BAD, `SELECT d.id, d.business_id, d.submission_date::text AS sub FROM "Document" d JOIN LATERAL (SELECT status FROM "Verification" v WHERE v.document_id = d.id ORDER BY v.id DESC LIMIT 1) v ON true
        WHERE d.expiry_date > DATE '${REF}' + 120 AND v.status = 'Verified' AND d.business_id <> ALL($1) ORDER BY d.id LIMIT 1`, [[...planted]]);
    assert.ok(doc, 'an unplanted verified document exists');
    await query(BAD, `UPDATE "Document" SET expiry_date = $1::date - 20, issue_date = $1::date - 400 WHERE id = $2`, [doc.sub, doc.id]); // the same shape as a planted issue, but NOT labelled
    const [owner] = await query(BAD, `SELECT b.id FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE c.customer_id <> ALL($1) ORDER BY b.id LIMIT 1`, [[...planted]]);
    await query(BAD, `ALTER TABLE "BeneficialOwner" DISABLE TRIGGER "BeneficialOwner_mirror_update"`);
    await query(BAD, `UPDATE "BeneficialOwner" SET ownership_percentage = 3 WHERE id = $1`, [owner.id]); // total no longer 100
    await query(BAD, `UPDATE "Customer" SET email = 'not-an-email' WHERE id = (SELECT min(id) FROM "Customer")`);
    const out = tmp('bad');
    fs.copyFileSync(path.join(dir, 'ground_truth.json'), path.join(out, 'ground_truth.json'));
    const res = run('validation/index.js', [`--database=${BAD}`, `--dataset-dir=${out}`]);
    assert.notEqual(res.status, 0, 'accidental corruption fails the run');
    const r = readJson(out, 'validation_report.json');
    const failed = r.checks.filter((c) => c.status === 'FAIL').map((c) => c.name);
    assert.ok(failed.some((n) => /not verified after it has expired/.test(n)), failed.join(' | '));
    assert.ok(failed.some((n) => /E-mail and phone/.test(n)));
    assert.ok(failed.some((n) => /must total 100|mirror the owner rows|No unlabelled|Ownership below/.test(n)));
    const expiredCheck = r.checks.find((c) => /not verified after it has expired/.test(c.name));
    assert.ok(expiredCheck.expected >= 1 && expiredCheck.unexpected === 1, 'the labelled ones stay expected, the unlabelled one is unexpected');
    assert.equal(expiredCheck.unexpected_examples[0].record, doc.business_id);
    await admin((c) => c.query(`DROP DATABASE IF EXISTS "${BAD}" WITH (FORCE)`));
  });

  const pkg = tmp('package');
  await t.test('export: every table in CSV, JSON and SQL, masked, ordered, separate from the answer key', async () => {
    ok(run('exporter/exportDataset.js', [`--database=${EDGE}`, `--out=${pkg}`, `--report-dir=${dir}`]), 'export');
    const tables = await query(EDGE, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' AND table_name <> 'SystemSetting' ORDER BY 1`); // SystemSetting = Phase 6 application settings, deliberately not part of the KYC dataset
    const report = readJson(dir, 'export_report.json');
    assert.deepEqual(report.tables.map((x) => x.table).sort(), tables.map((x) => x.table_name).sort(), 'no table is left out');
    for (const x of report.tables) {
      const [n] = await query(EDGE, `SELECT count(*)::int AS n FROM "${x.table}"`);
      assert.equal(x.rows, n.n, `${x.table} row count`);
      assert.ok(fs.existsSync(path.join(pkg, 'csv', `${x.file}.csv`)) && fs.existsSync(path.join(pkg, 'json', `${x.file}.json`)));
      assert.equal(readJson(pkg, `json/${x.file}.json`).length, x.rows);
    }
    for (const f of ['customers', 'documents', 'verifications', 'review_cases', 'beneficial_owners', 'company_ownership', 'alerts', 'audit_events', 'customer_types', 'kyc_requirements', 'risk_ratings']) assert.ok(fs.existsSync(path.join(pkg, 'csv', `${f}.csv`)), f);
    // stable ordering: ids ascend
    const docs = readJson(pkg, 'json/documents.json');
    assert.deepEqual(docs.map((d) => d.id), [...docs.map((d) => d.id)].sort((x, y) => x - y));
    // sensitive values are masked, not copied
    const customers = readJson(pkg, 'json/customers.json');
    for (const c of customers) {
      assert.match(c.pan_number, /^X+[A-Z0-9]{4}$/);
      assert.equal(c.pan_hash.length, 24);
      assert.ok(!/\./.test(c.pan_number), 'no ciphertext');
    }
    assert.ok(docs.every((d) => d.document_number === null || /^X+[A-Za-z0-9-]{4}$/.test(d.document_number)), 'document numbers are masked');
    // dates and timestamps are ISO and the answer key is not in the operational files
    assert.match(customers[0].created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(docs[0].issue_date, /^\d{4}-\d{2}-\d{2}$/);
    for (const d of ['csv', 'json', 'sql']) for (const f of fs.readdirSync(path.join(pkg, d))) assert.ok(!/ISSUE-\d{6}|expected_detection|ground_truth/i.test(fs.readFileSync(path.join(pkg, d, f), 'utf8')), `${d}/${f}`);
    assert.ok(!fs.existsSync(path.join(pkg, 'ground_truth.json')), 'the answer key is not part of the export step');
    const text = fs.readFileSync(path.join(pkg, 'csv/customers.csv'), 'utf8');
    assert.ok(!text.includes('\r') && text.charCodeAt(0) !== 0xfeff, 'LF line endings, no byte-order mark');
  });

  await t.test('export: the SQL loads into an empty database and the detector gives the same result on it', () => {
    const res = run('exporter/verifyExport.js', [`--dir=${pkg}`, `--dataset-dir=${dir}`]);
    ok(res, 'export check');
    assert.match(res.stdout, /VERIFIED/);
    assert.match(res.stdout, /identical to the saved results: true/);
    const schema = fs.readFileSync(path.join(pkg, 'sql/schema.sql'), 'utf8');
    assert.ok(/CREATE TABLE "Customer"/.test(schema) && /PRIMARY KEY/.test(schema) && /FOREIGN KEY/.test(schema) && /CREATE UNIQUE INDEX/.test(schema) && /CHECK/.test(schema) && /CREATE TRIGGER/.test(schema));
    assert.ok(!/ReviewCase_resolution_notes_check/.test(schema), 'the schema reflects the live database, including the one relaxed check');
  });

  await t.test('export + checksums are repeatable: exporting again gives byte-identical files', () => {
    const again = tmp('again');
    ok(run('exporter/exportDataset.js', [`--database=${EDGE}`, `--out=${again}`, `--report-dir=${tmp('rep')}`]), 'second export');
    const hashes = (d) => buildChecksumsText(d).text;
    assert.equal(hashes(again), hashes(pkg));
    const txt = hashes(pkg);
    assert.ok(/[0-9a-f]{64}  csv\/customers\.csv/.test(txt) && /[0-9a-f]{64}  sql\/seed\.sql/.test(txt));
  });

  await t.test('reproducibility: two complete runs give identical logical data, ground truth, detection results and checksums', () => {
    const rdir = tmp('repro');
    ok(run('reproducibility/runReproducibility.js', ['--scale=starter', `--dataset-dir=${rdir}`, `--export-dir=${pkg}`]), 'reproducibility');
    const r = readJson(rdir, 'reproducibility_report.json');
    assert.equal(r.overall_result, 'REPRODUCIBLE: PASS');
    assert.equal(r.seed, 20261022);
    assert.deepEqual([r.comparison.record_counts.matching, r.comparison.primary_ids.matching, r.comparison.foreign_keys.matching, r.comparison.field_values.logical_identical, r.comparison.field_values.strict_identical, r.comparison.derived_values.matching], [true, true, true, true, true, true]);
    assert.deepEqual([r.comparison.edge_case_records.ground_truth_identical, r.comparison.edge_case_records.injected_changes_identical, r.comparison.detection_results.identical, r.comparison.checksums.matching], [true, true, true, true]);
    assert.ok(r.comparison.foreign_keys.columns_compared >= 30);
    assert.equal(r.differences.count, 0);
    assert.deepEqual(r.run_a.record_counts, r.run_b.record_counts);
    assert.equal(r.matches_exported_dataset.matching, true, 'the exported dataset equals the reproduced runs');
    fs.copyFileSync(path.join(rdir, 'reproducibility_report.json'), path.join(dir, 'reproducibility_report.json'));
  });

  await t.test('packaging refuses to package without a passing reproducibility result, then packages and verifies', () => {
    const out = tmp('final');
    const lacking = tmp('lacking');
    for (const f of fs.readdirSync(dir)) if (fs.statSync(path.join(dir, f)).isFile() && f !== 'reproducibility_report.json') fs.copyFileSync(path.join(dir, f), path.join(lacking, f));
    const refused = run('packaging/packageDataset.js', ['--scale=starter', `--database=${EDGE}`, `--dataset-dir=${lacking}`, `--out=${out}`, '--no-repo-docs']);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr + refused.stdout, /reproducibility_report\.json/);

    ok(run('validation/index.js', [`--database=${EDGE}`, `--dataset-dir=${dir}`]), 'validation before packaging');
    ok(run('packaging/finalDetectionSummary.js', [`--database=${EDGE}`, `--dataset-dir=${dir}`]), 'summary before packaging');
    const res = run('packaging/packageDataset.js', ['--scale=starter', `--database=${EDGE}`, `--dataset-dir=${dir}`, `--out=${out}`, '--no-repo-docs']);
    ok(res, 'packaging');
    for (const f of ['csv/customers.csv', 'json/customers.json', 'sql/schema.sql', 'sql/seed.sql', 'documentation/README.md', 'documentation/data_dictionary.md', 'documentation/database_relationships.md', 'documentation/id_conventions.md', 'documentation/edge_case_rules.md', 'documentation/source_manifest.md',
      'ground_truth.json', 'detection_report.json', 'reproducibility_report.json', 'validation_summary.json', 'final_detection_summary.json', 'checksums.txt']) assert.ok(fs.existsSync(path.join(out, f)), f);
    const s = readJson(out, 'validation_summary.json');
    assert.deepEqual([s.reproducibility_status, s.export_status, s.checksum_status, s.validation_status], ['PASS', 'VERIFIED', 'GENERATED', 'PASSED']);
    assert.equal(verifyChecksums(out).status, 'VERIFIED');
    const manifest = fs.readFileSync(path.join(out, 'documentation/source_manifest.md'), 'utf8');
    assert.match(manifest, /Every record in this dataset is synthetic/);
    assert.match(manifest, /20261022/);
    assert.match(manifest, /2026-10-31/);
    assert.match(manifest, /no claim of regulatory compliance/i);
    assert.match(manifest, /Generator version/);
    // the answer key is section 2 of the checksum file, never section 1
    const sums = fs.readFileSync(path.join(out, 'checksums.txt'), 'utf8');
    assert.ok(sums.indexOf('ground_truth.json') > sums.indexOf('# [2]') && sums.indexOf('ground_truth.json') < sums.indexOf('# [3]'));
    // any edit is caught
    fs.appendFileSync(path.join(out, 'csv/customers.csv'), 'x\n');
    assert.equal(verifyChecksums(out).status, 'MISMATCH');
  });
});
