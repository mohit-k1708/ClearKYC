# Scene 3: Risk Assessment & Beneficial Ownership

Scene 3 adds beneficial ownership for company customers, ownership validation, owner screening records, an overall
customer risk model that uses owner risk, and a permanent risk assessment history. Scenes 1 and 2 keep working: they
read the newest risk assessment as before.

> **Prototype rules, synthetic screening.** Every point value, band and trigger is an illustrative prototype assumption,
> not a regulatory standard (`server/src/config/ownershipRules.js`). Screening outcomes are synthetic. Nothing connects to
> a real sanctions or PEP database. A potential match is never treated as confirmed, and nothing rejects a customer
> automatically. Use synthetic data only.

## 1. Run it

Scene 1 and 2 steps still apply. Then, once:

```powershell
npm install
npm run db:migrate                         # applies the Scene 3 migration
npm run generate:ownership -- --reset      # owners, screenings, ownership checks and risk assessments
```

Start the servers as before (`npm run db:local`, `npm run dev`, `npm run client`) and open http://localhost:5173.
`npm test` runs every test file one after another (the database must be running).

If you ever rebuild all data from scratch, run these in order: `npm run generate:customers -- --reset`,
`npm run generate:kyc -- --reset`, `npm run generate:ownership -- --reset`. The Scene 1 reset also empties the Scene 2
and Scene 3 tables and restarts the `CUS-` and `RSK-` numbering.

## 2. What the analyst can do

| Page (sidebar) | Route | What it does |
|---|---|---|
| Overview (dashboard) | `/` | Five new cards: business customers, beneficial owners, ownership issues, high-risk customers, customers requiring manual review |
| Ownership Management | `/ownership` | Company customers with owner count, total ownership, status and current risk. Search by company ID, company name or owner name |
| Company ownership | `/ownership/:customerId` | Validation message, ownership structure bar, owners table, recorded ownership checks |
| Add or edit owner | `/ownership/owners/new`, `/ownership/owners/:id/edit` | The beneficial owner form (company customers only) |
| Beneficial owner details | `/ownership/owners/:id` | Owner details, **Owner Risk Assessment**, screening history, record a screening |
| Customer Risk Summary | `/risk/:customerId` | Customer risk, ownership validation and KYC completeness as three separate cards, reasons, run a new assessment |
| Risk Assessment History | `/risk-history` | Every assessment with filters. Expand a row for reasons and how the score was built |
| Customer profile (Scene 1) | `/customers/:id` | New **Beneficial ownership** section (companies) and **Risk and ownership assessment** section |

**Acting as (sidebar).** As in Scene 2 there is no login. The person chosen in the sidebar is sent as `X-Reviewer-Id`:
- any active person can add or edit owners and record an ownership check;
- only a **Reviewer or Admin** can record a screening outcome or run a risk assessment. An Analyst gets a clear refusal (403).

This is a stand-in for real authentication: the header can be spoofed by anyone who can call the API.

## 3. Business rules

### 3.1 Ownership validation

Percentages are added in basis points (hundredths of a percent), so 33.33 + 33.33 + 33.34 is exactly 100.

| Situation | Status | Message |
|---|---|---|
| No owners recorded | `NO_OWNERS` | Add the owners, or record why none can be identified |
| Total above 100% | `EXCEEDS_100` | **Invalid ownership total** |
| Total exactly 100% | `RECONCILED` | **Ownership reconciled** |
| Total below 100% | `BELOW_100` | **Ownership information incomplete**, with the unaccounted amount. A total below 100% is not proof of wrongdoing. It needs investigation or an explanation |
| An owner has no percentage | `MISSING_PERCENTAGE` | The total cannot be reconciled |

- Above 100% wins over a missing percentage.
- A percentage must be greater than 0 and at most 100, with at most 2 decimals. The database enforces this too.
- Possible duplicate owners: the same normalised name with the same or an unknown date of birth is refused (409). Two owners with the same name and different known birth dates are two people.
- Owners can only be added to **company** customers (400 `NOT_A_COMPANY` for an individual, and a database trigger).
- A recorded ownership check (`OwnershipValidation`) is a permanent record. The page shows when owners changed since the last one.

### 3.2 Owner risk (illustrative scoring)

| Indicator | Points |
|---|---|
| Confirmed PEP | 3 |
| Possible PEP match, or declared PEP not yet confirmed | 2 (needs review) |
| High-risk country (residence or nationality) | 2 |
| Elevated-risk country | 1 |
| **Potential** sanctions match | 3 (needs investigation, **not a confirmed match**) |
| Sanctions match recorded as **Confirmed** after investigation | 6 (escalate, still no automatic rejection) |
| Missing mandatory owner information (counted once per owner) | 1 |

Bands: 0-2 Low, 3-5 Medium, 6 or more High. Mandatory information is date of birth, country of residence, nationality,
ownership percentage, and a known PEP status.

**Screening states are four distinct things:** Confirmed, Potential Match, No Match, and **Not Screened** (no record yet,
never stored as a value). A screening is either a synthetic outcome the Reviewer chooses, or a **simulated list match**
that compares the owner's name with a small **fictional** list and can only ever produce Potential Match or No Match.
Points are calculated by the server from the rules, never taken from the request.

### 3.3 Ownership complexity

The structure is complex (2 points) if any of these hold: an owner holds indirectly, there are 5 or more owners, owners
live in 3 or more countries, or control is exercised by "other means of control".

### 3.4 Overall customer risk

```
score = baseline + owner uplift + complexity uplift + validation uplift      (capped at 100)

baseline            the Scene 1 rules re-run on the customer's profile (not the previous rating, so nothing compounds)
owner uplift        5 per owner point of the highest-risk owner only
complexity uplift   5 x 2 points when the structure is complex      (owner + complexity together capped at 40)
validation uplift   Exceeds 100%: 15   Below 100%: 10   Missing percentage: 10   No owners: 10   Reconciled: 0
level               Low below 30, Medium 30-59, High 60 or more   (the Scene 1 thresholds)
```

Only the highest-risk owner counts, so many clean owners add no risk and one risky owner is not diluted.

**Requires Manual Review** is separate from the score band. It is set when any of these apply: a potential or confirmed
sanctions match, a potential, confirmed or declared PEP, ownership that exceeds, falls below or cannot be reconciled to
100% (or no owners), a complex structure, or a potential match on the customer's own name in Scene 1's simulated
screening. A review is not a rejection: the customer stays registered. The assessment keeps `risk_level` (Low, Medium or
High) and a separate `assessment_status` (`Completed` or `Requires Manual Review`).

### 3.5 Three separate measures

| Measure | Question | Where |
|---|---|---|
| **KYC completeness** (Scene 2) | Are the required documents present and valid? | `/kyc/:id` |
| **Customer risk** | What is the customer's risk? | `/risk/:id` |
| **Ownership validation** | Is the ownership structure reconciled? | `/ownership/:id` |

Documents never change the risk score, and risk changes never change completeness (both are tested). A customer can be 100%
KYC complete and High risk, or Low risk with missing documents. The summary shows all three side by side.

**Effect on Scene 2:** Scene 2 selects required documents by the customer's *current* risk level. When a new assessment
changes that level, the required documents change with it, and completeness is recalculated.

### 3.6 History

Every assessment is a **new** `RiskRating` row with an ID (`RSK-000001`), the previous level, the new level, the score, the
reasons, the date and who assessed it. Scene 1's onboarding rating is the first row (assessed by "System"). An assessment
that would change nothing is refused (409 `NO_CHANGE`) unless you choose to record it anyway. The database blocks
UPDATE and DELETE on `RiskRating`, `OwnerScreening` and `OwnershipValidation`, so history cannot be rewritten.

## 4. Database changes

Migration `*_scene3_ownership_risk`.

| Table | Purpose |
|---|---|
| `BeneficialOwner` (new) | `customer_id` FK to a company, `full_name`, `date_of_birth` (**encrypted**), `country_of_residence`, `nationality`, `ownership_percentage` (nullable = missing), `ownership_type` (Direct/Indirect), `control_type`, `pep_status` (declared), `notes`, `identity_hash` (duplicate detection), `created_by_id`, `updated_by_id`. CHECKs on percentage (> 0 and <= 100), types and country codes. UNIQUE (customer, identity hash). Trigger: company customers only |
| `OwnerScreening` (new) | `beneficial_owner_id` FK, `screening_type` (PEP/Sanctions), `screening_result` (Confirmed/Potential Match/No Match), `risk_points`, `remarks`, `source`, `screened_by_id`, `screened_at`. Insert-only. Remarks required for any match |
| `OwnershipValidation` (new) | `customer_id` FK, `total_ownership_percentage`, `owner_count`, `validation_status`, `validation_message`, `checked_by_id`, `checked_at`. Insert-only |
| `RiskRating` (extended) | New: `assessment_code` (RSK-000001, database default from a sequence), `previous_risk_level`, `assessed_by_id` FK, `assessment_status`. Existing rows were back-filled. Insert-only from now on |

Relationships: Company 1-* BeneficialOwner, BeneficialOwner 1-* OwnerScreening, Customer 1-* RiskRating, Company 1-*
OwnershipValidation. Deleting a customer cascades to its owners, screenings, checks and ratings (this is the only way those
rows can be deleted). Scene 1's `Low/Medium/High` constraint is unchanged, which is why "Requires Manual Review" is a status.
The date of birth is encrypted at application level, lists show only the birth year, and the full date is returned only on the owner's own detail endpoint.

## 5. API

Responses are `{ data, pagination? }` or `{ error: { code, message, details? } }`.

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/customers/:customerId/beneficial-owners` | anyone | Owners, validation result, complexity |
| `POST /api/customers/:customerId/beneficial-owners` | active person | Add an owner. 400 `NOT_A_COMPANY`, 409 `DUPLICATE_OWNER` |
| `GET /api/beneficial-owners/:id` | anyone | Owner with full date of birth, risk indicators and screenings |
| `PUT /api/beneficial-owners/:id` | active person | Edit an owner |
| `GET /api/customers/:customerId/ownership-validation` | anyone | Live result, last recorded check, history |
| `POST /api/customers/:customerId/ownership-validation` | active person | Record the current result as a new check |
| `POST /api/beneficial-owners/:id/screening` | Reviewer or Admin | Record a screening (`mode`: `manual` or `simulated`) |
| `GET /api/beneficial-owners/:id/screening` | anyone | Screening history and current status ("Not Screened" when none) |
| `POST /api/customers/:customerId/risk-assessments` | Reviewer or Admin | Record a new assessment. 409 `NO_CHANGE` unless `force` |
| `GET /api/customers/:customerId/risk-assessments` | anyone | This customer's history, newest first |
| `GET /api/risk-assessments` | anyone | Paginated history: `search`, `riskLevel`, `status`, `customerType`, `customerId`, `from`, `to`, `page`, `pageSize` |
| `GET /api/customers/:customerId/risk-summary` | anyone | Customer risk, "if assessed now", ownership validation and KYC completeness as separate blocks |
| `GET /api/risk-assessments/:id` | anyone | One assessment by `RSK-000001` |
| `GET /api/ownership/overview` | anyone | Company list for the Ownership Management page (search by company or owner) |
| `GET /api/ownership/options` | anyone | Form values and the documented rules |
| `GET /api/dashboard/risk-summary` | anyone | The five dashboard counts |

Status codes: 400 validation, 401 nobody chosen or inactive, 403 role not allowed, 404 not found, 409 duplicate or no change.

## 6. Synthetic data

`npm run generate:ownership -- --reset` (seed `20261022`, up to 30 companies, `--limit` and `--seed` available). It runs the
same service code as the API, so records are exactly what the application would create, and risk results are **calculated**,
never assigned. Each company gets one of nine scenarios (a block of nine covers all of them): ownership exactly 100%, above 100%,
below 100%, no owners, a low-risk owner, a high-risk owner (confirmed PEP, high-risk country, missing nationality), a potential
PEP match, a potential sanctions match (a name on the fictional list), and a complex structure (six owners, indirect holdings, four countries).
Each story has two stages (owners added, then screening recorded), so the history shows a change. For the 50-customer set
it created 40 owners, 80 screenings and 32 assessments, and the rules calculated 12 reconciled, 2 above 100%, 1 below 100% and 2 with no owners,
with 13 customers requiring manual review. The same seed gives identical owners, percentages, screenings, RSK ids, scores, levels and statuses (verified by fingerprinting).
Assessment dates are the real time of the run, because the database does not allow back-dating.

## 7. Files

**Created (backend):** `config/ownershipRules.js`, `services/ownershipEngine.js`, `ownershipService.js`, `screeningService.js`,
`riskAssessmentService.js`, `controllers/ownershipController.js`, `riskController.js`, `routes/ownership.js`,
`middleware/requireActor.js`, `utils/ownershipValidation.js`, `prisma/migrations/*_scene3_ownership_risk`,
`scripts/generateOwnershipData.js`, `server/tests/ownership.engine.test.js`, `ownership.api.test.js`.

**Created (frontend):** `services/ownershipApi.js`, `components/riskUi.jsx`, `OwnershipRiskSections.jsx`, `RiskCards.jsx`, and the pages
`OwnershipManagementPage`, `CompanyOwnershipPage`, `BeneficialOwnerFormPage`, `BeneficialOwnerDetailsPage`, `CustomerRiskPage`, `RiskHistoryPage`.

**Changed (additive):** `prisma/schema.prisma`, `routes/index.js` (mounts the Scene 3 router), `middleware/requireReviewer.js` (neutral
wording), `scripts/generateCustomers.js` (`--reset` also empties the Scene 3 tables and restarts `RSK-` numbering),
`package.json` (`generate:ownership`), client `kycUi.jsx` (customer picker can be limited to one customer type), `Layout.jsx`,
`App.jsx`, `DashboardPage.jsx`, `CustomerProfilePage.jsx`.

## 8. Test results

| What | Result |
|---|---|
| `npm test`: Scene 1 (28) + Scene 2 (39) + Scene 3 engine unit tests (24) + Scene 3 API and database tests (23) | **114 / 114 passed** |
| Scene 3 browser run in headless Chrome (dashboard cards, search, filters, add and edit owners, validation messages, duplicate refusal, screening and authorisation, assessment, history, profile sections, mobile widths) | **43 / 43 passed** |
| Scene 2 browser run and Scene 1 browser run, repeated after the changes | **36 / 36** and **20 / 20 passed** |
| Seed reproducibility (same seed twice, a different seed, a re-run without `--reset`) | Identical, different, and refused with a message |

Covered by tests: adding owners to a company; refusing owners for an individual (API and database); ownership totals above, at
and below 100%, no owners and missing percentages (including Companies A, B and C from the brief); duplicates; owner and
overall risk scores; potential versus confirmed screening; "Not Screened"; manual review without rejection; history preserved
and immutable; documents not affecting risk and risk not affecting completeness; Scene 1 and Scene 2 behaviour afterwards.

## 9. Limitations

- **No real authentication.** "Acting as" is a stand-in with a spoofable header.
- Rules, country lists and complexity thresholds are prototype assumptions. Screening outcomes are synthetic and no real list is consulted.
- Beneficial owners cannot be deleted in the UI. An edit replaces the owner's data without keeping a version. Each assessment keeps a snapshot of the owners it used.
- Indirect ownership is recorded as a label. Ownership chains are not followed or multiplied through intermediate entities.
- Only the highest-risk owner counts toward the customer score. A different policy is a change in `ownershipRules.js` and `ownershipEngine.js`.
- Assessments are run on request. Nothing reassesses automatically (the summary flags when one is recommended).
- Seeded assessment dates are the time of the run, not spread across past months.
- A new assessment can change a customer's risk level and therefore their Scene 2 required documents.
- Ownership "issues" on the dashboard counts every company that is not reconciled, including companies that simply have no owners recorded yet.
