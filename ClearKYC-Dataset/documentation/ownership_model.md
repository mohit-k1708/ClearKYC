# Ownership Model: Current Implementation, the Gap, and the Plan

> **Phase 2 status (implemented).** The bridge recommended below now exists as `CompanyOwnership` (migration `20261105090000_phase2_ids_ownership_expiry`): one row per company-owner relationship with its own `ownership_percentage`, `ownership_type`, `control_type` and `effective_from` / `effective_to`, one active row per pair (partial unique index), and a `person_ref` that groups the owner rows of the same real person across companies. It is filled and kept in step by `AFTER INSERT / UPDATE` triggers on `BeneficialOwner` (a percentage change on a later day closes the old row and opens a new one, so history is kept), so the existing application code, screens and the ownership engine are unchanged. The 40 pre-existing owner rows were back-filled. The generator creates ownership for all 1,000 companies at full scale, including people who own several companies with a different percentage in each. The sections below describe the state **before** this migration.
>
> A person who owns several companies is still stored as one `BeneficialOwner` row **per company** (the same name, birth date and `identity_hash`); a separate `Person` table was deliberately not introduced because it would have changed every existing query.

This document explains how beneficial ownership is stored **today**, whether it supports the required many-to-many model (one company with many owners, one person owning several companies, a different percentage for each pair), and how to close any gap safely. Nothing has been changed in the database.

## 1. What the requirement is

| Rule | Example |
|---|---|
| One company has multiple beneficial owners | ABC is owned by Person A and Person B |
| One individual can own several companies | Person A owns part of ABC and part of XYZ |
| The percentage belongs to the company–owner **pair** | A: ABC 40%, XYZ 25%. B: ABC 60% |
| Ownership is calculated separately for each company | ABC = 40 + 60 = 100% (complete). XYZ = 25% (incomplete) |

## 2. How it is implemented today

### 2.1 Tables involved

| Table | Role |
|---|---|
| `BeneficialOwner` | One row per owner **per company**. Holds the person's details **and** the company link **and** the percentage. |
| `OwnerScreening` | PEP / sanctions screening results, linked to a `BeneficialOwner` row (insert-only history). |
| `OwnershipValidation` | Recorded reconciliation checks for a company (insert-only history). |
| `Customer` | The company (a customer of type Company). |

There is **no bridge table** and **no separate person table**. Relevant columns of `BeneficialOwner`:

| Column | Meaning today |
|---|---|
| `customer_id` | The company (foreign key to `Customer`, ON DELETE CASCADE; a trigger refuses non-company customers) |
| `full_name`, `date_of_birth` (encrypted), `country_of_residence`, `nationality`, `pep_status` | Details of the person |
| `ownership_percentage` | Share in **that** company (`NUMERIC(5,2)`, empty or greater than 0 and at most 100) |
| `ownership_type`, `control_type` | Direct/Indirect and how the person controls the company |
| `identity_hash` | Keyed hash of the normalised name and date of birth |
| `created_at`, `updated_at`, `created_by_id`, `updated_by_id` | Housekeeping. **No effective dates.** |

Uniqueness: `UNIQUE (customer_id, identity_hash)`: the same person cannot be entered twice **for the same company**, but may be entered again for another company.

### 2.2 Source files

| Area | File |
|---|---|
| Owner create/update/list, ownership validation, overview SQL | `server/src/services/ownershipService.js` |
| Total, status and issue calculation (pure functions) | `server/src/services/ownershipEngine.js` (`validateOwnership`, `assessOwnerRisk`, `assessComplexity`) |
| Screening results | `server/src/services/screeningService.js` |
| Rules (statuses, control types, points) | `server/src/config/ownershipRules.js` |
| Routes | `server/src/routes/ownership.js` |
| Other readers of owner rows | `exceptionService.js` (detection), `riskAssessmentService.js`, `analyticsService.js` (`COMPANY_BASE`), `exportService.js`, `dataQualityChecks.js` (`OWN_*`), the generator `scripts/generateOwnershipData.js`, and the React pages under `pages/*Ownership*`, `BeneficialOwner*` |

### 2.3 How the total is calculated

For each company, the engine sums the `ownership_percentage` of **that company's** `BeneficialOwner` rows (`WHERE customer_id = company`). Status: no rows = `NO_OWNERS`; any empty percentage = `MISSING_PERCENTAGE`; total above 100 = `EXCEEDS_100`; below = `BELOW_100`; exactly 100 = `RECONCILED`. So **the calculation is already per company** and correct.

## 3. Does the current model support the requirement?

| Requirement | Supported today? | Notes |
|---|---|---|
| One company, many owners | **Yes** | Many `BeneficialOwner` rows share a `customer_id`. |
| Different percentage for each company–owner pair | **Yes, indirectly** | The percentage sits on the per-company row. |
| One person owning several companies | **Only by duplicating the person** | The person becomes two unrelated rows (one per company). |
| Ownership calculated separately per company | **Yes** | Grouped by `customer_id`. |
| Historical ownership changes | **No** | An edit overwrites the row. The audit trail records old and new values (`OWNERSHIP_PERCENTAGE_CHANGED`) from Scene 5 onward, but the table itself has no history and no effective dates. |
| No duplicate active relationship for the same pair | **Partly** | Unique `(customer_id, identity_hash)` stops duplicates per company, but only when a date of birth was given (the hash is empty otherwise). |

### 3.1 Why "duplicate the person" is not good enough

| Problem | Consequence |
|---|---|
| Personal data (name, encrypted date of birth, nationality) is stored once per company | Inconsistent copies; correcting a name must be done in every company |
| Screening is stored per row | The same person can be "No Match" in one company and "Potential Match" in another. Risk and alerts then disagree about the same human being |
| No person identity across companies | Cannot answer "which companies does this person own or control?" |
| Percentage changes overwrite | Cannot answer "who owned how much of the company on 1 March?" |
| Current seed data | **No person is currently linked to more than one company** (checked: 0 shared identities), so the many-to-many case is not exercised by the data at all |

**Verdict: PARTIALLY COMPLETE.** The per-company model works and is well tested, but it is not a true many-to-many model and keeps no ownership history.

## 4. Proposed design: a `CompanyOwnership` bridge table

`CompanyOwnership` does **not** exist today, so there is no duplicate to avoid. It would hold the relationship; `BeneficialOwner` becomes the **person**.

```
Customer (company) 1 ───< CompanyOwnership >─── 1 BeneficialOwner (person) 1 ───< OwnerScreening
```

| Field | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `company_customer_id` | INTEGER, required | FK → `Customer(id)`; must be a Company (reuse the existing trigger logic) |
| `beneficial_owner_id` | INTEGER, required | FK → `BeneficialOwner(id)` |
| `ownership_percentage` | NUMERIC(5,2), **nullable** | CHECK empty or `> 0 AND <= 100`. Kept nullable to preserve the existing "missing percentage" case |
| `ownership_type` | TEXT, required | Direct / Indirect (same CHECK) |
| `control_type` | TEXT, required | same list as today |
| `effective_from` | DATE, required | When this share started |
| `effective_to` | DATE, nullable | Empty = still current. CHECK: later than `effective_from` |
| `created_at`, `updated_at` | TIMESTAMP | as elsewhere |
| `created_by_id`, `updated_by_id` | INTEGER, nullable | FK → `Reviewer(id)` (as on `BeneficialOwner` today) |

Constraints and indexes:

* **No duplicate active relationship** for a pair: partial unique index on `(company_customer_id, beneficial_owner_id) WHERE effective_to IS NULL`.
* No overlapping periods for the same pair: a trigger (an exclusion constraint would need the `btree_gist` extension, which should not be assumed in the embedded PostgreSQL).
* Indexes: `(company_customer_id, effective_to)`, `(beneficial_owner_id)`.
* Percentages are **not** forced to total 100 by the database: the system must still be able to store and flag an incomplete or over-100 company (the existing exceptions `OWNERSHIP_EXCEEDS_100` and `OWNERSHIP_INCOMPLETE` depend on that).

Behaviour:

* **Changing a percentage** = close the current row (`effective_to` = today) and insert a new row (`effective_from` = today). The old row is never updated, so history is kept.
* **Per-company calculation**: sum the rows with `company_customer_id = X` that are current on the chosen date (`effective_from <= date AND (effective_to IS NULL OR effective_to > date)`). Companies never mix.
* **Screening stays on the person** (`OwnerScreening.beneficial_owner_id`), so one human has one screening history across all their companies.

### 4.1 The example in this model

| Person | Company | % | Current |
|---|---|---|---|
| Person A | ABC | 40 | yes |
| Person A | XYZ | 25 | yes |
| Person B | ABC | 60 | yes |

ABC total = 40 + 60 = **100% (reconciled)**. XYZ total = **25% (incomplete)**. Person A is one row in `BeneficialOwner` with two ownership rows.

## 5. Migration plan (additive, in phases, not executed)

### Phase A: add and backfill (no behaviour change)

1. Create `CompanyOwnership` with the constraints above.
2. Backfill **one row per existing `BeneficialOwner` row** (40 today): `company_customer_id = customer_id`, `beneficial_owner_id = id`, the same percentage, type and control type, `effective_from = created_at::date`, `effective_to = NULL`.
3. Keep every existing `BeneficialOwner` column and index exactly as they are.
4. Keep both in step: the services that create or edit an owner also write the `CompanyOwnership` row **in the same transaction** (an automated check compares the two after every test run).

Existing data is only **added to**. Nothing is deleted, rewritten or merged.

### Phase B: switch the readers

Move the readers listed in section 2.2 (engine input, analytics SQL, exports, data quality checks, exception detection, the generator) to `CompanyOwnership`, one at a time, with the existing tests as the safety net. Add the new capability:

* `POST /api/customers/:companyId/ownerships` links an **existing** person to another company with a percentage;
* `GET /api/beneficial-owners/:id/companies` lists the companies a person owns.

### Phase C: people become unique (needs your approval)

Only after Phase B is stable: merge duplicate person rows that share an `identity_hash` (none exist in the current seed), move their screening history to the surviving person, and make `identity_hash` unique across the whole table instead of per company. This changes existing rows, so it must not run without explicit approval and a backup.

## 6. Compatibility of existing APIs

| Existing endpoint | Plan |
|---|---|
| `GET/POST /api/customers/:id/beneficial-owners` | Unchanged. Responses keep the same fields; new optional fields (`ownershipId`, `effectiveFrom`) are added. |
| `GET/PUT /api/beneficial-owners/:id` | Unchanged. `PUT` of the percentage becomes "close and insert" internally; the response is the same. |
| `POST /api/beneficial-owners/:id/screening` and `GET` | Unchanged (screening stays on the owner row). |
| `GET/POST /api/customers/:id/ownership-validation` | Unchanged; the calculation reads `CompanyOwnership`. |
| `GET /api/ownership/overview`, analytics, exports | Same numbers. A test compares the old and new calculation on the same data before the switch. |

## 7. How it would be tested

* Backfill equality: for every company, the total from `CompanyOwnership` equals the total from `BeneficialOwner` (all 17 companies in the seed).
* New many-to-many cases: Person A in ABC (40%) and XYZ (25%) with Person B in ABC (60%): ABC reconciles, XYZ does not, and screening one person affects both companies.
* A percentage change creates a new row and closes the old one; a point-in-time query returns the old share for a past date.
* Duplicate active pair is rejected; overlapping periods are rejected; percentage above 100 or at 0 is rejected; a non-company customer is rejected.
* The existing 216 backend tests and the browser suites still pass.

## 8. Risk and rollback

| Risk | Mitigation |
|---|---|
| Two copies of the same fact during Phase A–B | Written in the same transaction; automated equality check |
| Many places read owner rows | Switch one reader at a time behind the existing tests |
| Person merge (Phase C) changes data | Separate step, needs approval and a backup |

Rollback of Phases A and B: drop `CompanyOwnership` and revert the service changes; `BeneficialOwner` was never altered.
