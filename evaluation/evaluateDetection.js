#!/usr/bin/env node
/**
 * Detection measurement. This is the ONLY place where the answer key (ground_truth.json) meets the detector's output.
 *
 *   npm run evaluate:detection -- --scale=full
 *   node evaluation/evaluateDetection.js --database=clearkyc_full_edge --dataset-dir=dataset
 *
 * Evaluation unit: ONE record + ONE issue type (entity_type | entity_id | issue_type). A record flagged twice for the same issue
 * counts once. A record can be a true positive for one issue type and a false positive for another.
 *
 *   TP  planted and detected          FN  planted and missed
 *   FP  detected but not planted      TN  evaluated and correctly left alone
 * True negatives need a population: for each issue type it is the set of records the rule could have flagged (all documents,
 * the companies, the closed cases ...). TN = population - TP - FP - FN.
 *
 * The evaluation never changes the detector's results.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { connectionString } = require('../detector');

const safeDivide = (a, b) => (b === 0 ? 0 : a / b);
const round = (x) => Math.round(x * 10000) / 10000;
const unit = (x) => `${x.entity_type}|${x.entity_id}|${x.issue_type}`;

function scores({ tp, fp, fn }, planted) {
  const precision = safeDivide(tp, tp + fp);
  const recall = safeDivide(tp, tp + fn);
  const f1 = safeDivide(2 * precision * recall, precision + recall);
  return { precision: round(precision), recall: round(recall), f1_score: round(f1), detection_rate_percent: round(safeDivide(tp, planted) * 100) };
}

/** Pure function: answer key + detector output + populations -> metrics. */
function computeMetrics(issues, detections, populations = {}) {
  const planted = new Map();
  for (const i of issues) planted.set(unit(i), i); // duplicates in the key would be the same unit
  const detected = new Map();
  for (const d of detections) detected.set(unit(d), d);

  const types = [...new Set([...issues.map((i) => i.issue_type), ...detections.map((d) => d.issue_type)])].sort();
  const byType = {};
  const missed = [];
  const falsePositives = [];
  for (const type of types) {
    const p = [...planted.values()].filter((i) => i.issue_type === type);
    const d = [...detected.values()].filter((x) => x.issue_type === type);
    const tpList = p.filter((i) => detected.has(unit(i)));
    const fnList = p.filter((i) => !detected.has(unit(i)));
    const fpList = d.filter((x) => !planted.has(unit(x)));
    const c = { planted: p.length, detected: d.length, tp: tpList.length, fp: fpList.length, fn: fnList.length };
    const population = populations[type] ?? null;
    c.tn = population === null ? null : Math.max(population - c.tp - c.fp - c.fn, 0);
    c.population = population;
    byType[type] = { ...c, ...scores(c, c.planted) };
    for (const i of fnList) missed.push({ issue_id: i.issue_id, issue_type: type, entity_type: i.entity_type, entity_id: i.entity_id, related_customer_id: i.related_customer_id, injection_method: i.injection_method });
    for (const x of fpList) falsePositives.push({ detection_id: x.detection_id, issue_type: type, entity_type: x.entity_type, entity_id: x.entity_id, related_customer_id: x.related_customer_id, description: x.description });
  }
  const sum = (k) => Object.values(byType).reduce((s, t) => s + (t[k] ?? 0), 0);
  const allTn = Object.values(byType).every((t) => t.tn !== null);
  const totals = { planted: sum('planted'), detected: sum('detected'), tp: sum('tp'), fp: sum('fp'), fn: sum('fn'), tn: allTn ? sum('tn') : null };
  return { totals: { ...totals, ...scores(totals, totals.planted) }, by_issue_type: byType, missed_issues: missed, false_positives: falsePositives };
}

async function loadPopulations(db) {
  const n = async (sql) => Number((await db.query(sql)).rows[0].n);
  return {
    EXPIRED_DOCUMENT_MARKED_VALID: await n('SELECT count(*)::int AS n FROM "Document"'),
    APPROVED_WITH_MISSING_EVIDENCE: await n(`SELECT count(*)::int AS n FROM (SELECT DISTINCT ON (customer_id) decision FROM "OnboardingDecision" ORDER BY customer_id, decided_at DESC, id DESC) d WHERE decision = 'Approved'`),
    OWNERSHIP_OVER_100: await n(`SELECT count(DISTINCT customer_id)::int AS n FROM "BeneficialOwner"`),
    CLOSED_WITHOUT_RESOLUTION: await n(`SELECT count(*)::int AS n FROM "ReviewCase" WHERE status = 'Closed'`),
    DOCUMENT_REUSED_ACROSS_CUSTOMERS: await n('SELECT count(*)::int AS n FROM "Document" WHERE document_number_hash IS NOT NULL OR file_reference IS NOT NULL'),
    DOCUMENT_NAME_MISMATCH: await n('SELECT count(*)::int AS n FROM "Document" WHERE name_on_document IS NOT NULL'),
  };
}

function renderMarkdown(r) {
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const t = r.totals;
  const lines = [
    '# Detection report', '',
    `Seed ${r.seed} - scale ${r.scale} - reference date ${r.reference_date}`, '',
    '## Summary', '',
    '| Measure | Value |', '|---|---:|',
    `| Total planted issues | ${t.planted} |`, `| Total detected issues | ${t.detected} |`,
    `| True positives | ${t.tp} |`, `| False positives | ${t.fp} |`, `| False negatives | ${t.fn} |`, `| True negatives | ${t.tn === null ? 'n/a' : t.tn.toLocaleString('en-US')} |`,
    `| Precision | ${pct(t.precision)} |`, `| Recall | ${pct(t.recall)} |`, `| F1 score | ${pct(t.f1_score)} |`, `| Detection rate | ${t.detection_rate_percent.toFixed(2)}% |`, '',
    '## Results by issue type', '',
    '| Issue type | Planted | Detected | TP | FP | FN | TN | Precision | Recall | F1 |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...Object.entries(r.by_issue_type).map(([k, v]) => `| ${k} | ${v.planted} | ${v.detected} | ${v.tp} | ${v.fp} | ${v.fn} | ${v.tn === null ? 'n/a' : v.tn.toLocaleString('en-US')} | ${pct(v.precision)} | ${pct(v.recall)} | ${pct(v.f1_score)} |`),
    '', '## Missed issues (false negatives)', '',
    ...(r.missed_issues.length === 0 ? ['None: every planted issue was detected.'] : ['| Issue | Type | Entity | Customer | Injection method |', '|---|---|---|---|---|', ...r.missed_issues.map((m) => `| ${m.issue_id} | ${m.issue_type} | ${m.entity_id} | ${m.related_customer_id} | ${m.injection_method} |`)]),
    '', '## False positives', '',
    ...(r.false_positives.length === 0 ? ['None: nothing was flagged that was not planted.'] : ['| Detection | Type | Entity | Customer | Description |', '|---|---|---|---|---|', ...r.false_positives.slice(0, 100).map((f) => `| ${f.detection_id} | ${f.issue_type} | ${f.entity_id} | ${f.related_customer_id} | ${f.description.replace(/\|/g, '/')} |`), ...(r.false_positives.length > 100 ? [`| ... | | | | ${r.false_positives.length - 100} more in detection_report.json |`] : [])]),
    '', '## How to read this', '',
    ...r.notes.map((n) => `- ${n}`),
  ];
  return lines.join('\n');
}

async function evaluate(argv = process.argv.slice(2)) {
  const a = {};
  for (const x of argv) if (x.startsWith('--')) { const [k, v] = x.slice(2).split('='); a[k] = v === undefined ? true : v; }
  const scale = a.scale || 'full';
  const database = a.database || `clearkyc_${scale}_edge`;
  const datasetDir = path.resolve(a['dataset-dir'] || path.join(__dirname, '..', 'dataset'));
  const truth = JSON.parse(fs.readFileSync(path.join(datasetDir, 'ground_truth.json'), 'utf8'));
  const found = JSON.parse(fs.readFileSync(path.join(datasetDir, 'detection_results.json'), 'utf8'));
  const db = new Client({ connectionString: connectionString(database) });
  await db.connect();
  let populations;
  try {
    populations = await loadPopulations(db);
  } finally {
    await db.end();
  }
  const metrics = computeMetrics(truth.issues, found.detections, populations);
  const report = {
    seed: truth.seed, scale: truth.scale, reference_date: truth.reference_date,
    evaluation_unit: 'one record plus one issue type (entity_type | entity_id | issue_type); a repeated detection of the same pair counts once',
    populations_for_true_negatives: populations,
    ...metrics,
    notes: [
      'Precision = TP / (TP + FP); Recall = TP / (TP + FN); F1 = 2 x Precision x Recall / (Precision + Recall); Detection rate = detected planted issues / planted issues x 100. A zero denominator gives 0.',
      'True negatives = evaluated records of that issue type (see populations_for_true_negatives) minus TP, FP and FN.',
      'The answer key was read only by this script, after detection had finished. It did not change the detector results.',
      'Detection of EXPIRED_DOCUMENT_MARKED_VALID requires the Verified decision to be recorded after the expiry date. Documents that expired after a correct verification are ordinary and are not planted issues; see documentation/edge_case_rules.md.',
    ],
  };
  fs.writeFileSync(path.join(datasetDir, 'detection_report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(datasetDir, 'detection_report.md'), renderMarkdown(report));
  return { report, datasetDir };
}

if (require.main === module) {
  evaluate()
    .then(({ report, datasetDir }) => {
      const t = report.totals;
      console.log(`\nDetection evaluation (scale ${report.scale}, seed ${report.seed})`);
      console.log(`  planted ${t.planted}   detected ${t.detected}   TP ${t.tp}   FP ${t.fp}   FN ${t.fn}   TN ${t.tn}`);
      console.log(`  precision ${(t.precision * 100).toFixed(2)}%   recall ${(t.recall * 100).toFixed(2)}%   F1 ${(t.f1_score * 100).toFixed(2)}%   detection rate ${t.detection_rate_percent.toFixed(2)}%`);
      for (const [k, v] of Object.entries(report.by_issue_type)) console.log(`  ${k.padEnd(36)} planted ${String(v.planted).padStart(3)}  TP ${String(v.tp).padStart(3)}  FP ${String(v.fp).padStart(3)}  FN ${String(v.fn).padStart(3)}`);
      console.log(`  reports: ${path.join(datasetDir, 'detection_report.json')} / .md\n`);
    })
    .catch((err) => {
      console.error(`Evaluation stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { computeMetrics, evaluate, renderMarkdown, safeDivide, loadPopulations };
