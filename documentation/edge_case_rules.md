# Edge Cases, Ground Truth and Detection (Phase 3)

This document explains the six deliberately planted KYC errors, the answer key, the independent detector and how detection is measured. Everything is synthetic.

## 1. The idea in one picture

```
 valid baseline  ->  plant labelled errors  ->  answer key (separate file)
 (Phase 2 data)      (seed 20261022)              dataset/ground_truth.json
                           |
                           v
                  edge-case database ----> independent detector ----> dataset/detection_results.json
                  clearkyc_<scale>_edge     (reads records only)                  |
                                                                                   v
                              evaluation script (the only reader of the answer key) -> detection_report.json / .md
```

| Command | What it does |
|---|---|
| `npm run inject:edge-cases -- --scale=full` | Makes sure a valid baseline exists (`clearkyc_<scale>`, generated if missing), proves the detector finds nothing in it, copies it to `clearkyc_<scale>_edge`, plants the issues and writes `ground_truth.json` + `edge_case_manifest.json` |
| `npm run detect:anomalies -- --scale=full` | Runs the six rules on the edge database, writes `detection_results.json`. Never opens the answer key |
| `npm run evaluate:detection -- --scale=full` | Compares detections with the answer key, writes `detection_report.json` / `.md` |
| `npm run edge-cases:workflow -- --scale=full` | All three in order |
| `npm run label:existing` | Task 8: labels the anomalies already planted in the development database (read-only) |
| `npm run test:edge-cases` | The Phase 3 tests |

Scales: `starter`, `medium`, `full` (planted issues: 12 / 56 / 310). `--seed`, `--reference-date`, `--dataset-dir` and `--source-database` / `--database` can be overridden. The development database `clearkyc` is never used: the baseline and edge databases must be separate databases named `clearkyc_...`.

## 2. What was added to the schema (migration `20261106090000_phase3_edge_case_support`, additive)

* `Document.name_on_document` (nullable text): the name written on the document. Documents created before this migration keep `NULL` and are simply skipped by the name rule.
* `OnboardingDecision` (new, insert-only): `customer_id`, `decision` (Approved / Rejected / Pending Review), `decided_by_id`, `decided_at`, `notes`. The newest row is the current decision. Only an active Reviewer or Admin can approve or reject (database trigger). This gives "customer approved" a meaning that can be audited against the documents that existed **at the time**.

The baseline generator now also writes both (every document records the name on it; every customer has a Pending Review entry and about 16% of customers, those whose mandatory evidence was complete, are approved). Because of this the full baseline checksum changed to `cad33cb85dfc7967aebdb2292a12c209` and it now has 127 validation checks (all pass).

## 3. The six issue types

Every planted issue gets an ID (`ISSUE-000001` ...), a type, the affected record (business ID), the related customer, a severity, the injection method and the rule expected to find it. The planted counts at full scale are in brackets.

### 3.1 `EXPIRED_DOCUMENT_MARKED_VALID` (60), HIGH

* **Planted:** a currently valid, Verified document gets new dates so that it had **already expired when it was submitted**, and stays Verified. Only `issue_date` and `expiry_date` of that document change; the verification history is not touched.
* **Detection rule:** `expiry_date < reference date` AND the newest verification is `Verified` AND **that Verified decision was recorded after the expiry date**.
* **Why the third condition (a deliberate difference from the literal rule in the brief).** The brief's rule is `expiryDate < referenceDate AND latestVerificationStatus = VERIFIED`. In this dataset 601 documents match that literal rule, but 541 of them were verified **while valid** and expired later. That is an ordinary lifecycle state: the Verified decision was correct on the day it was made, the application already reports the document as Expired (never as valid evidence) and raises an "expired" exception. Flagging them would report 541 correct records as errors. Only documents that a reviewer verified after they had expired (60) are errors. The detection output records both numbers.
* **Isolation:** documents of customers who already have an approval are never chosen, because changing their evidence would invalidate the approval and plant a second, unlabelled error. (An early version did exactly that; the first starter run showed one false positive, which led to this rule.)

### 3.2 `APPROVED_WITH_MISSING_EVIDENCE` (50), HIGH

* **Planted:** a new "Approved" decision is added for a customer whose file was incomplete at that moment, with every other mandatory document verified. Variants: `missing_document` (38, one mandatory type never submitted) and `unverified_document` (12, submitted but still Pending / In Review). Only a decision row is added; no document is changed.
* **Detection rule:** for every customer whose current decision is Approved, rebuild the situation **on the decision date**: the risk level then in force (newest assessment on or before the decision), the mandatory requirements of that type and level whose effective window contains the date (a decision before the first requirement set is judged against that first set), and for each required type whether a document had been submitted, was Verified at that moment and had not expired. Any failure flags the customer.
* **What it does not do:** it does not use today's completeness. A document that expired after a correct approval does not make the approval wrong (the dataset contains 541 such cases), and a document verified after the approval does not repair it.

### 3.3 `OWNERSHIP_OVER_100` (40), HIGH

* **Planted:** the beneficial owners of a company add up to more than 100%. `extra_owner` (28) adds a new owner with 5-25%; `inflate_share` (12) raises the smallest owner's share by 5-20 points and the ownership bridge keeps the old share as a closed history row. Original owners are never removed. The recorded ownership checks are insert-only history and are not rewritten.
* **Detection rule:** `SUM(ownership_percentage) > 100` over a company's owner rows, in exact decimal arithmetic.

### 3.4 `CLOSED_WITHOUT_RESOLUTION` (50), MEDIUM

* **Planted:** an ordinary Closed review case has its resolution notes erased. Status, closed date and case history are untouched, and nothing repairs the record afterwards. The entity ID is the review code (for example `REV-CUS-000050-2026`).
* **Why this needs a relaxed constraint:** the database normally refuses this state (`ReviewCase_resolution_notes_check`). The check is dropped **only in the isolated edge database** and the manifest says so; the baseline and the development database keep it. The tests assert this.
* **Detection rule:** status Closed, closed date present, resolution notes empty after trimming.

### 3.5 `DOCUMENT_REUSED_ACROSS_CUSTOMERS` (40), HIGH

* **Planted:** a later document carries the document number (and stored file) of an earlier document of another customer with no ownership link (`copy_number`, 32), or only the stored file reference (`copy_file`, 8). The earlier document is the original and is not touched; the copy is the planted issue.
* **Detection rule:** documents are grouped by document-number hash (per document type) and by stored file. In a group spanning several customers the earliest document is the original and each later one is flagged, **unless** the sharing is explained by context: both customers are companies with a common beneficial owner **and** the type is one a group can share (address proof, bank statement, ownership details, financial statements - see `detector/config/detectionRules.js`). A PAN, certificate of incorporation or photograph is never legitimately shared.
* **Legitimate look-alikes:** 20 pairs of related companies share an address proof in the full dataset. They are not in the answer key and are not flagged.

### 3.6 `DOCUMENT_NAME_MISMATCH` (70), MEDIUM

* **Planted:** the name on a document is replaced by a clearly different name: same surname, different first name (32, the "Amit Sharma" / "Rahul Sharma" example), a different person (32), or a different company (6).
* **Detection rule:** the configurable comparison in `detector/nameMatcher.js` (settings in `detector/config/nameMatching.js`):
  * `mode: 'exact'` accepts only an identical string; `mode: 'normalized'` (default) first normalises capitals, punctuation, accents, titles (Mr, Shri ...), company legal forms (Pvt Ltd = Private Limited), word order, initials (A. Sharma = Amit Sharma), a missing middle name and a small spelling difference (similarity at least 0.8).
  * Only a name that is still different after that is reported, as a **potential** mismatch "for manual review (not confirmed fraud)".
  * A legitimate change of name (marriage, a company rename) cannot be told apart from a different person by text alone; such a case is also flagged for review, which is the intended behaviour.
* **Legitimate look-alikes:** about 5,100 of the 20,000 baseline documents carry a legitimate variant of the registered name. At full scale the comparison classified them as EXACT 14,912, NORMALIZED 3,786, INITIALS 871, SIMILAR 361 and MISMATCH 70 (exactly the planted ones).

## 4. Existing anomalies (Task 8)

The Phase 2 baseline contains **no** deliberate errors by design (127 checks prove it, and the detector finds nothing in it). The anomalies planted earlier live in the **development database** `clearkyc`, created by the scene seed scripts. `npm run label:existing` inspects it read-only and writes `dataset/existing_dataset_labels.json` (33 labels with `LEGACY-` IDs, kept apart from `ground_truth.json`): ownership above 100% (2, scenario OVER_100), ownership below 100% (1), companies without owners (2), expired documents still Verified (10), rejected documents (7), documents requiring resubmission (7), overdue periodic reviews (3) and one case closed while its issue persists. Each label names the seed scenario and script that planted it. Ordinary workflow conditions (pending documents, upcoming reviews, potential screening matches under review) are not labelled. Only the types for which one of the six rules exists are marked `covered_by_detector`.

## 5. Measurement

* **Evaluation unit:** one record plus one issue type. A repeated detection of the same pair counts once; the same record can be right for one issue type and wrong for another.
* **TP** planted and detected; **FN** planted and missed; **FP** detected but not planted; **TN** = the records the rule could have flagged (population) minus TP, FP and FN. Populations: all documents (expired rule), customers with a current Approved decision, companies with owners, Closed cases, documents with a number or file, documents with a captured name.
* **Precision** = TP / (TP + FP), **Recall** = TP / (TP + FN), **F1** = 2PR / (P + R), **Detection rate** = detected planted / planted x 100. A zero denominator gives 0, never NaN.
* The evaluation reads the answer key only after detection has finished and never changes detector results.

### Result at full scale (seed 20261022)

310 planted, 310 detected: TP 310, FP 0, FN 0, TN 59,396; precision, recall, F1 and detection rate all 100%. Per type and the (empty) lists of missed issues and false positives are in `dataset/detection_report.md`. Starter and medium scales also give 100%.

**How much weight to give a perfect score.** The same person designed the injection and the detector, and every rule is deterministic, so a perfect score on planted cases is expected and is not evidence that the detector would find real-world errors. What the run does show: the rules do not fire on the 541 documents that expired after a correct verification, the 5,000 legitimate name variants, the 20 legitimately shared documents or the 1,265 correct approvals; the baseline is clean; and the results are reproducible. The one real finding during development was a false positive caused by an injection side effect (section 3.1), caught by this measurement.

## 6. Separation of the answer key

* `ground_truth.json`, `edge_case_manifest.json` and `existing_dataset_labels.json` are files in `dataset/`. There is no table or column holding labels in any database, and no API or frontend code refers to them (tested).
* The `detector/` folder never mentions or reads them and does not import the generator (tested statically). It also runs with an empty dataset directory (tested). Its timestamps are the end of the reference day, so its output is byte-identical between runs.
* The only reader of `ground_truth.json` is `evaluation/evaluateDetection.js`.

## 7. Reproducibility

Seed 20261022 drives every choice (a random stream per issue type). Running the injection again from the same baseline gives an identical answer key, an identical list of changes and an identical modified database (checksum `7a66138fc96d16d970e83818748536fd` at full scale); another seed plants different records. The detector gives identical results on identical data. Tested at starter scale and re-verified at full scale.

## 8. Known limitations

* The score is for the six rules on planted cases of the kinds listed; it says nothing about error types that were not planted.
* The `EXPIRED_DOCUMENT_MARKED_VALID` rule is deliberately narrower than the literal wording of the brief (section 3.1).
* `CLOSED_WITHOUT_RESOLUTION` can exist only where the database guard is removed; that is why the edge database is separate.
* Names written on documents are synthetic; there is no real document or OCR. A legitimate change of name is flagged for review like any other mismatch.
* After planting, the stored exceptions and alerts of the edge database are not recomputed (they still describe the baseline); the independent detector reads the records themselves.
* Approvals exist only in the Phase 3 baseline; the user interface does not show them yet.
