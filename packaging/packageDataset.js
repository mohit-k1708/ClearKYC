#!/usr/bin/env node
/**
 * Assembles the final dataset folder ClearKYC-Dataset/ from the ACTUAL database and the results of the earlier steps.
 *
 *   npm run package:dataset -- --scale=full
 *
 * Refuses to package (exit 1) when a result it depends on is missing, when validation found unexpected errors, or when the
 * reproducibility test did not pass - unless --allow-incomplete is given, in which case the problem is written into
 * validation_summary.json instead of being hidden.
 *
 * Steps: export CSV / JSON / SQL -> check the export loads and reproduces the detection -> copy documentation and reports ->
 * write the source manifest -> finish validation_summary.json -> write checksums.txt -> verify checksums.
 */
const fs = require('fs');
const path = require('path');
const { exportDataset } = require('../exporter/exportDataset');
const { verifyExport } = require('../exporter/verifyExport');
const { generateChecksums, verifyChecksums } = require('./checksums');
const { buildSourceManifest } = require('./sourceManifest');
const { SCALES, RATIOS, GENERATOR_CONFIG, GENERATOR_VERSION } = require('../generator/config/generatorConfig');
const { PLAN } = require('../generator/edgeCases/edgeCasePlan');

const ROOT = path.join(__dirname, '..');
const DOCS = ['README.md', 'data_dictionary.md', 'database_relationships.md', 'id_conventions.md', 'edge_case_rules.md', 'ownership_model.md', 'expiry_configuration.md'];
const REPORTS = ['ground_truth.json', 'detection_report.json', 'detection_report.md', 'edge_case_manifest.json', 'reproducibility_report.json', 'validation_summary.json', 'validation_report.json', 'validation_report.md', 'final_detection_summary.json', 'final_detection_summary.md'];
const GENERATED = ['csv', 'json', 'sql', 'documentation', ...REPORTS, 'generation_config.json', 'checksums.txt'];

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

async function packageDataset({ scale = 'full', database, datasetDir, outDir, seed = 20261022, referenceDate = '2026-10-31', allowIncomplete = false, writeRepoDocs = true }) {
  const problems = [];
  const need = (f) => {
    if (!fs.existsSync(path.join(datasetDir, f))) problems.push(`missing ${f} in ${datasetDir} (run the earlier steps first: npm run dataset:all)`);
  };
  for (const f of ['ground_truth.json', 'edge_case_manifest.json', 'detection_results.json', 'detection_report.json', 'final_detection_summary.json', 'validation_summary.json', 'reproducibility_report.json']) need(f);
  if (problems.length === 0) {
    const validation = readJson(path.join(datasetDir, 'validation_summary.json'));
    const repro = readJson(path.join(datasetDir, 'reproducibility_report.json'));
    const final = readJson(path.join(datasetDir, 'final_detection_summary.json'));
    if (validation.validation_status !== 'PASSED' || validation.unexpected_data_errors > 0) problems.push(`validation did not pass (${validation.failed_checks} failed checks, ${validation.unexpected_data_errors} unexpected data errors)`);
    if (repro.overall_result !== 'REPRODUCIBLE: PASS') problems.push(`reproducibility test result: ${repro.overall_result}`);
    if (final.status !== 'PASS') problems.push('the final detection summary has failing integrity checks');
    if (repro.scale !== scale) problems.push(`the reproducibility report is for scale ${repro.scale}, not ${scale}`);
  }
  if (problems.length && !allowIncomplete) throw new Error(`Not packaged:\n  - ${problems.join('\n  - ')}`);

  fs.mkdirSync(outDir, { recursive: true });
  for (const name of GENERATED) fs.rmSync(path.join(outDir, name), { recursive: true, force: true }); // only what this command creates
  const exported = await exportDataset({ database, outDir });
  fs.writeFileSync(path.join(datasetDir, 'export_report.json'), JSON.stringify({ status: 'EXPORTED', ...exported }, null, 2));

  const exportCheck = await verifyExport({ dir: outDir, datasetDir, referenceDate });
  if (exportCheck.status !== 'VERIFIED') problems.push(`the export check failed: ${exportCheck.problems.join('; ')}`);

  // documentation: the source manifest is written from the actual results and kept in the repository documentation too
  fs.mkdirSync(path.join(outDir, 'documentation'), { recursive: true });
  const sourceManifest = buildSourceManifest({ datasetDir, exportReport: exported, scale, seed, referenceDate });
  fs.writeFileSync(path.join(outDir, 'documentation', 'source_manifest.md'), sourceManifest);
  if (writeRepoDocs) fs.writeFileSync(path.join(ROOT, 'documentation', 'source_manifest.md'), sourceManifest); // a real run also refreshes the repository copy
  for (const f of DOCS) {
    const from = path.join(ROOT, 'documentation', f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, 'documentation', f));
    else problems.push(`documentation/${f} does not exist`);
  }

  // the seed and configuration that produced the data, so the dataset can be regenerated exactly
  fs.writeFileSync(path.join(outDir, 'generation_config.json'), `${JSON.stringify({
    generator_version: GENERATOR_VERSION, seed, scale, reference_date: referenceDate, batch_size: GENERATOR_CONFIG.batchSize, volumes: SCALES[scale], ratios: RATIOS, planted_issues_per_type: PLAN[scale],
    commands: { regenerate_everything: `npm run dataset:all -- --scale=${scale}`, baseline: `npm run generate:${scale} -- --reset`, inject_edge_cases: `npm run inject:edge-cases -- --scale=${scale}`, verify_reproducibility: `npm run test:reproducibility -- --scale=${scale}` },
    note: 'Same seed, scale, reference date and configuration (and the same ENCRYPTION_KEY / HASH_KEY in .env) reproduce every file of this package byte for byte.',
  }, null, 2)}
`);

  // validation_summary.json: the statuses of the steps that ran after validation
  const repro = fs.existsSync(path.join(datasetDir, 'reproducibility_report.json')) ? readJson(path.join(datasetDir, 'reproducibility_report.json')) : null;
  const summaryFile = path.join(datasetDir, 'validation_summary.json');
  const summary = readJson(summaryFile);
  summary.reproducibility_status = repro ? (repro.overall_result === 'REPRODUCIBLE: PASS' ? 'PASS' : 'FAIL') : 'NOT_RUN';
  summary.export_status = exportCheck.status === 'VERIFIED' ? 'VERIFIED' : 'FAILED';
  summary.checksum_status = 'GENERATED';
  summary.checksum_verification_command = 'npm run verify:checksums';
  summary.packaging_problems = problems;
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));

  for (const f of REPORTS) {
    const from = path.join(datasetDir, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outDir, f));
    else if (f !== 'validation_report.md' && f !== 'detection_report.md' && f !== 'final_detection_summary.md') problems.push(`${f} was not found in ${datasetDir}`);
  }
  const sums = generateChecksums(outDir);
  const verified = verifyChecksums(outDir);
  return { outDir, exported, exportCheck, checksums: { ...sums, verification: verified.status }, summary, problems };
}

if (require.main === module) {
  const a = {};
  for (const x of process.argv.slice(2)) if (x.startsWith('--')) { const [k, v] = x.slice(2).split('='); a[k] = v === undefined ? true : v; }
  const scale = a.scale || 'full';
  packageDataset({
    scale, database: a.database || `clearkyc_${scale}_edge`, datasetDir: path.resolve(a['dataset-dir'] || path.join(ROOT, 'dataset')), outDir: path.resolve(a.out || path.join(ROOT, 'ClearKYC-Dataset')),
    seed: Number(a.seed ?? 20261022), referenceDate: a['reference-date'] || '2026-10-31', allowIncomplete: Boolean(a['allow-incomplete']), writeRepoDocs: !a['no-repo-docs'],
  })
    .then((r) => {
      console.log(`\nPackaged ${r.exported.tables.length} entities (${r.exported.total_rows.toLocaleString('en-US')} rows) into ${r.outDir}`);
      console.log(`  export check: ${r.exportCheck.status}   checksums: ${r.checksums.files} files, ${r.checksums.verification}`);
      console.log(`  validation: ${r.summary.validation_status}, reproducibility: ${r.summary.reproducibility_status}, export: ${r.summary.export_status}, checksums: ${r.summary.checksum_status}`);
      for (const p of r.problems) console.log(`  PROBLEM: ${p}`);
      console.log('');
      process.exit(r.problems.length === 0 && r.checksums.verification === 'VERIFIED' ? 0 : 1);
    })
    .catch((err) => {
      console.error(`Packaging stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { packageDataset };
