#!/usr/bin/env node
/**
 * Task 8: labels the anomalies that were ALREADY planted in the development data by the earlier scene seed scripts
 * (scripts/generateOwnershipData.js, generateKycData.js, generateReviewData.js). READ-ONLY: it changes nothing.
 *
 *   npm run label:existing                       (database: clearkyc, the development database)
 *   node generator/edgeCases/labelExisting.js --database=clearkyc --dataset-dir=dataset
 *
 * Each label points at the seed scenario that planted the record (the scripts document their scenarios), so the label comes from
 * how the data was made, and the database query only finds WHICH records the scenario produced. Ordinary workflow conditions
 * (a document still pending, an upcoming review, a potential screening match under review) are not anomalies and are not labelled.
 * The labels go to dataset/existing_dataset_labels.json - a separate file with LEGACY- IDs, never mixed into ground_truth.json.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { connectionString } = require('./common');

function parse(argv) {
  const a = {};
  for (const x of argv) {
    if (!x.startsWith('--')) continue;
    const [k, v] = x.slice(2).split('=');
    a[k] = v === undefined ? true : v;
  }
  return a;
}

async function labelExisting(argv = process.argv.slice(2)) {
  const a = parse(argv);
  const database = a.database || 'clearkyc';
  const referenceDate = a['reference-date'] || '2026-10-31';
  const datasetDir = path.resolve(a['dataset-dir'] || path.join(__dirname, '..', '..', 'dataset'));
  const db = new Client({ connectionString: connectionString(database) });
  await db.connect();
  const labels = [];
  const add = (issue_type, entity_type, entity_id, related_customer_id, severity, description, source_scenario, source_script, covered_by_detector, evidence) =>
    labels.push({ issue_type, entity_type, entity_id, related_customer_id, severity, description, source_scenario, source_script, covered_by_detector, evidence });
  try {
    const rows = async (sql, params) => (await db.query(sql, params)).rows;

    for (const r of await rows(`SELECT c.customer_id AS code, sum(b.ownership_percentage)::text AS total, count(*)::int AS owners FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id GROUP BY c.id, c.customer_id HAVING sum(b.ownership_percentage) > 100 ORDER BY c.id`)) {
      add('OWNERSHIP_OVER_100', 'Customer', r.code, r.code, 'HIGH', `Owners hold ${Number(r.total)}% in total.`, 'OVER_100 (60% + 50%)', 'scripts/generateOwnershipData.js', true, { total_percentage: Number(r.total), owners: r.owners });
    }
    for (const r of await rows(`SELECT c.customer_id AS code, sum(b.ownership_percentage)::text AS total FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id GROUP BY c.id, c.customer_id HAVING sum(b.ownership_percentage) < 100 ORDER BY c.id`)) {
      add('OWNERSHIP_BELOW_100', 'Customer', r.code, r.code, 'MEDIUM', `Owners hold only ${Number(r.total)}% in total.`, 'UNDER_100 (40% + 30%)', 'scripts/generateOwnershipData.js', false, { total_percentage: Number(r.total) });
    }
    for (const r of await rows(`SELECT c.customer_id AS code FROM "Customer" c WHERE c.customer_type_id = 2 AND NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.customer_id = c.id) ORDER BY c.id`)) {
      add('MISSING_BENEFICIAL_OWNERS', 'Customer', r.code, r.code, 'MEDIUM', 'The company has no beneficial owners recorded.', 'NO_OWNERS', 'scripts/generateOwnershipData.js', false, { owners: 0 });
    }
    const latest = `JOIN LATERAL (SELECT status, verification_date FROM "Verification" v WHERE v.document_id = d.id ORDER BY v.id DESC LIMIT 1) v ON true`;
    for (const r of await rows(`SELECT d.business_id, c.customer_id AS code, d.document_type, d.expiry_date::text AS expiry, v.verification_date::date::text AS verified_on FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id ${latest}
                                 WHERE d.expiry_date < $1::date AND v.status = 'Verified' ORDER BY d.id`, [referenceDate])) {
      add('EXPIRED_DOCUMENT_MARKED_VALID', 'Document', r.business_id, r.code, 'HIGH', `${r.document_type} expired on ${r.expiry} yet its newest verification is still Verified (verified ${r.verified_on}).`,
        'EXPIRED (verified_expired)', 'scripts/generateKycData.js', r.verified_on > r.expiry, { expiry_date: r.expiry, verified_on: r.verified_on, verified_after_expiry: r.verified_on > r.expiry });
    }
    for (const r of await rows(`SELECT d.business_id, c.customer_id AS code, d.document_type, v.status FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id ${latest} WHERE v.status IN ('Rejected', 'Requires Resubmission') ORDER BY d.id`)) {
      add(r.status === 'Rejected' ? 'REJECTED_DOCUMENT' : 'DOCUMENT_REQUIRES_RESUBMISSION', 'Document', r.business_id, r.code, 'MEDIUM', `${r.document_type} is ${r.status}.`, 'REJECTED (rejected / resubmit)', 'scripts/generateKycData.js', false, { status: r.status });
    }
    for (const r of await rows(`SELECT c.customer_id AS code, s.cycle_number, s.next_review_date::text AS due FROM "ReviewSchedule" s JOIN "Customer" c ON c.id = s.customer_id WHERE s.status = 'Scheduled' AND s.next_review_date < $1::date ORDER BY s.id`, [referenceDate])) {
      add('OVERDUE_PERIODIC_REVIEW', 'ReviewSchedule', `${r.code}/cycle-${r.cycle_number}`, r.code, 'MEDIUM', `The periodic review was due on ${r.due}.`, 'overdue by 20 / 45 / 100 days', 'scripts/generateReviewData.js', false, { next_review_date: r.due });
    }
    for (const r of await rows(`SELECT rc.review_code, c.customer_id AS code, e.exception_code FROM "ReviewCase" rc JOIN "Customer" c ON c.id = rc.customer_id JOIN "Exception" e ON e.id = rc.exception_id WHERE rc.status = 'Closed' AND e.status <> 'Resolved' ORDER BY rc.id`)) {
      add('REVIEW_CLOSED_ISSUE_PERSISTS', 'ReviewCase', r.review_code, r.code, 'MEDIUM', `The case was closed while exception ${r.exception_code} is still active.`, 'thirteenth case: closed while the issue persists', 'scripts/generateReviewData.js', false, { exception: r.exception_code });
    }
    var counts = (await rows(`SELECT (SELECT count(*) FROM "Customer")::int AS customers, (SELECT count(*) FROM "Document")::int AS documents, (SELECT count(*) FROM "ReviewCase")::int AS review_cases`))[0];
  } finally {
    await db.end();
  }

  labels.sort((x, y) => x.issue_type.localeCompare(y.issue_type) || x.entity_id.localeCompare(y.entity_id));
  const issues = labels.map((l, i) => ({ issue_id: `LEGACY-${String(i + 1).padStart(6, '0')}`, ...l }));
  const byType = {};
  for (const i of issues) byType[i.issue_type] = (byType[i.issue_type] || 0) + 1;
  const out = {
    database, reference_date: referenceDate, read_only_inspection: true, dataset_size: counts,
    note: 'Anomalies planted earlier by the scene seed scripts. Kept apart from ground_truth.json (the answer key of the edge-case dataset). covered_by_detector says whether one of the six Phase 3 rules is built to find the issue type; for EXPIRED_DOCUMENT_MARKED_VALID it is true only when the Verified decision was recorded after the expiry date.',
    not_labelled: [
      'Documents that are simply Pending / In Review / expiring soon, mandatory documents not yet submitted, upcoming reviews and potential PEP / sanctions matches under review: ordinary workflow conditions that the application already tracks as exceptions, not errors.',
    ],
    total_issues: issues.length, issues_by_type: byType, issues,
  };
  fs.mkdirSync(datasetDir, { recursive: true });
  fs.writeFileSync(path.join(datasetDir, 'existing_dataset_labels.json'), JSON.stringify(out, null, 2));
  return out;
}

if (require.main === module) {
  labelExisting()
    .then((o) => {
      console.log(`\nLabelled ${o.total_issues} existing planted anomalies in ${o.database} (read-only):`);
      for (const [k, v] of Object.entries(o.issues_by_type)) console.log(`  ${k.padEnd(34)} ${v}`);
      console.log('  file: dataset/existing_dataset_labels.json\n');
    })
    .catch((err) => {
      console.error(`Labelling stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { labelExisting };
