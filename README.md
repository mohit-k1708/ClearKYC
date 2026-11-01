# ClearKYC - KYC onboarding evidence, completeness, reviews and expiries

ClearKYC tracks the evidence a bank or fintech needs to onboard customers, checks that it is complete, and manages periodic reviews and
document expiries. It exposes the decisions and exceptions, keeps a permanent audit trail, and ships with a reproducible synthetic dataset.
**All data is synthetic**; there is no real personal data, and PEP / sanctions screening is simulated.

## What it does (features)

| Area | What you can do |
|---|---|
| Customers | Register Individuals and Companies; unique IDs (`CUS-000001`); PAN / Aadhaar encrypted and shown masked; rule-based risk rating with recorded reasons |
| Documents and verification | Add documents with issue / expiry dates; reviewer decisions kept as insert-only history; expired documents never count as valid; name on the document compared with the registered name (a mismatch is flagged, never auto-rejected) |
| KYC completeness | Requirements by customer type and risk level; completeness percentage and exceptions per customer |
| Beneficial ownership and risk | Owners per company with percentage validation (below / exactly / above 100%); simulated PEP and sanctions screening; the same person across several companies; risk assessments with history |
| Onboarding decisions | Approve or reject with a reason; final and never overwritten; open Critical / High exceptions block approval unless a Reviewer waives them with a recorded reason; Medium / Low need a follow-up action |
| Exceptions, cases and reviews | Detected exceptions, review cases with assignment, notes, approvals and timeline, periodic reviews, detection as a background job with progress |
| Alerts and expiry settings | Alerts at configurable lead times (default 90 / 60 / 30 / 7 days; change them on the Expiry Alert Settings screen) |
| Audit, analytics, reporting | Immutable audit trail written in the same transaction as each change, dashboards and analytics, 34 data-quality checks, masked CSV / JSON / SQL exports |
| Synthetic dataset | 8,000 customers, 20,000 documents, 1,000 companies, 3,000 review cases; labelled edge cases with a separate answer key; independent detector; validation; reproducibility proof; packaged in `ClearKYC-Dataset/` |

Stack: React 18 + React Router + Tailwind CSS v4 + Axios + React Hook Form (Vite) · Node.js + Express · PostgreSQL 17 + Prisma 6 · JavaScript only.

> **Authentication is simulated.** The "Acting as" selector in the sidebar chooses a demo person (Analyst, Reviewer or Admin) and sends it as the
> `X-Reviewer-Id` header. The server enforces what each role may do, but nobody is logged in and the header is trusted. A real deployment needs real login.

## Required software

| Software | Version | Needed for |
|---|---|---|
| Node.js | **20 or newer** (developed and tested with 24.18.1) | everything |
| npm | 10 or newer (tested with 10.8.1) | everything |
| PostgreSQL | **17**. Not required to install: `npm run db:local` starts a bundled copy (`embedded-postgres`: npm installs the binary for your platform, data in `.pgdata/`; **tested on Windows only**). You can use your own PostgreSQL 17 instead | database |
| Google Chrome | any recent version (set `CHROME_PATH` if it is not at `C:/Program Files/Google/Chrome/Application/chrome.exe`) | `npm run test:browser` only |
| Disk / memory | about 1 GB free; the full dataset database needs about 130 MB and the generator about 550 MB of memory | dataset generation |

Commands in this file are written for Windows PowerShell; they work the same in other shells except `copy` (use `cp`). The browser-test runner uses `taskkill`, so it is Windows-oriented.

---

## 1. Set up and run it (from the project folder)

### 1.1 Install

```powershell
npm install                  # backend dependencies at the root (also generates the Prisma client)
npm --prefix client install  # the React app
npm run db:generate          # only if you see "@prisma/client did not initialize yet"
```

### 1.2 Configure the environment

```powershell
copy .env.example .env       # (macOS / Linux: cp .env.example .env)
```

Then open `.env` and replace the two placeholder keys with your own random values (64 hexadecimal characters each). Run this twice, once per key:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

| Variable | Meaning |
|---|---|
| `DATABASE_URL` | PostgreSQL connection. The default points at the bundled database on port 5433 |
| `LOCAL_PG_PORT` | Port used by `npm run db:local` (default 5433) |
| `PORT` | API port (default 4000) |
| `CORS_ORIGIN` | Address of the website (default http://localhost:5173) |
| `ENCRYPTION_KEY` | Encrypts PAN, Aadhaar, document numbers and owner dates of birth. Losing it makes them unreadable |
| `HASH_KEY` | Keyed hashes for duplicate detection. Changing it breaks duplicate detection and owner matching for existing rows |
| `UPLOAD_DIR` | Optional folder for uploaded files (default `server/uploads`) |

`.env` is git-ignored and must never be committed. `.env.example` holds placeholders only.

### 1.3 Database setup and migrations

```powershell
npm run db:local             # terminal A: starts PostgreSQL (leave it running); creates the database "clearkyc"
npm run db:migrate           # terminal B: applies every migration in prisma/migrations (prisma migrate deploy)
```

`db:migrate` only adds what is missing and never deletes data. **`npm run db:reset` deletes everything in the database named in `DATABASE_URL`**: use it only on a database you can lose.
Each migration lives in `prisma/migrations/<name>/migration.sql`; the Phase 6 one also has a `rollback.sql` (Prisma has no automatic rollback; see `docs/phase6-features.md`).

Optional demo data (50 customers with documents, owners, cases and alerts; same seed gives the same data). **Each command with `--reset` empties the tables it fills**, so run them on a new database:

```powershell
npm run generate:customers -- --reset
npm run generate:kyc -- --reset
npm run generate:ownership -- --reset
npm run generate:reviews -- --reset
npm run generate:scene5 -- --reset
```

### 1.4 Start the backend and the frontend

```powershell
npm run dev                  # backend API, http://localhost:4000  (auto-restarts on change; "npm start" runs it once)
npm run client               # frontend, http://localhost:5173  (second terminal)
```

Open **http://localhost:5173** (use `localhost`, not `127.0.0.1`). Health check: http://localhost:4000/api/health should answer `{"status":"ok"}`.

**Using your own PostgreSQL instead?** Skip `npm run db:local`, create an empty database, set
`DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/clearkyc"` in `.env`, then continue with `npm run db:migrate`.

### 1.5 Tests and the production build

```powershell
npm test                     # all backend tests (node:test) on the dedicated database "clearkyc_test", created and seeded automatically
npm run test:browser         # browser tests (headless Chrome) on a throw-away copy of the app (API 4100, web 5174) and the same test database
npm --prefix client run build   # production build of the frontend into client/dist
npm run verify:package       # independent checks of the packaged dataset in ClearKYC-Dataset/
```

Both test commands need the database running (`npm run db:local`). They use `clearkyc_test` only and **never touch your development database**; the browser runner rebuilds `clearkyc_test` at the start of every run (about 10 minutes for all scripts).
Other helpers: `npm run test:db:reset` (rebuild the test database), `npm run test:browser -- --serve` (start the test copy of the app with sample data for a demo, http://localhost:5174), `npm run db:backup` / `db:backups` / `db:restore`, `npm run db:studio`.

### 1.6 Verify the key workflows by hand

Choose a person under **Acting as** in the sidebar first (a Reviewer such as *Asha Reviewer* for decisions and settings, an Analyst such as *Vikram Analyst* for data entry).

1. **Register and rate.** Customers → Add Customer → Individual. The profile shows the generated ID, masked PAN / Aadhaar and the risk rating with its reasons.
2. **Evidence and completeness.** Documents → Add Document for that customer (PAN, Address Proof, Photograph); KYC Completeness shows 0%. As a Reviewer open Verification Review and verify each document: 33.3%, 66.7%, 100%. Every decision stays in the document history.
3. **Name on the document.** Add a document with a name different from the customer's: it shows "Name differs" in the list, details and review screens; it is flagged, not rejected.
4. **Ownership.** Register a Company, add owners with 60% and 40% (Reconciled), then 20% more (flagged "above 100%"). Open an owner → "All companies of this person".
5. **Exceptions and the approval policy.** Exceptions & Issues → Run detection (progress is shown). Open the customer profile → Onboarding decision: Critical / High exceptions block approval (a Reviewer can waive each with a reason), Medium / Low need a follow-up action, evidence can never be waived. Approve or reject; the decision is final.
6. **Expiry settings.** Expiry Alert Settings → try `7, 30` (refused: must be largest to smallest), save `120, 45, 10`, then Alerts → Refresh alerts; restore with "Use defaults".
7. **Audit trail.** As a Reviewer open Audit Trail and find the steps above, including the waiver.

### 1.7 Documentation map

| Where | What |
|---|---|
| `docs/requirements-traceability.md` | every requirement, where it lives, the test that checks it |
| `docs/submission-readiness.md` | test results, dataset package facts, setup and demo steps, known limitations, decisions |
| `docs/phase6-features.md` | onboarding decisions and approval policy, name check, owner view, expiry settings, detection job, policy review |
| `docs/DOCUMENTATION.md`, `docs/SCENE2.md` ... `SCENE5.md`, `docs/UI_REDESIGN.md` | how each part of the application works |
| `documentation/` | dataset documentation: data dictionary, relationships, ID rules, edge cases, source manifest |
| `ClearKYC-Dataset/` | the packaged dataset (CSV, JSON, SQL, answer key, reports, checksums) |
| `dataset/` | the results of the last dataset run (answer key, detection and validation reports) |
| `docs/ai-prompts/` | the prompts given to the AI assistant that built the project, in order, with an index |

---

## 2. Project structure and what each file does

```
.env / .env.example        Settings: DATABASE_URL, ports, ENCRYPTION_KEY, HASH_KEY (.env is git-ignored)
package.json               Backend scripts + dependencies
prisma/
  schema.prisma            The database schema (3 tables)
  migrations/*_init/       SQL that creates the tables PLUS the Customer ID sequence and CHECK constraints
  seed.js                  Idempotent seed of the two customer types
scripts/
  localPostgres.js         Starts the self-contained local PostgreSQL (data in .pgdata/)
  generateCustomers.js     Seeded synthetic data generator
server/src/
  server.js                Starts listening on PORT
  app.js                   Express app: CORS, JSON parsing, routes, error handlers
  config/env.js            Reads + validates .env (fails fast if keys are missing)
  config/riskRules.js      ALL risk points, lists and thresholds (the documented prototype assumptions)
  config/options.js        Countries, business activities, occupation suggestions
  routes/index.js          URL -> controller mapping
  controllers/             Thin HTTP layer: validate request, call a service, send JSON
  services/customerService.js   Registration (ID + save + first risk rating in one transaction), list, profile
  services/riskService.js       Pure rule engine + simulated screening
  services/dashboardService.js  Dashboard counts straight from the database
  middleware/errorHandler.js    One JSON error format; maps DB-down to 503
  middleware/asyncHandler.js    Forwards async errors to the error handler
  utils/validation.js      zod schemas for both forms (format rules)
  utils/crypto.js          AES-256-GCM encryption + HMAC "blind index" for duplicate detection
  utils/mask.js            PAN / Aadhaar masking
  utils/errors.js, prisma.js    Error type, shared Prisma client
server/tests/              unit.test.js (rules, crypto) + api.test.js (real API + database)
client/src/
  main.jsx, App.jsx        Entry point and route table
  components/              Layout (sidebar), Toast, RegistrationForm + inputs, ui.jsx (badges, pagination, spinner...)
  pages/                   Dashboard, CustomerDirectory, CustomerTypeSelection, IndividualForm, CompanyForm, CustomerProfile
  services/api.js          All Axios calls + friendly error conversion
  hooks/                   useAsync (loading/error), useDebounce, useMeta, useRegistration (submit logic)
  utils/                   validators.js (form rules), format.js
```

---

## 3. Database schema

Table and column names follow the specification. Prisma field names are camelCase and mapped to snake_case columns.

**CustomerType** - `id` PK, `type_name` (unique; CHECK in `Individual`/`Company`). Seeded with 1 = Individual, 2 = Company.

**Customer**
| Column | Notes |
|---|---|
| `id` | PK |
| `customer_id` | Business ID `CUS-000001`. UNIQUE, format CHECK, immutable (trigger) |
| `customer_type_id` | FK -> CustomerType (RESTRICT) |
| `full_name`, `email`, `phone`, `address`, `country` | NOT NULL. Country is an ISO code (`IN`) |
| `pan_number`, `aadhaar_number` | **AES-256-GCM encrypted** at application level. Aadhaar only for individuals |
| `pan_hash`, `aadhaar_hash` | *Added column.* HMAC-SHA256 blind index so the database can enforce UNIQUE (duplicate detection) without plaintext |
| `date_of_birth`, `occupation` | Individuals only |
| `company_registration_number` (UNIQUE), `business_activity`, `date_of_incorporation` | Companies only |
| `registration_status` | `Registered` (default) / `Pending Review` / `Closed`. Onboarding status only, **not** KYC completeness |
| `created_at`, `updated_at` | Timestamps |

A CHECK constraint (`Customer_type_fields_check`) guarantees an Individual row has DOB + Aadhaar and no company fields, and a Company row has registration number + activity + incorporation date and no personal fields.

**RiskRating** - `id` PK, `customer_id` FK -> Customer (CASCADE), `risk_score` (CHECK 0-100), `risk_level` (CHECK Low/Medium/High),
`risk_reasons` JSONB, `assessment_date`, `assessment_method` (e.g. `RULES_V1_PROTOTYPE`), `created_at`.
A customer can have many ratings over time; the newest is the "current" rating.

**Customer ID generation**: the migration creates the sequence `customer_code_seq` and the SQL function `next_customer_code()`.
The backend calls it inside the registration transaction. A sequence is concurrency-safe and never hands out a number twice,
so IDs are not reused after deletion or rollback (gaps are possible; reuse is not). If a ID conflict is ever reported the
backend retries up to 3 times, then returns `503 CUSTOMER_ID_CONFLICT`.

---

## 4. API

All responses are JSON. Success: `{ data, pagination? }`. Failure: `{ error: { code, message, details? } }`.

| Method & path | Purpose |
|---|---|
| `POST /api/customers` | Register. Body: `{ "customerType": "Individual" \| "Company", ...fields }`. Returns `201` with the created customer (masked identifiers, current risk). |
| `GET /api/customers?page=1&pageSize=10&search=&type=&risk=` | Paginated list (`pageSize` max 100). `search` matches name or Customer ID (case-insensitive, partial). `type` = Individual/Company, `risk` = Low/Medium/High. |
| `GET /api/customers/:id` | Profile by `CUS-000001` (or numeric id) with current risk, reasons, simulated screening and earlier assessments. |
| `GET /api/dashboard/summary` | `totalCustomers, individualCustomers, companyCustomers, lowRiskCustomers, mediumRiskCustomers, highRiskCustomers`. |
| `GET /api/meta` | Countries, business activities, occupation suggestions, risk-model version/thresholds (used by the forms). |
| `GET /api/health` | Liveness check. |

Individual fields: `fullName, dateOfBirth (YYYY-MM-DD), email, phone, address, panNumber, aadhaarNumber, occupation, country`.
Company fields: `legalName, registrationNumber, panNumber, email, phone, address, country, businessActivity, dateOfIncorporation`.

| Situation | Response |
|---|---|
| Missing/invalid fields, invalid PAN/Aadhaar/email/phone | `400 VALIDATION_ERROR` with `details: { field: message }` |
| Same PAN, Aadhaar or company registration number again (including double-click races) | `409 DUPLICATE_CUSTOMER` (+ `existingCustomerId`) |
| Unknown customer | `404 NOT_FOUND` |
| Database down | `503 DATABASE_UNAVAILABLE` |
| Customer ID could not be allocated | `503 CUSTOMER_ID_CONFLICT` |
| Anything else | `500 INTERNAL_ERROR` (no internals leaked) |

---

## 5. Validation rules (format only)

- Name, address, occupation / company name, registration number: required.
- Email: `name@domain.tld`. Phone: 10-digit Indian mobile (`+91`/`91`/`0` prefix optional, starts 6-9) or `+<country code><number>`; stored normalised.
- **PAN**: `AAAAA9999A` (5 letters, 4 digits, 1 letter). The 4th letter must be `P` for individuals; for companies one of `C F H A T B L J G` (configurable in `utils/validation.js`).
- **Aadhaar**: exactly 12 digits (spaces/dashes ignored).
- Date of birth: valid, not in the future, age 18+. Date of incorporation: valid, not in the future.

**These checks do not prove a PAN or Aadhaar is genuine or belongs to the customer.** Verification against the issuing authority is not part of Scene 1, and the UI says so.

---

## 6. Risk classification (PROTOTYPE ASSUMPTIONS - not regulatory rules)

Defined in `server/src/config/riskRules.js`; edit that one file to change the rules. `score = sum of matching points, capped at 100`.

| Level | Score |
|---|---|
| Low | 0-29 |
| Medium | 30-59 |
| High | 60-100 |

| Factor | Points |
|---|---|
| Customer type | Individual +5, Company +15 |
| Country | India 0; other country +10; "elevated" list +25 (AF, NG, VE, YE, PK); "high" list +40 (IR, KP, SY, MM) |
| Business activity (companies) | 0-30 by industry, e.g. IT 0, Real estate +20, Crypto/Casinos/Money services +30 |
| Occupation (individuals) | Jeweller/bullion +15, real estate +10, self-employed/business/trader +5 |
| **PEP indicator (simulated)** | +30 for a fictional-list name match or a political/government occupation keyword |
| **Sanctions screening (simulated)** | +40 for a name on the fictional list |
| Other | Individual under 21 +5; company incorporated within 365 days +10 |

- The country lists are **illustrative**, not an official jurisdiction rating.
- **Screening is simulated** against a fictional list in `riskRules.js`. Results are labelled "Simulated" in the API and UI.
- A potential PEP/sanctions match **never rejects** a customer: it adds points and sets `requiresManualReview`.
- Every assessment stores its reasons (`factor, description, points, simulated`) in `RiskRating.risk_reasons`.
- Risk is independent of KYC completeness (not implemented in this scene).

---

## 7. Security notes

- PAN and Aadhaar are encrypted with AES-256-GCM using `ENCRYPTION_KEY` (from the environment, never in code). API responses only return masked values (`XXXXXX234F`, `XXXX XXXX 9012`). Logs never contain submitted values.
- `HASH_KEY` powers the duplicate-detection hashes. Changing it breaks duplicate detection for existing rows; losing `ENCRYPTION_KEY` makes stored identifiers unreadable.
- `.env.example` contains **placeholder keys only**. Generate your own for anything beyond a local demo. `.env` is git-ignored.
- All seed/test PAN and Aadhaar values are random synthetic values (PANs start with `Z` or `QTE`). They only follow the format and are not checked against any registry.

---

## 8. Synthetic data

```powershell
npm run generate:customers                              # 50 customers, seed 20261022
npm run generate:customers -- --count=5000              # larger set
npm run generate:customers -- --reset                   # wipe customers, restart IDs at CUS-000001, then generate
npm run generate:customers -- --count=200 --seed=7 --reset
npm run generate:customers -- --dry-run                 # preview only
```

Same seed + `--reset` => identical customers and identical IDs (verified). Risk levels come from the same rule engine as the API.
Without `--reset` new customers are appended and IDs continue from the current sequence value.

---

## 9. Test results (final build)

| What | Result |
|---|---|
| Backend: `npm test` (unit, API and database tests for all scenes, the dataset pipeline and the Phase 6 / approval-policy features) | **320 / 320 passed** |
| Browser: `npm run test:browser` (9 scripts: customers, documents, ownership and risk, review cases, alerts / audit / reports, navigation, overview, Phase 6 features, approval policy) | **357 / 357 checks passed** |
| Dataset validation (8,000-customer dataset) | 182 checks: 179 passed, 3 passed with expected (planted) exceptions, 0 failed, 0 unexpected |
| Reproducibility (the whole pipeline run twice, same seed) | **REPRODUCIBLE: PASS**, 308,971 records per run, 51 file checksums equal |
| Package checks: `npm run verify:package` and `npm run verify:checksums` | 15 / 15 and 65 files verified |
| Clean-environment run (a fresh copy set up from this file, own database server, fresh keys) | backend 307 / 307, browser 330 / 330, production build and health check passed (before the approval policy was added) |

Full details and how each number was produced: `docs/submission-readiness.md`.

---

## 10. Known limitations

- **No real authentication.** The "Acting as" selector is a prototype stand-in (see the note at the top). Roles are enforced, the caller is not authenticated.
- Risk rules, review intervals and country lists are prototype assumptions; PEP / sanctions screening is simulated against a fictional list. No regulatory compliance is claimed.
- PAN / Aadhaar are format-checked only; there is no verification against NSDL / UIDAI or any registry.
- Keys come from `.env`. Production would use a secrets manager with key rotation; there is no rotation here.
- Customers cannot be edited or deleted in the UI. `registration_status` is always `Registered`.
- Detection jobs are kept in the memory of one API process (forgotten on restart); the full detection sweep takes about 78 s at 8,000 customers.
- Owners without a date of birth are not matched across companies. A follow-up action on an approval is recorded, not scheduled.
- Uploaded files are stored on local disk (`server/uploads`, git-ignored). The bundled `embedded-postgres` is for development only.
- **Keep the project out of OneDrive if you can.** During development files inside `node_modules` (including the embedded PostgreSQL binaries) disappeared once while the project sat in a OneDrive folder.
- Browser tests are timing-sensitive; a single "frame detached" crash is a browser glitch, re-run it.

---

## Scene 2: Document Management & Verification

KYC requirements, documents with optional file upload, a manual verification workflow with immutable history,
missing/expired detection and a server-calculated KYC completeness percentage are documented in
**[docs/SCENE2.md](docs/SCENE2.md)** (run commands, rules, schema changes, API, files, test results, limitations).

Quick start after the Scene 1 steps above:

```powershell
npm install
npm run db:migrate
npm run generate:kyc -- --reset
```

Verification is a simulated manual review, not an external identity check. Use synthetic data only.

---

## Scene 3: Risk Assessment & Beneficial Ownership

Beneficial owners of company customers, ownership validation, owner screening records (synthetic outcomes), an overall
customer risk model that uses owner risk, and a permanent risk assessment history are documented in
**[docs/SCENE3.md](docs/SCENE3.md)** (run commands, rules, schema changes, API, files, test results, limitations).

Quick start after the Scene 1 and Scene 2 steps above:

```powershell
npm install
npm run db:migrate
npm run generate:ownership -- --reset
```

Risk rules are illustrative prototype assumptions. Screening is synthetic. A potential match is never treated as confirmed,
and nothing rejects a customer automatically.

## Scene 4: Review Cases & Exception Management

Exception detection from the real Scene 1 to 3 records, review cases with a role-based workflow and compliance approval,
a permanent case timeline, and periodic KYC reviews are documented in **[docs/SCENE4.md](docs/SCENE4.md)** (run commands,
demo users, rules, schema changes, API, files, test results, limitations).

Quick start after the Scene 1 to 3 steps above:

```powershell
npm install
npm run db:migrate
npm run generate:reviews -- --reset
```

Choose a person under **Acting as** in the sidebar (an analyst such as Vikram, or a reviewer such as Asha) to see the
actions each role may take. Review intervals and severities are illustrative assumptions. A potential sanctions or PEP
match is investigated, never auto-confirmed.

## Scene 5: Audit History, Alerts, Analytics & Final Reporting

An immutable audit trail written in the same transaction as each change, alerts derived from the real records, analytics calculated
from the database, 34 read-only data quality checks, and masked CSV/JSON/SQL exports are documented in
**[docs/SCENE5.md](docs/SCENE5.md)** (run commands, roles, rules, schema changes, API, files, test results, sample output, limitations).

Quick start after the Scene 1 to 4 steps above:

```powershell
npm install
npm run db:migrate
npm run generate:scene5 -- --reset --as-of=2026-10-22
```

Choose a Compliance Reviewer (for example Asha) under **Acting as** to open the Audit Trail, run Data Quality checks and export every report.

---

## Synthetic KYC dataset (Phases 2-4)

The project can also generate, validate, export and package a complete synthetic KYC dataset (8,000 customers, 20,000 documents, 3,000 review cases, six kinds of planted errors with an answer key and an independent detector). It never touches the development database. See `documentation/README.md` for every command; the one-command workflow is `npm run dataset:all -- --scale=full`, which writes `ClearKYC-Dataset/` (verify with `npm run verify:checksums`).
