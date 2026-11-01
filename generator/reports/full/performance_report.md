# Performance report - scale full

Seed 20261022, reference date 2026-10-31, batch size 1000, database clearkyc_full. Total 112.08 s.

| Entity | Records | Generate (s) | Insert (s) | Total (s) | Records/sec | Errors |
|---|---:|---:|---:|---:|---:|---:|
| Reference data | 34 | 0.01 | 0.00 | 0.01 | 6,800 | 0 |
| Customers | 8,000 | 7.79 | 0.00 | 7.79 | 1,026 | 0 |
| BeneficialOwners | 2,194 | 1.81 | 0.00 | 1.81 | 1,214 | 0 |
| RiskRatings | 9,000 | 0.63 | 0.00 | 0.63 | 14,331 | 0 |
| Documents + Verifications | 69,307 | 7.73 | 0.00 | 7.73 | 8,968 | 0 |
| OnboardingDecisions | 9,419 | 0.18 | 0.00 | 0.18 | 50,914 | 0 |
| Schedules + Exceptions + Cases | 26,812 | 1.40 | 0.00 | 1.40 | 19,220 | 0 |
| Alerts | 14,076 | 0.25 | 0.00 | 0.25 | 56,758 | 0 |
| AuditEvents | 139,968 | 0.85 | 0.00 | 0.85 | 164,089 | 0 |
| CustomerType | 2 | 0.00 | 0.00 | 0.00 | - | 0 |
| Reviewer | 7 | 0.00 | 0.03 | 0.03 | 250 | 0 |
| KYCRequirement | 25 | 0.00 | 0.01 | 0.01 | 2,083 | 0 |
| Customer | 8,000 | 0.00 | 2.93 | 2.93 | 2,730 | 0 |
| BeneficialOwner | 2,194 | 0.00 | 1.29 | 1.29 | 1,696 | 0 |
| CompanyOwnership | 2,194 | 0.00 | 0.00 | 0.00 | - | 0 |
| OwnerScreening | 4,388 | 0.00 | 0.78 | 0.78 | 5,655 | 0 |
| OwnershipValidation | 1,000 | 0.00 | 0.15 | 0.15 | 6,667 | 0 |
| Document | 20,000 | 0.00 | 6.24 | 6.24 | 3,207 | 0 |
| Verification | 49,307 | 0.00 | 6.83 | 6.83 | 7,216 | 0 |
| RiskRating | 9,000 | 0.00 | 5.66 | 5.66 | 1,591 | 0 |
| OnboardingDecision | 9,419 | 0.00 | 1.30 | 1.30 | 7,218 | 0 |
| ReviewSchedule | 8,342 | 0.00 | 1.79 | 1.79 | 4,671 | 0 |
| Exception | 15,470 | 0.00 | 4.13 | 4.13 | 3,743 | 0 |
| ReviewCase | 3,000 | 0.00 | 1.26 | 1.26 | 2,372 | 0 |
| CaseHistory | 9,635 | 0.00 | 1.26 | 1.26 | 7,617 | 0 |
| CaseNote | 2,326 | 0.00 | 0.25 | 0.25 | 9,157 | 0 |
| Alert | 14,076 | 0.00 | 5.27 | 5.27 | 2,670 | 0 |
| AuditEvent | 139,968 | 0.00 | 34.85 | 34.85 | 4,016 | 0 |
| ID sequences + counters | 1 | 0.00 | 0.00 | 0.67 | 1 | 0 |
| Post-generation validation | 1 | 0.00 | 0.00 | 8.77 | 0 | 0 |
| Checksums | 1 | 0.00 | 0.00 | 4.15 | 0 | 0 |

Failed records: 0