# ID Conventions: What Exists, What Is Required, and the Plan

> **Phase 2 status (implemented).** The plan below has been carried out by the additive migrations `20261105090000_phase2_ids_ownership_expiry` and `20261105100000_phase2_code_trigger_fk`. `KYCRequirement.business_id` (`KYC-2026-000001`), `Document.business_id` (`DOC-CUS-000001-001`), `ReviewCase.review_code` (`REV-CUS-000001-2026`, a customer's later cases in the same year get `-02`, `-03`) and `Alert.business_id` (`ALT-2026-000001`) now exist, are filled by `BEFORE INSERT` triggers when the application does not supply them, are unique, format-checked and immutable, and are numbered by the gap-free `IdCounter` table through `next_scoped_number(scope, period)`. Existing rows were back-filled in `id` order. The table in section 1 and the "NOT IMPLEMENTED" markers describe the state **before** that migration. The data generator (`generator/`) uses the same formats and continues the same counters.

This document audits the identifiers used by the **actual** implementation and gives a migration-safe plan for the formats that are missing. Nothing in this document has been changed in the database yet.

## 1. Required formats versus what exists today

| Entity | Required format | What the system uses today | Status |
|---|---|---|---|
| Customer | `CUS-000001` | `CUS-000001` (column `Customer.customer_id`) | **COMPLETE** |
| KYC Requirement | `KYC-2026-000001` | Only the numeric key `KYCRequirement.id` (1, 2, 3 …). No business code. | **NOT IMPLEMENTED** |
| Document | `DOC-CUS-000001-001` | Only the numeric key `Document.id`. No business code. | **NOT IMPLEMENTED** |
| Review Case | `REV-CUS-000001-2026` | `CASE-000001` (column `ReviewCase.case_code`), one global counter | **PARTIALLY COMPLETE** (generated safely, wrong format) |
| Alert | `ALT-2026-000001` | `ALT-000001` (column `Alert.alert_code`), one global counter, no year | **PARTIALLY COMPLETE** (generated safely, wrong format) |

Other business codes that already exist and are not part of the required list: `RSK-000001` (risk assessments), `EXC-000001` (exceptions), `AUD-000001` (audit events). They follow the same safe mechanism as the customer ID.

## 2. How the existing IDs are generated

All existing business codes use the same mechanism: **a PostgreSQL sequence plus a SQL function that formats it**, used as the column default.

| Code | Sequence | Function (column default) | Format check (CHECK) | Unique index |
|---|---|---|---|---|
| `CUS-` | `customer_code_seq` | `next_customer_code()` — called explicitly in the registration transaction | `^CUS-[0-9]{6,}$` | `Customer_customer_id_key` |
| `RSK-` | `risk_assessment_seq` | `next_risk_assessment_code()` | `^RSK-[0-9]{6,}$` | `RiskRating_assessment_code_key` |
| `EXC-` | `exception_seq` | `next_exception_code()` | `^EXC-[0-9]{6,}$` | `Exception_exception_code_key` |
| `CASE-` | `review_case_seq` | `next_review_case_code()` | `^CASE-[0-9]{6,}$` | `ReviewCase_case_code_key` |
| `ALT-` | `alert_seq` | `next_alert_code()` | `^ALT-[0-9]{6,}$` | `Alert_alert_code_key` |
| `AUD-` | `audit_event_seq` | `next_audit_event_code()` | `^AUD-[0-9]{6,}$` | `AuditEvent_event_code_key` |

Each function is `SELECT 'PREFIX-' || lpad(nextval('sequence')::text, 6, '0')`. The number is zero-padded to six digits and grows past six digits if it ever needs to.

Numeric keys (`id`, auto-increment) exist on every table and are what foreign keys use. People see the business codes.

## 3. Audit results

### 3.1 Are IDs generated automatically?

* **Customer, risk assessment, exception, case, alert, audit event: yes.** The client never supplies them.
* **Requirement and document: no business code exists.** Only the numeric `id`.

### 3.2 Are IDs unique?

Yes, for every code above: a unique index (listed in the table) makes the database refuse a duplicate, and a CHECK constraint refuses a malformed code. Customer codes are also **immutable** (trigger `Customer_code_immutable`); the `Alert_guard` trigger likewise forbids changing an alert code.

### 3.3 Can concurrent requests generate duplicate IDs?

No. `nextval()` is atomic in PostgreSQL: two simultaneous calls always receive different numbers. The existing automated tests prove this for customers:

* `parallel registrations all receive different Customer IDs` (12 simultaneous registrations),
* `simultaneous identical submissions create exactly one customer`,
* `a Customer ID is never reused after the customer is deleted`.

The registration code also retries (up to 3 times) if the unique index ever rejects a code. Alert, exception and case creation are protected the same way (sequence default + unique index, plus `createMany({ skipDuplicates: true })` for the duplicate-prevention index on alerts and exceptions).

**Important property: IDs are unique, but not gap-free.** A sequence number is consumed even if the transaction that asked for it rolls back, so a failed registration leaves a hole (CUS-000007 might be followed by CUS-000009). This is normal for sequences and harmless for uniqueness. If a gap-free series is ever required, it needs a different mechanism (see the counter table in the plan below).

### 3.4 Do child records reference the correct parent IDs?

* Every child-to-parent link is a numeric foreign key enforced by PostgreSQL (37 foreign keys; see `database_relationships.md`). A child with a non-existent parent cannot be saved. The data quality checks `FK_*` re-test this on demand.
* Business codes are **not** copied into child rows as references (a document stores `customer_id` = 12, not "CUS-000012"). This is safe because the customer code can never change.
* Soft references (`Exception.source_entity_id`, `Alert.related_entity_id`, `AuditEvent.entity_ref`) are plain values without a foreign key; the check `ALERT_ACTIVE_VALID` validates the active ones.

### 3.5 Do IDs stay consistent after a database restart?

Yes. A sequence is stored inside the database like a table, so its position survives restarts of PostgreSQL (including the embedded server used for development, which keeps its data in `.pgdata`). Nothing is held in application memory.

Evidence from the current database (read-only comparison of each sequence with the highest code in use):

| Sequence | `last_value` | Highest code in the table | Rows | Comment |
|---|---|---|---|---|
| `customer_code_seq` | 50 | CUS-000050 | 50 | consistent |
| `review_case_seq` | 15 | CASE-000015 | 15 | consistent |
| `alert_seq` | 94 | ALT-000094 | 94 | consistent |
| `exception_seq` | 124 | EXC-000124 | 124 | consistent |
| `risk_assessment_seq` | 82 | RSK-000082 | 82 | consistent |
| `audit_event_seq` | 1106 | AUD-001008 | 1008 | **gap of 98**: the seed scripts delete the audit events of the data they regenerate without resetting this sequence. Codes stay unique and increasing; only the sequence is ahead. |

The generator scripts reset the sequences deliberately (`ALTER SEQUENCE … RESTART`) when asked to start from scratch (`--reset`), which is why the same seed gives the same customer, case and alert codes.

### 3.6 Are IDs deterministic?

* Customer, case, alert, exception and risk codes are **deterministic given the same order of inserts** from a clean sequence (that is how the generator scripts reproduce CUS-000001 … with the fixed seed). They are never random.
* The required document code (`DOC-CUS-000001-001`) and the year-based codes depend only on parent code, year and an ordered counter, so they can also be fully deterministic.

## 4. Gaps and decisions needed before implementing

| # | Gap | Why it matters | Decision needed |
|---|---|---|---|
| 1 | **Year-based codes need a counter that restarts every year** (`KYC-2026-000001`, `ALT-2026-000001`). A single PostgreSQL sequence cannot restart by itself. | One sequence per year would have to be created in advance. | Use a small counter table (plan below). |
| 2 | **Which date decides the year?** | The year must be reproducible. | Proposed: requirement = year of `effective_from`; alert = year of `created_at` (UTC); review = year of the review's `due_date` for periodic cases, otherwise year of `created_at`. Please confirm. |
| 3 | **`REV-CUS-000001-2026` is not unique if a customer has two cases in one year.** The format contains no sequence number. With 3,000 cases and 8,000 customers some customers will have several. | A unique code cannot repeat. | Choose: (a) use `REV-` only for **periodic review cases** (at most one active per customer and cycle) and keep `CASE-` for other cases; or (b) add a suffix for repeats, `REV-CUS-000001-2026-02`. Recommended: (a), and keep `CASE-000001` as the code for non-periodic cases. |
| 4 | **The Alert trigger forbids changing `alert_code`.** | Rewriting existing alert codes in place would be blocked (and would break history). | Add a **new** column rather than rewrite the old one (plan below). |
| 5 | **Numeric `id` is used in URLs and API responses** (`/documents/12`, `/review-cases/5`). | Changing URLs would break the frontend and tests. | Keep numeric ids; add the new code as an extra field. |

## 5. Migration-safe implementation plan (not executed)

Principles: **additive only** (no table is dropped or recreated, no column is removed, no existing value is changed), idempotent, and reversible by dropping what was added.

### Step 1: a counter table and one function

```
IdCounter(scope TEXT, period INT, last_value INT, PRIMARY KEY (scope, period))
next_scoped_number(scope, period) -> INT
   INSERT … ON CONFLICT (scope, period) DO UPDATE SET last_value = IdCounter.last_value + 1 RETURNING last_value
```

* Scopes: `KYC`, `ALT`, `REV`, and one scope per customer for documents (`DOC:CUS-000001`).
* The increment happens inside the caller's transaction and takes a row lock, so concurrent callers queue and each receive a different number. If the transaction rolls back, the increment is undone too, so these series are **gap-free**.
* Cost: callers for the same scope are serialised for the length of their transaction. Acceptable for this system.

### Step 2: add new columns (nullable first)

| Table | New column | Example | Unique | Format CHECK |
|---|---|---|---|---|
| KYCRequirement | `business_id` | `KYC-2026-000001` | yes | `^KYC-[0-9]{4}-[0-9]{6}$` |
| Document | `business_id` | `DOC-CUS-000001-001` | yes | `^DOC-CUS-[0-9]{6,}-[0-9]{3,}$` |
| ReviewCase | `review_code` (only for periodic cases) | `REV-CUS-000001-2026` | yes, where not null | `^REV-CUS-[0-9]{6,}-[0-9]{4}$` |
| Alert | `business_id` | `ALT-2026-000001` | yes | `^ALT-[0-9]{4}-[0-9]{6}$` |

The existing `case_code` (`CASE-000001`) and `alert_code` (`ALT-000001`) stay exactly as they are, so nothing that uses them breaks.

### Step 3: backfill existing rows deterministically

One `UPDATE` per table, ordered by the existing numeric id (so the result is reproducible):

* requirements: year from `effective_from`, number = `row_number()` partitioned by year;
* documents: customer code from the parent, number = `row_number()` partitioned by customer;
* alerts: year from `created_at`, number = `row_number()` partitioned by year;
* periodic review cases: customer code, year of the due date.

Then set each counter to the highest number used. Existing data is only **added to**; no existing value changes.

### Step 4: make it automatic and strict

* A `BEFORE INSERT` trigger fills `business_id` when it is empty, so the existing application code keeps working without changes.
* After the backfill: `NOT NULL`, unique index and the CHECK from step 2. A trigger forbids changing the code later (as for customers).

### Step 5: APIs and screens (backward compatible)

* Responses gain a field (for example `businessId`) **next to** the current `id`, `caseId` and `alertId`; nothing is removed or renamed.
* Search boxes and filters accept both the old and the new code.
* Screens show the new code where space allows; routes keep using the numeric id.

### Step 6: tests

* 50 parallel inserts per entity produce 50 distinct, correctly formatted codes with no gaps.
* A rolled-back insert leaves no gap in the scoped series.
* The backfill gives the same result when run twice (idempotent) and the same result on a copy of the database (deterministic).
* Restart consistency: stop and start PostgreSQL, insert, and confirm the next code continues the series.
* Existing suites (216 backend tests, browser suites) keep passing unchanged.

### Rollback

Everything is additive: dropping the new columns, triggers and `IdCounter` restores the previous state exactly.

## 6. Summary

| Check | Result |
|---|---|
| Customer ID format works and should not change | Yes. Left untouched. |
| IDs generated automatically | Yes for six codes; not for requirements and documents. |
| IDs unique | Yes (unique index + format CHECK). |
| Duplicate IDs under concurrent requests | Not possible (atomic sequences; tested for customers). |
| Child rows reference the right parents | Yes (37 enforced foreign keys; data quality checks). |
| IDs consistent after restart | Yes (sequences persist in the database). |
| Gap-free | No (sequences skip numbers on rollback and the seed scripts do not rewind the audit sequence). |
| Required formats for requirement, document, review, alert | **Missing.** Plan above; needs the decisions in section 4. |
