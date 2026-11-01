/**
 * Independent checks of a dataset package (run them on a staged package BEFORE it replaces the live one):
 *   npm run verify:package                                    the live ClearKYC-Dataset/ against dataset/
 *   npm run verify:package -- --dir=<package> --dataset-dir=<results> [--previous=<older package>]
 *
 * It re-derives everything from the files: every checksum, all 22 required tables and their row counts (report, JSON and seed.sql
 * must agree), the documented volumes, every foreign key against the exported rows, business ID formats, the schema (Phase 6
 * constraints present, application settings table absent), the absence of secrets / unmasked identifiers / local files, the
 * validation, reproducibility and detection verdicts and, with --previous, which files differ from an older package.
 * It reads the project's .env only to know which key values must NOT appear in the package.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');
const arg = (name) => process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const NEW = path.resolve(arg('dir') || path.join(ROOT, 'ClearKYC-Dataset'));
const DATASET = path.resolve(arg('dataset-dir') || path.join(ROOT, 'dataset'));
const OLD = arg('previous') ? path.resolve(arg('previous')) : null;
const out = [];
const say = (ok, msg) => { out.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); };

const walk = (d, base = d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name), base) : [path.relative(base, path.join(d, e.name)).replace(/\\/g, '/')]));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const parseSums = (dir) => {
  const m = new Map();
  for (const line of fs.readFileSync(path.join(dir, 'checksums.txt'), 'utf8').split('\n')) {
    const x = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line.trim());
    if (x) m.set(x[2], x[1]);
  }
  return m;
};

// 1. every file listed in checksums.txt exists and matches; nothing unlisted
const files = walk(NEW).filter((f) => f !== 'checksums.txt');
const sums = parseSums(NEW);
const bad = [...sums].filter(([f, h]) => !fs.existsSync(path.join(NEW, f)) || sha(path.join(NEW, f)) !== h);
const unlisted = files.filter((f) => !sums.has(f));
say(bad.length === 0 && sums.size > 0, `checksums.txt: ${sums.size} files listed, ${bad.length} wrong or missing`);
say(unlisted.length === 0, `no file outside checksums.txt (${unlisted.length} unlisted${unlisted.length ? `: ${unlisted.slice(0, 5)}` : ''})`);

// 2. table coverage and row counts, from the export report and the files themselves
const exp = JSON.parse(fs.readFileSync(path.join(DATASET, 'export_report.json'), 'utf8'));
const expectedTables = ['CustomerType', 'Reviewer', 'KYCRequirement', 'Customer', 'BeneficialOwner', 'OwnerScreening', 'OwnershipValidation', 'CompanyOwnership', 'Document', 'Verification', 'RiskRating', 'OnboardingDecision', 'ReviewSchedule', 'Exception', 'ReviewCase', 'CaseHistory', 'CaseNote', 'Alert', 'AuditEvent', 'ValidationRun', 'ValidationIssue', 'IdCounter'];
say(exp.tables.length === 22 && expectedTables.every((t) => exp.tables.some((x) => x.table === t)), `all 22 required tables exported (${exp.tables.length}); SystemSetting deliberately excluded: ${!exp.tables.some((x) => x.table === 'SystemSetting')}`);
const seedCounts = {};
{
  let current = null;
  for (const line of fs.readFileSync(path.join(NEW, 'sql', 'seed.sql'), 'utf8').split(/\r?\n/)) {
    const h = /^INSERT INTO "(\w+)"/.exec(line);
    if (h) { current = h[1]; seedCounts[current] = seedCounts[current] || 0; } else if (current && line.startsWith('(')) seedCounts[current] += 1;
  }
}
let rowTotal = 0;
let coverage = true;
for (const t of exp.tables) {
  const csv = fs.readFileSync(path.join(NEW, 'csv', `${t.file}.csv`), 'utf8');
  const json = JSON.parse(fs.readFileSync(path.join(NEW, 'json', `${t.file}.json`), 'utf8'));
  const csvRows = csv.split('\n').filter(Boolean).length - 1; // may be off for multi-line cells, so only used as a lower bound
  const seedRows = seedCounts[t.table] || 0;
  if (json.length !== t.rows || seedRows !== t.rows || csvRows < t.rows) { coverage = false; console.log(`   mismatch ${t.table}: report ${t.rows}, json ${json.length}, seed.sql ${seedRows}, csv lines ${csvRows}`); }
  rowTotal += t.rows;
}
say(coverage && rowTotal === exp.total_rows, `row counts agree between the report, JSON and seed.sql for every table (total ${rowTotal.toLocaleString('en-US')})`);

// 3. headline volumes (the documented full scale)
const count = (t) => exp.tables.find((x) => x.table === t).rows;
const want = { Customer: 8000, Document: 20000, ReviewCase: 3000 };
say(Object.entries(want).every(([t, n]) => count(t) === n), `documented volumes: customers ${count('Customer')}, documents ${count('Document')}, review cases ${count('ReviewCase')}`);

// 4. relationships: every foreign key value in the JSON points at an existing row
const schema = fs.readFileSync(path.join(NEW, 'sql', 'schema.sql'), 'utf8');
const fks = [...schema.matchAll(/ALTER TABLE "(\w+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \(("?\w+"?)\) REFERENCES "(\w+)"\((\w+)\)/g)];
const fileOf = Object.fromEntries(exp.tables.map((t) => [t.table, t.file]));
const cache = new Map();
const rows = (t) => { if (!cache.has(t)) cache.set(t, JSON.parse(fs.readFileSync(path.join(NEW, 'json', `${fileOf[t]}.json`), 'utf8'))); return cache.get(t); };
let orphans = 0;
for (const m of fks) {
  const [, child, col0, parent, pcol] = m;
  const col = col0.replace(/"/g, '');
  if (!fileOf[child] || !fileOf[parent]) continue;
  const ids = new Set(rows(parent).map((r) => r[pcol]));
  for (const r of rows(child)) if (r[col] !== null && r[col] !== undefined && !ids.has(r[col])) orphans += 1;
}
say(fks.length >= 25 && orphans === 0, `relationships: ${fks.length} foreign keys checked against the exported rows, ${orphans} orphans`);

// 5. IDs: business IDs unique and in the documented formats
const cust = rows('Customer');
const idsOk = new Set(cust.map((c) => c.customer_id)).size === cust.length && cust.every((c) => /^CUS-\d{6}$/.test(c.customer_id));
const docs = rows('Document');
const docOk = new Set(docs.map((d) => d.business_id)).size === docs.length && docs.every((d) => /^DOC-CUS-\d{6}-\d{3}$/.test(d.business_id));
say(idsOk && docOk, 'business IDs: customer IDs (CUS-nnnnnn) and document IDs (DOC-CUS-nnnnnn-nnn) are unique and well-formed');

// 6. schema: current migrations reflected, settings table excluded
say(/OnboardingDecision_one_final_per_customer/.test(schema) && /OnboardingDecision_reason_check/.test(schema), 'schema.sql contains the Phase 6 constraints on OnboardingDecision');
say(!/SystemSetting|valid_expiry_alert_days|system_setting_check_reviewer/.test(schema), 'schema.sql contains nothing of the application settings table');

// 7. secrets, real-looking personal data, local files
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const secrets = [...env.matchAll(/(?:ENCRYPTION_KEY|HASH_KEY)="?([0-9a-f]{64})"?/g)].map((m) => m[1]);
const forbiddenNames = /(^|\/)(\.env|\.pgdata|.*\.log|node_modules|server\/uploads)(\/|$)/;
let leaks = 0;
let fullPan = 0;
let aadhaar = 0;
let dbUrl = 0;
for (const f of files) {
  if (forbiddenNames.test(f)) leaks += 1;
  const text = fs.readFileSync(path.join(NEW, f), 'utf8');
  for (const s of secrets) if (text.includes(s)) { leaks += 1; console.log(`   key found in ${f}`); }
  if (/postgres(ql)?:\/\/\w+:\w+@/.test(text)) dbUrl += 1;
  if (/(csv|json)\//.test(f) || /seed\.sql/.test(f)) {
    fullPan += (text.match(/\b[A-Z]{5}[0-9]{4}[A-Z]\b/g) || []).length;
    aadhaar += (text.match(/(?<![0-9])[2-9][0-9]{3}[ -]?[0-9]{4}[ -]?[0-9]{4}(?![0-9])/g) || []).filter((x) => x.replace(/\D/g, '').length === 12 && /[ -]/.test(x)).length;
  }
}
say(secrets.length === 2 && leaks === 0 && dbUrl === 0, `no secrets: neither encryption key appears in any file, no .env / .pgdata / log / upload files, no database URL with credentials (${files.length} files scanned)`);
say(fullPan === 0 && aadhaar === 0, `no unmasked identifiers: ${fullPan} complete PAN-format values, ${aadhaar} spaced 12-digit Aadhaar-format values in csv / json / seed.sql (identifiers are masked to their last four characters)`);
const manifest = fs.readFileSync(path.join(NEW, 'documentation', 'source_manifest.md'), 'utf8');
say(/synthetic/i.test(manifest) && /no external personal data/i.test(manifest.replace(/\s+/g, ' ')), 'source manifest states the data is synthetic and no external personal data source was used');

// 8. validation and reproducibility verdicts
const val = JSON.parse(fs.readFileSync(path.join(NEW, 'validation_summary.json'), 'utf8'));
const rep = JSON.parse(fs.readFileSync(path.join(NEW, 'reproducibility_report.json'), 'utf8'));
const fin = JSON.parse(fs.readFileSync(path.join(NEW, 'final_detection_summary.json'), 'utf8'));
say(val.validation_status === 'PASSED' && val.unexpected_data_errors === 0 && val.failed_checks === 0, `validation: ${val.validation_status}, ${val.total_validation_checks} checks, failed ${val.failed_checks}, unexpected data errors ${val.unexpected_data_errors}`);
say(rep.overall_result === 'REPRODUCIBLE: PASS' && val.export_status === 'VERIFIED', `reproducibility: ${rep.overall_result}; export check: ${val.export_status}`);
say(fin.status === 'PASS', `final detection summary: ${fin.status}`);

// 9. comparison with an older package (only with --previous=<folder>)
if (OLD) {
  const oldSums = parseSums(OLD);
  const same = [];
  const changed = [];
  const added = [];
  for (const [f, h] of sums) (oldSums.has(f) ? (oldSums.get(f) === h ? same : changed) : added).push(f);
  const removed = [...oldSums.keys()].filter((f) => !sums.has(f));
  const dataFiles = [...sums.keys()].filter((f) => /^(csv|json)\//.test(f) || f === 'sql/seed.sql');
  const dataChanged = dataFiles.filter((f) => changed.includes(f));
  console.log(`\nComparison with the previous package: ${same.length} identical, ${changed.length} changed, ${added.length} new, ${removed.length} removed`);
  console.log(`  changed: ${changed.join(', ')}`);
  console.log(`  new: ${added.join(', ') || '-'}   removed: ${removed.join(', ') || '-'}`);
  say(dataChanged.length === 0 && removed.length === 0, `the DATA is byte-identical to the previous package (${dataFiles.length - dataChanged.length} of ${dataFiles.length} csv/json/seed files unchanged); only the schema, documentation and run reports differ`);
}

const total = files.reduce((n, f) => n + fs.statSync(path.join(NEW, f)).size, 0);
const biggest = files.map((f) => [f, fs.statSync(path.join(NEW, f)).size]).sort((a, b) => b[1] - a[1])[0];
console.log(`\nPackage size: ${(total / 1048576).toFixed(1)} MB in ${files.length + 1} files; largest file ${biggest[0]} (${(biggest[1] / 1048576).toFixed(1)} MB)`);
const sub = (d) => (fs.existsSync(path.join(NEW, d)) ? walk(path.join(NEW, d)).reduce((n, f) => n + fs.statSync(path.join(NEW, d, f)).size, 0) / 1048576 : 0);
console.log(`  csv ${sub('csv').toFixed(1)} MB, json ${sub('json').toFixed(1)} MB, sql ${sub('sql').toFixed(1)} MB`);
console.log(`\n${out.every(Boolean) ? 'ALL PACKAGE CHECKS PASSED' : 'PACKAGE CHECKS FAILED'} (${out.filter(Boolean).length}/${out.length})`);
process.exit(out.every(Boolean) ? 0 : 1);
