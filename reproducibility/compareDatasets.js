/**
 * Compares two exported datasets (the json/ folders produced by exporter/exportDataset.js).
 *
 * Two views, both reported:
 *   strict      every column of every row, in primary-key order, exactly as exported
 *   logical     rows matched by their STABLE BUSINESS KEY, ignoring database surrogate numbers (the serial `id` columns and the numeric
 *               columns that point at them), so an internal numbering difference alone could never fail the test.
 * Differences are listed, never hidden.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// table file -> column that identifies a row for people (falls back to the full row without surrogate numbers)
const BUSINESS_KEY = {
  customers: 'customer_id', documents: 'business_id', kyc_requirements: 'business_id', review_cases: 'review_code', alerts: 'business_id', exceptions: 'exception_code',
  risk_ratings: 'assessment_code', audit_events: 'event_code', reviewers: 'email', customer_types: 'type_name',
};
const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');

/** Names of the numeric surrogate columns of one table: its `id` and every foreign-key / polymorphic id column. */
function surrogateColumns(columns, foreignKeys, file) {
  const set = new Set(['id']);
  for (const fk of foreignKeys.filter((f) => f.file === file)) set.add(fk.column);
  for (const c of columns) if (/(^|_)entity_id$/.test(c) || c === 'entity_id') set.add(c);
  return set;
}

function readTable(dir, file) {
  const p = path.join(dir, 'json', `${file}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function compareDatasets({ dirA, dirB, files, foreignKeys }) {
  const result = { tables: [], strictIdentical: true, logicalIdentical: true, differences: [], foreignKeyColumns: 0, foreignKeyMismatches: [] };
  const note = (d) => { if (result.differences.length < 200) result.differences.push(d); };

  for (const file of files) {
    const a = readTable(dirA, file);
    const b = readTable(dirB, file);
    const columns = a.length ? Object.keys(a[0]) : b.length ? Object.keys(b[0]) : [];
    for (const fk of foreignKeys.filter((f) => f.file === file)) {
      result.foreignKeyColumns += 1;
      if (sha(a.map((r) => r[fk.column])) !== sha(b.map((r) => r[fk.column]))) result.foreignKeyMismatches.push(`${file}.${fk.column}`);
    }
    const strictA = sha(a);
    const strictB = sha(b);
    const surrogate = surrogateColumns(columns, foreignKeys, file);
    const idColumn = columns.includes('id') ? 'id' : null;

    const entry = {
      table: file, rows_a: a.length, rows_b: b.length,
      counts_match: a.length === b.length,
      ids_match: idColumn ? sha(a.map((r) => r[idColumn])) === sha(b.map((r) => r[idColumn])) : sha(a.map((r) => JSON.stringify(r))) === sha(b.map((r) => JSON.stringify(r))),
      strict_match: strictA === strictB,
      logical_match: true,
      differing_rows: 0,
      differing_columns: [],
    };

    // logical comparison
    const keyColumn = BUSINESS_KEY[file];
    const strip = (r) => Object.fromEntries(Object.entries(r).filter(([c]) => !surrogate.has(c)));
    const keyOf = (r) => (keyColumn ? String(r[keyColumn]) : sha(strip(r)));
    const mapA = new Map(a.map((r) => [keyOf(r), strip(r)]));
    const mapB = new Map(b.map((r) => [keyOf(r), strip(r)]));
    const columnsDiffering = new Set();
    for (const [key, ra] of mapA) {
      const rb = mapB.get(key);
      if (!rb) { entry.differing_rows += 1; note({ table: file, record: key, difference: 'present in run A only' }); continue; }
      for (const c of Object.keys(ra)) {
        if (JSON.stringify(ra[c]) !== JSON.stringify(rb[c])) {
          columnsDiffering.add(c);
          entry.differing_rows += 1;
          note({ table: file, record: key, column: c, run_a: ra[c], run_b: rb[c] });
          break;
        }
      }
    }
    for (const key of mapB.keys()) if (!mapA.has(key)) { entry.differing_rows += 1; note({ table: file, record: key, difference: 'present in run B only' }); }
    entry.differing_columns = [...columnsDiffering].sort();
    entry.logical_match = entry.differing_rows === 0 && a.length === b.length;
    if (!entry.strict_match) result.strictIdentical = false;
    if (!entry.logical_match || !entry.counts_match) result.logicalIdentical = false;
    result.tables.push(entry);
  }
  return result;
}

module.exports = { compareDatasets, sha };
