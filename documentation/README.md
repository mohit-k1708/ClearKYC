# ClearKYC synthetic KYC dataset

A complete, reproducible and independently verifiable **synthetic** KYC dataset: customers, documents, verifications, beneficial ownership, risk assessments, review cases, alerts and an audit trail, with six kinds of deliberately planted errors, an answer key, an independent detector and a measurement of how well it finds them.

> **Everything is synthetic.** No real person, company or identifier is used, and no external personal data source was consulted. Nothing has been verified externally and no regulatory compliance is claimed. See `source_manifest.md`.

## 1. Project overview

ClearKYC is a small KYC application (React + Node/Express + PostgreSQL + Prisma). On top of it, four phases built this dataset:

| Phase | What it added | Where |
|---|---|---|
| 1 | Database documentation and audit | `documentation/` |
| 2 | A seeded, high-performance generator for 8,000 customers / 20,000 documents / 3,000 review cases | `generator/` |
| 3 | Six planted error types, the answer key, an independent detector, a measurement | `generator/edgeCases/`, `detector/`, `evaluation/` |
| 4 | Reproducibility test, complete validation, CSV / JSON / SQL export, SHA-256 checksums, packaging | `validation/`, `exporter/`, `reproducibility/`, `packaging/` |
| 5 | Audit of the whole project, isolated test database, browser tests, submission documents | `docs/`, `tests/browser/`, `scripts/testDatabase.js` |
| 6 | Application features the audit found missing: onboarding decisions, name-on-document check, owner across companies, expiry settings, detection job | `docs/phase6-features.md` |
| 7 | This package was rebuilt after Phase 6 in a disposable database (see section 2 and `source_manifest.md`) | `scripts/buildDataset.js` |

Requirements: Node.js 20+, the project's local PostgreSQL (`npm run db:local`, port 5433) and the `.env` file with `DATABASE_URL`, `ENCRYPTION_KEY` and `HASH_KEY` (see the root `README.md`). The generator never touches the development database `clearkyc`: it uses its own databases `clearkyc_<scale>` (baseline) and `clearkyc_<scale>_edge` (with the planted errors).

## 2. Dataset contents (`ClearKYC-Dataset/`)

```
csv/            one CSV per table              json/           the same tables as JSON arrays
sql/schema.sql  tables, keys, indexes, checks, triggers   sql/seed.sql  the data as INSERT statements
documentation/  this README, data dictionary, relationships, ID conventions, edge-case rules, source manifest
ground_truth.json            the answer key (kept apart from the operational data)
detection_report.json/.md    detection measured against the answer key
final_detection_summary.*    independent re-check of that report
validation_summary.json      the quality report (+ validation_report.json/.md with every check)
reproducibility_report.json  two complete runs compared
edge_case_manifest.json      what was changed for each planted issue
generation_config.json       the seed, scale, reference date, ratios and commands that produced the data
checksums.txt                SHA-256 of every file, in three sections
```

Full scale: 8,000 customers (7,000 individuals, 1,000 companies), 20,000 documents, 3,000 review cases, 49,307 verifications, 2,222 beneficial owners, 9,000 risk assessments, 14,076 alerts and 139,968 audit events (308,971 rows in 22 tables).

## 3. Database entities

| File | Table | What it holds |
|---|---|---|
| customer_types, customers | CustomerType, Customer | Individuals and companies |
| kyc_requirements | KYCRequirement | Which documents are mandatory per customer type and risk level |
| reviewers | Reviewer | The analysts, reviewers and admin who act in the workflow |
| documents, verifications | Document, Verification | Submitted documents and their insert-only review history |
| beneficial_owners, company_ownership, owner_screenings, ownership_validations | BeneficialOwner, CompanyOwnership, OwnerScreening, OwnershipValidation | Who owns each company (a person can own several companies, with a different share in each), screening results, recorded ownership checks |
| risk_ratings | RiskRating | Insert-only risk assessment history |
| onboarding_decisions | OnboardingDecision | Approved / Rejected / Pending Review decisions |
| review_schedules, exceptions, review_cases, case_history, case_notes | ReviewSchedule, Exception, ReviewCase, CaseHistory, CaseNote | Periodic reviews, detected problems, cases and their history |
| alerts, audit_events | Alert, AuditEvent | Alerts (expiry lead times 90 / 60 / 30 / 7 days) and the audit trail |
| validation_runs, validation_issues, id_counters | ValidationRun, ValidationIssue, IdCounter | Application data-quality runs (empty here) and the gap-free ID counters |

`data_dictionary.md` describes every column; `database_relationships.md` the foreign keys; `id_conventions.md` the business IDs (`CUS-000001`, `KYC-2026-000001`, `DOC-CUS-000001-001`, `REV-CUS-000001-2026`, `ALT-2026-000001`).

**Masking.** PAN, Aadhaar and document numbers keep only their last four characters; keyed hashes (`pan_hash`, `document_number_hash` ...) are replaced by a SHA-256 fingerprint that keeps equality (so duplicates and document reuse remain detectable); owner dates of birth keep only the year.

**What is NOT in the package.** The database has one more table than the 22 above: `SystemSetting` (Phase 6), which stores the application's expiry-alert settings and their change history. It is application configuration, not KYC data, so it is deliberately left out of the export and of `schema.sql` (together with its sequence, its index and its two helper functions `valid_expiry_alert_days` and `system_setting_check_reviewer`). The generated databases never contain a row in it. Everything else in the database is exported.

**Constraints added by Phase 6 that appear in `sql/schema.sql`:** on `OnboardingDecision`, the unique index `OnboardingDecision_one_final_per_customer` (a customer has at most one Approved or Rejected decision) and the check `OnboardingDecision_reason_check` (Approved and Rejected need a non-empty reason in `notes`). Every exported row satisfies both.

## 4. How the synthetic records are generated

`generator/index.js` builds everything in memory, parents before children, with a separate random stream per stage forked from the seed. Dates are relative to the reference date (2026-10-31), never the clock. Derived values are calculated by the application's own rules (risk scoring, KYC completeness, exception and alert detection, case workflow, review intervals): nothing is assigned at random. The generator README (`generator/README.md`) has the details and the performance figures.

## 5. Change the dataset scale

Three scales share one engine (`generator/config/generatorConfig.js`, `SCALES`):

| Scale | Customers | Companies | Documents | Review cases |
|---|---:|---:|---:|---:|
| starter | 50 | 17 | 152 | 15 |
| medium | 1,000 | 125 | 2,500 | 300 |
| full | 8,000 | 1,000 | 20,000 | 3,000 |

Add `--scale=starter|medium|full` to any command below (the default of the dataset commands is `full`).

## 6. Change the random seed

The seed is `20261022`. To try another one, add `--seed=<whole number>` to the generate, inject and test commands (for example `npm run edge-cases:workflow -- --scale=starter --seed=1`). A different seed gives a different dataset and a different answer key; the packaged dataset always uses `20261022`.

## 7. Regenerate the dataset

```bash
npm run generate:starter -- --reset      # or generate:medium / generate:full; writes clearkyc_<scale>
npm run dataset:all -- --scale=full      # the whole workflow below in one command
```

`--reset` is needed only if the target database already holds data; it empties that database only, never `clearkyc`.

## 8. Inject the edge cases

```bash
npm run inject:edge-cases -- --scale=full
```

Makes sure a valid baseline exists, proves the detector finds nothing in it, copies it to `clearkyc_full_edge`, plants six kinds of error and writes `dataset/ground_truth.json` and `dataset/edge_case_manifest.json`. The rules are in `edge_case_rules.md`.

## 9. Run the anomaly detection

```bash
npm run detect:anomalies -- --scale=full       # writes dataset/detection_results.json
```

The detector reads only the records (never the answer key) and applies business rules.

## 10. Evaluate the detection

```bash
npm run evaluate:detection -- --scale=full     # dataset/detection_report.json and .md
npm run summarize:detection -- --scale=full    # dataset/final_detection_summary.json and .md
```

The first computes TP, FP, FN, TN, precision, recall, F1 and detection rate; the second re-checks that report from the raw files, confirms the answer key was not edited and the detector's results were not altered.

## 11. Run the validation

```bash
npm run validate:dataset -- --scale=full       # dataset/validation_summary.json, validation_report.json / .md
```

About 180 checks over primary keys, identifiers, every foreign key, customers, documents, verifications, ownership, risk, review cases, alerts, audit events and the answer key. A violation that belongs to a labelled planted anomaly is reported as an **expected exception**; any other violation is an **unexpected data error** and fails the run.

## 12. Generate the checksums

```bash
npm run generate:checksums -- --dir=ClearKYC-Dataset    # writes ClearKYC-Dataset/checksums.txt
npm run verify:checksums -- --dir=ClearKYC-Dataset      # recomputes every hash and compares
```

## 13. Export CSV, JSON and SQL

```bash
npm run export:dataset -- --scale=full                  # into ClearKYC-Dataset/ (csv/, json/, sql/)
npm run verify:export                                   # loads schema.sql + seed.sql into an empty database and checks counts and detection
```

To load the dataset into your own PostgreSQL database: create an empty database, then run `sql/schema.sql` followed by `sql/seed.sql`.

## 14. Verify reproducibility

```bash
npm run test:reproducibility -- --scale=starter         # about 30 seconds
npm run test:reproducibility -- --scale=full            # about 8 minutes: two complete runs
```

Runs generation, injection, detection, evaluation, validation and export twice in fresh databases and compares counts, IDs, foreign-key columns, field values (strictly and by business key), derived values, ground truth, detection results and the SHA-256 of every file. Result: `dataset/reproducibility_report.json` (`REPRODUCIBLE: PASS`). The result depends on the same `ENCRYPTION_KEY` / `HASH_KEY` in `.env`.

## Package and tests

```bash
npm run package:dataset -- --scale=full        # assembles ClearKYC-Dataset/ (refuses if validation or reproducibility failed)
# Rebuild everything WITHOUT touching the live package or the clearkyc_<scale> databases (disposable databases clearkyc_pkg_<scale>*, output to a staging folder):
npm run dataset:all -- --scale=full --database-prefix=clearkyc_pkg --out=<staging>/ClearKYC-Dataset --dataset-dir=<staging>/dataset --no-repo-docs
npm run verify:checksums -- --dir=<staging>/ClearKYC-Dataset
npm run test:edge-cases                        # Phase 3 tests
npm run test:phase4                            # validation, export, checksum and reproducibility tests
npm test                                       # every backend test, on the dedicated test database (clearkyc_test)
npm run test:browser                           # the browser tests, on a test API and web app (ports 4100 / 5174) and the test database
```

## Known limitations

See `source_manifest.md`. In short: synthetic data has no real-world validity, the detector and the planted errors were written by the same team (so high scores on planted cases do not predict real-world accuracy), uploaded files do not exist, and one check constraint is absent in the dataset database so that a deliberately invalid closed case can exist.
