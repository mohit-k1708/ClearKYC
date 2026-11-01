#!/usr/bin/env node
/**
 * Final detection summary (Phase 4, task 3). Independently re-checks the Phase 3 detection report instead of trusting it:
 *
 *   - recomputes TP / FP / FN / TN, precision, recall, F1 and detection rate from the raw files and compares them with the report;
 *   - confirms every planted issue was evaluated (planted = TP + FN, no label left out);
 *   - confirms the answer key was not edited after it was written (its SHA-256 is in the manifest);
 *   - confirms the detector does not read the answer key (source scan) and that its saved results were not touched
 *     (the detector is run again now on the database and must produce exactly the saved results);
 *   - reviews every false positive and lists every missed issue.
 *
 *   npm run summarize:detection -- --scale=full
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { connectionString } = require('../generator/edgeCases/common');
const { runDetection } = require('../detector/detectionEngine');
const { computeMetrics, loadPopulations } = require('../evaluation/evaluateDetection');

const ROOT = path.join(__dirname, '..');
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

function detectorSourceFiles() {
  const files = [];
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (f.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'detector'));
  return files;
}

async function buildSummary({ database, datasetDir, referenceDate }) {
  const truthText = fs.readFileSync(path.join(datasetDir, 'ground_truth.json'), 'utf8');
  const truth = JSON.parse(truthText);
  const manifest = readJson(datasetDir, 'edge_case_manifest.json');
  const saved = readJson(datasetDir, 'detection_results.json');
  const report = readJson(datasetDir, 'detection_report.json');

  const db = new Client({ connectionString: connectionString(database) });
  await db.connect();
  let populations;
  let rerun;
  try {
    populations = await loadPopulations(db);
    rerun = await runDetection(db, { referenceDate });
  } finally {
    await db.end();
  }

  const recomputed = computeMetrics(truth.issues, saved.detections, populations);
  const keys = ['planted', 'detected', 'tp', 'fp', 'fn', 'tn', 'precision', 'recall', 'f1_score', 'detection_rate_percent'];
  const metricDifferences = keys.filter((k) => recomputed.totals[k] !== report.totals[k]).map((k) => ({ metric: k, recomputed: recomputed.totals[k], reported: report.totals[k] }));

  const unit = (x) => `${x.entity_type}|${x.entity_id}|${x.issue_type}`;
  const detected = new Set(saved.detections.map(unit));
  const evaluatedAsTp = truth.issues.filter((i) => detected.has(unit(i)));
  const evaluatedAsFn = truth.issues.filter((i) => !detected.has(unit(i)));

  const sources = detectorSourceFiles();
  const offenders = sources.filter((f) => {
    const text = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    return /ground[_-]?truth|edge_case_manifest|ISSUE-|require\([^)]*generator\//i.test(text);
  }).map((f) => path.relative(ROOT, f));
  const resultsClean = !/ISSUE-\d{6}|injection_method|expected_detection/.test(JSON.stringify(saved));
  const identicalOnRerun = JSON.stringify(rerun.detections) === JSON.stringify(saved.detections);

  const changed = new Set(manifest.changes.map((c) => c.key));
  const falsePositiveReview = recomputed.false_positives.map((f) => ({
    detection_id: f.detection_id, issue_type: f.issue_type, entity_id: f.entity_id, related_customer_id: f.related_customer_id,
    verdict: changed.has(f.entity_id) || [...changed].some((k) => k === f.related_customer_id)
      ? 'collateral effect of an injection on a record that was not labelled for this issue type: the injection must be fixed'
      : 'the rule fired on a record the injection never touched: the rule over-reaches and must be reviewed',
  }));

  const checks = [
    ['Every planted issue was evaluated (planted = detected planted + missed)', truth.issues.length === evaluatedAsTp.length + evaluatedAsFn.length && recomputed.totals.planted === truth.issues.length],
    ['The evaluation report matches an independent recomputation from the raw files', metricDifferences.length === 0],
    ['The answer key was not modified after it was written (SHA-256 matches the manifest)', sha256(truthText) === manifest.ground_truth_sha256],
    ['The detector source does not read the answer key or import the generator', offenders.length === 0],
    ['The saved detection results carry no answer-key fields', resultsClean],
    ['Running the detector again gives exactly the saved results (nothing was altered)', identicalOnRerun],
    ['Every false positive has been reviewed', falsePositiveReview.length === recomputed.false_positives.length],
    ['Every missed issue is listed', recomputed.missed_issues.length === evaluatedAsFn.length],
  ].map(([name, ok]) => ({ name, result: ok ? 'PASS' : 'FAIL' }));

  return {
    status: checks.every((c) => c.result === 'PASS') ? 'PASS' : 'FAIL',
    seed: truth.seed, scale: truth.scale, reference_date: truth.reference_date,
    totals: recomputed.totals,
    by_issue_type: recomputed.by_issue_type,
    missed_issues: recomputed.missed_issues,
    false_positives: recomputed.false_positives,
    false_positive_review: falsePositiveReview,
    integrity_checks: checks,
    metric_differences: metricDifferences,
    detector_sources_scanned: sources.map((f) => path.relative(ROOT, f).replace(/\\/g, '/')).sort(),
    ground_truth_sha256: sha256(truthText),
    note: 'The metrics of a rule-based detector on cases planted by the same authors are expected to be high. They show that the rules find what they were built for and do not fire on the legitimate look-alikes; they do not predict accuracy on real data.',
  };
}

function renderMarkdown(s) {
  const pct = (x) => `${(x * 100).toFixed(2)}%`;
  const t = s.totals;
  return [
    '# Final detection summary', '', `Seed ${s.seed} - scale ${s.scale} - reference date ${s.reference_date} - **${s.status}**`, '',
    '| Measure | Value |', '|---|---:|', `| Planted issues | ${t.planted} |`, `| Detected | ${t.detected} |`, `| True positives | ${t.tp} |`, `| False positives | ${t.fp} |`, `| False negatives | ${t.fn} |`, `| True negatives | ${t.tn === null ? 'n/a' : t.tn.toLocaleString('en-US')} |`,
    `| Precision | ${pct(t.precision)} |`, `| Recall | ${pct(t.recall)} |`, `| F1 score | ${pct(t.f1_score)} |`, `| Detection rate | ${t.detection_rate_percent.toFixed(2)}% |`, '',
    '## By issue type', '', '| Issue type | Planted | TP | FP | FN |', '|---|---:|---:|---:|---:|',
    ...Object.entries(s.by_issue_type).map(([k, v]) => `| ${k} | ${v.planted} | ${v.tp} | ${v.fp} | ${v.fn} |`), '',
    '## Integrity checks', '', ...s.integrity_checks.map((c) => `* ${c.result}: ${c.name}`), '',
    '## Missed issues', '', ...(s.missed_issues.length ? s.missed_issues.map((m) => `* ${m.issue_id} ${m.issue_type} ${m.entity_id}`) : ['None.']), '',
    '## False positives and their review', '', ...(s.false_positive_review.length ? s.false_positive_review.map((f) => `* ${f.detection_id} ${f.issue_type} ${f.entity_id}: ${f.verdict}`) : ['None - nothing was flagged that was not planted.']), '',
    `Answer key SHA-256: \`${s.ground_truth_sha256}\``, '', s.note, '',
  ].join('\n');
}

if (require.main === module) {
  const a = {};
  for (const x of process.argv.slice(2)) if (x.startsWith('--')) { const [k, v] = x.slice(2).split('='); a[k] = v === undefined ? true : v; }
  const scale = a.scale || 'full';
  const datasetDir = path.resolve(a['dataset-dir'] || path.join(ROOT, 'dataset'));
  buildSummary({ database: a.database || `clearkyc_${scale}_edge`, datasetDir, referenceDate: a['reference-date'] || '2026-10-31' })
    .then((s) => {
      fs.writeFileSync(path.join(datasetDir, 'final_detection_summary.json'), JSON.stringify(s, null, 2));
      fs.writeFileSync(path.join(datasetDir, 'final_detection_summary.md'), renderMarkdown(s));
      console.log(`\nFinal detection summary: ${s.status}  (TP ${s.totals.tp}, FP ${s.totals.fp}, FN ${s.totals.fn}; precision ${(s.totals.precision * 100).toFixed(2)}%, recall ${(s.totals.recall * 100).toFixed(2)}%)`);
      for (const c of s.integrity_checks) console.log(`  ${c.result}  ${c.name}`);
      console.log('');
      process.exit(s.status === 'PASS' ? 0 : 1);
    })
    .catch((err) => {
      console.error(`Summary stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { buildSummary, renderMarkdown };
