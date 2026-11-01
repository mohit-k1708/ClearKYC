#!/usr/bin/env node
/**
 *   npm run detect:anomalies -- --scale=full                 (database clearkyc_full_edge)
 *   node detector/index.js --database=clearkyc_full_edge --reference-date=2026-10-31 --dataset-dir=dataset
 *
 * Writes <dataset-dir>/detection_results.json. This command never opens any answer key.
 */
const path = require('path');
const { Client } = require('pg');
const { runDetection } = require('./detectionEngine');
const { writeResults } = require('./detectionResults');

function parse(argv) {
  const a = {};
  for (const x of argv) {
    if (!x.startsWith('--')) continue;
    const [k, v] = x.slice(2).split('=');
    a[k] = v === undefined ? true : v;
  }
  return a;
}

function connectionString(database) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

async function detect(argv = process.argv.slice(2)) {
  const a = parse(argv);
  const scale = a.scale || 'full';
  const database = a.database || `clearkyc_${scale}_edge`;
  const referenceDate = a['reference-date'] || '2026-10-31';
  const datasetDir = path.resolve(a['dataset-dir'] || path.join(__dirname, '..', 'dataset'));
  const db = new Client({ connectionString: connectionString(database) });
  await db.connect();
  try {
    const result = await runDetection(db, { referenceDate });
    writeResults(path.join(datasetDir, 'detection_results.json'), { database, referenceDate, ...result });
    return { database, referenceDate, datasetDir, ...result };
  } finally {
    await db.end();
  }
}

if (require.main === module) {
  detect()
    .then((r) => {
      console.log(`\nAnomaly detection on ${r.database} (as of ${r.referenceDate})`);
      for (const p of r.perRule) console.log(`  ${p.issueType.padEnd(36)} ${String(p.findings).padStart(6)} flagged   (${p.ms} ms)`);
      console.log(`  ${'TOTAL'.padEnd(36)} ${String(r.detections.length).padStart(6)}\n  results: ${path.join(r.datasetDir, 'detection_results.json')}\n`);
    })
    .catch((err) => {
      console.error(`Detection stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { detect, connectionString };
