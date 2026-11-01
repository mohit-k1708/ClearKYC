/**
 * Dataset validator: runs every check on one database and sorts each violation into
 *   EXPECTED    it belongs to a deliberately planted, labelled anomaly (the answer key names that record or its customer), or
 *   UNEXPECTED  anything else - accidental corruption. Never hidden, never excluded.
 * A check with only expected violations is reported as PASS_WITH_EXPECTED_EXCEPTIONS (and still listed with the issue IDs).
 *
 * This is the one place besides the evaluation script that reads the answer key: the validator needs it precisely to tell planted
 * errors from accidents. It reads it only to classify, never to hide a violation.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { connectionString } = require('../generator/edgeCases/common');
const { runDetection } = require('../detector/detectionEngine');
const { sqlChecks, engineChecks, TABLES } = require('./datasetChecks');

const EXAMPLES = 5;

// How to turn a violating row (table + id) into a business key and the customer it belongs to.
const KEYS = {
  Customer: { key: 't.customer_id', customer: 't.customer_id', from: '"Customer" t' },
  Document: { key: 't.business_id', customer: 'c.customer_id', from: '"Document" t JOIN "Customer" c ON c.id = t.customer_id' },
  ReviewCase: { key: 't.review_code', customer: 'c.customer_id', from: '"ReviewCase" t JOIN "Customer" c ON c.id = t.customer_id' },
  Alert: { key: 't.business_id', customer: 'c.customer_id', from: '"Alert" t JOIN "Customer" c ON c.id = t.customer_id' },
  Exception: { key: 't.exception_code', customer: 'c.customer_id', from: '"Exception" t JOIN "Customer" c ON c.id = t.customer_id' },
  RiskRating: { key: 't.assessment_code', customer: 'c.customer_id', from: '"RiskRating" t JOIN "Customer" c ON c.id = t.customer_id' },
  BeneficialOwner: { key: `'OWNER#' || t.id`, customer: 'c.customer_id', from: '"BeneficialOwner" t JOIN "Customer" c ON c.id = t.customer_id' },
  OnboardingDecision: { key: `'DECISION#' || t.id`, customer: 'c.customer_id', from: '"OnboardingDecision" t JOIN "Customer" c ON c.id = t.customer_id' },
  CompanyOwnership: { key: `'OWNERSHIP#' || t.id`, customer: 'c.customer_id', from: '"CompanyOwnership" t JOIN "Customer" c ON c.id = t.company_customer_id' },
  ReviewSchedule: { key: `'SCHEDULE#' || t.id`, customer: 'c.customer_id', from: '"ReviewSchedule" t JOIN "Customer" c ON c.id = t.customer_id' },
  Verification: { key: `'VERIFICATION#' || t.id`, customer: 'c.customer_id', from: '"Verification" t JOIN "Document" d ON d.id = t.document_id JOIN "Customer" c ON c.id = d.customer_id' },
  AuditEvent: { key: 't.event_code', customer: 'c.customer_id', from: '"AuditEvent" t LEFT JOIN "Customer" c ON c.id = t.customer_id' },
};

async function resolve(db, table, ids) {
  const numeric = ids.filter((i) => Number.isInteger(Number(i)) && String(i).trim() !== '').map(Number);
  const known = KEYS[table];
  const out = new Map(ids.map((i) => [String(i), { key: `${table}#${i}`, customer: null }]));
  if (!known || numeric.length === 0) return out;
  const rows = (await db.query(`SELECT t.id, ${known.key} AS key, ${known.customer} AS customer FROM ${known.from} WHERE t.id = ANY($1::int[])`, [numeric])).rows;
  for (const r of rows) out.set(String(r.id), { key: r.key, customer: r.customer });
  return out;
}

function groundTruthIndex(truth) {
  const byType = new Map();
  for (const i of truth?.issues ?? []) {
    if (!byType.has(i.issue_type)) byType.set(i.issue_type, { entities: new Map(), customers: new Map() });
    byType.get(i.issue_type).entities.set(i.entity_id, i.issue_id);
    byType.get(i.issue_type).customers.set(i.related_customer_id, i.issue_id);
  }
  return byType;
}

/** The planted issue (ID) that explains a violation, or null. */
function explain(index, planted, v) {
  for (const type of planted) {
    const t = index.get(type);
    if (!t) continue;
    const hit = t.entities.get(v.key) ?? (v.customer ? t.customers.get(v.customer) : undefined);
    if (hit) return hit;
  }
  return null;
}

function settle(check, violations, index) {
  const expected = [];
  const unexpected = [];
  for (const v of violations) {
    if (check.info) continue; // informational findings are reported on their own, never as errors
    const issue = check.planted?.length ? explain(index, check.planted, v) : null;
    (issue ? expected : unexpected).push({ ...v, issue_id: issue });
  }
  let status = 'PASS';
  if (check.info) status = violations.length ? 'INFO' : 'PASS';
  else if (unexpected.length) status = 'FAIL';
  else if (expected.length) status = 'PASS_WITH_EXPECTED_EXCEPTIONS';
  return {
    group: check.group, name: check.name, table: check.table ?? null, status, violations: violations.length, expected: expected.length, unexpected: unexpected.length,
    planted_issue_types: check.planted ?? [], expected_issue_ids: [...new Set(expected.map((e) => e.issue_id))].sort(),
    unexpected_examples: unexpected.slice(0, EXAMPLES).map(({ key, customer, detail }) => ({ record: key, customer, detail: detail ?? null })),
  };
}

async function groundTruthChecks(db, { truth, referenceDate, exportDir, expectedSeed }) {
  const out = [];
  const add = (name, violations) => out.push({ group: 'Ground truth', name, table: 'GroundTruth', planted: [], violations });
  const v = (key, customer, detail) => ({ table: 'GroundTruth', key, customer, detail });
  if (!truth) {
    add('The answer key (ground_truth.json) is present and readable', [v('ground_truth.json', null, 'missing or unreadable')]);
    return out;
  }
  const issues = truth.issues ?? [];
  add('The answer key was made with the fixed seed', truth.seed === expectedSeed ? [] : [v('ground_truth.json', null, `seed ${truth.seed}, expected ${expectedSeed}`)]);
  const seenIds = new Map();
  const seenUnits = new Map();
  const dupIds = [];
  for (const i of issues) {
    seenIds.set(i.issue_id, (seenIds.get(i.issue_id) || 0) + 1);
    const unit = `${i.entity_type}|${i.entity_id}|${i.issue_type}`;
    seenUnits.set(unit, (seenUnits.get(unit) || 0) + 1);
    if (!/^ISSUE-\d{6}$/.test(i.issue_id ?? '')) dupIds.push(v(String(i.issue_id), i.related_customer_id, 'malformed issue ID'));
  }
  add('Every planted issue has a unique, well-formed issue ID', [...dupIds, ...[...seenIds].filter(([, n]) => n > 1).map(([id]) => v(id, null, 'issue ID used twice'))]);
  add('Every planted issue is a distinct record + issue type', [...seenUnits].filter(([, n]) => n > 1).map(([u]) => v(u, null, 'the same record and issue type is labelled twice')));
  add('Every planted issue has a type, severity, rule and injection method', issues.filter((i) => !i.issue_type || !i.severity || !i.expected_detection_rule || !i.injection_method).map((i) => v(i.issue_id, i.related_customer_id, 'incomplete label')));

  const lookup = { Document: 'SELECT business_id AS key, (SELECT customer_id FROM "Customer" c WHERE c.id = d.customer_id) AS customer FROM "Document" d WHERE business_id = ANY($1)',
    Customer: 'SELECT customer_id AS key, customer_id AS customer FROM "Customer" WHERE customer_id = ANY($1)',
    ReviewCase: 'SELECT review_code AS key, (SELECT customer_id FROM "Customer" c WHERE c.id = r.customer_id) AS customer FROM "ReviewCase" r WHERE review_code = ANY($1)' };
  const missing = [];
  for (const [type, sql] of Object.entries(lookup)) {
    const wanted = issues.filter((i) => i.entity_type === type);
    const found = new Map((await db.query(sql, [wanted.map((i) => i.entity_id)])).rows.map((r) => [r.key, r.customer]));
    for (const i of wanted) {
      if (!found.has(i.entity_id)) missing.push(v(i.issue_id, i.related_customer_id, `${type} ${i.entity_id} does not exist`));
      else if (found.get(i.entity_id) !== i.related_customer_id) missing.push(v(i.issue_id, i.related_customer_id, `${i.entity_id} belongs to ${found.get(i.entity_id)}, not ${i.related_customer_id}`));
    }
  }
  for (const i of issues) if (!lookup[i.entity_type]) missing.push(v(i.issue_id, i.related_customer_id, `unknown entity type ${i.entity_type}`));
  add('Every labelled issue references an existing record of the right customer', missing);

  const leak = (await db.query(`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND (table_name ILIKE '%truth%' OR table_name ILIKE '%planted%' OR table_name ILIKE '%label%')
                                UNION ALL SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND (column_name ILIKE '%planted%' OR column_name ILIKE '%injected%' OR column_name ILIKE 'issue_id' OR column_name ILIKE '%ground%')`)).rows;
  const leaks = leak.map((r) => v(r.name, null, 'labels stored in the operational database'));
  if (exportDir) {
    for (const dir of ['csv', 'json', 'sql']) {
      const full = path.join(exportDir, dir);
      if (!fs.existsSync(full)) continue;
      for (const f of fs.readdirSync(full)) {
        const text = fs.readFileSync(path.join(full, f), 'utf8');
        if (/ISSUE-\d{6}|ground[_-]?truth|expected_detection/i.test(text)) leaks.push(v(`${dir}/${f}`, null, 'answer-key content found in an operational export'));
      }
    }
  }
  add('Ground truth is separate from the operational records (database and exports)', leaks);

  const result = await runDetection(db, { referenceDate });
  const planted = new Set(issues.map((i) => `${i.entity_type}|${i.entity_id}|${i.issue_type}`));
  const detected = new Set(result.detections.map((d) => `${d.entity_type}|${d.entity_id}|${d.issue_type}`));
  add('No unlabelled planted anomalies: everything the independent detector finds is in the answer key',
    result.detections.filter((d) => !planted.has(`${d.entity_type}|${d.entity_id}|${d.issue_type}`)).map((d) => v(d.entity_id, d.related_customer_id, `${d.issue_type}: ${d.description}`)));
  add('Every labelled issue is observable in the data (found by the independent detector)',
    issues.filter((i) => !detected.has(`${i.entity_type}|${i.entity_id}|${i.issue_type}`)).map((i) => v(i.issue_id, i.related_customer_id, `${i.issue_type} on ${i.entity_id} was not found`)));
  return out;
}

async function validateDataset({ database, referenceDate, datasetDir, exportDir = null, expectedSeed = 20261022 }) {
  const db = new Client({ connectionString: connectionString(database) });
  await db.connect();
  try {
    const truthFile = path.join(datasetDir, 'ground_truth.json');
    const truth = fs.existsSync(truthFile) ? JSON.parse(fs.readFileSync(truthFile, 'utf8')) : null;
    const index = groundTruthIndex(truth);

    const fks = (await db.query(`SELECT cc.relname AS child, a.attname AS "column", pc.relname AS parent, pa.attname AS "parentColumn"
                                   FROM pg_constraint k JOIN pg_class cc ON cc.oid = k.conrelid JOIN pg_class pc ON pc.oid = k.confrelid
                                   JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1] JOIN pg_attribute pa ON pa.attrelid = k.confrelid AND pa.attnum = k.confkey[1]
                                  WHERE k.contype = 'f' AND k.connamespace = 'public'::regnamespace AND cc.relname <> 'SystemSetting' ORDER BY cc.relname, a.attname`)).rows; // SystemSetting = Phase 6 application settings, not part of the dataset

    const results = [];
    for (const check of sqlChecks(referenceDate, fks)) {
      let violations;
      try {
        const rows = (await db.query(check.sql)).rows;
        const resolved = await resolve(db, check.table, rows.map((r) => r.id));
        violations = rows.map((r) => ({ table: check.table, ...resolved.get(String(r.id)), detail: null }));
      } catch (err) {
        violations = [{ table: check.table, key: check.table, customer: null, detail: `the check could not run: ${err.message.split('\n')[0]}` }];
      }
      results.push(settle(check, violations, index));
    }
    for (const check of engineChecks(referenceDate)) {
      let violations;
      try {
        const rows = await check.run(db);
        const byTable = new Map();
        for (const r of rows) byTable.set(r.table, [...(byTable.get(r.table) || []), r]);
        violations = [];
        for (const [table, list] of byTable) {
          const resolved = await resolve(db, table, list.map((r) => r.id));
          for (const r of list) violations.push({ table, ...resolved.get(String(r.id)), detail: r.detail });
        }
      } catch (err) {
        violations = [{ table: null, key: 'engine', customer: null, detail: `the check could not run: ${err.message.split('\n')[0]}` }];
      }
      results.push(settle(check, violations, index));
    }
    for (const g of await groundTruthChecks(db, { truth, referenceDate, exportDir, expectedSeed })) results.push(settle(g, g.violations, index));

    const count = async (sql) => Number((await db.query(sql)).rows[0].n);
    const entities = {
      customers: await count('SELECT count(*)::int AS n FROM "Customer"'),
      individual_customers: await count('SELECT count(*)::int AS n FROM "Customer" WHERE customer_type_id = 1'),
      company_customers: await count('SELECT count(*)::int AS n FROM "Customer" WHERE customer_type_id = 2'),
      documents: await count('SELECT count(*)::int AS n FROM "Document"'),
      review_cases: await count('SELECT count(*)::int AS n FROM "ReviewCase"'),
      beneficial_owners: await count('SELECT count(*)::int AS n FROM "BeneficialOwner"'),
      verifications: await count('SELECT count(*)::int AS n FROM "Verification"'),
      risk_assessments: await count('SELECT count(*)::int AS n FROM "RiskRating"'),
      alerts: await count('SELECT count(*)::int AS n FROM "Alert"'),
      audit_events: await count('SELECT count(*)::int AS n FROM "AuditEvent"'),
    };
    const tableCounts = {};
    for (const t of TABLES) tableCounts[t] = await count(`SELECT count(*)::int AS n FROM "${t}"`);
    return { reference_date: referenceDate, ground_truth_loaded: Boolean(truth), planted_issues: truth?.issues?.length ?? 0, entities, table_counts: tableCounts, checks: results };
  } finally {
    await db.end();
  }
}

function summarise(r) {
  const c = r.checks;
  const failed = c.filter((x) => x.status === 'FAIL');
  const withExpected = c.filter((x) => x.status === 'PASS_WITH_EXPECTED_EXCEPTIONS');
  const sum = (key) => c.reduce((s, x) => s + x[key], 0);
  return {
    reference_date: r.reference_date,
    total_customers: r.entities.customers, total_individual_customers: r.entities.individual_customers, total_company_customers: r.entities.company_customers,
    total_documents: r.entities.documents, total_review_cases: r.entities.review_cases, total_beneficial_owners: r.entities.beneficial_owners, total_verifications: r.entities.verifications,
    total_risk_assessments: r.entities.risk_assessments, total_alerts: r.entities.alerts, total_audit_events: r.entities.audit_events,
    total_validation_checks: c.length,
    passed_checks: c.filter((x) => x.status === 'PASS' || x.status === 'INFO').length,
    passed_with_expected_exceptions: withExpected.length,
    failed_checks: failed.length,
    expected_planted_anomalies: { labelled_issues: r.planted_issues, violations_explained_by_labels: sum('expected'), checks_showing_them: withExpected.length },
    unexpected_data_errors: sum('unexpected'),
    informational_findings: c.filter((x) => x.status === 'INFO').map((x) => ({ check: x.name, count: x.violations })),
    validation_status: failed.length === 0 ? 'PASSED' : 'FAILED',
    reproducibility_status: 'NOT_RUN', checksum_status: 'NOT_RUN', export_status: 'NOT_RUN',
  };
}

function renderMarkdown(r, s) {
  const mark = { PASS: 'PASS', PASS_WITH_EXPECTED_EXCEPTIONS: 'PASS (expected exceptions)', FAIL: 'FAIL', INFO: 'INFO' };
  const lines = [
    '# Dataset validation report', '', `Reference date ${r.reference_date} - **${s.validation_status}**`, '',
    `* ${s.total_validation_checks} checks: ${s.passed_checks} passed, ${s.passed_with_expected_exceptions} passed with expected exceptions, ${s.failed_checks} failed.`,
    `* Deliberately planted anomalies (expected): ${s.expected_planted_anomalies.labelled_issues} labelled issues; ${s.expected_planted_anomalies.violations_explained_by_labels} violations are explained by them.`,
    `* Unexpected data errors (accidental corruption): **${s.unexpected_data_errors}**.`, '',
    '| Group | Check | Result | Violations | Expected | Unexpected | Planted issues involved |', '|---|---|---|---:|---:|---:|---|',
    ...r.checks.map((x) => `| ${x.group} | ${x.name.replace(/\|/g, '/')} | ${mark[x.status]} | ${x.violations} | ${x.expected} | ${x.unexpected} | ${x.expected_issue_ids.length ? `${x.expected_issue_ids.length} (${x.expected_issue_ids.slice(0, 3).join(', ')}${x.expected_issue_ids.length > 3 ? ', ...' : ''})` : ''} |`),
  ];
  const bad = r.checks.filter((x) => x.unexpected > 0);
  if (bad.length) {
    lines.push('', '## Unexpected violations', '');
    for (const x of bad) lines.push(`* **${x.name}** (${x.unexpected}): ${x.unexpected_examples.map((e) => `${e.record}${e.detail ? ` - ${e.detail}` : ''}`).join('; ')}`);
  }
  return `${lines.join('\n')}\n`;
}

module.exports = { validateDataset, summarise, renderMarkdown };
