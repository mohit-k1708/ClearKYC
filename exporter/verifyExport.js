#!/usr/bin/env node
/**
 * Proves an export is usable and complete, without trusting the exporter:
 *   1. every entity has a CSV and a JSON file with the same columns and the same number of rows;
 *   2. sql/schema.sql then sql/seed.sql load into an EMPTY scratch database;
 *   3. every table of the scratch database has exactly the exported number of rows;
 *   4. the independent anomaly detector, run on the scratch database, finds exactly what it found on the original
 *      (compared with <dataset-dir>/detection_results.json), so the exported data is complete enough to reproduce the detection.
 *
 *   npm run verify:export -- --dir=ClearKYC-Dataset --dataset-dir=dataset
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { connectionString } = require('../generator/edgeCases/common');
const { runDetection } = require('../detector/detectionEngine');
const { TABLES } = require('./exportDataset');

const SCRATCH = 'clearkyc_export_check';

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; } else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; } else cell += ch;
  }
  return rows;
}

async function verifyExport({ dir, datasetDir, referenceDate = '2026-10-31' }) {
  const problems = [];
  const tables = [];
  for (const [table, file] of TABLES) {
    const csvFile = path.join(dir, 'csv', `${file}.csv`);
    const jsonFile = path.join(dir, 'json', `${file}.json`);
    if (!fs.existsSync(csvFile) || !fs.existsSync(jsonFile)) { problems.push(`${file}: csv or json file is missing`); continue; }
    const csv = parseCsv(fs.readFileSync(csvFile, 'utf8'));
    const json = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
    const header = csv[0] ?? [];
    const csvRows = csv.length - 1;
    if (csvRows !== json.length) problems.push(`${file}: csv has ${csvRows} rows, json has ${json.length}`);
    if (json.length && JSON.stringify(Object.keys(json[0])) !== JSON.stringify(header)) problems.push(`${file}: csv and json columns differ`);
    tables.push({ table, file, rows: json.length });
  }

  let loaded = null;
  let detection = null;
  const admin = new Client({ connectionString: connectionString('postgres') });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${SCRATCH}`);
    const db = new Client({ connectionString: connectionString(SCRATCH) });
    await db.connect();
    try {
      try {
        await db.query(fs.readFileSync(path.join(dir, 'sql', 'schema.sql'), 'utf8'));
        await db.query(fs.readFileSync(path.join(dir, 'sql', 'seed.sql'), 'utf8'));
      } catch (err) {
        problems.push(`the SQL files do not load into an empty database: ${err.message}`);
      }
      if (problems.length === 0 || (await db.query(`SELECT to_regclass('"Customer"') AS t`)).rows[0].t) {
        loaded = {};
        for (const t of tables) {
          const n = Number((await db.query(`SELECT count(*)::int AS n FROM "${t.table}"`)).rows[0].n);
          loaded[t.file] = n;
          if (n !== t.rows) problems.push(`${t.file}: ${n} rows after loading the SQL, ${t.rows} exported`);
        }
        const savedFile = datasetDir && path.join(datasetDir, 'detection_results.json');
        if (savedFile && fs.existsSync(savedFile)) {
          const saved = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
          const result = await runDetection(db, { referenceDate });
          const key = (d) => `${d.issue_type}|${d.entity_type}|${d.entity_id}`;
          const a = result.detections.map(key).sort();
          const b = saved.detections.map(key).sort();
          detection = { detections_on_loaded_sql: a.length, detections_in_saved_results: b.length, identical: JSON.stringify(a) === JSON.stringify(b) };
          if (!detection.identical) problems.push('the detector gives different results on the data loaded from the exported SQL');
        }
      }
    } finally {
      await db.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${SCRATCH} WITH (FORCE)`);
    await admin.end();
  }
  return { status: problems.length === 0 ? 'VERIFIED' : 'FAILED', entities: tables.length, total_rows: tables.reduce((s, t) => s + t.rows, 0), sql_loaded_row_counts_match: problems.every((p) => !/rows after loading/.test(p)), detection_on_loaded_sql: detection, problems };
}

if (require.main === module) {
  const a = {};
  for (const x of process.argv.slice(2)) if (x.startsWith('--')) { const [k, v] = x.slice(2).split('='); a[k] = v === undefined ? true : v; }
  verifyExport({ dir: path.resolve(a.dir || path.join(__dirname, '..', 'ClearKYC-Dataset')), datasetDir: path.resolve(a['dataset-dir'] || path.join(__dirname, '..', 'dataset')) })
    .then((r) => {
      console.log(`\nExport check: ${r.status} (${r.entities} entities, ${r.total_rows.toLocaleString('en-US')} rows)`);
      if (r.detection_on_loaded_sql) console.log(`  detector on the loaded SQL: ${r.detection_on_loaded_sql.detections_on_loaded_sql} detections, identical to the saved results: ${r.detection_on_loaded_sql.identical}`);
      for (const p of r.problems) console.log(`  PROBLEM: ${p}`);
      console.log('');
      process.exit(r.status === 'VERIFIED' ? 0 : 1);
    })
    .catch((err) => {
      console.error(`Export check stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { verifyExport, parseCsv };
