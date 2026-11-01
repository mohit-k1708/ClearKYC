/**
 * Phase 3: edge-case injection, ground truth, independent detection and measurement.
 *
 * Unit tests cover the pure pieces (name comparison, metrics). The pipeline tests run the real commands at the "starter" scale in
 * CHILD PROCESSES against their own test databases (never the development database) and then check every planted case in the data.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..', '..');
const BASE_DB = 'clearkyc_test_edge_base';
const EDGE_DB = 'clearkyc_test_edge_edge';
const REF = '2026-10-31';

const { compareNames } = require('../../detector/nameMatcher');
const nameConfig = require('../../detector/config/nameMatching');
const { computeMetrics } = require('../../evaluation/evaluateDetection');
const { connectionString } = require('../../detector');

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `edge-${label}-`));
const readJson = (dir, file) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
function run(script, args) {
  return spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 280000 });
}
const inject = (dir, extra = []) => run('generator/edgeCases/index.js', ['--scale=starter', `--source-database=${BASE_DB}`, `--database=${EDGE_DB}`, `--dataset-dir=${dir}`, `--baseline-report-dir=${path.join(dir, 'baseline_reports')}`, ...extra]);
const detect = (dir) => run('detector/index.js', [`--database=${EDGE_DB}`, `--dataset-dir=${dir}`]);
const evaluate = (dir) => run('evaluation/evaluateDetection.js', [`--database=${EDGE_DB}`, `--dataset-dir=${dir}`]);

async function dropDatabases() {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const admin = new Client({ connectionString: connectionString('postgres') });
  await admin.connect();
  try {
    for (const name of [BASE_DB, EDGE_DB]) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

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
test('name comparison: legitimate variants match, a different name does not', () => {
  const same = (a, b, isCompany = false) => compareNames(a, b, { isCompany }).match;
  assert.ok(same('Amit Sharma', 'Amit Sharma'));
  assert.ok(same('Amit Sharma', 'AMIT SHARMA'), 'capitals');
  assert.ok(same('Amit Sharma', 'Mr. Amit Sharma'), 'title');
  assert.ok(same('Amit Sharma', 'A. Sharma'), 'initial');
  assert.ok(same('Amit Sharma', 'Sharma Amit'), 'reversed order');
  assert.ok(same('Amit Sharma', 'Amit K Sharma'), 'middle initial');
  assert.ok(same('Amit Sharma', 'Amit Sharmaa'), 'one-letter typo');
  assert.ok(same('Amit  Sharma', 'Amit Sharma'), 'spacing');
  assert.ok(same('Bluewave Technologies Pvt Ltd', 'BLUEWAVE TECHNOLOGIES PRIVATE LIMITED', true), 'legal form written out');
  assert.ok(same('Bluewave Technologies Pvt Ltd', 'Bluewave Technologies Pvt. Ltd.', true));
  assert.equal(same('Amit Sharma', 'Rahul Sharma'), false, 'the example from the brief');
  assert.equal(same('Amit Sharma', 'Priya Nair'), false);
  assert.equal(same('Amit Sharma', 'A. S.'), false, 'two bare initials prove nothing');
  assert.equal(same('Bluewave Technologies Pvt Ltd', 'Orchid Foods Ltd', true), false);
});

test('name comparison: exact mode is strict, normalised mode is the default, the rule is configurable', () => {
  assert.equal(nameConfig.mode, 'normalized');
  const exact = { ...nameConfig, mode: 'exact' };
  assert.equal(compareNames('Amit Sharma', 'Amit Sharma', { config: exact }).kind, 'EXACT');
  assert.equal(compareNames('Amit Sharma', 'AMIT SHARMA', { config: exact }).match, false);
  assert.equal(compareNames('Amit Sharma', 'AMIT SHARMA').kind, 'NORMALIZED');
  assert.equal(compareNames('Amit Sharma', 'A. Sharma').kind, 'INITIALS');
  const noInitials = { ...nameConfig, allowInitials: false };
  assert.equal(compareNames('Amit Sharma', 'A. Sharma', { config: noInitials }).match, false);
  const strict = { ...nameConfig, similarityThreshold: 0.99 };
  assert.equal(compareNames('Amit Sharma', 'Amit Sharmaa', { config: strict }).match, false, 'a tighter threshold turns a typo into a mismatch');
});

test('every baseline name variant the generator can produce is accepted by the comparison', () => {
  const { personName, companyName } = require('../../generator/utils/nameVariants');
  const { createRng } = require('../../generator/utils/seededRandom');
  const { FIRST, LAST } = require('../../generator/generators/customerGenerator');
  const r = createRng(3);
  for (let i = 0; i < 4000; i += 1) {
    const full = `${r.pick(FIRST)} ${r.pick(LAST)}`;
    const variant = personName(full, r);
    assert.ok(compareNames(full, variant).match, `"${full}" vs "${variant}"`);
  }
  for (let i = 0; i < 1000; i += 1) {
    const full = `${r.pick(['Bluewave', 'Orchid', 'Nimbus', 'Cedar'])} ${r.pick(['Technologies', 'Foods', 'Retail'])} ${r.pick(['Pvt Ltd', 'Ltd', 'LLP'])}`;
    const variant = companyName(full, r);
    assert.ok(compareNames(full, variant, { isCompany: true }).match, `"${full}" vs "${variant}"`);
  }
});

test('measurement: TP / FP / FN / TN, precision, recall, F1, detection rate', () => {
  const issues = [
    { issue_id: 'I1', issue_type: 'A', entity_type: 'Document', entity_id: 'D1' },
    { issue_id: 'I2', issue_type: 'A', entity_type: 'Document', entity_id: 'D2' },
    { issue_id: 'I3', issue_type: 'B', entity_type: 'Customer', entity_id: 'C1' },
    { issue_id: 'I4', issue_type: 'B', entity_type: 'Customer', entity_id: 'C2' },
  ];
  const detections = [
    { detection_id: 'X1', issue_type: 'A', entity_type: 'Document', entity_id: 'D1' }, // TP
    { detection_id: 'X2', issue_type: 'A', entity_type: 'Document', entity_id: 'D1' }, // the same unit again: counted once
    { detection_id: 'X3', issue_type: 'A', entity_type: 'Document', entity_id: 'D9' }, // FP
    { detection_id: 'X4', issue_type: 'B', entity_type: 'Customer', entity_id: 'C1' }, // TP
    { detection_id: 'X5', issue_type: 'B', entity_type: 'Document', entity_id: 'C2' }, // same id, other entity type: not the planted unit -> FP, and C2 stays FN
  ];
  const m = computeMetrics(issues, detections, { A: 10, B: 6 });
  assert.deepEqual([m.by_issue_type.A.tp, m.by_issue_type.A.fp, m.by_issue_type.A.fn, m.by_issue_type.A.tn], [1, 1, 1, 7]);
  assert.deepEqual([m.by_issue_type.B.tp, m.by_issue_type.B.fp, m.by_issue_type.B.fn, m.by_issue_type.B.tn], [1, 1, 1, 3]);
  assert.deepEqual([m.totals.tp, m.totals.fp, m.totals.fn, m.totals.tn], [2, 2, 2, 10]);
  assert.equal(m.totals.precision, 0.5);
  assert.equal(m.totals.recall, 0.5);
  assert.equal(m.totals.f1_score, 0.5);
  assert.equal(m.totals.detection_rate_percent, 50);
  assert.deepEqual(m.missed_issues.map((x) => x.issue_id).sort(), ['I2', 'I4']);
  assert.equal(m.false_positives.length, 2);
});

test('measurement: zero denominators never produce NaN', () => {
  const none = computeMetrics([], [], {});
  assert.deepEqual([none.totals.precision, none.totals.recall, none.totals.f1_score, none.totals.detection_rate_percent], [0, 0, 0, 0]);
  const onlyFalse = computeMetrics([], [{ detection_id: 'X', issue_type: 'A', entity_type: 'Document', entity_id: 'D' }], { A: 5 });
  assert.equal(onlyFalse.totals.precision, 0);
  assert.equal(onlyFalse.totals.recall, 0);
  assert.equal(onlyFalse.totals.tn, 4);
  const missedAll = computeMetrics([{ issue_id: 'I', issue_type: 'A', entity_type: 'Document', entity_id: 'D' }], [], {});
  assert.equal(missedAll.totals.recall, 0);
  assert.equal(missedAll.totals.tn, null, 'no population => no true negatives claimed');
  for (const v of Object.values(missedAll.totals)) assert.ok(v === null || Number.isFinite(v));
});

test('the detector never mentions the answer key (static check) and the application never exposes it', () => {
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      if (f.name === 'node_modules') continue;
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(js|jsx|json)$/.test(f.name)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'detector'));
  assert.ok(files.length >= 8);
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    assert.ok(!/ground[_-]?truth/i.test(text), `${path.relative(ROOT, f)} mentions the answer key`);
    assert.ok(!/edge_case_manifest|issue_id|ISSUE-/.test(text), `${path.relative(ROOT, f)} touches planted-issue data`);
    assert.ok(!/generator\//.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')), `${path.relative(ROOT, f)} imports the generator`);
  }
  // nothing served by the API or the frontend can reveal the labels
  const served = [];
  for (const dir of [path.join(ROOT, 'server', 'src'), path.join(ROOT, 'client', 'src')]) {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) stack.push(p);
        else served.push(p);
      }
    }
  }
  for (const f of served) assert.ok(!/ground[_-]?truth|edge_case_manifest/i.test(fs.readFileSync(f, 'utf8')), `${path.relative(ROOT, f)} refers to ground truth`);
});

// ---------------------------------------------------------------------------------------------------------------------------
// Pipeline tests (starter scale, own databases)
// ---------------------------------------------------------------------------------------------------------------------------
test('edge cases: injection, independent detection and measurement', { timeout: 900000 }, async (t) => {
  await dropDatabases();
  t.after(dropDatabases);
  const dir = tmp('a');

  const injected = inject(dir);
  assert.equal(injected.status, 0, injected.stdout + injected.stderr);
  const detected = detect(dir);
  assert.equal(detected.status, 0, detected.stdout + detected.stderr);
  const evaluated = evaluate(dir);
  assert.equal(evaluated.status, 0, evaluated.stdout + evaluated.stderr);

  const truth = readJson(dir, 'ground_truth.json');
  const manifest = readJson(dir, 'edge_case_manifest.json');
  const found = readJson(dir, 'detection_results.json');
  const report = readJson(dir, 'detection_report.json');
  const issuesOf = (type) => truth.issues.filter((i) => i.issue_type === type);

  await t.test('the answer key lists every planted issue with a unique ID, severity and rule', () => {
    assert.equal(truth.seed, 20261022);
    assert.equal(truth.total_issues, truth.issues.length);
    assert.equal(new Set(truth.issues.map((i) => i.issue_id)).size, truth.issues.length);
    assert.equal(new Set(truth.issues.map((i) => `${i.entity_type}|${i.entity_id}|${i.issue_type}`)).size, truth.issues.length, 'one entry per record + issue type');
    for (const type of ['EXPIRED_DOCUMENT_MARKED_VALID', 'APPROVED_WITH_MISSING_EVIDENCE', 'OWNERSHIP_OVER_100', 'CLOSED_WITHOUT_RESOLUTION', 'DOCUMENT_REUSED_ACROSS_CUSTOMERS', 'DOCUMENT_NAME_MISMATCH']) {
      assert.ok(issuesOf(type).length >= 1, `${type} was planted`);
      assert.equal(manifest.plan[type].shortfall, 0, `${type} planted as planned`);
    }
    for (const i of truth.issues) {
      assert.match(i.issue_id, /^ISSUE-\d{6}$/);
      assert.equal(i.expected_detection, true);
      assert.ok(['HIGH', 'MEDIUM', 'LOW'].includes(i.severity));
      assert.ok(i.expected_detection_rule && i.injection_method && i.description);
    }
    assert.equal(manifest.baseline_check.detections_in_baseline, 0, 'the baseline was clean before anything was planted');
  });

  await t.test('1. expired document marked Verified: expired, still Verified, verified after expiry, history preserved', async () => {
    for (const i of issuesOf('EXPIRED_DOCUMENT_MARKED_VALID')) {
      const [d] = await query(EDGE_DB, `SELECT d.id, d.expiry_date::text AS expiry, v.status, v.verification_date::date::text AS verified_on FROM "Document" d JOIN LATERAL (SELECT status, verification_date FROM "Verification" x WHERE x.document_id = d.id ORDER BY x.id DESC LIMIT 1) v ON true WHERE d.business_id = $1`, [i.entity_id]);
      assert.ok(d.expiry < REF && d.status === 'Verified' && d.verified_on > d.expiry, `${i.entity_id}: ${JSON.stringify(d)}`);
      const [before] = await query(BASE_DB, 'SELECT count(*)::int AS n, string_agg(status, \',\' ORDER BY id) AS s FROM "Verification" WHERE document_id = $1', [d.id]);
      const [after] = await query(EDGE_DB, 'SELECT count(*)::int AS n, string_agg(status, \',\' ORDER BY id) AS s FROM "Verification" WHERE document_id = $1', [d.id]);
      assert.deepEqual(after, before, 'verification history untouched');
      assert.ok(found.detections.some((x) => x.entity_id === i.entity_id && x.issue_type === i.issue_type));
    }
  });

  await t.test('2. customer approved with missing mandatory evidence: judged against the evidence at the time of approval', async () => {
    for (const i of issuesOf('APPROVED_WITH_MISSING_EVIDENCE')) {
      const change = manifest.changes.find((c) => c.issue_id === i.issue_id);
      const rows = await query(EDGE_DB, `SELECT d.id, d.status FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE c.customer_id = $1 AND d.document_type = $2`, [i.entity_id, change.after.gap]);
      assert.ok(rows.every((r) => r.status !== 'Verified'), `${i.entity_id}: ${change.after.gap} must not be verified`);
      const [approval] = await query(EDGE_DB, `SELECT decision FROM "OnboardingDecision" d JOIN "Customer" c ON c.id = d.customer_id WHERE c.customer_id = $1 ORDER BY d.id DESC LIMIT 1`, [i.entity_id]);
      assert.equal(approval.decision, 'Approved');
      assert.ok(found.detections.some((x) => x.entity_id === i.entity_id && x.issue_type === i.issue_type));
    }
  });

  await t.test('3. ownership above 100%: owners add up to more than 100 and the original owners are preserved', async () => {
    for (const i of issuesOf('OWNERSHIP_OVER_100')) {
      const [now] = await query(EDGE_DB, `SELECT sum(b.ownership_percentage)::float AS total FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE c.customer_id = $1`, [i.entity_id]);
      assert.ok(now.total > 100, `${i.entity_id} totals ${now.total}`);
      const baseOwners = await query(BASE_DB, `SELECT b.id, b.full_name, b.ownership_percentage::float AS pct FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE c.customer_id = $1 ORDER BY b.id`, [i.entity_id]);
      const edgeOwners = await query(EDGE_DB, `SELECT b.id, b.full_name, b.ownership_percentage::float AS pct FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE c.customer_id = $1 ORDER BY b.id`, [i.entity_id]);
      assert.ok(edgeOwners.length >= baseOwners.length, 'no owner was removed');
      assert.ok(baseOwners.every((b) => edgeOwners.some((e) => e.id === b.id && e.full_name === b.full_name)), 'every original owner is still there');
      if (i.injection_method === 'inflate_share') {
        const history = await query(EDGE_DB, `SELECT ownership_percentage::float AS pct, effective_to::text AS ended FROM "CompanyOwnership" o JOIN "Customer" c ON c.id = o.company_customer_id WHERE c.customer_id = $1 AND o.effective_to IS NOT NULL`, [i.entity_id]);
        assert.ok(history.length >= 1, 'the earlier share is kept as history in the ownership bridge');
      }
      assert.ok(found.detections.some((x) => x.entity_id === i.entity_id && x.issue_type === i.issue_type));
    }
  });

  await t.test('4. review closed without resolution: Closed, closed date present, notes empty and NOT silently repaired', async () => {
    for (const i of issuesOf('CLOSED_WITHOUT_RESOLUTION')) {
      assert.match(i.entity_id, /^REV-CUS-\d{6}-\d{4}/);
      const [c] = await query(EDGE_DB, 'SELECT status, closed_at IS NOT NULL AS has_closed, coalesce(btrim(resolution_notes), \'\') AS notes FROM "ReviewCase" WHERE review_code = $1', [i.entity_id]);
      assert.deepEqual(c, { status: 'Closed', has_closed: true, notes: '' });
      assert.ok(found.detections.some((x) => x.entity_id === i.entity_id && x.issue_type === i.issue_type));
    }
    assert.ok(manifest.relaxed_constraints_in_edge_database_only.some((r) => r.constraint === 'ReviewCase_resolution_notes_check'), 'the relaxed guard is documented');
    const [baseGuard] = await query(BASE_DB, `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'ReviewCase_resolution_notes_check'`);
    const [edgeGuard] = await query(EDGE_DB, `SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'ReviewCase_resolution_notes_check'`);
    assert.deepEqual([baseGuard.n, edgeGuard.n], [1, 0], 'only the isolated edge database lost the guard');
  });

  await t.test('5. same document used by unrelated customers: shared number / file, no ownership link; both customers preserved', async () => {
    for (const i of issuesOf('DOCUMENT_REUSED_ACROSS_CUSTOMERS')) {
      const [copy] = await query(EDGE_DB, 'SELECT d.id, d.customer_id, d.document_number_hash AS hash, d.file_reference AS file FROM "Document" d WHERE d.business_id = $1', [i.entity_id]);
      const others = await query(EDGE_DB, 'SELECT d.id, d.business_id, d.customer_id FROM "Document" d WHERE d.id <> $1 AND d.customer_id <> $2 AND ((d.document_number_hash IS NOT NULL AND d.document_number_hash = $3) OR (d.file_reference IS NOT NULL AND d.file_reference = $4)) ORDER BY d.id', [copy.id, copy.customer_id, copy.hash, copy.file]);
      assert.ok(others.length >= 1, `${i.entity_id} shares a number or file with another customer`);
      const link = await query(EDGE_DB, `SELECT 1 FROM "CompanyOwnership" a JOIN "CompanyOwnership" b ON a.person_ref = b.person_ref WHERE a.company_customer_id = $1 AND b.company_customer_id = $2`, [copy.customer_id, others[0].customer_id]);
      assert.equal(link.length, 0, 'the two customers are not related');
      assert.ok(others[0].id < copy.id, 'the earlier document is the original');
      const [n] = await query(EDGE_DB, 'SELECT count(*)::int AS n FROM "Customer" WHERE id = ANY($1)', [[copy.customer_id, others[0].customer_id]]);
      assert.equal(n.n, 2);
      assert.ok(found.detections.some((x) => x.entity_id === i.entity_id && x.issue_type === i.issue_type));
    }
  });

  await t.test('6. name mismatch: the name on the document is clearly different from the registered name', async () => {
    for (const i of issuesOf('DOCUMENT_NAME_MISMATCH')) {
      const [d] = await query(EDGE_DB, 'SELECT d.name_on_document AS on_doc, c.full_name AS registered FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.business_id = $1', [i.entity_id]);
      assert.notEqual(d.on_doc, d.registered);
      assert.equal(compareNames(d.registered, d.on_doc).match, false, `${d.registered} vs ${d.on_doc}`);
      const hit = found.detections.find((x) => x.entity_id === i.entity_id && x.issue_type === i.issue_type);
      assert.ok(hit && /manual review/.test(hit.description), 'flagged for manual review, not declared fraud');
    }
  });

  await t.test('7. valid records are not flagged: no false positives, legitimate look-alikes left alone', async () => {
    assert.equal(report.totals.fp, 0, JSON.stringify(report.false_positives));
    assert.equal(report.totals.fn, 0, JSON.stringify(report.missed_issues));
    assert.equal(report.totals.tp, truth.total_issues);
    assert.equal(report.totals.precision, 1);
    assert.equal(report.totals.recall, 1);
    const flagged = new Set(found.detections.map((d) => `${d.issue_type}|${d.entity_id}`));
    // groups of related companies sharing an address proof
    assert.ok(manifest.negative_controls.shared_documents_between_related_companies.length >= 1);
    for (const s of manifest.negative_controls.shared_documents_between_related_companies) {
      assert.ok(!flagged.has(`DOCUMENT_REUSED_ACROSS_CUSTOMERS|${s.shared_by_document}`), `${s.shared_by_document} is a legitimate shared document`);
      const rows = await query(EDGE_DB, 'SELECT count(DISTINCT customer_id)::int AS n FROM "Document" WHERE business_id = ANY($1)', [[s.original_document, s.shared_by_document]]);
      assert.equal(rows[0].n, 2);
    }
    // name variants, and documents that expired after a correct verification
    const look = manifest.negative_controls.look_alikes_in_dataset;
    assert.ok(look.documents_with_a_legitimate_name_variant > 0);
    assert.ok(look.documents_expired_after_a_correct_verification > 0 || look.approvals_total > 0);
    const planted = new Set(truth.issues.map((i) => `${i.issue_type}|${i.entity_id}`));
    for (const d of found.detections) assert.ok(planted.has(`${d.issue_type}|${d.entity_id}`), `${d.issue_type} ${d.entity_id} was flagged but not planted`);
    // a clean baseline is flagged nowhere
    const baseline = run('detector/index.js', [`--database=${BASE_DB}`, `--dataset-dir=${tmp('base')}`]);
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /TOTAL\s+0\b/);
  });

  await t.test('8. ground truth stays separate: in files only, never in the database', async () => {
    assert.ok(fs.existsSync(path.join(dir, 'ground_truth.json')));
    const tables = await query(EDGE_DB, `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%truth%' OR table_name ILIKE '%planted%' OR table_name ILIKE '%label%' OR table_name ILIKE '%edgecase%')`);
    const columns = await query(EDGE_DB, `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND (column_name ILIKE '%planted%' OR column_name ILIKE '%injected%' OR column_name ILIKE '%ground%' OR column_name ILIKE 'issue_id')`);
    assert.deepEqual([tables.length, columns.length], [0, 0]);
    const text = JSON.stringify(found);
    assert.ok(!/ISSUE-\d{6}/.test(text) && !/injection_method|expected_detection/.test(text), 'the detector output carries no answer-key fields');
  });

  await t.test('9 + 11. the detector works without the answer key and gives identical results every time', () => {
    const emptyDir = tmp('nokey');
    const again = detect(emptyDir);
    assert.equal(again.status, 0, again.stderr);
    assert.ok(!fs.existsSync(path.join(emptyDir, 'ground_truth.json')));
    const second = readJson(emptyDir, 'detection_results.json');
    assert.deepEqual(second.detections, found.detections, 'same data => identical detections (ids, text, timestamps)');
  });

  await t.test('10. repeated injection with the same seed plants the same anomalies; another seed plants different ones', () => {
    const dir2 = tmp('b');
    const again = inject(dir2);
    assert.equal(again.status, 0, again.stdout + again.stderr);
    assert.deepEqual(readJson(dir2, 'ground_truth.json'), truth);
    const m2 = readJson(dir2, 'edge_case_manifest.json');
    assert.equal(m2.edge_database_checksums.dataset, manifest.edge_database_checksums.dataset, 'the modified database is identical too');
    assert.deepEqual(m2.changes, manifest.changes);
    // detection over the re-planted data is identical as well
    assert.equal(detect(dir2).status, 0);
    assert.deepEqual(readJson(dir2, 'detection_results.json').detections, found.detections);

    const dir3 = tmp('c');
    const other = inject(dir3, ['--seed=1']);
    assert.equal(other.status, 0, other.stdout + other.stderr);
    const t3 = readJson(dir3, 'ground_truth.json');
    assert.notDeepEqual(t3.issues.map((i) => i.entity_id), truth.issues.map((i) => i.entity_id));
    assert.ok(t3.total_issues > 0);
  });
});
