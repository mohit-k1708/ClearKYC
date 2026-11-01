# ClearKYC synthetic data generator (Phase 2)

Generates a reproducible, entirely **synthetic** KYC dataset on top of the existing PostgreSQL + Prisma schema. No real person, company, PAN or Aadhaar is used: names come from small fictional pools, PAN and Aadhaar are placeholders that only follow the format, e-mails use `example.com`. Deliberate edge cases, the answer key and the detector are Phase 3: see `documentation/edge_case_rules.md` (the generator only provides the valid baseline for them).

## Commands

```
npm run generate:starter -- --reset     # 50 customers      (about 6 s)
npm run generate:medium  -- --reset     # 1,000 customers   (about 20 s)
npm run generate:full    -- --reset     # 8,000 customers   (about 2 min)
```

All three call the same engine (`node generator/index.js --scale=<name>`). `--reset` is only needed when the target database already holds data. Optional flags (after `--`):

| Flag | Default | Meaning |
|---|---|---|
| `--seed=N` | 20261022 | Random seed. Same seed + same configuration = identical data |
| `--reference-date=YYYY-MM-DD` | 2026-10-31 | Every date and timestamp is generated relative to this day, never the machine clock |
| `--batch-size=N` | 1000 | Rows per `createMany` (1-2000) |
| `--database=name` | `clearkyc_<scale>` | Target database (created and migrated on demand) |
| `--reset` | off | Empty the target database first (only that database) |
| `--confirm-reset-main-database` | off | Needed **in addition to** `--reset` to write into the main `clearkyc` database |
| `--skip-validation` | off | Skip the post-generation checks |
| `--report-dir=path` | `generator/reports/<scale>` | Where the reports are written |

**Safety.** The generator writes into its own database (`clearkyc_starter`, `clearkyc_medium`, `clearkyc_full`) on the same PostgreSQL server, so your development data in `clearkyc` is never touched. It refuses to write into a database that already contains customers unless `--reset` is given, and refuses the main database unless both flags are given.

## Configuration

One central file: [`config/generatorConfig.js`](config/generatorConfig.js).

* `GENERATOR_CONFIG`: `seed`, `scale`, `referenceDate`, `batchSize`, `resetBeforeGeneration`, `databaseName`.
* `SCALES`: the four fixed volumes per scale (customers, companies, documents, review cases). **Every other count is derived** (owners, verifications, risk assessments, schedules, exceptions, alerts, audit events), so changing the scale changes everything consistently.

| Scale | Customers (individual / company) | Documents | Review cases |
|---|---|---|---|
| starter | 50 (33 / 17) | 152 | 15 |
| medium | 1,000 (875 / 125) | 2,500 | 300 |
| full | 8,000 (7,000 / 1,000) | 20,000 | 3,000 |

* `RATIOS`: proportions that shape the derived data (owners per company, share of people owning several companies, replacement-document rate, document outcome shares, completed-review rate, share of historical cases, alert acknowledgement rates ...).
* Business rules are **not** duplicated: risk scoring, KYC completeness, exception detection, alert derivation, case workflow rules and review intervals are the application's own code (`server/src/...`), called in memory. Expiry lead times (90 / 60 / 30 / 7) come from `server/src/config/expiryRules.js`.

## Generation order and how each entity is derived

Parents first, all IDs assigned in memory, then written in dependency order with batched `createMany` (no per-record queries, no lookups in loops):

1. **CustomerType, Reviewer, KYCRequirement** (the 25 sample requirements, `KYC-2026-000001` ...).
2. **Customers**: onboarded over the 36 months before the reference date (more recent ones more common), numbered `CUS-000001` in onboarding order. Individuals are adults on the onboarding day; companies were incorporated before onboarding (12% are new).
3. **BeneficialOwners** (+ `CompanyOwnership` filled by the database trigger, screenings, ownership checks): every company gets 1-4 owners whose shares add up to exactly 100.00; about 12% of owner slots are people who also own another company (different percentage in each).
4. **Documents**: the document types a customer must provide come from the requirements of their type and **current** risk level. Documents carry real dates (expiry = issue date + the validity of that type); an expired document keeps its old Verified decision but never counts as valid.
5. **Verifications**: an insert-only history per document (Pending by the system, optional In Review, then the decision by a Reviewer or Admin).
6. **RiskRatings**: calculated by the application's rules (company: a second assessment after its owners were recorded). They are computed before the documents (the documents depend on the level) but written after them.
7. **ReviewSchedules**: periodic cycles from the configured intervals (36 / 24 / 12 months); finished reviews are `Completed`, the rest are overdue.
8. **Exceptions**: the application's detection engine is run on every customer at the reference date; conditions that cleared in the past (a replaced bad document, a review completed late) are resolved exceptions.
9. **ReviewCases**: exactly the configured number, chosen from real conditions: every overdue periodic review, about 20% historical (Resolved / Closed) and the rest active, preferring serious conditions. Exceptions are written before the cases because the cases reference them.
10. **Alerts**: the application's alert engine; one alert per document and expiry threshold; plus closed alerts for cleared conditions.
11. **OnboardingDecisions** (added for Phase 3): every customer starts "Pending Review"; a customer is approved only if every mandatory document was Verified and unexpired at the moment of approval, so the baseline has no "approved with missing evidence". Every document also records the name written on it (a legitimate variant of the registered name for about a quarter of documents).
12. **AuditEvents**: one event for every generated action, with valid references.

After writing, the PostgreSQL sequences and the `IdCounter` table are moved past the generated data, so the application keeps numbering from where the generator stopped.

## Deterministic IDs

`CUS-000001`, `KYC-2026-000001`, `DOC-CUS-000001-001`, `REV-CUS-000001-2026` (`-02` for a customer's second case in a year), `ALT-2026-000001`. The internal numeric primary keys are kept; the older codes (`CASE-`, `EXC-`, `RSK-`, `AUD-`, `ALT-000001`) are generated too.

## Reproducibility

Each stage has its own random stream forked from the seed by name, dates come from the reference date, and the encrypted columns use a deterministic IV, so the same seed and configuration give byte-identical data. Proof: `generator/reports/<scale>/checksums.json` holds an md5 per table plus a dataset checksum. Before the Phase 3 additions two **full** runs gave identical checksums for every table; after them the determinism is covered by the starter test (`server/tests/generator.test.js`, identical checksums for the same seed) and by the Phase 3 tests, and the current full baseline has dataset checksum `cad33cb85dfc7967aebdb2292a12c209`. The checksums depend on the `ENCRYPTION_KEY` and `HASH_KEY` in `.env`; different keys give different ciphertext.

## Performance (full scale, this machine, embedded PostgreSQL on the OneDrive folder)

Total **112-140 s** (112 s and 133 s before the Phase 3 additions, 140 s after) for 8,000 customers / 20,000 documents / about 49,000 verifications / 3,000 cases / about 130,000 audit events. Building everything in memory takes about 20 s; the rest is writing and validating (validation 9 s). The slowest stage is the audit trail (about 130,000 rows, 32 s). Per-entity records, time and records/second are in `generator/reports/<scale>/performance_report.md`; failed records: 0.

| Scale | Total time |
|---|---|
| starter | 6 s |
| medium | 20 s |
| full | 112 s |

## Validation

After writing, 127 database checks run and the report lists every one (`validation_report.md`): counts (8,000 / 7,000 / 1,000 / 20,000 / 3,000), primary and business-ID uniqueness and formats, foreign keys (no orphans), customer-type field rules, document dates and status, verification history, ownership (exactly 100.00 per company, bridge in step), risk history, schedules, exceptions-versus-cases consistency, alert rules (no duplicate active alert, thresholds, one alert per document and threshold), audit references and no PAN/Aadhaar-like text. Then the application's own 33 data-quality checks run on the data. Each failure prints the check, the number of violating rows and up to five example rows. Result for all three scales (re-verified for starter and full after the Phase 3 additions): **127/127 passed, 0 application checks failed** (120/120 before the Phase 3 additions). One application check reports a **warning** ("active case past its due date", about 20% of active cases): that is realistic backlog, not an error.

## Tests

`server/tests/generator.test.js`: configuration, seeded randomness, ID formats, expiry boundaries (91, 90, 61, 60, 31, 30, 8, 7, 1, 0, -1), one alert per document and threshold, ownership shares, the main-database safety guard, and an end-to-end starter run (exact counts, validation, refusal to overwrite, identical checksums for the same seed, different data for a different seed).

## Files

Created: `generator/` (`index.js`, `config/generatorConfig.js`, `generators/{reference,customer,ownership,risk,document,review,alert,audit}Generator.js`, `utils/{seededRandom,idGenerator,syntheticCrypto,database,batchInsert}.js`, `validation/postGenerationValidation.js`, `reports/`), `server/src/config/expiryRules.js`, `server/tests/generator.test.js`, migrations `20261105090000_phase2_ids_ownership_expiry` and `20261105100000_phase2_code_trigger_fk`.
Modified: `prisma/schema.prisma`, `server/src/services/{exceptionEngine,alertEngine,exceptionService,alertService}.js`, `scripts/generate{Customers,KycData,ReviewData}.js` (reset lists), `server/tests/scene5.api.test.js` (one assertion made precise), `package.json` (three scripts, `pg`), Phase 1 documents (status notes).

## Known limitations

* No uploaded files exist on disk: 40% of documents carry file metadata (`syn-doc-000001.pdf`) but nothing is stored.
* About 25% of mandatory documents are missing. This is a consequence of the fixed 20,000 documents (full requirements would need about 24,900 first copies); it is derived from the data, not a random percentage, and recently onboarded customers are more often incomplete.
* A person owning several companies is stored as one owner row per company linked by `person_ref`; there is no separate `Person` table.
* The expiry thresholds live in a code file (`expiryRules.js`), not in a database settings table.
* Risk levels follow the application's prototype rules: the mix is about 84% Low, 15% Medium, under 1% High. Only the portfolio inputs (country, occupation, activity frequencies) were tuned.
* Closed expiry alerts for already-expired documents are not linked to a historical exception.
* Identical checksums need identical encryption/hash keys.
* The generator does not inject deliberate errors or ground truth (Phase 3).
