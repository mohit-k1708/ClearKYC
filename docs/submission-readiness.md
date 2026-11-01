# Submission readiness (Phase 5, updated in Phase 6 and the final submission phase)

## Verdict

**Every required check of the final submission phase passed (section 10), but the project is NOT declared fully complete.** Phase 6 closed four of the five Partial requirements (A4, A8, A16, A17: details in `docs/phase6-features.md`). One requirement is still **Partial** by design (A18, no real authentication) and the performance item D4 is Partial (the full detection sweep is now a background job, but is not faster). Everything else has executable evidence, and the approval policy for open exceptions is decided and implemented (section 11). Submit it as "complete for the implemented scope, with these documented gaps"; do not describe it as meeting every requirement.

The evidence is in `docs/requirements-traceability.md` (every requirement, where it lives, how it is verified) and in the results below. Every number in this file was produced by running the command next to it; none is estimated.

## 1. Completed requirements and evidence

See `docs/requirements-traceability.md` (A1 to A18, B1, C1 to C11, D1 to D4). In short: customer onboarding, KYC requirements by type and risk, documents with expiry and an insert-only verification history, KYC completeness, risk rating and history, beneficial ownership with validation, exceptions and review cases with approvals, notes and timeline, periodic reviews, alerts, an immutable audit trail, dashboards, data quality checks, in-app exports, the synthetic dataset (8,000 customers, 1,000 companies, 20,000 documents, 3,000 review cases), six planted edge cases with a separate answer key, an independent detector with TP / FP / FN / precision / recall / F1, validation, reproducibility and the packaged dataset.

## 2. Known limitations and deferred items

**Partial requirements (not complete).** A4, A8, A16 and A17 were closed in Phase 6 (see `docs/phase6-features.md`); these remain:

| # | Gap | Why it was not closed |
|---|---|---|
| A18 | **No authentication.** The person acting is chosen in the sidebar and sent as `X-Reviewer-Id`; roles are enforced, but the header is trusted | Intentionally out of scope (documented in `docs/DOCUMENTATION.md`); production needs real login |

**Decisions needed from you** (nothing was changed silently; details in `docs/phase6-features.md`, "Policy review")

1. **Restore the development database** to its original seed data? It still holds the leftovers of my earlier mistaken browser run (section 7). Nothing was reset.
2. **Delete the backup of the previous dataset package** kept outside the repository (section 10) once you are happy with the new one.

**Other limitations**

* **Performance at 8,000 customers** (section 5): the Overview analytics take about 1.0 to 1.6 s, customer analytics about 1 s, and the full detection sweep about **78 s** (Phase 5 measurement, not repeated in Phase 6). Since Phase 6 the sweep runs as a background job (job ID, progress, one at a time), so no request waits for it; its duration is unchanged. Jobs live in the server's memory and are forgotten on restart; one API process only.
* **Phase 6 limits:** an owner recorded without a date of birth is not linked to other companies; approving a customer needs verified, unexpired mandatory documents but ignores open exceptions; name matching is text only (a genuine change of name is flagged, not decided); `SystemSetting` is application configuration and is deliberately left out of the dataset export (the package was rebuilt after Phase 6; section 10).
* **Dataset.** About 25% of mandatory documents are missing, because the fixed 20,000 documents is below "everyone submitted everything" (derived, not random). A planted "Closed case without resolution notes" needs one check constraint dropped, only in the isolated edge database. The expired-document rule is deliberately narrower than the literal wording (it also requires the Verified decision to be recorded after the expiry; 541 documents verified while valid and expired later are ordinary). Stored exceptions and alerts in the edge database describe the valid baseline and were not recomputed after planting.
* **The detection scores are 100%** because the same team wrote the planted cases and the rules. They show that the rules find what they were built for and leave the legitimate look-alikes alone; they do not predict accuracy on real data.
* **Dataset size.** `ClearKYC-Dataset/` is about 293 MB (CSV 65 MB, JSON 154 MB because it is pretty-printed, SQL 75 MB). The largest single file is 74.5 MB, under common 100 MB per-file limits; compressing the folder is advisable for delivery.
* **Uploaded files** are stored on local disk (development storage); generated documents have file metadata but no file.
* **Browser tests are timing-sensitive.** In the final phase one full run (started 14:12) had the script `scene3-ownership-risk` crash with Puppeteer's "Navigating frame was detached" after 30 passing checks and 0 failing ones (the other seven scripts passed: 317 checks). It did not reproduce: the immediately following full run from a freshly rebuilt test database passed **330 of 330**, and the same script passed in two earlier runs and in the clean environment. The cause was not investigated further; treat a single "frame detached" crash as a browser glitch and re-run.
* **Browser tests** need Google Chrome (set `CHROME_PATH` if it is not at the default Windows path) and use `taskkill`, so the runner is Windows-oriented.
* Case status transitions are enforced in the service layer; the database enforces the allowed values and history immutability, not the transition graph.
* Encryption keys live in `.env`; there is no key rotation. Identical dataset checksums need the same keys.

**Honest history.** During Phase 4 I ran the browser tests against the *development* database by mistake. That added 2 customers (`CUS-000776`, `CUS-000777`), 1 document, 4 cases, 13 exceptions, 12 alerts, 75 audit events and 1 requirement ("QK E2E Licence"), and marked two original review schedules Completed. Nothing was deleted or reset. In Phase 5 the tests were moved to a dedicated test database and a backup was taken. Restoring the development database to its original contents is **your decision** (see section 7).

## 3. Setup and run instructions

Requirements: Node.js 20+ (24 was used), npm. No PostgreSQL install is needed. Google Chrome only for the browser tests.

```powershell
npm install
npm --prefix client install
npm run db:generate           # Prisma client (npm install does it too; run it if you see "@prisma/client did not initialize yet")
copy .env.example .env        # then put real random keys in .env (64 hex characters each)
npm run db:local              # terminal A: the local PostgreSQL (leave running)
npm run db:migrate            # terminal B: create the tables (development database `clearkyc`)
npm run generate:customers -- --reset     # optional demo data for the development database (see section 7 first)
npm run dev                   # API on http://localhost:4000
npm run client                # web app on http://localhost:5173
```

## 4. Test commands and actual results

| Command | What it runs | Result |
|---|---|---|
| `npm test` | all backend tests (`server/tests/*.test.js`) on the dedicated test database `clearkyc_test` | **320 passed, 0 failed** (about 187 s; includes the 13 approval-policy tests). Before the approval policy (clean environment): 307 passed |
| `npm run test:browser` | 9 Puppeteer scripts in `tests/browser/` against a test API (port 4100) and web app (port 5174) on the test database, rebuilt for a clean start | **357 checks passed, 0 failed** across 9 scripts (about 10 minutes; includes the 27-check `approval-policy` script). Before the approval policy (clean environment): 330 checks across 8 scripts |
| `npm run test:edge-cases` | edge-case injection, detection and measurement | included in `npm test` (18 tests) |
| `npm run test:phase4` | validation, export, checksums, reproducibility (starter), packaging | included in `npm test` (15 tests) |
| `npm run validate:dataset -- --scale=full` | 182 checks on the 8,000-customer dataset (rebuilt in the final phase, section 10) | 179 passed, 3 passed with expected (planted) exceptions, **0 failed, 0 unexpected data errors** |
| `npm run test:reproducibility -- --scale=full` | the whole pipeline twice (generate, inject, detect, evaluate, validate, export), compared | **REPRODUCIBLE: PASS**: 308,971 records per run, byte-identical, 51 file checksums equal (run A 223.4 s, run B 186.5 s; final-phase rebuild) |
| `npm run verify:checksums` | recomputes the SHA-256 of every packaged file | **VERIFIED: 65 files** |
| `npm run verify:package` | independent package checks: checksums, 22 tables and row counts (report, JSON, seed.sql), volumes, 41 foreign keys against the rows, ID formats, schema, secrets, unmasked identifiers, verdicts | **15 of 15 passed** |
| `npm run verify:export` | loads `schema.sql` + `seed.sql` into an empty database and re-runs the detector | VERIFIED: 22 tables, 308,971 rows, 310 detections identical |

Backend test files: `api`, `kyc.*`, `ownership.*`, `reviews.*`, `scene5.*`, `unit` (the five application scenes), plus Phase 2 to 5: `generator`, `edgeCases`, `phase4`, `workflows.api` (7 end-to-end workflows), `api.hardening`, `audit.regression`, and Phase 6: `phase6.settings`, `phase6.decisions`, `phase6.names`, `phase6.person`, `phase6.detectionJob`.

**Defects found by this phase's audit and fixed (each has a regression test)**

1. `npm run generate:customers -- --reset` failed because the new `OnboardingDecision` table was missing from its reset list (`audit.regression.test.js`).
2. A request body over 100 KB returned a 500 error instead of 413 (`api.hardening.test.js`).
3. A NUL character in a search box or JSON field reached PostgreSQL and returned a 500 error; it is now refused with 400.
4. The `X-Powered-By: Express` banner was exposed; it is disabled.

**Defect found while building Phase 6 and fixed (regression test `phase6.settings.test.js`):** the new `SystemSetting` table references `Reviewer`, so the generator reset (`TRUNCATE ... "Reviewer"`) failed with "cannot truncate a table referenced in a foreign key constraint"; three dataset tests caught it. The table is now in the reset list and a test checks that every table referencing `Reviewer` is listed. Two tests were adapted on purpose: the export check now expects `SystemSetting` to be left out of the dataset, and the scene 4 browser test waits for the detection job to finish instead of a fixed 2.5 s.

Browser test assertions that had gone stale (hard-coded code prefixes, an old Overview layout, a fixed customer share, a fixed wait) were corrected; this changed tests only, not the application.

## 5. Performance at the target scale

Generator, full scale (`npm run generate:full -- --reset`): **112 s**, **545 MB** peak resident memory (heap in use at the end 279 MB), 8,000 customers / 20,000 documents / 3,000 review cases / 1,000 companies exactly, 127 of 127 generation checks passed, dataset checksum `cad33cb85dfc7967aebdb2292a12c209` identical to the earlier run. Per-entity rows and records per second: `generator/reports/full/performance_report.md`.

Application at 8,000 customers (`npm run perf:probe`, median of five calls, local machine; all `docs/performance-probe.json`):

| Endpoint | Median |
|---|---:|
| Customer list / search / filter / profile | 12 to 83 ms |
| Documents list and search | 70 to 78 ms |
| Audit trail page (about 140,000 events) | 53 ms |
| Alerts (active) | 219 ms |
| Dashboard summary | 89 ms |
| Overview analytics (30 days / all time) | 1,261 / 963 ms |
| Customer analytics | 987 ms |
| KYC completeness exceptions | 689 ms |
| Export: customers / documents CSV | 2.4 s / 3.6 s |
| Run all data-validation checks (once) | 7.9 s |
| Run detection for ALL customers (once) | **77.6 s** |

No list, detail or audit endpoint is slow. The analytics endpoints evaluate every customer in memory; the full detection sweep is the one operation that is too slow for an interactive click.

## 6. Dataset generation and export instructions

```bash
npm run dataset:all -- --scale=full      # baseline -> edge cases -> detect -> evaluate -> validate -> export -> reproducibility -> package
npm run generate:starter -- --reset      # or generate:medium / generate:full: the baseline only
npm run package:dataset -- --scale=full  # re-assemble ClearKYC-Dataset/ from the existing results
npm run verify:checksums                 # check every file of ClearKYC-Dataset/ against checksums.txt
npm run verify:package                   # independent checks of the whole package (15 checks)
# Rebuild into a STAGING folder with disposable databases, leaving ClearKYC-Dataset/ and clearkyc_<scale> alone (used in the final phase):
npm run dataset:all -- --scale=full --database-prefix=clearkyc_pkg --out=<staging>/ClearKYC-Dataset --dataset-dir=<staging>/dataset --no-repo-docs
npm run verify:package -- --dir=<staging>/ClearKYC-Dataset --dataset-dir=<staging>/dataset --previous=<old package>
```

Full command reference: `documentation/README.md`. The packaged folder `ClearKYC-Dataset/` holds `csv/` and `json/` (22 tables), `sql/schema.sql` and `sql/seed.sql`, the documentation, `ground_truth.json` (kept apart from the operational files), `detection_report.json`, `final_detection_summary.json`, `validation_summary.json`, `reproducibility_report.json`, `generation_config.json` (seed and configuration) and `checksums.txt` (three sections: operational data, ground truth and measurement, documentation). Latest package (`npm run package:dataset -- --scale=full`): 22 tables, 308,971 rows, export check VERIFIED, 65 files checksummed and VERIFIED, validation PASSED, reproducibility PASS.

## 7. Database recovery and test isolation

* **Phase 6 migration.** `prisma/migrations/20261107090000_phase6_settings_and_decisions` is additive (new table `SystemSetting`; a unique index and a CHECK on `OnboardingDecision`). It was applied to the test database and, after a pre-check (no customer with two final decisions, no decision without a reason) and a snapshot of every table, to the development database `clearkyc` with `prisma migrate deploy`: 22 to 23 tables, and the row counts and content checksums of every existing table were identical before and after (52 customers, 153 documents, 1,105 audit events). Nothing was reset or deleted. Rollback: `rollback.sql` in the migration folder (then remove its row from `_prisma_migrations`); it was rehearsed on a scratch copy of the test database (objects removed, 58 customers / 158 documents / 1,258 audit events unchanged, migration re-applied cleanly), and the scratch database was dropped.

* **Test isolation.** `npm test` and `npm run test:browser` set `DATABASE_URL` to `clearkyc_test` (a separate database on the same server) before anything runs; the browser tests refuse to start any other way and refuse the development ports 4000 / 5173. `npm run test:db:reset` rebuilds the test database from the project's own seed scripts (about 40 s). The generator uses its own databases `clearkyc_<scale>` and `clearkyc_<scale>_edge`.
* **Backups.** `npm run db:backup` copies `clearkyc` to `clearkyc_backup_<date>` (add `-- --name=...`; `--force` disconnects other sessions). `npm run db:backups` lists them. A backup named `clearkyc_backup_before_phase5` was taken at the start of this phase (it already contains the Phase 4 test residue described above).
* **Restore.** `npm run db:restore -- --from=clearkyc_backup_before_phase5 --confirm-replace-clearkyc` replaces `clearkyc` with that backup. It is destructive and refuses to run without the confirm flag; take a new backup first.
* **Getting back to the original seed data** (if you want the development database without the Phase 4 test residue): either run the five seed scripts with `--reset` against `clearkyc` (this deletes and regenerates its records, so I did not do it without your confirmation) or point the app at the rebuilt test database. `npm run test:browser -- --serve` starts the app on the test database for a demo.

## 8. Demo workflow and recommended demo data

Recommended data: the standard small dataset (50 customers: 33 individuals, 17 companies, 152 documents, 15 review cases, 98 alerts). It is what `npm run test:db:reset` builds, and `npm run test:browser -- --serve` serves it with a throw-away copy of the app (web `http://localhost:5174`), so the demo cannot damage the development database. For a scale demonstration, point `DATABASE_URL` at `clearkyc_full` (8,000 customers; expect the 1 to 2 s analytics pages).

1. **Overview** (`/`): six KPI cards, charts, review cases, alerts, recent activity; change the date filter.
2. **Register an individual** (Add Customer): the risk rating appears with its reasons; open the profile and see the masked PAN / Aadhaar.
3. **KYC completeness**: the customer shows 0% with three required documents. Choose **Vikram Analyst** and upload a PAN (PDF); it is Pending and completeness does not change.
4. Choose **Asha Reviewer**, open Verification Review, verify the PAN: completeness becomes 33.3%. Verify the other two: 100%. Open the document: the history keeps every decision.
5. **Expired or invalid evidence**: try to verify an expired document (refused with a clear message); reject one without remarks (refused); reject with remarks (completeness stays below 100%).
6. **Register a company** and add owners (60% + 40%: Reconciled; add 20%: "above 100%" is flagged, as a reason to investigate, not an accusation). Record a screening to see a potential match treated as "needs review".
7. **Exceptions and cases**: run detection, create a case from an exception, assign it, start it, add a note, resolve it with notes; open the timeline. As a reviewer open **Audit Trail** and find the same steps.
8. **Alerts**: open Alerts, acknowledge one, resolve it with remarks; a potential sanctions alert cannot be dismissed.
9. **Reports**: download the customer CSV (masked), the document register and the schema SQL.
10. **Dataset**: open `ClearKYC-Dataset/documentation/README.md`, `ground_truth.json` and `dataset/detection_report.md` to show the planted errors and how they were measured.

## 9. Security and synthetic-data notes

* **All data is synthetic.** No real person, company or identifier is used and no external personal data source was consulted (`documentation/source_manifest.md`). PAN, Aadhaar and registration numbers follow the *format* of real ones only. Screening against PEP and sanctions lists is simulated; verification is a simulated manual review. No regulatory compliance is claimed; the KYC rules, risk bands and review intervals are illustrative.
* **Stored identifiers** (PAN, Aadhaar, document numbers, owners' dates of birth) are encrypted with AES-256-GCM; keyed HMAC hashes detect duplicates without plaintext; only masked values leave the API; the exported dataset masks them further (last four characters, SHA-256 fingerprints, birth year).
* **Secrets.** `.env` and local database files (`.pgdata/`) are git-ignored; `.env.example` holds placeholders; a scan of the repository for the actual key values found them only in `.env`.
* **Authentication is intentionally absent** (the "Acting as" selector with `X-Reviewer-Id` is a prototype stand-in); anyone who can reach the API can use it. The database independently protects the audit trail and history tables (triggers refuse UPDATE and DELETE).
* **Input handling:** parameterised queries, a 100 KB body limit, strict upload checks (PDF / JPG / PNG by magic bytes, 2 MB), no path traversal, JSON errors without stack traces or SQL text (`server/tests/api.hardening.test.js`).

## 10. Final submission phase (Phase 7): dataset rebuild, policy review, clean-environment verification

### 10.1 Dataset package rebuilt after Phase 6

| Item | Value |
|---|---|
| Why | the packaged dataset predated Phase 6 (new constraints on `OnboardingDecision`, new table `SystemSetting`) |
| Source | the documented generator and exporter: seed **20261022**, scale **full**, reference date **2026-10-31**, generator 4.0.0; baseline then the labelled edge cases, detection, evaluation, validation, export, reproducibility, packaging |
| Databases used | **disposable** `clearkyc_pkg_full` (baseline) and `clearkyc_pkg_full_edge`, created by the run, migrated with all 10 current migrations, **dropped afterwards**. The development database `clearkyc` and the databases `clearkyc_full`, `clearkyc_medium`, `clearkyc_starter` (and their `_edge` copies) were not touched |
| Where it was built | a staging folder outside the repository; `ClearKYC-Dataset/` was replaced only after the new package passed every check. The previous package was kept outside the repository (not deleted) |
| Command | `node scripts/buildDataset.js --scale=full --database-prefix=clearkyc_pkg --out=<staging>/ClearKYC-Dataset --dataset-dir=<staging>/dataset --no-repo-docs` (12 min 30 s) |
| Generator dataset checksum | `cad33cb85dfc7967aebdb2292a12c209` (identical to the Phase 5 value) |
| Rows | **308,971 in 22 tables** (8,000 customers, 20,000 documents, 3,000 review cases, 49,307 verifications, 2,222 owners, 14,076 alerts, 139,968 audit events) |
| Files / size | **65 files + checksums.txt, 292.4 MB** (csv 64.1 MB, json 153.2 MB, sql 74.5 MB; largest file `sql/seed.sql` 74.5 MB) |
| Checksums | `npm run verify:checksums` VERIFIED: 65 files. `checksums.txt` SHA-256 `d0012ebf320f3c0a22b18e81ca99a2641ec63c91edc9ebab15b29744cec0f1f6` |
| Validation | **PASSED**: 182 checks, 179 passed, 3 passed with expected (planted) exceptions, 0 failed, 0 unexpected data errors |
| Detection | TP 310, FP 0, FN 0 (precision, recall and F1 100%; same-team caveat in section 2) |
| Reproducibility | **REPRODUCIBLE: PASS**, 308,971 records per run, 51 file checksums equal (run A 223.4 s, run B 186.5 s) |
| Export check | VERIFIED (`schema.sql` + `seed.sql` load into an empty database and reproduce the detection) |
| Independent package check | `npm run verify:package`: 15 of 15 (and 16 of 16 with the comparison to the previous package) |
| Against the previous package | the **data is byte-identical** (all 45 csv / json / seed.sql files). Only `sql/schema.sql` (the two Phase 6 constraints), four documentation files and the reproducibility report (timings) differ |
| Secrets, personal data, local files | none: neither encryption key value appears in any file, no `.env`, `.pgdata`, log or upload file, no database URL with credentials; 0 complete PAN-format and 0 spaced Aadhaar-format values (identifiers are masked to the last four characters); all data synthetic (`documentation/source_manifest.md`) |
| Excluded table | `SystemSetting` (the expiry-alert settings and their history): application configuration, not KYC data. It is left out of the CSV / JSON / SQL data, of `schema.sql` (with its sequence, index and two helper functions) and of the validation report; the generated databases hold no rows in it |

Rows per table (required table coverage: all 22 exported, report, JSON and `seed.sql` agree for every table):

| Table | File | Rows |
|---|---|---:|
| CustomerType | customer_types | 2 |
| Reviewer | reviewers | 7 |
| KYCRequirement | kyc_requirements | 25 |
| Customer | customers | 8,000 |
| BeneficialOwner | beneficial_owners | 2,222 |
| OwnerScreening | owner_screenings | 4,388 |
| OwnershipValidation | ownership_validations | 1,000 |
| CompanyOwnership | company_ownership | 2,234 |
| Document | documents | 20,000 |
| Verification | verifications | 49,307 |
| RiskRating | risk_ratings | 9,000 |
| OnboardingDecision | onboarding_decisions | 9,469 |
| ReviewSchedule | review_schedules | 8,342 |
| Exception | exceptions | 15,470 |
| ReviewCase | review_cases | 3,000 |
| CaseHistory | case_history | 9,635 |
| CaseNote | case_notes | 2,326 |
| Alert | alerts | 14,076 |
| AuditEvent | audit_events | 139,968 |
| ValidationRun | validation_runs | 0 |
| ValidationIssue | validation_issues | 0 |
| IdCounter | id_counters | 10,500 |

### 10.2 Clean-environment verification

An isolated copy of the repository (everything except what `.gitignore` excludes: no `node_modules`, `.env`, `.pgdata`, uploads, build output or screenshots) was prepared exactly as the README says, with its **own** PostgreSQL cluster (port 5543), **fresh random keys** and its own API port, so it could not touch the development database:

| Step | Result |
|---|---|
| `npm install`, `npm --prefix client install` | 72 s and 9 s |
| `npm run db:generate` / `postinstall` | Prisma client generated |
| `npm run db:local` (own cluster) | up on 5543, database created |
| `npm run db:migrate` | all 10 migrations applied, including Phase 6 |
| `npm run test:db:reset`, `npm test` | **307 passed, 0 failed** (147 s) |
| `npm run test:browser` | **330 checks passed, 0 failed** across 8 scripts |
| `npm --prefix client run build` | built in about 10 s |
| dataset: `node scripts/buildDataset.js --scale=starter` | validation PASSED (182 checks), reproducibility PASS, export VERIFIED, 2,399 rows, 65 checksums VERIFIED |
| dataset tests (`generator`, `edgeCases`, `phase4`) with the final code | 42 passed, 0 failed |
| start and health | API `GET /api/health` → 200 `{"status":"ok"}`; `/api/settings/expiry-alerts` and `/api/reviewers` → 200; the production frontend build served by `vite preview` → 200 |

The dataset in the clean environment was generated at **starter** scale; the full scale was built in the main workspace (10.1) with the same code. Checksums of a dataset built with different keys differ (documented); the structure, counts and verdicts do not.

**The clean-environment run found real defects (all fixed; the first run failed):**

1. After the documented `npm install` the Prisma client was not generated, so the first test failed. Fixed: a `postinstall` step and a README line (`npm run db:generate`).
2. A test database left behind by an interrupted setup (empty) was reused for ever, so tests failed with 401s for lack of seed data. Fixed: `scripts/testDatabase.js` rebuilds an existing but empty test database (verified by hand on a deliberately empty database; no automated test).
3. `tests/browser/screenshots/` is git-ignored, so on a fresh checkout every browser script crashed at its first screenshot. Fixed: the folder is created automatically.
4. The dataset validator (and the reproducibility runner) checked every foreign key in the database, so the application settings table added one check to the package's validation report (183). Fixed: application configuration is skipped (182, as before).
5. The source manifest still said `name_on_document` and `OnboardingDecision` were "not shown by the application" (true before Phase 6). Updated, with a section on what is and is not in the schema.

### 10.3 Policy review (no rule was changed)

See `docs/phase6-features.md`, "Policy review": whether open exceptions should block approval (**decision needed**; current behaviour: they do not, pinned by a test), the exact approval conditions, how cross-company matching works and what happens without a date of birth, detection jobs after a restart and the single-process limit, and why the reviewer selector is not authentication.

### 10.4 Files changed in this phase

`scripts/buildDataset.js` (staging options), `packaging/verifyPackage.js` (new, `npm run verify:package`), `packaging/sourceManifest.js`, `validation/datasetValidator.js`, `reproducibility/runReproducibility.js`, `scripts/testDatabase.js`, `tests/browser/config.js`, `package.json` (`postinstall`, `verify:package`), `README.md`, `documentation/README.md`, `documentation/data_dictionary.md`, `documentation/expiry_configuration.md`, `documentation/remaining_requirements_audit.md`, `documentation/source_manifest.md`, `server/tests/phase6.decisions.test.js` and `phase6.person.test.js` (two tests that pin documented behaviour), `docs/*`, and the rebuilt `ClearKYC-Dataset/` plus `dataset/export_report.json` and `dataset/reproducibility_report.json`.

### 10.5 Demo instructions for the new features

Use `npm run test:browser -- --serve` (test database, throw-away app on http://localhost:5174). Choose **Asha Reviewer** in the sidebar, then:

1. **Expiry Alert Settings** (sidebar, Reporting): see 90, 60, 30, 7; try `7, 30` (refused: largest to smallest), save `120, 45, 10`; Alerts → Refresh alerts shows progress and the new windows; Use defaults → Save restores them.
2. **Onboarding decision**: open a customer with missing documents (Approve is not offered, the blockers are listed), Reject with a reason; open a customer with every mandatory document verified and Approve. Try to decide again: refused (final).
3. **Name on the document**: add a document with the name "Pooja Deshmukh" for a customer called "Neha Kulkarni": "Name differs" appears in the list, the details and the review screen; edit it to "NEHA KULKARNI" and it matches.
4. **All companies of this person**: Ownership Management → a company → an owner → "All companies of this person".
5. **Detection job**: Exceptions & Issues → Run detection: the button shows "Checking… n/total".

## 11. Onboarding approval policy for open exceptions

Implemented after the product owner's decision (details and limits: `docs/phase6-features.md`, section A; no migration, no change to the dataset):

* open **Critical or High** exceptions block approval; a Reviewer or Admin may **waive** each one for that approval only with a non-empty reason, recorded in the audit trail (the exception stays open);
* open **Medium or Low** exceptions do not block but approving needs the rationale **and a follow-up action**;
* **no** open exception: the mandatory-evidence rule only; missing evidence can never be waived;
* the decision screen lists the blocking exceptions, explains why approval is unavailable, offers the waiver form to reviewers and shows follow-up actions and waivers in the history.

A latent race was found and fixed while testing this (concurrent detection for a new customer could return a 500 on the first review schedule; regression test included).
