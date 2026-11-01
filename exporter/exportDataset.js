#!/usr/bin/env node
/**
 * Exports EVERY table of the dataset database to CSV, JSON and SQL, from the actual records.
 *
 *   npm run export:dataset -- --scale=full                      (database clearkyc_full_edge -> ClearKYC-Dataset/)
 *   node exporter/exportDataset.js --database=clearkyc_full_edge --out=ClearKYC-Dataset
 *
 * csv/<entity>.csv, json/<entity>.json   one file per table, rows in primary-key order, masked identifiers (see masking.js)
 * sql/schema.sql                          the schema read from the live catalogue
 * sql/seed.sql                            INSERTs in parent-before-child order, triggers disabled while loading, sequences restored
 *
 * Ground truth is NOT exported here: it is an answer key, not part of the operational dataset.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { connectionString } = require('../generator/edgeCases/common');
const { maskRow, maskedColumns } = require('./masking');
const { toCsv, toJson, insertStatements } = require('./formats');
const { buildSchemaSql } = require('./schemaSql');

// Parent tables before the tables that reference them. [table, file name]
const TABLES = [
  ['CustomerType', 'customer_types'], ['Reviewer', 'reviewers'], ['KYCRequirement', 'kyc_requirements'], ['Customer', 'customers'],
  ['BeneficialOwner', 'beneficial_owners'], ['OwnerScreening', 'owner_screenings'], ['OwnershipValidation', 'ownership_validations'], ['CompanyOwnership', 'company_ownership'],
  ['Document', 'documents'], ['Verification', 'verifications'], ['RiskRating', 'risk_ratings'], ['OnboardingDecision', 'onboarding_decisions'],
  ['ReviewSchedule', 'review_schedules'], ['Exception', 'exceptions'], ['ReviewCase', 'review_cases'], ['CaseHistory', 'case_history'], ['CaseNote', 'case_notes'],
  ['Alert', 'alerts'], ['AuditEvent', 'audit_events'], ['ValidationRun', 'validation_runs'], ['ValidationIssue', 'validation_issues'], ['IdCounter', 'id_counters'],
];

const selectExpression = (c) => {
  const q = `"${c.column_name}"`;
  if (c.data_type === 'timestamp without time zone') return `to_char(${q}, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${q}`;
  if (c.data_type === 'date') return `to_char(${q}, 'YYYY-MM-DD') AS ${q}`;
  if (c.data_type === 'numeric' || c.data_type === 'json' || c.data_type === 'jsonb') return `${q}::text AS ${q}`;
  return q;
};

async function exportDataset({ database, outDir }) {
  const db = new Client({ connectionString: connectionString(database) });
  await db.connect();
  try {
    // no table may be left out
    const existing = (await db.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' AND table_name <> 'SystemSetting' ORDER BY 1`)).rows.map((r) => r.table_name); // SystemSetting = Phase 6 application settings, not KYC data
    const listed = TABLES.map(([t]) => t);
    const missing = existing.filter((t) => !listed.includes(t));
    const unknown = listed.filter((t) => !existing.includes(t));
    if (missing.length || unknown.length) throw new Error(`Export list and database disagree. Not exported: [${missing}] ; not in the database: [${unknown}]`);

    for (const dir of ['csv', 'json', 'sql']) fs.mkdirSync(path.join(outDir, dir), { recursive: true });
    const manifest = { database, tables: [], files: [] };
    const seed = ['-- ClearKYC dataset seed data. Load schema.sql first.', '-- Identifiers are masked (see the README). Triggers are disabled while loading so the stored values are inserted exactly as exported.', 'BEGIN;'];
    for (const [table] of TABLES) seed.push(`ALTER TABLE "${table}" DISABLE TRIGGER USER;`);

    for (const [table, file] of TABLES) {
      const cols = (await db.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`, [table])).rows;
      const pk = (await db.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = $1::regclass AND i.indisprimary ORDER BY array_position(i.indkey::int[], a.attnum::int)`, [`"${table}"`])).rows.map((r) => `"${r.attname}"`);
      const raw = (await db.query(`SELECT ${cols.map(selectExpression).join(', ')} FROM "${table}" ORDER BY ${pk.join(', ')}`)).rows;
      const names = cols.map((c) => c.column_name);
      const rows = raw.map((r) => {
        const masked = maskRow(table, r);
        for (const c of cols) if ((c.data_type === 'json' || c.data_type === 'jsonb') && typeof masked[c.column_name] === 'string') masked[c.column_name] = JSON.parse(masked[c.column_name]);
        return masked;
      });
      const jsonRows = rows.map((r) => {
        const copy = { ...r };
        for (const c of cols) if (c.data_type === 'numeric' && copy[c.column_name] !== null) copy[c.column_name] = Number(copy[c.column_name]);
        return copy;
      });

      fs.writeFileSync(path.join(outDir, 'csv', `${file}.csv`), toCsv(names, rows));
      fs.writeFileSync(path.join(outDir, 'json', `${file}.json`), toJson(names, jsonRows));
      seed.push('', `-- ${table}: ${rows.length} rows`, ...insertStatements(table, names, cols.map((c) => c.data_type), rows));
      manifest.tables.push({ table, file, rows: rows.length, columns: names.length, masked_columns: maskedColumns(table) });
      manifest.files.push(`csv/${file}.csv`, `json/${file}.json`);
    }

    seed.push('', '-- Restore the counters so new records continue the series');
    for (const s of (await db.query(`SELECT sequencename, last_value FROM pg_sequences WHERE schemaname = 'public' AND last_value IS NOT NULL ORDER BY sequencename`)).rows) {
      seed.push(`SELECT setval('"${s.sequencename}"', ${s.last_value}, true);`);
    }
    seed.push('', ...TABLES.map(([t]) => `ALTER TABLE "${t}" ENABLE TRIGGER USER;`), 'COMMIT;');
    fs.writeFileSync(path.join(outDir, 'sql', 'schema.sql'), await buildSchemaSql(db));
    fs.writeFileSync(path.join(outDir, 'sql', 'seed.sql'), `${seed.join('\n')}\n`);
    manifest.files.push('sql/schema.sql', 'sql/seed.sql');
    manifest.total_rows = manifest.tables.reduce((s, t) => s + t.rows, 0);
    return manifest;
  } finally {
    await db.end();
  }
}

function parse(argv) {
  const a = {};
  for (const x of argv) {
    if (!x.startsWith('--')) continue;
    const [k, v] = x.slice(2).split('=');
    a[k] = v === undefined ? true : v;
  }
  return a;
}

if (require.main === module) {
  const a = parse(process.argv.slice(2));
  const scale = a.scale || 'full';
  const database = a.database || `clearkyc_${scale}_edge`;
  const outDir = path.resolve(a.out || path.join(__dirname, '..', 'ClearKYC-Dataset'));
  exportDataset({ database, outDir })
    .then((m) => {
      fs.mkdirSync(path.resolve(a['report-dir'] || path.join(__dirname, '..', 'dataset')), { recursive: true });
      fs.writeFileSync(path.join(path.resolve(a['report-dir'] || path.join(__dirname, '..', 'dataset')), 'export_report.json'), JSON.stringify({ status: 'EXPORTED', ...m }, null, 2));
      console.log(`\nExported ${m.tables.length} tables (${m.total_rows.toLocaleString('en-US')} rows) from ${m.database} to ${outDir}`);
      for (const t of m.tables) console.log(`  ${t.file.padEnd(24)} ${String(t.rows).padStart(8)} rows${t.masked_columns.length ? `   masked: ${t.masked_columns.join(', ')}` : ''}`);
      console.log('  sql/schema.sql, sql/seed.sql\n');
    })
    .catch((err) => {
      console.error(`Export stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { exportDataset, TABLES };
