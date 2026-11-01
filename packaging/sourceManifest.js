/**
 * documentation/source_manifest.md: where the data comes from and what it does and does not claim. Written from the actual files
 * of the run (configuration, plan, results), so the numbers cannot drift from the dataset.
 */
const fs = require('fs');
const path = require('path');
const { SCALES, RATIOS, GENERATOR_CONFIG, GENERATOR_VERSION } = require('../generator/config/generatorConfig');
const { PLAN } = require('../generator/edgeCases/edgeCasePlan');

const readJson = (dir, f) => (fs.existsSync(path.join(dir, f)) ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null);

function buildSourceManifest({ datasetDir, exportReport, scale, seed, referenceDate }) {
  const manifest = readJson(datasetDir, 'edge_case_manifest.json');
  const truth = readJson(datasetDir, 'ground_truth.json');
  const validation = readJson(datasetDir, 'validation_summary.json');
  const repro = readJson(datasetDir, 'reproducibility_report.json');
  const counts = SCALES[scale];
  const generationDate = new Date().toISOString().slice(0, 10); // the only wall-clock value; it is not part of the data
  const byType = truth?.issues_by_type ?? {};

  const lines = [
    '# Source Manifest', '',
    '## Provenance in one paragraph', '',
    '**Every record in this dataset is synthetic.** It was produced by the ClearKYC generator from small fictional name pools and seeded random numbers. **No real customer personal data was used and no external personal data source was consulted.** Names, e-mail addresses (`example.com`), phone numbers, addresses, PAN-like and Aadhaar-like identifiers, company registration numbers and documents are invented; the identifiers only follow the *format* of real ones. Nothing was checked against any real sanctions list, PEP list, registry or identity provider: screening outcomes and verifications are simulated.', '',
    '## Generation facts', '',
    '| Item | Value |', '|---|---|',
    `| Fixed random seed | ${seed} |`, `| Reference date (every date and timestamp is generated relative to it, never to the machine clock) | ${referenceDate} |`,
    `| Generator version | ${GENERATOR_VERSION} |`, `| Generation date (the day this package was assembled; run-specific, not part of the data) | ${generationDate} |`,
    `| Dataset scale | ${scale} |`, `| Customers | ${counts.customers.toLocaleString('en-US')} (${(counts.customers - counts.companies).toLocaleString('en-US')} individuals, ${counts.companies.toLocaleString('en-US')} companies) |`,
    `| Documents | ${counts.documents.toLocaleString('en-US')} |`, `| Review cases | ${counts.reviewCases.toLocaleString('en-US')} |`,
    `| Records exported | ${exportReport ? `${exportReport.total_rows.toLocaleString('en-US')} rows in ${exportReport.tables.length} tables` : 'n/a'} |`,
    `| Database | PostgreSQL 17, schema in \`sql/schema.sql\` |`, '',
    '## Generation configuration', '',
    `* Central configuration: \`generator/config/generatorConfig.js\` (\`GENERATOR_CONFIG\`: seed ${GENERATOR_CONFIG.seed}, batch size ${GENERATOR_CONFIG.batchSize}, reference date ${GENERATOR_CONFIG.referenceDate}; \`SCALES\`; \`RATIOS\`).`,
    `* Ratios in use: owners per company ${JSON.stringify(RATIOS.ownersPerCompany)}; share of owner slots held by a person who owns another company ${RATIOS.sharedPersonRate}; replacement-document rate ${RATIOS.replacementDocumentRate}; completed periodic review rate ${RATIOS.completedReviewRate}; share of historical review cases ${RATIOS.historicalCaseShare}; document outcome shares ${JSON.stringify(RATIOS.documentOutcomes)}.`,
    '* Business rules (risk scoring, KYC completeness, exception and alert detection, case workflow, review intervals, expiry lead times 90 / 60 / 30 / 7 days) are the rules of the ClearKYC application itself (`server/src/config/*`), applied in memory. They are illustrative prototype rules, not regulatory requirements.',
    '* Every stage uses its own random stream forked from the seed by name; derived values are calculated from the source records; IDs are deterministic (`CUS-000001`, `KYC-2026-000001`, `DOC-CUS-000001-001`, `REV-CUS-000001-2026`, `ALT-2026-000001`).', '',
    '## Edge cases deliberately injected', '',
    `Planted into a copy of the valid baseline with seed ${seed}, listed in \`ground_truth.json\` (the answer key) with a unique issue ID each. The operational files in \`csv/\`, \`json/\` and \`sql/\` contain the planted records but **no label**: nothing in them says which records are planted.`, '',
    '| Issue type | Planted | What was done |', '|---|---:|---|',
    `| EXPIRED_DOCUMENT_MARKED_VALID | ${byType.EXPIRED_DOCUMENT_MARKED_VALID ?? PLAN[scale].EXPIRED_DOCUMENT_MARKED_VALID} | a Verified document was given dates so it had already expired when it was submitted and verified |`,
    `| APPROVED_WITH_MISSING_EVIDENCE | ${byType.APPROVED_WITH_MISSING_EVIDENCE ?? PLAN[scale].APPROVED_WITH_MISSING_EVIDENCE} | an Approved decision was added while one mandatory document was missing or unverified |`,
    `| OWNERSHIP_OVER_100 | ${byType.OWNERSHIP_OVER_100 ?? PLAN[scale].OWNERSHIP_OVER_100} | a company's beneficial owners were made to total more than 100% |`,
    `| CLOSED_WITHOUT_RESOLUTION | ${byType.CLOSED_WITHOUT_RESOLUTION ?? PLAN[scale].CLOSED_WITHOUT_RESOLUTION} | a Closed review case had its resolution notes removed |`,
    `| DOCUMENT_REUSED_ACROSS_CUSTOMERS | ${byType.DOCUMENT_REUSED_ACROSS_CUSTOMERS ?? PLAN[scale].DOCUMENT_REUSED_ACROSS_CUSTOMERS} | a document of one customer carries the number or file of an unrelated customer's document |`,
    `| DOCUMENT_NAME_MISMATCH | ${byType.DOCUMENT_NAME_MISMATCH ?? PLAN[scale].DOCUMENT_NAME_MISMATCH} | the name on a document was replaced by a clearly different name |`,
    `| **Total** | **${truth?.total_issues ?? 'n/a'}** | |`, '',
    `Legitimate look-alikes that must NOT be flagged are also present (name variants, documents that expired after a correct verification, correct approvals, ${manifest?.negative_controls?.shared_documents_between_related_companies?.length ?? 0} documents shared between related companies). They are described in \`edge_case_manifest.json\`.`, '',
    '## Results recorded in this package', '',
    validation ? `* Validation: ${validation.total_validation_checks} checks, ${validation.passed_checks} passed, ${validation.passed_with_expected_exceptions} passed with expected (planted) exceptions, ${validation.failed_checks} failed; unexpected data errors: ${validation.unexpected_data_errors}.` : '* Validation: see validation_summary.json.',
    repro ? `* Reproducibility: ${repro.overall_result} (two complete runs compared; ${repro.comparison.checksums.files_compared} file checksums).` : '* Reproducibility: see reproducibility_report.json.', '',
    '## Export formats', '',
    '* `csv/` one UTF-8 CSV per table (header row, LF, RFC 4180 quoting, rows in primary-key order); `json/` one JSON array per table with the same columns; `sql/schema.sql` the schema read from the live database; `sql/seed.sql` the data as INSERT statements in parent-before-child order.',
    '* Sensitive-looking identifiers are masked: PAN, Aadhaar and document numbers keep only their last four characters; keyed hashes are replaced by a SHA-256 fingerprint that preserves equality; owner dates of birth keep only the year.',
    '* `checksums.txt` lists the SHA-256 of every file in three sections: the operational dataset, the ground truth and its measurement, and documentation / run reports.', '',
    '## What is in the schema, and what is not', '',
    '* This package was built from the database as it is after the Phase 6 migration `20261107090000_phase6_settings_and_decisions`, so `sql/schema.sql` contains the unique index `OnboardingDecision_one_final_per_customer` (at most one Approved or Rejected decision per customer) and the check `OnboardingDecision_reason_check` (a decision needs a reason). Every exported row satisfies both.',
    '* The database has one more table, `SystemSetting` (the expiry-alert settings of the application and their change history). It is application configuration, not KYC data: it is **not exported** and **not in `schema.sql`** (nor its sequence, index and two helper functions). The generated databases hold no rows in it.', '',
    '## Known limitations', '',
    '* Synthetic data has no real-world validity. Nothing in this package has been externally verified, and **no claim of regulatory compliance is made**: the KYC rules are illustrative.',
    '* The detector and the injection were written by the same team, so the high detection scores on planted cases do not predict accuracy on real data.',
    '* The EXPIRED_DOCUMENT_MARKED_VALID rule additionally requires that the Verified decision was recorded after the expiry date; documents verified while valid and expired later are ordinary and are not flagged (see `edge_case_rules.md`).',
    '* A Closed case without resolution notes can only exist because the check constraint `ReviewCase_resolution_notes_check` is absent in this dataset database (the shipped `schema.sql` reflects that).',
    '* About a quarter of mandatory documents are missing: the fixed document total is lower than "every customer submitted everything". This is derived from the data, not a random percentage.',
    '* Uploaded files do not exist: documents carry file metadata only. The generator fills `name_on_document` (a legitimate variant of the registered name, or a planted mismatch) and the `OnboardingDecision` history; since Phase 6 the application can also capture and show both, but this package contains generated records only.',
    '* Identical checksums require the same encryption and hash keys in `.env` for the *internal* encrypted columns; the exported files contain only masked values and fingerprints derived from them, so the keys must also match for the fingerprints to repeat.',
    '* Stored exceptions and alerts describe the valid baseline; after the edge cases were planted they were not recomputed.', '',
  ];
  return `${lines.join('\n')}\n`;
}

module.exports = { buildSourceManifest };
