# Source Manifest

## Provenance in one paragraph

**Every record in this dataset is synthetic.** It was produced by the ClearKYC generator from small fictional name pools and seeded random numbers. **No real customer personal data was used and no external personal data source was consulted.** Names, e-mail addresses (`example.com`), phone numbers, addresses, PAN-like and Aadhaar-like identifiers, company registration numbers and documents are invented; the identifiers only follow the *format* of real ones. Nothing was checked against any real sanctions list, PEP list, registry or identity provider: screening outcomes and verifications are simulated.

## Generation facts

| Item | Value |
|---|---|
| Fixed random seed | 20261022 |
| Reference date (every date and timestamp is generated relative to it, never to the machine clock) | 2026-10-31 |
| Generator version | 4.0.0 |
| Generation date (the day this package was assembled; run-specific, not part of the data) | 2026-10-31 |
| Dataset scale | full |
| Customers | 8,000 (7,000 individuals, 1,000 companies) |
| Documents | 20,000 |
| Review cases | 3,000 |
| Records exported | 308,971 rows in 22 tables |
| Database | PostgreSQL 17, schema in `sql/schema.sql` |

## Generation configuration

* Central configuration: `generator/config/generatorConfig.js` (`GENERATOR_CONFIG`: seed 20261022, batch size 1000, reference date 2026-10-31; `SCALES`; `RATIOS`).
* Ratios in use: owners per company [[1,0.25],[2,0.4],[3,0.25],[4,0.1]]; share of owner slots held by a person who owns another company 0.12; replacement-document rate 0.07; completed periodic review rate 0.88; share of historical review cases 0.2; document outcome shares [["verified",0.64],["expiring",0.05],["expired",0.06],["pending",0.07],["in_review",0.06],["rejected",0.06],["resubmit",0.06]].
* Business rules (risk scoring, KYC completeness, exception and alert detection, case workflow, review intervals, expiry lead times 90 / 60 / 30 / 7 days) are the rules of the ClearKYC application itself (`server/src/config/*`), applied in memory. They are illustrative prototype rules, not regulatory requirements.
* Every stage uses its own random stream forked from the seed by name; derived values are calculated from the source records; IDs are deterministic (`CUS-000001`, `KYC-2026-000001`, `DOC-CUS-000001-001`, `REV-CUS-000001-2026`, `ALT-2026-000001`).

## Edge cases deliberately injected

Planted into a copy of the valid baseline with seed 20261022, listed in `ground_truth.json` (the answer key) with a unique issue ID each. The operational files in `csv/`, `json/` and `sql/` contain the planted records but **no label**: nothing in them says which records are planted.

| Issue type | Planted | What was done |
|---|---:|---|
| EXPIRED_DOCUMENT_MARKED_VALID | 60 | a Verified document was given dates so it had already expired when it was submitted and verified |
| APPROVED_WITH_MISSING_EVIDENCE | 50 | an Approved decision was added while one mandatory document was missing or unverified |
| OWNERSHIP_OVER_100 | 40 | a company's beneficial owners were made to total more than 100% |
| CLOSED_WITHOUT_RESOLUTION | 50 | a Closed review case had its resolution notes removed |
| DOCUMENT_REUSED_ACROSS_CUSTOMERS | 40 | a document of one customer carries the number or file of an unrelated customer's document |
| DOCUMENT_NAME_MISMATCH | 70 | the name on a document was replaced by a clearly different name |
| **Total** | **310** | |

Legitimate look-alikes that must NOT be flagged are also present (name variants, documents that expired after a correct verification, correct approvals, 20 documents shared between related companies). They are described in `edge_case_manifest.json`.

## Results recorded in this package

* Validation: 182 checks, 179 passed, 3 passed with expected (planted) exceptions, 0 failed; unexpected data errors: 0.
* Reproducibility: REPRODUCIBLE: PASS (two complete runs compared; 51 file checksums).

## Export formats

* `csv/` one UTF-8 CSV per table (header row, LF, RFC 4180 quoting, rows in primary-key order); `json/` one JSON array per table with the same columns; `sql/schema.sql` the schema read from the live database; `sql/seed.sql` the data as INSERT statements in parent-before-child order.
* Sensitive-looking identifiers are masked: PAN, Aadhaar and document numbers keep only their last four characters; keyed hashes are replaced by a SHA-256 fingerprint that preserves equality; owner dates of birth keep only the year.
* `checksums.txt` lists the SHA-256 of every file in three sections: the operational dataset, the ground truth and its measurement, and documentation / run reports.

## What is in the schema, and what is not

* This package was built from the database as it is after the Phase 6 migration `20261107090000_phase6_settings_and_decisions`, so `sql/schema.sql` contains the unique index `OnboardingDecision_one_final_per_customer` (at most one Approved or Rejected decision per customer) and the check `OnboardingDecision_reason_check` (a decision needs a reason). Every exported row satisfies both.
* The database has one more table, `SystemSetting` (the expiry-alert settings of the application and their change history). It is application configuration, not KYC data: it is **not exported** and **not in `schema.sql`** (nor its sequence, index and two helper functions). The generated databases hold no rows in it.

## Known limitations

* Synthetic data has no real-world validity. Nothing in this package has been externally verified, and **no claim of regulatory compliance is made**: the KYC rules are illustrative.
* The detector and the injection were written by the same team, so the high detection scores on planted cases do not predict accuracy on real data.
* The EXPIRED_DOCUMENT_MARKED_VALID rule additionally requires that the Verified decision was recorded after the expiry date; documents verified while valid and expired later are ordinary and are not flagged (see `edge_case_rules.md`).
* A Closed case without resolution notes can only exist because the check constraint `ReviewCase_resolution_notes_check` is absent in this dataset database (the shipped `schema.sql` reflects that).
* About a quarter of mandatory documents are missing: the fixed document total is lower than "every customer submitted everything". This is derived from the data, not a random percentage.
* Uploaded files do not exist: documents carry file metadata only. The generator fills `name_on_document` (a legitimate variant of the registered name, or a planted mismatch) and the `OnboardingDecision` history; since Phase 6 the application can also capture and show both, but this package contains generated records only.
* Identical checksums require the same encryption and hash keys in `.env` for the *internal* encrypted columns; the exported files contain only masked values and fingerprints derived from them, so the keys must also match for the fingerprints to repeat.
* Stored exceptions and alerts describe the valid baseline; after the edge cases were planted they were not recomputed.

