#!/usr/bin/env node
/**
 * Reproducibility test (Phase 4, task 1).
 *
 *   npm run test:reproducibility -- --scale=full            (about 8 minutes at full scale)
 *   node reproducibility/runReproducibility.js --scale=starter --dataset-dir=dataset [--export-dir=ClearKYC-Dataset]
 *
 * Runs the COMPLETE process twice with the same seed, scale, reference date and configuration, each time in its own fresh databases:
 *   generate baseline -> inject labelled edge cases -> detect -> evaluate -> validate -> export (CSV, JSON, SQL)
 * and compares the two results: record counts, primary IDs, foreign-key columns, field values (strict and by business key),
 * derived values, edge-case records, ground truth, detection results and the SHA-256 of every file.
 * Writes <dataset-dir>/reproducibility_report.json. Differences are reported, never hidden.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { Client } = require('pg');
const { SCALES } = require('../generator/config/generatorConfig');
const { TABLES } = require('../exporter/exportDataset');
const { connectionString } = require('../generator/edgeCases/common');
const { compareDatasets } = require('./compareDatasets');

const ROOT = path.join(__dirname, '..');
const REPORT_FILES = ['ground_truth.json', 'edge_case_manifest.json', 'detection_results.json', 'detection_report.json', 'validation_summary.json'];
const fileOf = Object.fromEntries(TABLES.map(([t, f]) => [t, f]));

function parse(argv) {
  const a = {};
  for (const x of argv) {
    if (!x.startsWith('--')) continue;
    const [k, v] = x.slice(2).split('=');
    a[k] = v === undefined ? true : v;
  }
  return a;
}

function step(label, script, args, record) {
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [path.join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  record.push({ step: label, seconds: Math.round((Date.now() - t0) / 100) / 10, exit_code: res.status });
  if (res.status !== 0) throw new Error(`${label} failed (exit ${res.status}):\n${(res.stdout || '').slice(-1500)}\n${(res.stderr || '').slice(-1500)}`);
}

const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(dir);
  return out.map((p) => path.relative(dir, p).replace(/\\/g, '/')).sort();
}

async function dropDatabase(name) {
  const admin = new Client({ connectionString: connectionString('postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

async function foreignKeyColumns(database) {
  const db = new Client({ connectionString: connectionString(database) });
  await db.connect();
  try {
    const rows = (await db.query(`SELECT cc.relname AS child, a.attname AS "column" FROM pg_constraint k JOIN pg_class cc ON cc.oid = k.conrelid JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
                                   WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace AND cc.relname <> 'SystemSetting' ORDER BY 1, 2`)).rows; // application settings table: not part of the dataset
    return rows.map((r) => ({ file: fileOf[r.child], table: r.child, column: r.column }));
  } finally {
    await db.end();
  }
}

/** One complete run. Returns where its outputs are and what it recorded. */
async function runOnce(label, cfg) {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), `clearkyc-repro-${label}-`));
  const base = `clearkyc_repro_${label}`;
  const edge = `${base}_edge`;
  const steps = [];
  const common = [`--scale=${cfg.scale}`, `--seed=${cfg.seed}`, `--reference-date=${cfg.referenceDate}`];
  const dataset = path.join(work, 'dataset');
  const exportDir = path.join(work, 'export');
  await dropDatabase(base);
  await dropDatabase(edge);
  try {
    step('1. generate baseline', 'generator/index.js', [...common, `--database=${base}`, '--reset', `--report-dir=${path.join(work, 'generator_report')}`], steps);
    step('2. inject labelled edge cases', 'generator/edgeCases/index.js', [...common, `--source-database=${base}`, `--database=${edge}`, `--dataset-dir=${dataset}`], steps);
    step('3. detect anomalies', 'detector/index.js', [`--database=${edge}`, `--reference-date=${cfg.referenceDate}`, `--dataset-dir=${dataset}`], steps);
    step('4. evaluate detection', 'evaluation/evaluateDetection.js', [`--scale=${cfg.scale}`, `--database=${edge}`, `--dataset-dir=${dataset}`], steps);
    step('5. validate', 'validation/index.js', [`--database=${edge}`, `--reference-date=${cfg.referenceDate}`, `--dataset-dir=${dataset}`], steps);
    step('6. export csv/json/sql', 'exporter/exportDataset.js', [`--database=${edge}`, `--out=${exportDir}`, `--report-dir=${dataset}`], steps);
    const foreignKeys = await foreignKeyColumns(edge);
    return { label, work, dataset, exportDir, steps, foreignKeys };
  } finally {
    await dropDatabase(base);
    await dropDatabase(edge);
  }
}

function summariseRun(run) {
  const files = {};
  for (const f of listFiles(run.exportDir)) files[`export/${f}`] = sha256File(path.join(run.exportDir, f));
  for (const f of REPORT_FILES) if (fs.existsSync(path.join(run.dataset, f))) files[`dataset/${f}`] = sha256File(path.join(run.dataset, f));
  const exportReport = JSON.parse(fs.readFileSync(path.join(run.dataset, 'export_report.json'), 'utf8'));
  const counts = Object.fromEntries(exportReport.tables.map((t) => [t.file, t.rows]));
  return {
    steps: run.steps, total_seconds: Math.round(run.steps.reduce((s, x) => s + x.seconds, 0) * 10) / 10,
    record_counts: counts, total_records: exportReport.total_rows,
    files_hashed: Object.keys(files).length, file_sha256: files,
  };
}

async function reproducibility(argv = process.argv.slice(2)) {
  const a = parse(argv);
  const scale = a.scale || 'full';
  if (!SCALES[scale]) throw new Error(`Unknown scale "${scale}"`);
  const cfg = { scale, seed: Number(a.seed ?? 20261022), referenceDate: a['reference-date'] || '2026-10-31' };
  const datasetDir = path.resolve(a['dataset-dir'] || path.join(ROOT, 'dataset'));

  console.log(`Run A (seed ${cfg.seed}, scale ${scale}) ...`);
  const A = await runOnce('a', cfg);
  console.log(`Run B (seed ${cfg.seed}, scale ${scale}) ...`);
  const B = await runOnce('b', cfg);
  const sumA = summariseRun(A);
  const sumB = summariseRun(B);

  const files = TABLES.map(([, f]) => f);
  const cmp = compareDatasets({ dirA: A.exportDir, dirB: B.exportDir, files, foreignKeys: A.foreignKeys });
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const text = (run, f) => fs.readFileSync(path.join(run.dataset, f), 'utf8');

  const checksumDiffs = [];
  for (const f of new Set([...Object.keys(sumA.file_sha256), ...Object.keys(sumB.file_sha256)])) {
    if (sumA.file_sha256[f] !== sumB.file_sha256[f]) checksumDiffs.push({ file: f, run_a: sumA.file_sha256[f] ?? null, run_b: sumB.file_sha256[f] ?? null });
  }
  const derived = ['risk_ratings', 'documents', 'verifications', 'exceptions', 'review_cases', 'alerts', 'review_schedules', 'onboarding_decisions'];
  const changesA = JSON.parse(text(A, 'edge_case_manifest.json')).changes;
  const changesB = JSON.parse(text(B, 'edge_case_manifest.json')).changes;

  const comparison = {
    record_counts: { matching: same(sumA.record_counts, sumB.record_counts), tables_compared: files.length, differences: cmp.tables.filter((t) => !t.counts_match).map((t) => ({ table: t.table, run_a: t.rows_a, run_b: t.rows_b })) },
    primary_ids: { matching: cmp.tables.every((t) => t.ids_match), differences: cmp.tables.filter((t) => !t.ids_match).map((t) => t.table) },
    foreign_keys: { columns_compared: cmp.foreignKeyColumns, matching: cmp.foreignKeyMismatches.length === 0, mismatching_columns: cmp.foreignKeyMismatches },
    field_values: {
      strict_identical: cmp.strictIdentical, logical_identical: cmp.logicalIdentical,
      tables: cmp.tables.map((t) => ({ table: t.table, rows: t.rows_a, strict_match: t.strict_match, logical_match: t.logical_match, differing_rows: t.differing_rows, differing_columns: t.differing_columns })),
    },
    derived_values: { tables: derived, matching: derived.every((f) => cmp.tables.find((t) => t.table === f)?.strict_match) },
    edge_case_records: { ground_truth_identical: text(A, 'ground_truth.json') === text(B, 'ground_truth.json'), injected_changes_identical: same(changesA, changesB), planted_issues: JSON.parse(text(A, 'ground_truth.json')).total_issues },
    detection_results: { identical: text(A, 'detection_results.json') === text(B, 'detection_results.json'), report_identical: text(A, 'detection_report.json') === text(B, 'detection_report.json') },
    checksums: { files_compared: Object.keys(sumA.file_sha256).length, matching: checksumDiffs.length === 0, differences: checksumDiffs },
  };

  const failing = [];
  if (!comparison.record_counts.matching) failing.push('record counts');
  if (!comparison.primary_ids.matching) failing.push('primary IDs');
  if (!comparison.foreign_keys.matching) failing.push('foreign keys');
  if (!comparison.field_values.logical_identical) failing.push('field values');
  if (!comparison.derived_values.matching) failing.push('derived values');
  if (!comparison.edge_case_records.ground_truth_identical || !comparison.edge_case_records.injected_changes_identical) failing.push('edge-case records / ground truth');
  if (!comparison.detection_results.identical || !comparison.detection_results.report_identical) failing.push('detection results');
  if (!comparison.checksums.matching) failing.push('file checksums');

  // the dataset the main pipeline exported (the one that gets packaged) must equal what both runs produced
  let matchesPackage = null;
  if (a['export-dir'] && fs.existsSync(path.resolve(a['export-dir']))) {
    const dir = path.resolve(a['export-dir']);
    const compared = Object.entries(sumA.file_sha256).filter(([f]) => f.startsWith('export/')).map(([f, h]) => [f.replace('export/', ''), h]);
    const mismatched = compared.filter(([f, h]) => !fs.existsSync(path.join(dir, f)) || sha256File(path.join(dir, f)) !== h).map(([f]) => f);
    matchesPackage = { files_compared: compared.length, matching: mismatched.length === 0, mismatched };
    if (!matchesPackage.matching) failing.push('exported dataset differs from the reproduced runs');
  }

  const report = {
    test: 'ClearKYC reproducibility', seed: cfg.seed, scale, reference_date: cfg.referenceDate,
    configuration: { scale, seed: cfg.seed, reference_date: cfg.referenceDate, batch_size: 1000, steps: A.steps.map((s) => s.step) },
    run_a: sumA, run_b: sumB,
    comparison,
    matches_exported_dataset: matchesPackage,
    differences: { count: failing.length + cmp.differences.length, categories_failing: failing, row_level: cmp.differences },
    overall_result: failing.length === 0 ? 'REPRODUCIBLE: PASS' : 'REPRODUCIBLE: FAIL',
    notes: [
      'Each run uses its own fresh databases (generation, injection, detection, evaluation, validation and export), which are dropped afterwards.',
      'Logical comparison matches rows by stable business keys and ignores database surrogate numbers; the strict comparison compares every column. Both are reported.',
      'Step timings differ between runs by nature and are not part of the comparison.',
    ],
  };
  fs.mkdirSync(datasetDir, { recursive: true });
  fs.writeFileSync(path.join(datasetDir, 'reproducibility_report.json'), JSON.stringify(report, null, 2));
  for (const run of [A, B]) fs.rmSync(run.work, { recursive: true, force: true });
  return report;
}

if (require.main === module) {
  reproducibility()
    .then((r) => {
      console.log(`\n${r.overall_result}`);
      console.log(`  records per run: ${r.run_a.total_records.toLocaleString('en-US')} (A ${r.run_a.total_seconds}s, B ${r.run_b.total_seconds}s)`);
      console.log(`  counts match: ${r.comparison.record_counts.matching}   IDs match: ${r.comparison.primary_ids.matching}   values (strict/logical): ${r.comparison.field_values.strict_identical}/${r.comparison.field_values.logical_identical}`);
      console.log(`  ground truth identical: ${r.comparison.edge_case_records.ground_truth_identical}   detection identical: ${r.comparison.detection_results.identical}   ${r.comparison.checksums.files_compared} file checksums match: ${r.comparison.checksums.matching}`);
      if (r.matches_exported_dataset) console.log(`  matches the exported dataset: ${r.matches_exported_dataset.matching} (${r.matches_exported_dataset.files_compared} files)`);
      if (r.differences.count) console.log(`  DIFFERENCES: ${JSON.stringify(r.differences.categories_failing)}; first: ${JSON.stringify(r.differences.row_level.slice(0, 3))}`);
      console.log('');
      process.exit(r.overall_result.endsWith('PASS') ? 0 : 1);
    })
    .catch((err) => {
      console.error(`Reproducibility test stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { reproducibility };
