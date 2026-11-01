/**
 * The complete Phase 3 workflow with one command (arguments such as --scale=starter are passed to every step):
 *   npm run edge-cases:workflow -- --scale=full
 * baseline -> inject labelled anomalies -> save the answer key -> independent detection -> evaluation -> reports.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const args = process.argv.slice(2);
const steps = [
  ['1-2-3. baseline, injection and answer key', 'generator/edgeCases/index.js'],
  ['4. independent detection', 'detector/index.js'],
  ['5-6. evaluation and reports', 'evaluation/evaluateDetection.js'],
];
for (const [label, file] of steps) {
  console.log(`\n=== ${label} ===`);
  const res = spawnSync(process.execPath, [path.join(__dirname, '..', file), ...args], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error(`Workflow stopped at: ${label}`);
    process.exit(res.status || 1);
  }
}
