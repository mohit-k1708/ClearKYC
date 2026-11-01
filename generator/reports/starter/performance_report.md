# Performance report - scale starter

Seed 20261022, reference date 2026-10-31, batch size 1000, database clearkyc_starter. Total 5.67 s.

| Entity | Records | Generate (s) | Insert (s) | Total (s) | Records/sec | Errors |
|---|---:|---:|---:|---:|---:|---:|
| Reference data | 34 | 0.00 | 0.00 | 0.00 | 8,500 | 0 |
| Customers | 50 | 0.04 | 0.00 | 0.04 | 1,429 | 0 |
| BeneficialOwners | 38 | 0.03 | 0.00 | 0.03 | 1,357 | 0 |
| RiskRatings | 67 | 0.02 | 0.00 | 0.02 | 3,190 | 0 |
| Documents + Verifications | 512 | 0.12 | 0.00 | 0.12 | 4,267 | 0 |
| OnboardingDecisions | 62 | 0.01 | 0.00 | 0.01 | 12,400 | 0 |
| Schedules + Exceptions + Cases | 186 | 0.04 | 0.00 | 0.04 | 5,167 | 0 |
| Alerts | 102 | 0.01 | 0.00 | 0.01 | 14,571 | 0 |
| AuditEvents | 1,088 | 0.01 | 0.00 | 0.01 | 72,533 | 0 |
| CustomerType | 2 | 0.00 | 0.00 | 0.00 | - | 0 |
| Reviewer | 7 | 0.00 | 0.01 | 0.01 | 467 | 0 |
| KYCRequirement | 25 | 0.00 | 0.02 | 0.02 | 1,563 | 0 |
| Customer | 50 | 0.00 | 0.03 | 0.03 | 1,515 | 0 |
| BeneficialOwner | 38 | 0.00 | 0.04 | 0.04 | 844 | 0 |
| CompanyOwnership | 38 | 0.00 | 0.00 | 0.00 | - | 0 |
| OwnerScreening | 76 | 0.00 | 0.03 | 0.03 | 2,714 | 0 |
| OwnershipValidation | 17 | 0.00 | 0.01 | 0.01 | 1,545 | 0 |
| Document | 152 | 0.00 | 0.09 | 0.09 | 1,617 | 0 |
| Verification | 360 | 0.00 | 0.10 | 0.10 | 3,564 | 0 |
| RiskRating | 67 | 0.00 | 0.08 | 0.08 | 798 | 0 |
| OnboardingDecision | 62 | 0.00 | 0.02 | 0.02 | 2,952 | 0 |
| ReviewSchedule | 54 | 0.00 | 0.03 | 0.03 | 2,000 | 0 |
| Exception | 117 | 0.00 | 0.06 | 0.06 | 1,828 | 0 |
| ReviewCase | 15 | 0.00 | 0.02 | 0.02 | 652 | 0 |
| CaseHistory | 46 | 0.00 | 0.02 | 0.02 | 2,556 | 0 |
| CaseNote | 9 | 0.00 | 0.01 | 0.01 | 1,286 | 0 |
| Alert | 102 | 0.00 | 0.07 | 0.07 | 1,500 | 0 |
| AuditEvent | 1,088 | 0.00 | 0.30 | 0.30 | 3,615 | 0 |
| ID sequences + counters | 1 | 0.00 | 0.00 | 0.04 | 22 | 0 |
| Post-generation validation | 1 | 0.00 | 0.00 | 0.69 | 1 | 0 |
| Checksums | 1 | 0.00 | 0.00 | 0.07 | 14 | 0 |

Failed records: 0