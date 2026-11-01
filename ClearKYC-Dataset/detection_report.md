# Detection report

Seed 20261022 - scale full - reference date 2026-10-31

## Summary

| Measure | Value |
|---|---:|
| Total planted issues | 310 |
| Total detected issues | 310 |
| True positives | 310 |
| False positives | 0 |
| False negatives | 0 |
| True negatives | 59,396 |
| Precision | 100.00% |
| Recall | 100.00% |
| F1 score | 100.00% |
| Detection rate | 100.00% |

## Results by issue type

| Issue type | Planted | Detected | TP | FP | FN | TN | Precision | Recall | F1 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| APPROVED_WITH_MISSING_EVIDENCE | 50 | 50 | 50 | 0 | 0 | 1,265 | 100.00% | 100.00% | 100.00% |
| CLOSED_WITHOUT_RESOLUTION | 50 | 50 | 50 | 0 | 0 | 371 | 100.00% | 100.00% | 100.00% |
| DOCUMENT_NAME_MISMATCH | 70 | 70 | 70 | 0 | 0 | 19,930 | 100.00% | 100.00% | 100.00% |
| DOCUMENT_REUSED_ACROSS_CUSTOMERS | 40 | 40 | 40 | 0 | 0 | 16,930 | 100.00% | 100.00% | 100.00% |
| EXPIRED_DOCUMENT_MARKED_VALID | 60 | 60 | 60 | 0 | 0 | 19,940 | 100.00% | 100.00% | 100.00% |
| OWNERSHIP_OVER_100 | 40 | 40 | 40 | 0 | 0 | 960 | 100.00% | 100.00% | 100.00% |

## Missed issues (false negatives)

None: every planted issue was detected.

## False positives

None: nothing was flagged that was not planted.

## How to read this

- Precision = TP / (TP + FP); Recall = TP / (TP + FN); F1 = 2 x Precision x Recall / (Precision + Recall); Detection rate = detected planted issues / planted issues x 100. A zero denominator gives 0.
- True negatives = evaluated records of that issue type (see populations_for_true_negatives) minus TP, FP and FN.
- The answer key was read only by this script, after detection had finished. It did not change the detector results.
- Detection of EXPIRED_DOCUMENT_MARKED_VALID requires the Verified decision to be recorded after the expiry date. Documents that expired after a correct verification are ordinary and are not planted issues; see documentation/edge_case_rules.md.