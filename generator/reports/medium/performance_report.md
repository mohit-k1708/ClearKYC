# Performance report - scale medium

Seed 20261022, reference date 2026-10-31, batch size 1000, database clearkyc_medium. Total 17.58 s.

| Entity | Records | Generate (s) | Insert (s) | Total (s) | Records/sec | Errors |
|---|---:|---:|---:|---:|---:|---:|
| Reference data | 34 | 0.00 | 0.00 | 0.00 | 8,500 | 0 |
| Customers | 1,000 | 0.93 | 0.00 | 0.93 | 1,081 | 0 |
| BeneficialOwners | 273 | 0.21 | 0.00 | 0.21 | 1,300 | 0 |
| RiskRatings | 1,125 | 0.09 | 0.00 | 0.09 | 12,931 | 0 |
| Documents + Verifications | 8,688 | 0.97 | 0.00 | 0.97 | 8,929 | 0 |
| OnboardingDecisions | 1,185 | 0.05 | 0.00 | 0.05 | 24,184 | 0 |
| Schedules + Exceptions + Cases | 3,252 | 0.24 | 0.00 | 0.24 | 13,273 | 0 |
| Alerts | 1,679 | 0.04 | 0.00 | 0.04 | 45,378 | 0 |
| AuditEvents | 17,073 | 0.12 | 0.00 | 0.12 | 138,805 | 0 |
| CustomerType | 2 | 0.00 | 0.00 | 0.00 | - | 0 |
| Reviewer | 7 | 0.00 | 0.02 | 0.02 | 438 | 0 |
| KYCRequirement | 25 | 0.00 | 0.02 | 0.02 | 1,471 | 0 |
| Customer | 1,000 | 0.00 | 0.38 | 0.38 | 2,653 | 0 |
| BeneficialOwner | 273 | 0.00 | 0.13 | 0.13 | 2,150 | 0 |
| CompanyOwnership | 273 | 0.00 | 0.00 | 0.00 | - | 0 |
| OwnerScreening | 546 | 0.00 | 0.10 | 0.10 | 5,747 | 0 |
| OwnershipValidation | 125 | 0.00 | 0.02 | 0.02 | 5,208 | 0 |
| Document | 2,500 | 0.00 | 0.84 | 0.84 | 2,983 | 0 |
| Verification | 6,188 | 0.00 | 0.81 | 0.81 | 7,649 | 0 |
| RiskRating | 1,125 | 0.00 | 0.68 | 0.68 | 1,647 | 0 |
| OnboardingDecision | 1,185 | 0.00 | 0.21 | 0.21 | 5,537 | 0 |
| ReviewSchedule | 1,053 | 0.00 | 0.22 | 0.22 | 4,765 | 0 |
| Exception | 1,899 | 0.00 | 0.57 | 0.57 | 3,308 | 0 |
| ReviewCase | 300 | 0.00 | 0.13 | 0.13 | 2,326 | 0 |
| CaseHistory | 956 | 0.00 | 0.14 | 0.14 | 6,829 | 0 |
| CaseNote | 214 | 0.00 | 0.03 | 0.03 | 7,643 | 0 |
| Alert | 1,679 | 0.00 | 0.68 | 0.68 | 2,473 | 0 |
| AuditEvent | 17,073 | 0.00 | 4.09 | 4.09 | 4,169 | 0 |
| ID sequences + counters | 1 | 0.00 | 0.00 | 0.11 | 9 | 0 |
| Post-generation validation | 1 | 0.00 | 0.00 | 1.60 | 1 | 0 |
| Checksums | 1 | 0.00 | 0.00 | 0.50 | 2 | 0 |

Failed records: 0