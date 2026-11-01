# Performance report - scale full

Seed 20261022, reference date 2026-10-31, batch size 1000, database clearkyc_full. Total 132.83 s.

| Entity | Records | Generate (s) | Insert (s) | Total (s) | Records/sec | Errors |
|---|---:|---:|---:|---:|---:|---:|
| Reference data | 34 | 0.00 | 0.00 | 0.00 | 11,333 | 0 |
| Customers | 8,000 | 5.78 | 0.00 | 5.78 | 1,383 | 0 |
| BeneficialOwners | 2,194 | 0.86 | 0.00 | 0.86 | 2,542 | 0 |
| RiskRatings | 9,000 | 0.49 | 0.00 | 0.49 | 18,330 | 0 |
| Documents + Verifications | 69,231 | 5.90 | 0.00 | 5.90 | 11,730 | 0 |
| Schedules + Exceptions + Cases | 26,812 | 1.22 | 0.00 | 1.22 | 21,977 | 0 |
| Alerts | 14,076 | 0.19 | 0.00 | 0.19 | 74,084 | 0 |
| AuditEvents | 130,478 | 0.68 | 0.00 | 0.68 | 191,598 | 0 |
| CustomerType | 2 | 0.00 | 0.00 | 0.00 | - | 0 |
| Reviewer | 7 | 0.00 | 0.01 | 0.01 | 538 | 0 |
| KYCRequirement | 25 | 0.00 | 0.01 | 0.01 | 2,083 | 0 |
| Customer | 8,000 | 0.00 | 2.35 | 2.35 | 3,401 | 0 |
| BeneficialOwner | 2,194 | 0.00 | 0.83 | 0.83 | 2,628 | 0 |
| CompanyOwnership | 2,194 | 0.00 | 0.00 | 0.00 | - | 0 |
| OwnerScreening | 4,388 | 0.00 | 0.85 | 0.85 | 5,181 | 0 |
| OwnershipValidation | 1,000 | 0.00 | 0.13 | 0.13 | 7,463 | 0 |
| Document | 20,000 | 0.00 | 8.04 | 8.04 | 2,489 | 0 |
| Verification | 49,231 | 0.00 | 8.40 | 8.40 | 5,860 | 0 |
| RiskRating | 9,000 | 0.00 | 7.27 | 7.27 | 1,238 | 0 |
| ReviewSchedule | 8,342 | 0.00 | 1.88 | 1.88 | 4,433 | 0 |
| Exception | 15,470 | 0.00 | 7.05 | 7.05 | 2,193 | 0 |
| ReviewCase | 3,000 | 0.00 | 2.18 | 2.18 | 1,377 | 0 |
| CaseHistory | 9,625 | 0.00 | 2.00 | 2.00 | 4,805 | 0 |
| CaseNote | 2,341 | 0.00 | 0.37 | 0.37 | 6,344 | 0 |
| Alert | 14,076 | 0.00 | 18.23 | 18.23 | 772 | 0 |
| AuditEvent | 130,478 | 0.00 | 40.64 | 40.64 | 3,210 | 0 |
| ID sequences + counters | 1 | 0.00 | 0.00 | 0.88 | 1 | 0 |
| Post-generation validation | 1 | 0.00 | 0.00 | 9.22 | 0 | 0 |
| Checksums | 1 | 0.00 | 0.00 | 3.64 | 0 | 0 |

Failed records: 0