#!/usr/bin/env node
/**
 * Edge-case injection (Phase 3).
 *
 *   npm run inject:edge-cases -- --scale=full
 *   node generator/edgeCases/index.js --scale=starter --seed=20261022 --dataset-dir=dataset [--regenerate-baseline]
 *
 * Workflow
 *   1. make sure a VALID baseline exists (generator/index.js into clearkyc_<scale>; generated now if it is missing or out of date);
 *   2. prove the baseline is clean: the independent detector finds nothing in it;
 *   3. copy the baseline into its own database clearkyc_<scale>_edge (the baseline and the development database stay untouched);
 *   4. add the legitimate look-alikes, then plant the six kinds of issue with seeded, deterministic choices;
 *   5. write the answer key (dataset/ground_truth.json) and the manifest (dataset/edge_case_manifest.json).
 *
 * The answer key is only ever WRITTEN here and READ by evaluation/evaluateDetection.js. The detector never opens it.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('pg');
const { SCALES } = require('../config/generatorConfig');
const { createRng } = require('../utils/seededRandom');
const { connectionString, loadPeople } = require('./common');
const { PLAN } = require('./edgeCasePlan');
const { addSharedDocuments, countLookAlikes } = require('./legitimateControls');
const { runDetection } = require('../../detector/detectionEngine');

const MODULES = [
  require('./expiredDocumentValid'),
  require('./approvedMissingEvidence'),
  require('./ownershipOver100'),
  require('./reviewWithoutResolution'),
  require('./duplicateDocument'),
  require('./nameMismatch'),
];

function parse(argv) {
  const a = {};
  for (const x of argv) {
    if (!x.startsWith('--')) continue;
    const [k, v] = x.slice(2).split('=');
    a[k] = v === undefined ? true : v;
  }
  return a;
}

const safeName = (n) => /^clearkyc_[a-z0-9_]+$/.test(n);

async function adminClient() {
  const client = new Client({ connectionString: connectionString('postgres') });
  await client.connect();
  return client;
}

/** The baseline is valid when it exists, has the planned customers and already carries onboarding decisions + document names. */
async function baselineIsCurrent(database, expectedCustomers) {
  const admin = await adminClient();
  try {
    if ((await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [database])).rowCount === 0) return false;
  } finally {
    await admin.end();
  }
  const db = new Client({ connectionString: connectionString(database) });
  await db.connect();
  try {
    if (!(await db.query(`SELECT to_regclass('"OnboardingDecision"') AS t`)).rows[0].t) return false;
    const r = (await db.query(`SELECT (SELECT count(*) FROM "Customer")::int AS customers, (SELECT count(*) FROM "OnboardingDecision")::int AS decisions,
                                      (SELECT count(*) FROM "Document" WHERE name_on_document IS NULL)::int AS unnamed`)).rows[0];
    return r.customers === expectedCustomers && r.decisions > 0 && r.unnamed === 0;
  } catch {
    return false;
  } finally {
    await db.end();
  }
}

async function tableChecksums(db) {
  const out = {};
  for (const table of ['Document', 'OnboardingDecision', 'BeneficialOwner', 'ReviewCase']) {
    out[table] = (await db.query(`SELECT md5(coalesce(string_agg(md5(t::text), '' ORDER BY t.id), '')) AS sum FROM "${table}" t`)).rows[0].sum;
  }
  out.CompanyOwnership = (await db.query(
    `SELECT md5(coalesce(string_agg(md5(row(company_customer_id, beneficial_owner_id, person_ref, ownership_percentage, ownership_type, control_type, effective_from, effective_to)::text), '' ORDER BY company_customer_id, beneficial_owner_id, id), '')) AS sum FROM "CompanyOwnership"`
  )).rows[0].sum;
  out.dataset = crypto.createHash('md5').update(Object.keys(out).sort().map((k) => `${k}:${out[k]}`).join('|')).digest('hex');
  return out;
}

async function injectEdgeCases(argv = process.argv.slice(2)) {
  const a = parse(argv);
  const scale = a.scale || 'full';
  if (!SCALES[scale]) throw new Error(`Unknown scale "${scale}". Use one of: ${Object.keys(SCALES).join(', ')}`);
  const seed = Number(a.seed ?? 20261022);
  if (!Number.isInteger(seed)) throw new Error('--seed must be a whole number');
  const referenceDate = a['reference-date'] || '2026-10-31';
  const baselineDb = a['source-database'] || `clearkyc_${scale}`;
  const edgeDb = a.database || `clearkyc_${scale}_edge`;
  if (!safeName(baselineDb) || !safeName(edgeDb) || baselineDb === edgeDb) {
    throw new Error('The baseline and edge databases must be different, lower-case names starting with "clearkyc_". The main development database is never used.');
  }
  const datasetDir = path.resolve(a['dataset-dir'] || path.join(__dirname, '..', '..', 'dataset'));
  fs.mkdirSync(datasetDir, { recursive: true });

  // 1. a valid baseline
  let regenerated = false;
  if (a['regenerate-baseline'] || !(await baselineIsCurrent(baselineDb, SCALES[scale].customers))) {
    console.log(`Generating the baseline dataset into ${baselineDb} ...`);
    const { generate } = require('../index');
    const reportArg = a['baseline-report-dir'] ? [`--report-dir=${a['baseline-report-dir']}`] : [];
    const summary = await generate([`--scale=${scale}`, `--seed=${seed}`, `--reference-date=${referenceDate}`, `--database=${baselineDb}`, '--reset', ...reportArg]);
    if (summary.status !== 'SUCCESS') throw new Error(`The baseline could not be generated (${summary.status}). See generator/reports/${scale}/.`);
    regenerated = true;
  }

  // 2. prove it is clean
  const baseline = new Client({ connectionString: connectionString(baselineDb) });
  await baseline.connect();
  let baselineCheck;
  try {
    const result = await runDetection(baseline, { referenceDate });
    baselineCheck = { detections_in_baseline: result.detections.length, per_rule: result.perRule.map((p) => ({ issue_type: p.issueType, flagged: p.findings })) };
  } finally {
    await baseline.end();
  }
  if (baselineCheck.detections_in_baseline > 0) throw new Error(`The baseline is not clean: the detector flagged ${baselineCheck.detections_in_baseline} record(s) before any issue was planted.`);

  // 3. copy it
  const admin = await adminClient();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${edgeDb}" WITH (FORCE)`);
    try {
      await admin.query(`CREATE DATABASE "${edgeDb}" TEMPLATE "${baselineDb}"`);
    } catch (err) {
      throw new Error(`Could not copy ${baselineDb} (is anything connected to it, for example the API?): ${err.message}`);
    }
  } finally {
    await admin.end();
  }

  // 4. legitimate look-alikes, then the planted issues
  const db = new Client({ connectionString: connectionString(edgeDb) });
  await db.connect();
  const root = createRng(seed);
  const plan = PLAN[scale];
  const ctx = {
    db, referenceDate, stamp: `${referenceDate}T23:00:00.000Z`, used: { customers: new Set() }, people: await loadPeople(db), rng: null,
  };
  let issues = [];
  let manifest;
  try {
    ctx.rng = root.fork('edge/legitimate-shared-documents');
    const sharedDocuments = await addSharedDocuments(ctx, plan.legitimateSharedDocuments);

    const injected = {};
    const relaxed = [];
    for (const m of MODULES) {
      ctx.rng = root.fork(`edge/${m.issueType}`);
      const found = await m.inject(ctx, plan[m.issueType]);
      injected[m.issueType] = found.length;
      if (found.length > 0 && m.relaxedConstraints) relaxed.push(...m.relaxedConstraints);
      for (const f of found) issues.push({ m, ...f });
    }

    issues = issues.map((f, i) => ({
      issue_id: `ISSUE-${String(i + 1).padStart(6, '0')}`,
      issue_type: f.m.issueType,
      entity_type: f.m.entityType,
      entity_id: f.entity_id,
      related_customer_id: f.related_customer_id,
      expected_detection: true,
      severity: f.m.severity,
      description: f.description,
      injection_method: f.injection_method,
      expected_detection_rule: f.m.rule,
      _change: f.change,
    }));

    ctx.rng = root.fork('edge/counts');
    manifest = {
      schema_version: 1,
      seed, scale, reference_date: referenceDate,
      baseline_check: baselineCheck,
      plan: Object.fromEntries(Object.keys(injected).map((k) => [k, { requested: plan[k], injected: injected[k], shortfall: plan[k] - injected[k] }])),
      relaxed_constraints_in_edge_database_only: relaxed,
      negative_controls: { look_alikes_in_dataset: await countLookAlikes(ctx), shared_documents_between_related_companies: sharedDocuments },
      changes: issues.map((i) => ({ issue_id: i.issue_id, issue_type: i.issue_type, ...i._change })),
      edge_database_checksums: await tableChecksums(db),
    };
  } finally {
    await db.end();
  }

  const byType = {};
  for (const i of issues) byType[i.issue_type] = (byType[i.issue_type] || 0) + 1;
  const groundTruth = {
    seed, scale, reference_date: referenceDate,
    note: 'Official answer key. Stored apart from the operational database; the detection engine never reads it.',
    total_issues: issues.length, issues_by_type: byType,
    issues: issues.map(({ _change, ...rest }) => rest),
  };
  const truthText = JSON.stringify(groundTruth, null, 2);
  manifest.ground_truth_sha256 = crypto.createHash('sha256').update(truthText).digest('hex'); // lets later stages prove the answer key was not edited
  fs.writeFileSync(path.join(datasetDir, 'ground_truth.json'), truthText);
  fs.writeFileSync(path.join(datasetDir, 'edge_case_manifest.json'), JSON.stringify(manifest, null, 2));
  return { groundTruth, manifest, datasetDir, edgeDb, baselineDb };
}

if (require.main === module) {
  injectEdgeCases()
    .then((r) => {
      console.log(`\nEdge cases planted in ${r.edgeDb} (baseline ${r.baselineDb} untouched), seed ${r.groundTruth.seed}`);
      for (const [type, p] of Object.entries(r.manifest.plan)) console.log(`  ${type.padEnd(36)} ${String(p.injected).padStart(4)} planted (requested ${p.requested})`);
      console.log(`  ${'TOTAL'.padEnd(36)} ${String(r.groundTruth.total_issues).padStart(4)}`);
      console.log(`  answer key: ${path.join(r.datasetDir, 'ground_truth.json')}\n  manifest:   ${path.join(r.datasetDir, 'edge_case_manifest.json')}\n`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(`\nEdge-case injection stopped: ${err.message}\n`);
      process.exit(1);
    });
}

module.exports = { injectEdgeCases };
