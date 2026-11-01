# Final detection summary

Seed 20261022 - scale full - reference date 2026-10-31 - **PASS**

| Measure | Value |
|---|---:|
| Planted issues | 310 |
| Detected | 310 |
| True positives | 310 |
| False positives | 0 |
| False negatives | 0 |
| True negatives | 59,396 |
| Precision | 100.00% |
| Recall | 100.00% |
| F1 score | 100.00% |
| Detection rate | 100.00% |

## By issue type

| Issue type | Planted | TP | FP | FN |
|---|---:|---:|---:|---:|
| APPROVED_WITH_MISSING_EVIDENCE | 50 | 50 | 0 | 0 |
| CLOSED_WITHOUT_RESOLUTION | 50 | 50 | 0 | 0 |
| DOCUMENT_NAME_MISMATCH | 70 | 70 | 0 | 0 |
| DOCUMENT_REUSED_ACROSS_CUSTOMERS | 40 | 40 | 0 | 0 |
| EXPIRED_DOCUMENT_MARKED_VALID | 60 | 60 | 0 | 0 |
| OWNERSHIP_OVER_100 | 40 | 40 | 0 | 0 |

## Integrity checks

* PASS: Every planted issue was evaluated (planted = detected planted + missed)
* PASS: The evaluation report matches an independent recomputation from the raw files
* PASS: The answer key was not modified after it was written (SHA-256 matches the manifest)
* PASS: The detector source does not read the answer key or import the generator
* PASS: The saved detection results carry no answer-key fields
* PASS: Running the detector again gives exactly the saved results (nothing was altered)
* PASS: Every false positive has been reviewed
* PASS: Every missed issue is listed

## Missed issues

None.

## False positives and their review

None - nothing was flagged that was not planted.

Answer key SHA-256: `9fa719194b772de86df77c721f5a4967c6b0b81c3dd254d0f0b6defdadbe84dd`

The metrics of a rule-based detector on cases planted by the same authors are expected to be high. They show that the rules find what they were built for and do not fire on the legitimate look-alikes; they do not predict accuracy on real data.
