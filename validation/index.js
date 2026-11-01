#!/usr/bin/env node
/**
 *   npm run validate:dataset -- --scale=full
 *   node validation/index.js --database=clearkyc_full_edge --reference-date=2026-10-31 --dataset-dir=dataset [--export-dir=ClearKYC-Dataset]
 *
 * Writes validation_report.json / .md and validation_summary.json to the dataset directory. Exit code 1 if any check fails
 * (a violation that is not explained by a labelled planted anomaly). Expected exceptions never fail the run, but are listed.
 */
const fs = require('fs');
const path = require('path');
const { validateDataset, summarise, renderMarkdown } = require('./datasetValidator');

function parse(argv) {
  const a = {};
  for (const x of argv) {
    if (!x.startsWith('--')) continue;
    const [k, v] = x.slice(2).split('=');
    a[k] = v === undefined ? true : v;
  }
  return a;
}

async function run(argv = process.argv.slice(2)) {
  const a = parse(argv);
  const scale = a.scale || 'full';
  const database = a.database || `clearkyc_${scale}_edge`;
  const referenceDate = a['reference-date'] || '2026-10-31';
  const datasetDir = path.resolve(a['dataset-dir'] || path.join(__dirname, '..', 'dataset'));
  const exportDir = a['export-dir'] ? path.resolve(a['export-dir']) : null;
  const report = await validateDataset({ database, referenceDate, datasetDir, exportDir });
  const summary = summarise(report);
  fs.mkdirSync(datasetDir, { recursive: true });
  fs.writeFileSync(path.join(datasetDir, 'validation_report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(datasetDir, 'validation_report.md'), renderMarkdown(report, summary));
  fs.writeFileSync(path.join(datasetDir, 'validation_summary.json'), JSON.stringify(summary, null, 2));
  return { report, summary, datasetDir, database };
}

if (require.main === module) {
  run()
    .then(({ report, summary, datasetDir, database }) => {
      console.log(`\nDataset validation of ${database} (as of ${report.reference_date}): ${summary.validation_status}`);
      console.log(`  ${summary.total_validation_checks} checks: ${summary.passed_checks} passed, ${summary.passed_with_expected_exceptions} passed with expected (planted) exceptions, ${summary.failed_checks} failed`);
      console.log(`  planted anomalies: ${summary.expected_planted_anomalies.labelled_issues} labelled, ${summary.expected_planted_anomalies.violations_explained_by_labels} violations explained; unexpected data errors: ${summary.unexpected_data_errors}`);
      for (const x of report.checks.filter((c) => c.status === 'FAIL')) console.log(`  FAIL [${x.group}] ${x.name}: ${x.unexpected} unexpected, e.g. ${JSON.stringify(x.unexpected_examples.slice(0, 3))}`);
      for (const x of report.checks.filter((c) => c.status === 'INFO')) console.log(`  info [${x.group}] ${x.name}: ${x.violations}`);
      console.log(`  reports: ${path.join(datasetDir, 'validation_report.md')}, validation_summary.json\n`);
      process.exit(summary.validation_status === 'PASSED' ? 0 : 1);
    })
    .catch((err) => {
      console.error(`Validation stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { run };
