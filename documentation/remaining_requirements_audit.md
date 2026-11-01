# Remaining Requirements Audit and Implementation Plan (Phase 1)

> **Phase 6 status.** The application gaps this audit listed for onboarding decisions, the name on the document, the cross-company person view and a screen for the expiry lead times were implemented in Phase 6 (`docs/phase6-features.md`). Authentication is still intentionally simulated (the reviewer selector is not a login).
>
> **Phase 2 status.** Done since this audit was written: M1 (business IDs `KYC-`, `DOC-`, `REV-`, `ALT-`), M2 (`CompanyOwnership`), M3 (expiry lead times 90/60/30/7, configured in `expiryRules.js`) and the bulk generator at all three scales (`generator/`, `npm run generate:starter | medium | full`; 8,000 customers, 1,000 companies, 20,000 documents, 3,000 review cases, deterministic with seed 20261022). **Not started (Phase 3):** anomaly injection, `ground_truth`, the detection-versus-ground-truth report and the packaged dataset. The "NOT IMPLEMENTED" findings below describe the project **before** Phase 2.

**Scope of this document.** An honest audit of the ClearKYC project against the data-engineering requirements of the challenge, followed by the implementation plan (Stage B). It describes the **actual** implementation, read from the source code and the live database. **No database change was made in Phase 1** (no migration was run, no table dropped, no row deleted or changed; only documentation files were created). Phase 2 has not been started.

Classification used throughout:

* **COMPLETE**: implemented and verified.
* **PARTIALLY COMPLETE**: part of the requirement is implemented.
* **NOT IMPLEMENTED**: nothing exists yet.

Current database size (for context): 50 customers (33 individual, 17 company), 152 documents, 376 verification rows, 82 risk ratings, 40 beneficial owners, 15 review cases, 94 alerts, 1,008 audit events.

---

## Part 1. Phase 1 deliverables

| Task | Deliverable | Status |
|---|---|---|
| 1 | Database structure audit (10 entities + 9 additional tables, columns, keys, constraints, indexes, relationships) | **COMPLETE** (`data_dictionary.md`, `database_relationships.md`) |
| 2 | Complete data dictionary | **COMPLETE** (`data_dictionary.md`: every column of all 19 tables, generated from the live catalogue, with example records) |
| 3 | ID generation audit | **COMPLETE** (`id_conventions.md`), with the missing formats listed |
| 4 | Many-to-many ownership audit | **COMPLETE** (`ownership_model.md`); the model itself is partially complete (see R10) |
| 5 | Document expiry configuration audit | **COMPLETE** (`expiry_configuration.md`); the feature itself is partially complete (see R13) |
| 6 | Documentation files | **COMPLETE** (six files in `documentation/`) |
| 7 | Final audit report | **COMPLETE** (this file) |

The 10 expected entities all exist under these names: `Customer`, `CustomerType`, `KYCRequirement`, `Document`, `Verification`, `RiskRating`, `ReviewCase`, `BeneficialOwner`, `Alert`, `AuditEvent`. The schema additionally contains: `Reviewer`, `OwnerScreening`, `OwnershipValidation`, `Exception`, `ReviewSchedule`, `CaseHistory`, `CaseNote`, `ValidationRun`, `ValidationIssue`. There are no bridge tables.

---

## Part 2. Requirement-by-requirement audit

### A. Entities and workflow

| # | Requirement | Status | Current implementation | Source files | Models | Missing | Recommended change |
|---|---|---|---|---|---|---|---|
| R1 | Ten core entities, each with a primary key and foreign keys for every relationship | **COMPLETE** | All ten exist; every table has `id` primary key; 37 enforced foreign keys; CHECK constraints for allowed values | `prisma/schema.prisma`, `prisma/migrations/*` | all | none | none |
| R2 | Generate master data first, then dependent records with valid parent IDs | **COMPLETE** | Generators run in order: customers → documents/verifications → owners/ratings → exceptions/cases/schedules → alerts; every child uses a real parent id | `scripts/generateCustomers.js`, `generateKycData.js`, `generateOwnershipData.js`, `generateReviewData.js`, `generateScene5Data.js` | all | none | none |
| R3 | Define requirements by customer type and risk | **COMPLETE** | 25 requirements (2 types × 3 risk levels), effective dates, mandatory flag, active flag; configurable on a screen | `config/kycRules.js`, `requirementService.js` | KYCRequirement, CustomerType | none | none |
| R4 | Synthetic customers | **COMPLETE** (small scale) | Seeded generator, 50 customers, risk derived from documented rules | `generateCustomers.js`, `riskService.js` | Customer, RiskRating | volume (see R16) | none |
| R5 | Documents with issue/expiry dates and verification status | **COMPLETE** | Scenario-based generator; status comes from verification history, not assigned independently | `generateKycData.js`, `documentService.js`, `verificationService.js` | Document, Verification | none | none |
| R6 | Link beneficial owners for business customers | **COMPLETE** | 40 owners across 15 of 17 companies (2 have none by design) | `generateOwnershipData.js`, `ownershipService.js` | BeneficialOwner | See R10 | none |
| R7 | Calculate completeness | **COMPLETE** | Calculated on demand from mandatory requirements and valid verified documents; never stored | `kycEngine.js`, `kycService.js` | KYCRequirement, Document | none | none |
| R8 | Schedule periodic reviews | **COMPLETE** | Interval by risk level (36/24/12 months), cycles, auto-created cases | `reviewScheduleService.js`, `config/reviewRules.js` | ReviewSchedule, ReviewCase | none | none |
| R9 | Produce audit events | **COMPLETE** | Written in the same transaction as each change; immutable; 28 action types used | `auditService.js` | AuditEvent | none | none |
| R10 | Beneficial owners: one company many owners, one person many companies, percentage per pair, history | **PARTIALLY COMPLETE** | Many owners per company works. A person owning several companies is stored as separate rows (no bridge). No effective dates. Totals are calculated per company correctly. | `ownershipService.js`, `ownershipEngine.js`, `screeningService.js` | BeneficialOwner, OwnerScreening | `CompanyOwnership` bridge, effective dates, one person identity across companies | Plan in `ownership_model.md` (add bridge, backfill, switch readers; person merge only with approval) |
| R11 | Persist state changes as explicit records; never overwrite history | **PARTIALLY COMPLETE** | Insert-only: Verification, RiskRating, OwnerScreening, OwnershipValidation, CaseHistory, CaseNote, AuditEvent. Frozen when final: Exception, Alert, ReviewSchedule. **But** a beneficial owner's percentage is overwritten in place (only the audit trail keeps the old value) | triggers in migrations 2–5 | various | Ownership history in its own table | Resolved by the `CompanyOwnership` plan (R10) |
| R12 | Outcomes and labels come from documented rules, not independent random assignment | **PARTIALLY COMPLETE** | Statuses, scores, completeness, exceptions, alerts and due dates are derived from rules. The generators pick a *scenario* per customer with a seeded random generator, then derive everything else from rules. There are no ground-truth labels. | generators, engines | all | Labels (see R22) | Generate labels from the same rules at injection time |

### B. IDs and naming

| # | Requirement | Status | Current implementation | Source files | Models | Missing | Recommended change |
|---|---|---|---|---|---|---|---|
| R13a | Customer `CUS-000001` | **COMPLETE** | Sequence + function + unique index + CHECK + immutability trigger; concurrency tested | migration `init`, `customerService.js` | Customer | none | Do not change |
| R13b | KYC requirement `KYC-2026-000001` | **NOT IMPLEMENTED** | Numeric `id` only | n/a | KYCRequirement | business code and year counter | `id_conventions.md` plan (counter table, `business_id`) |
| R13c | Document `DOC-CUS-000001-001` | **NOT IMPLEMENTED** | Numeric `id` only | n/a | Document | per-customer counter and code | same plan |
| R13d | Review case `REV-CUS-000001-2026` | **PARTIALLY COMPLETE** | `CASE-000001` generated safely by a sequence | `next_review_case_code()` | ReviewCase | required format; **format is not unique if a customer has several cases in a year** | Decision needed (use `REV-` for periodic review cases only, or add a suffix) |
| R13e | Alert `ALT-2026-000001` | **PARTIALLY COMPLETE** | `ALT-000001`, one global counter | `next_alert_code()` | Alert | year in the code | New `business_id` column; old code kept |
| R13f | IDs automatic, unique, immutable, concurrency-safe, restart-safe | **COMPLETE** for existing codes | Sequences persist in PostgreSQL; unique indexes; tested; unique but **not gap-free** | see `id_conventions.md` | | gap-free counters if required | Counter table for the new codes |

### C. Data generation (Steps 1 to 10)

| # | Requirement | Status | Current implementation | Missing | Recommended change |
|---|---|---|---|---|---|
| R14 | Step 1: data dictionary for the ten entities | **COMPLETE** | `documentation/data_dictionary.md` | none | Keep regenerated when the schema changes (generator is in the Phase 2 plan) |
| R15 | Step 2: parents first, then children and events | **COMPLETE** | See R2 | none | none |
| R16 | Step 4: volume 8,000 customers, 20,000 documents, 1,000 businesses, 3,000 review cases; scale parameter shared by starter and full datasets | **NOT IMPLEMENTED** (volume) / **PARTIALLY COMPLETE** (scale parameter) | Current data: 50 / 152 / 17 / 15. The generators go through the application services one record at a time (a transaction per customer, detection loops over customers), which would take far too long for 8,000. Only `--count` (customers) is a parameter. | Bulk generator, unified scale option (`starter` / `full`), performance check of detection and the pages at full size | Phase 2: a set-based bulk generator that uses the same rules/engines, with one scale option |
| R17 | Fixed seed (20261022) | **COMPLETE** | All generators default to 20261022 | none | none |
| R18 | Include expired documents | **COMPLETE** | 10 expired documents, 7 more expiring within 30 days | none at small scale | Re-check distribution at full scale |
| R19 | Include overdue reviews | **COMPLETE** | 3 overdue periodic reviews, 3 overdue cases | same | same |
| R20 | Include missing ownership records | **COMPLETE** | 2 companies with no owners, 1 below 100% | same | same |
| R21 | Include name mismatches | **NOT IMPLEMENTED** | No "name on the document" field, no mismatch check or exception type | field `Document.name_on_document` (nullable), a detection rule and exception/alert type | Phase 2 (additive column; CHECK lists extended) |
| R22 | Step 5: inject labelled edge cases | **PARTIALLY COMPLETE** | See the table below | labels and 3 of the 5 cases | Phase 2 injectors that write the label at the moment of injection |
| R23 | Step 6: derived values calculated from sources | **COMPLETE** | Completeness, scores, levels, statuses, due dates are calculated and re-checked by data quality (`KYC_COMPLETENESS_CONSISTENT`, `RISK_RULES_FOLLOWED`, `PERIODIC_REVIEW_DATES`) | none | none |
| R24 | Step 7: separate `ground_truth.csv/json`, never leaked into features | **NOT IMPLEMENTED** | No file, no labels | the file and its generator | Phase 2: written by the injectors to a separate file outside the exported data tables |
| R25 | Step 8: validation (keys, joins, enums, dates, arithmetic, lifecycle, duplicates) | **PARTIALLY COMPLETE** | 33 checks cover every item **except duplicates across customers** (only within a customer) | checks for cross-customer duplicate documents and name mismatches | Add two checks and compare them with the ground truth |
| R26 | Step 9: export CSV/JSON/SQL plus README, schema/data dictionary, generator command, seed, source manifest, validation summary | **PARTIALLY COMPLETE** | App exports: 8 masked CSV reports, seed-data JSON (all main tables), schema SQL. Dictionary now exists. No dataset README, no source manifest, no packaged folder, no full per-table CSV set (for example no Verification or KYCRequirement CSV) | packaged dataset folder with checksums | Phase 2: one command writes the folder |
| R27 | Step 10: regenerate twice with the same seed and compare row counts and checksums | **NOT IMPLEMENTED** | Business codes reproduce (same CUS/CASE/ALT numbers) but **record timestamps use the run time**, so checksums differ between runs | deterministic timestamps and a comparison script | Phase 2: inject a clock (`--as-of`) for created/assessment/screening timestamps and compare checksums of the business columns |

#### R22 detail: the five required edge cases

| Edge case | Status | What exists | What is missing |
|---|---|---|---|
| Document expired but marked valid | **PARTIALLY COMPLETE** | The "verified_expired" scenario creates documents whose status is Verified but whose expiry date has passed (all 10 expired documents in the seed are still marked Verified); the engine reports them as Expired | Not labelled; the label must come from the injection |
| Customer approved with missing mandatory evidence | **NOT IMPLEMENTED** | The system detects missing mandatory documents (28 in the seed) but a customer has no "approved" decision (`registration_status` is only Registered / Pending Review / Closed) | An onboarding decision record (insert-only) so that "approved while evidence is missing" is a real, detectable state |
| Ownership percentages exceed 100% | **PARTIALLY COMPLETE** | 2 companies total 110% (a single owner cannot exceed 100: the database forbids it); detected as `OWNERSHIP_EXCEEDS_100` | Not labelled |
| Review closes without resolution | **PARTIALLY COMPLETE** | The database refuses a closed case with empty resolution notes. The system instead detects "closed without proper resolution" (the case is closed but its exception is still active): 1 case is flagged now (2 cases are Closed in total) | Not labelled; define the injected anomaly precisely (closed with a placeholder note while the exception persists) |
| Duplicate document used across unrelated customers | **NOT IMPLEMENTED** | The database stops the same document being submitted twice for **one** customer. The document-number hash is not customer-specific, so the same number for two customers could be detected, but nothing injects or detects it | Injector, a check, a (cross-customer) exception type |

### D. Acceptance criteria

| # | Requirement | Status | Evidence | Missing |
|---|---|---|---|---|
| R28 | Completeness rules match customer type | **COMPLETE** | Requirements are selected by customer type and risk; tests in `kyc.engine.test.js` | none |
| R29 | Ownership percentages reconcile | **COMPLETE** | Per-company totals and status; `OWN_*` checks; tests | none |
| R30 | Every exception is traceable | **COMPLETE** | Each exception/alert has a source entity, a dedupe key, linked cases and audit events | none |
| R13 (expiry) | Expiry alerts trigger at configured lead times | **PARTIALLY COMPLETE** | One fixed 30-day window; one alert per document | `expiry_configuration.md`: configuration table, per-threshold alerts, admin API |
| R31 | Expired document not counted as valid verified evidence | **COMPLETE** | `effectiveStatus` and the completeness buckets; test "expired Verified document does NOT count as valid" | none |
| R32 | Lawful provenance: external data recorded with source, licence and so on; otherwise synthetic | **PARTIALLY COMPLETE** | All data is synthetic; no external dataset is used (true in practice) | A written source manifest stating this | One short `source_manifest` file in the dataset package |

### E. Things that already satisfy the rules for this phase

* No Phase 1 action changed data. Existing reset scripts (`--reset`) were **not** run.
* The audit identified one operational note: the seed scripts delete the audit events of regenerated data without rewinding `audit_event_seq`, leaving a gap in AUD codes (see `id_conventions.md`). It is harmless (codes remain unique) and is listed only for completeness.

---

## Part 3. Stage B: implementation plan (nothing below has been executed)

### 3.1 Database changes necessary

| # | Change | Type | Needed for |
|---|---|---|---|
| 1 | `IdCounter` table + `next_scoped_number()` function | new table (additive) | R13b, R13c, R13e, R13d |
| 2 | `business_id` columns on `KYCRequirement`, `Document`, `Alert`; `review_code` on `ReviewCase`; triggers, unique indexes, format CHECKs, backfill | new nullable columns, then constraints | R13b–R13e |
| 3 | `CompanyOwnership` table (+ backfill of 40 rows, triggers, partial unique index) | new table (additive) | R10, R11 |
| 4 | `SystemSetting` table (versioned, insert-only) | new table (additive) | R13 (expiry) |
| 5 | `Alert.threshold` (nullable integer) | new nullable column | per-threshold expiry alerts |
| 6 | `Document.name_on_document` (nullable text) | new nullable column | R21 |
| 7 | `OnboardingDecision` table (customer, decision, decided by, date, basis; insert-only) | new table (additive) | edge case "approved with missing evidence" |
| 8 | Extend the allowed lists (new exception and alert types, audit actions) by replacing CHECK constraints | constraint change only | R21, cross-customer duplicates, name mismatches, settings |

No table is dropped or recreated. No existing column is removed or changed in type.

### 3.2 Already implemented (no change needed)

Ten core entities and keys; customer ID generation; derived completeness and risk; periodic reviews; exceptions, alerts and audit events with immutability; per-company ownership totals; expired documents excluded from valid evidence; fixed seed; 33 validation checks; masked exports; 216 backend tests and six browser suites.

### 3.3 Migrations required (proposed order, each additive and independently reversible)

| Migration | Contents | Depends on |
|---|---|---|
| M1 `ids_and_counters` | #1, #2 (columns nullable, backfill, then constraints) | none |
| M2 `company_ownership` | #3 | none |
| M3 `system_settings_expiry` | #4, #5 and the settings audit action | none |
| M4 `anomaly_support` | #6, #7, #8 | M1 recommended |

Each migration follows the pattern already used in this project: Prisma generates the table SQL (`prisma migrate diff`), hand-written constraints and triggers are added, then `prisma migrate deploy`.

### 3.4 How existing data will be preserved

* **Only additions.** Backfills write only into new columns and new tables.
* Take a safety copy first: stop PostgreSQL and copy the `.pgdata` folder (and export the seed JSON and schema SQL, which the application can already produce).
* Every backfill is deterministic (ordered by the existing numeric id) and idempotent (can run twice with the same result).
* History tables stay insert-only. Nothing in `Verification`, `RiskRating`, `OwnerScreening`, `CaseHistory` or `AuditEvent` is touched.
* **Person merge** (several `BeneficialOwner` rows for one person) is **not** part of M2. It changes existing rows, so it needs your explicit approval and is separate.

### 3.5 How existing APIs remain compatible

* No endpoint is removed, renamed or reshaped. New information appears as **additional fields** (`businessId`, `threshold`, `effectiveFrom`, …).
* Numeric ids stay in URLs; the old codes (`CASE-…`, `ALT-…`) stay in responses.
* Search and filters accept both old and new codes.
* New endpoints only: expiry settings, link-an-owner-to-another-company, list a person's companies.
* The frontend keeps working untouched, and gains the new IDs and fields screen by screen.

### 3.6 How the changes will be tested

* **Per migration:** apply to a copy of the current database; check row counts of every table before and after (unchanged); run the whole data quality suite; run `npm test` (216 tests) and the six browser suites.
* **IDs:** 50 parallel inserts per entity produce distinct, correctly formatted, gap-free codes; restart consistency; backfill idempotency.
* **Ownership:** per-company totals equal the old calculation for all 17 companies; the Person A / Person B example (ABC 100%, XYZ 25%); history on a percentage change; duplicate-active-pair rejection.
* **Expiry:** boundary tests at 91, 90, 61, 60, 31, 30, 8, 7, 1, 0 and −1 days; one alert per document, date and threshold; configuration validation and versioning.
* **Anomalies:** each injected case appears in `ground_truth` with its label and is found by exactly the check that should find it (the precision/recall report belongs to Phase 2).

### 3.7 Decisions needed from you before Phase 2

| # | Question | My recommendation |
|---|---|---|
| 1 | Which date gives the year in `KYC-`, `ALT-` and `REV-` codes? | Requirement: `effective_from`; alert: `created_at` (UTC); review: due date of the cycle |
| 2 | `REV-CUS-000001-2026` is not unique if a customer has two cases in a year. How should it apply? | Use `REV-…` for periodic review cases only; keep `CASE-…` for all other cases |
| 3 | How should "customer approved" be represented? | New insert-only `OnboardingDecision` table (Approved / Rejected / Pending, with date and decision-maker) |
| 4 | May Phase C (merging duplicate person rows and making person identity unique) run on your data? | Only after Phase B is stable, with a backup, and only for rows with an identical `identity_hash` (none exist today) |
| 5 | Expiry severity per lead time: is Low (90, 60) / Medium (30) / High (7) acceptable? | Yes, editable in the setting |

### 3.8 Suggested order for Phase 2 (not started)

1. M1 (IDs) and the dataset code generator for the data dictionary.
2. M2 (company ownership) and M3 (expiry settings).
3. M4 (anomaly support), then the injectors and `ground_truth`.
4. The bulk generator at full scale with deterministic timestamps.
5. Detection-versus-ground-truth report, the double-run checksum proof, and the packaged dataset with README and source manifest.

**Phase 1 ends here.**
