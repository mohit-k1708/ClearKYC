/**
 * The complete dataset workflow with one command (arguments such as --scale=starter are passed to every step):
 *   npm run dataset:all -- --scale=full
 *
 *   1  generate the valid baseline and inject the labelled edge cases   (writes ground_truth.json)
 *   2  run the independent anomaly detection
 *   3  evaluate the detection against the answer key
 *   4  re-check the detection report (final_detection_summary)
 *   5  validate all records
 *   6  export CSV, JSON and SQL into ClearKYC-Dataset/
 *   7  reproducibility test: the whole process twice, compared (skip with --skip-reproducibility)
 *   8  package: documentation, reports, source manifest, SHA-256 checksums, checks
 *
 * Safe staging (Phase 7): the defaults above write the live package folder and use the databases clearkyc_<scale> and
 * clearkyc_<scale>_edge. To build a NEW package without touching either, use
 *   npm run dataset:all -- --scale=full --database-prefix=clearkyc_pkg --out=<staging folder> --dataset-dir=<staging results folder> --no-repo-docs
 * which uses the disposable databases clearkyc_pkg_<scale> / clearkyc_pkg_<scale>_edge, writes only to the folders you name, and leaves
 * the repository's documentation/source_manifest.md alone. The development database `clearkyc` is never used by any of these steps.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const own = new Set(['--skip-reproducibility', '--no-repo-docs']);
const valueOf = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const all = process.argv.slice(2);
const skipRepro = all.includes('--skip-reproducibility');
const noRepoDocs = all.includes('--no-repo-docs');
const prefix = valueOf('database-prefix') || 'clearkyc';
const OUT = path.resolve(valueOf('out') || path.join(ROOT, 'ClearKYC-Dataset'));
const DATASET = path.resolve(valueOf('dataset-dir') || path.join(ROOT, 'dataset'));
const scale = valueOf('scale') || 'full';
if (!/^clearkyc_[a-z0-9_]+$/.test(prefix) && prefix !== 'clearkyc') throw new Error('--database-prefix must be "clearkyc" or start with "clearkyc_" (lower case letters, digits, underscores)');
if (prefix === 'clearkyc' && (valueOf('out') || valueOf('dataset-dir'))) console.log('Note: default database names with a custom output folder.');

// everything except the options this script handles itself is passed on to every step (scale, seed, reference date ...)
const args = all.filter((a) => !own.has(a) && !/^--(database-prefix|out|dataset-dir)=/.test(a));
const baseDb = `${prefix}_${scale}`;
const edgeDb = `${prefix}_${scale}_edge`;
const dataset = [`--dataset-dir=${DATASET}`];
const edge = [`--database=${edgeDb}`];

const steps = [
  ['1. baseline + labelled edge cases', 'generator/edgeCases/index.js', [...args, ...dataset, `--source-database=${baseDb}`, ...edge, '--regenerate-baseline', ...(prefix === 'clearkyc' ? [] : [`--baseline-report-dir=${path.join(DATASET, 'generator_report')}`])]],
  ['2. anomaly detection', 'detector/index.js', [...args, ...dataset, ...edge]],
  ['3. detection evaluation', 'evaluation/evaluateDetection.js', [...args, ...dataset, ...edge]],
  ['4. final detection summary', 'packaging/finalDetectionSummary.js', [...args, ...dataset, ...edge]],
  ['5. validation of all records', 'validation/index.js', [...args, ...dataset, ...edge]],
  ['6. export csv / json / sql', 'exporter/exportDataset.js', [...args, ...edge, `--out=${OUT}`, `--report-dir=${DATASET}`]],
  ...(skipRepro ? [] : [['7. reproducibility test (two complete runs)', 'reproducibility/runReproducibility.js', [...args, ...dataset, `--export-dir=${OUT}`]]]),
  ['8. package + checksums', 'packaging/packageDataset.js', [...args, ...dataset, ...edge, `--out=${OUT}`, ...(noRepoDocs ? ['--no-repo-docs'] : [])]],
];
console.log(`Databases: ${baseDb} (baseline) and ${edgeDb} (edge cases). Results: ${DATASET}. Package: ${OUT}.`);
for (const [label, file, a] of steps) {
  console.log(`\n=== ${label} ===`);
  const res = spawnSync(process.execPath, [path.join(ROOT, file), ...a], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`\nWorkflow stopped at: ${label}`);
    process.exit(res.status || 1);
  }
}
console.log(`\nDataset complete: ${OUT} (verify with: npm run verify:checksums -- --dir=<folder>)`);
