# ClearKYC Scene 1 - Complete Documentation

This document explains **what every part of the project is, how it works, why it was chosen, and how data
flows** from the browser to the database and back. It is written for a beginner MERN developer.
(For run commands only, see `README.md`.)

Contents

1. What the project does (big picture)
2. Key words you need to know
3. Technologies used and why
4. Architecture and folder map
5. The main flow: registering a customer (step by step)
6. The other flows (list, profile, dashboard, startup)
7. Database in detail
8. Backend in detail (file by file)
9. Frontend in detail (file by file)
10. Security design
11. Risk engine in detail
12. Validation in detail
13. Error handling
14. Synthetic data generator
15. Tests
16. How to change things (recipes)
17. Troubleshooting
18. Limitations

---

## 1. What the project does

A bank or finance company must "know its customer" (**KYC**) before doing business. **Scene 1** is the first step:
an **Operations Analyst** registers a new customer. The system:

1. Lets the analyst choose **Individual** or **Company**.
2. Shows the matching form and checks every field.
3. Creates a unique ID like `CUS-000001` (made by the backend, never by the browser).
4. Encrypts the PAN and Aadhaar numbers.
5. Calculates an **initial risk rating** (Low / Medium / High) from written rules and records the reasons.
6. Saves the customer and the rating in PostgreSQL.
7. Shows the customer in a searchable directory, a profile page and dashboard counts.

Not included (later scenes): document verification, beneficial ownership, review cases, alerts, audit, login.

---

## 2. Key words

| Word | Meaning |
|---|---|
| **KYC** | Know Your Customer: identity checks a financial firm must do. |
| **PAN** | Indian tax number, format `AAAAA9999A`. The 4th letter shows holder type (`P` person, `C` company...). |
| **Aadhaar** | Indian 12-digit identity number. |
| **PEP** | Politically Exposed Person (e.g. a minister). Higher corruption risk, so needs extra care. Not an automatic rejection. |
| **Sanctions** | Official lists of banned people/companies. |
| **Risk score / level** | Number 0-100 from rules, converted to Low / Medium / High. |
| **Simulated** | Fake demo screening against an invented list, never real data. |
| **REST API** | The backend offers URLs (`GET /api/customers`) that the frontend calls and gets JSON back. |
| **ORM (Prisma)** | A library that lets JavaScript talk to the database without writing all the SQL by hand. |
| **Migration** | A versioned SQL file that creates/changes tables so every machine gets the same database. |
| **Transaction** | A group of database steps that all succeed or all fail together. |
| **Sequence** | A database counter that hands out increasing numbers safely, even with many users at once. |
| **Encryption** | Scrambling data with a secret key so only the key holder can read it. |
| **Masking** | Showing only part of a value (`XXXX XXXX 9012`). |
| **Blind index** | A keyed hash of a value, used to find duplicates without storing the readable value. |
| **Validation** | Checking that input has the right shape before accepting it. |

---

## 3. Technologies used, and why

### Frontend

| Tool | What it is | Why it is used here |
|---|---|---|
| **React 18** | UI library, builds pages from components | Required by the spec; components (badges, forms) are reused across pages. |
| **Vite** | Dev server + bundler | Starts instantly, hot-reloads on save, and its `proxy` forwards `/api` to the backend so there are no CORS problems in development. |
| **React Router 6** | Page navigation without reloading | Gives separate URLs for each page (`/customers`, `/customers/CUS-000001`) and lets filters live in the URL. |
| **Tailwind CSS 4** | Utility CSS classes | Fast consistent styling and responsive layout with no separate CSS files. Shared styles (`.btn`, `.input`, `.card`) are in `index.css`. |
| **Axios** | HTTP client | Simple API calls, timeouts, and the error body from the server is easy to read. |
| **React Hook Form** | Form state + validation | Fast forms, per-field errors, no re-render on every keystroke, easy to show server errors under fields. |

### Backend

| Tool | What it is | Why |
|---|---|---|
| **Node.js** | JavaScript runtime | Same language as the frontend. |
| **Express 4** | Web framework | Minimal, the standard for REST APIs in MERN. |
| **zod** | Schema validation library | Describes allowed input once, and gives clear errors; also transforms values (uppercases PAN, normalises phone). |
| **Prisma 6** | ORM | Type-safe queries, schema in one file, migrations built in. Raw SQL is still used where needed (sequence, latest-rating joins). |
| **dotenv** | Loads `.env` | Keeps secrets and settings out of source code. |
| **cors** | Express middleware | Allows the frontend origin to call the API. |
| **node:crypto** (built in) | Cryptography | AES-256-GCM and HMAC without extra packages. |
| **node:test** (built in) | Test runner | No test framework to install. |

### Database

| Tool | Why |
|---|---|
| **PostgreSQL** | Required by the spec. Gives sequences (safe IDs), CHECK constraints, JSONB (risk reasons), foreign keys, and strong transactions. |
| **embedded-postgres** | Runs a real PostgreSQL from `node_modules` with no installer or admin rights. For development only. |

---

## 4. Architecture and folder map

```
 Browser (React app, port 5173)
      |   fetch /api/...        (Vite dev server proxies to port 4000)
      v
 Express API (port 4000)
      |   Prisma client / SQL
      v
 PostgreSQL (port 5433)  ->  files in .pgdata/
```

The backend follows three layers, each with one job:

```
routes       "which URL goes where"
controllers  "read the request, validate it, send the response"   (HTTP only)
services     "the real business logic and database work"          (no HTTP)
```

Keeping HTTP and business logic apart means the data generator and tests reuse the services directly.

```
CLEAR KYC/
  .env                  your real settings and keys (not for sharing)
  .env.example          template of settings
  .gitignore            files git must ignore (node_modules, .env, .pgdata)
  package.json          backend dependencies and npm scripts
  README.md             quick start
  docs/DOCUMENTATION.md this file
  prisma/               database definition
  scripts/              helper programs (local DB, data generator)
  server/               backend (src/ code, tests/ tests)
  client/               frontend
  .pgdata/              the actual database files (created by db:local)
```

---

## 5. The main flow: registering a customer

```
 Analyst           React                 Express                 PostgreSQL
    |                 |                      |                        |
    |-click Add------>|                      |                        |
    |                 |-show 2 type cards    |                        |
    |-pick Individual>|                      |                        |
    |                 |-show form (country list came from /api/meta)  |
    |-fill + submit-->|                      |                        |
    |                 |-1 React Hook Form checks fields (instant)     |
    |                 |  errors? stop, show under fields              |
    |                 |-POST /api/customers->|                        |
    |                 |                      |-2 zod validates+normalises
    |                 |                      |  errors? 400 + messages|
    |                 |                      |-3 duplicate pre-check->|
    |                 |                      |<-found? 409 -----------|
    |                 |                      |-4 encrypt PAN/Aadhaar; compute hashes
    |                 |                      |-5 assess risk (pure code)
    |                 |                      |-6 BEGIN transaction -->|
    |                 |                      |   next_customer_code() |
    |                 |                      |   INSERT Customer      |
    |                 |                      |   INSERT RiskRating    |
    |                 |                      |   COMMIT               |
    |                 |                      |-7 read back, decrypt, MASK
    |                 |<----201 + customer---|                        |
    |                 |-8 toast "Customer ID CUS-000051"              |
    |                 |-9 navigate to /customers/CUS-000051 (profile)  |
```

### Step by step, with the files involved

**Steps in the browser**

1. **Add Customer button** - `AddCustomerButton` in `components/ui.jsx` links to `/customers/new`.
2. **Type selection** - `pages/CustomerTypeSelectionPage.jsx` shows two cards linking to `/customers/new/individual` or `/customers/new/company`.
3. **Form page** - `IndividualFormPage.jsx` / `CompanyFormPage.jsx`. They only describe the fields. The shared frame (`RegistrationForm.jsx`) waits until `/api/meta` (countries, industries) has loaded.
4. **Client validation** - rules in `utils/validators.js` run when a field is touched and again on submit. This is for instant feedback only.
5. **Submit** - `hooks/useRegistration.js`:
   - ignores a second click while one request is in flight (a `useRef` guard) and disables the button,
   - trims all text,
   - calls `createCustomer()` in `services/api.js`.

**Steps in the backend** (`server/src`)

6. **Route** - `routes/index.js`: `POST /api/customers` -> `asyncHandler(createCustomer)`.
7. **Controller** - `controllers/customerController.js`:
   - reads `customerType`, picks `individualSchema` or `companySchema`,
   - `schema.safeParse(fields)`. On failure it throws a 400 with `{ field: message }`. On success the data is *normalised* (PAN uppercase, Aadhaar digits only, phone as `+91...`, dates as Date objects, email lowercase).
8. **Service** - `services/customerService.js` `registerCustomer()`:
   1. **Duplicate pre-check** (`findDuplicate`): computes the blind-index hash of the PAN (and Aadhaar, or company registration number) and looks for an existing customer. Found -> `409 DUPLICATE_CUSTOMER` with the existing Customer ID.
   2. **Build the row** (`toCustomerRow`): encrypts PAN/Aadhaar, computes hashes, maps form names to columns (`legalName` -> `fullName`).
   3. **Risk assessment** (`riskService.assessRisk`): pure function returning score, level and reasons.
   4. **Transaction** (`prisma.$transaction`):
      - `SELECT next_customer_code()` -> `CUS-000051` (from the database sequence),
      - `customer.create(...)`,
      - `riskRating.create(...)` with the reasons stored as JSON.
      Either both rows exist or neither.
   5. **Race protection**: if two identical submissions pass the pre-check at the same time, the database `UNIQUE` constraint rejects the second (Prisma error `P2002`). The code maps it to the same 409. If the ID itself ever collides it retries up to 3 times.
   6. **Response**: `getCustomer()` loads the saved data, decrypts PAN/Aadhaar **only to mask them**, and returns the DTO (data transfer object: the safe shape sent to the browser).
9. **Controller** returns `201 { data: customer }`.

**Back in the browser**

10. `useRegistration` shows a success toast with the Customer ID and navigates to `/customers/<id>` with `state.justRegistered`.
11. `CustomerProfilePage.jsx` fetches the profile and shows the green "Registration complete" banner.
12. If the server returned errors, they are placed under the matching inputs with `form.setError`, and a red banner shows the message (and a link to the existing customer on duplicates).

---

## 6. The other flows

### 6.1 Customer directory (`GET /api/customers`)

```
Typing in search box -> (350 ms pause, useDebounce) -> URL ?search=... -> useAsync refetches
   -> customerController.listCustomers (zod parses page/pageSize/search/type/risk)
   -> customerService.listCustomers: one SQL query with a LATERAL join
   -> { data: [...], pagination: { page, pageSize, totalItems, totalPages } }
```

- **Filters live in the URL** (`?type=Company&risk=High&page=2`). So Back/Forward work, a page can be bookmarked, and dashboard cards link to pre-filtered lists.
- **Search** matches name or Customer ID, case-insensitive and partial. `%` and `_` typed by a user are escaped so they are plain characters.
- **"Current risk"** = the newest `RiskRating` per customer. A `LEFT JOIN LATERAL (... ORDER BY assessment_date DESC LIMIT 1)` fetches it for each customer, so filtering by risk level uses the latest rating and not an old one.
- `useAsync` ignores stale responses, so fast typing never shows results for an older query.

### 6.2 Customer profile (`GET /api/customers/:id`)

`:id` can be `CUS-000001` or the numeric id. The service loads the customer with its type and all ratings (newest first). The newest becomes `currentRisk`, older ones `riskHistory`. Unknown id -> 404, malformed id -> 400.

### 6.3 Dashboard (`GET /api/dashboard/summary`)

One SQL query joins customers to their latest rating and counts with `COUNT(*) FILTER (WHERE ...)`. Numbers are computed live, so they always equal the database. Each card links to the directory with the matching filter.

### 6.4 Startup flow

```
npm run db:local   -> scripts/localPostgres.js: initialise .pgdata (UTF8) if new, start PostgreSQL on 5433, create db "clearkyc"
npm run db:migrate -> Prisma applies prisma/migrations (tables, sequence, constraints, 2 type rows)
npm run dev        -> server.js loads config/env.js (checks keys) -> app.js builds Express -> listen on 4000
npm run client     -> Vite serves React on 5173, proxies /api to 4000
App load           -> main.jsx wraps App in Router + Toast + Meta providers -> MetaProvider calls GET /api/meta once
```

---

## 7. Database in detail

Defined in `prisma/schema.prisma`; created by `prisma/migrations/20261030084217_init/migration.sql`.

### Tables

**CustomerType**: `id`, `type_name`. Rows: 1 = Individual, 2 = Company. One type has many customers.

**Customer** (key columns)

| Column | Why |
|---|---|
| `id` | Internal primary key. |
| `customer_id` | Business ID `CUS-xxxxxx`. UNIQUE. Format CHECK. Immutable by trigger. |
| `customer_type_id` | Foreign key to CustomerType. |
| `full_name` | Person's name or the legal company name (one column for both). |
| `email`, `phone`, `address`, `country` | Common fields. Country stored as code (`IN`). |
| `pan_number`, `aadhaar_number` | Encrypted text. |
| `pan_hash`, `aadhaar_hash` | Blind indexes, UNIQUE, for duplicate detection. |
| `date_of_birth`, `occupation` | Individual only (null for companies). |
| `company_registration_number` (UNIQUE), `business_activity`, `date_of_incorporation` | Company only. |
| `registration_status` | `Registered` / `Pending Review` / `Closed`. This is **onboarding status, not KYC completeness**. |
| `created_at`, `updated_at` | Timestamps. |

**RiskRating**: `id`, `customer_id` (FK -> Customer), `risk_score`, `risk_level`, `risk_reasons` (JSONB), `assessment_date`, `assessment_method`, `created_at`. Many ratings per customer over time.

### Constraints (rules the database itself enforces)

- Primary keys, foreign keys (a rating must point to a real customer; deleting a customer deletes its ratings).
- UNIQUE: `customer_id`, `pan_hash`, `aadhaar_hash`, `company_registration_number`, `type_name`.
- CHECK: ID format, status values, risk level in (Low, Medium, High), score 0-100, name not blank.
- CHECK `Customer_type_fields_check`: an Individual must have DOB + Aadhaar and no company fields; a Company must have registration number, activity, incorporation date and no personal fields.
- Trigger: `customer_id` can never be changed after insert.

Why constraints in the database too? The API validates, but the database is the last line of defence if someone writes a script, a future endpoint, or a bug bypasses the API. The test suite tries to break these rules directly.

### Customer ID generation

```sql
CREATE SEQUENCE customer_code_seq;
CREATE FUNCTION next_customer_code() ... 'CUS-' || lpad(nextval('customer_code_seq')::text, 6, '0')
```

- Concurrency safe: PostgreSQL hands each caller a different number.
- Never reused: deleting a customer does not rewind the sequence.
- Gaps can happen (a rolled-back transaction consumes a number). That is correct and safe: gaps are fine, reuse is not.
- Not derived from the name or the frontend.

### JSON risk reasons

`risk_reasons` stores
```json
{ "reasons": [ { "factor": "Country exposure", "description": "...", "points": 25, "simulated": false } ],
  "screening": { "simulated": true, "pep": {...}, "sanctions": {...} },
  "requiresManualReview": false,
  "thresholds": { "mediumFrom": 30, "highFrom": 60 } }
```
Storing the thresholds used means an old rating can still be explained after the rules change.

---

## 8. Backend in detail (file by file)

| File | What it does and why |
|---|---|
| `server.js` | Calls `app.listen`, and disconnects Prisma on Ctrl+C. Separate from `app.js` so tests can start the app on a random port. |
| `app.js` | Creates Express, adds `cors`, `express.json` (100 KB limit), mounts `/api` routes, then the 404 and error handlers (order matters: errors last). |
| `config/env.js` | Loads `.env`, **requires** `ENCRYPTION_KEY`/`HASH_KEY` to be 64 hex characters and `DATABASE_URL` to exist. Failing at startup is better than failing in the middle of a registration. |
| `config/riskRules.js` | Every risk number, country list, threshold and the fictional watch-lists. Change rules here only. |
| `config/options.js` | Country names, business activities, occupation suggestions. Served to the frontend via `/api/meta`. |
| `routes/index.js` | Table of URL -> handler. |
| `middleware/asyncHandler.js` | Express 4 does not catch errors from async functions; this wrapper sends them to the error handler. |
| `middleware/errorHandler.js` | One JSON error shape `{ error: { code, message, details } }`. Known app errors -> their status. Bad JSON -> 400. Database down (Prisma codes P1001 etc.) -> 503. Unknown -> 500 with a generic message; only the error *name* is logged, never values, so identifiers cannot leak to logs. |
| `controllers/customerController.js` | `createCustomer`, `listCustomers`, `getCustomer`. Validates, delegates, responds. |
| `controllers/dashboardController.js`, `metaController.js` | Summary counts; reference data and risk model description. |
| `services/customerService.js` | Registration, duplicate handling, list, profile, and **the only place identifiers are decrypted (and immediately masked)**. |
| `services/riskService.js` | Pure functions: `assessRisk`, `runSimulatedScreening`, `levelForScore`. No database, no clock (time is passed in), so results are repeatable and easy to test. |
| `services/dashboardService.js` | The counting query. |
| `utils/validation.js` | zod schemas and format regexes (section 12). |
| `utils/crypto.js` | `encrypt`, `decrypt`, `blindIndex` (section 10). |
| `utils/mask.js` | `maskPan`, `maskAadhaar`. |
| `utils/errors.js` | `AppError(status, code, message, details)` and helpers `badRequest`, `notFound`, `conflict`. |
| `utils/prisma.js` | One shared Prisma client (many clients would exhaust DB connections). |

---

## 9. Frontend in detail (file by file)

| File | What it does |
|---|---|
| `index.html` | The single HTML page with `<div id="root">`. |
| `vite.config.js` | React + Tailwind plugins, dev port 5173, proxy `/api` -> `localhost:4000`. |
| `src/main.jsx` | Mounts React with: `BrowserRouter` (routing) -> `ToastProvider` (notifications) -> `MetaProvider` (reference data) -> `App`. |
| `src/App.jsx` | Route table. `customers/new...` is listed before `customers/:id` so "new" is never treated as an ID. Unknown URL -> Not found page. |
| `src/index.css` | Tailwind import, brand colours, and reusable `.btn`, `.input`, `.card` classes. |
| `components/Layout.jsx` | Sidebar (Overview, Customers, Add Customer) on desktop; hamburger menu on phones. Highlights the active item (Customers stays highlighted on a profile page, not on Add Customer). |
| `components/Toast.jsx` | `useToast().success/error/info`. Messages vanish after 6 s. |
| `components/ui.jsx` | Spinner, ErrorBanner (with Try again), PageHeader, RiskBadge (green/amber/red), StatusBadge, TypeBadge, Field (label + error text), Pagination, AddCustomerButton. |
| `components/RegistrationForm.jsx` | Shared frame for both forms plus `TextInput`, `SelectInput`, `CountrySelect`. Shows spinner while `/api/meta` loads, the server error banner, the "format only" notice, Cancel and Submit (with "Registering..." state). |
| `pages/DashboardPage.jsx` | Six count cards (each a link to a filtered list), empty-state hint, risk model note with thresholds. |
| `pages/CustomerDirectoryPage.jsx` | Search, type filter, risk filter, table, pagination. State lives in the URL. |
| `pages/CustomerTypeSelectionPage.jsx` | The two cards. |
| `pages/IndividualFormPage.jsx`, `CompanyFormPage.jsx` | Field lists and rules for each form. |
| `pages/CustomerProfilePage.jsx` | Details, masked identifiers, risk score, reasons table with "Simulated" tags, review flag, thresholds, earlier assessments. |
| `services/api.js` | All HTTP calls in one place. `toApiError` turns any failure into `{ status, code, message, fields }` with friendly text (server error, timeout, or "cannot reach the server"). |
| `hooks/useAsync.js` | Runs an async function and tracks `{ data, loading, error, reload }`; ignores outdated responses. |
| `hooks/useDebounce.js` | Delays a value until typing pauses. |
| `hooks/useMeta.js` | Context that loads `/api/meta` once. |
| `hooks/useRegistration.js` | Shared submit logic (section 5). |
| `utils/validators.js` | Form rules mirroring the server. |
| `utils/format.js` | Date formatting and risk badge colours. |

Responsive design: Tailwind breakpoints (`sm`, `lg`) switch the grid columns, the sidebar becomes a top bar with a menu on phones, and the table scrolls horizontally inside its own box so the page never scrolls sideways.

---

## 10. Security design

| Concern | What was done | Where |
|---|---|---|
| PAN/Aadhaar stored readable | **AES-256-GCM** encryption. Random 12-byte IV for every value (same PAN encrypts differently each time). The GCM tag detects tampering. Stored as `iv.tag.ciphertext`. | `utils/crypto.js` |
| Finding duplicates without plaintext | **HMAC-SHA256** (keyed hash, "blind index") in separate unique columns. Different key (`HASH_KEY`) and a scope prefix (`PAN:` vs `AADHAAR:`). | `utils/crypto.js`, schema |
| Showing identifiers | Only masked values leave the server. The full value is never in any API response. | `utils/mask.js`, `customerService.customerDto` |
| Keys in code | Keys come from `.env` and are validated at startup. `.env` is git-ignored. `.env.example` has placeholders only. | `config/env.js` |
| Leaking via logs/errors | Error handler logs only the error name/code and sends generic 500 messages. | `middleware/errorHandler.js` |
| SQL injection | Prisma parameterises queries; raw SQL uses tagged templates (`Prisma.sql`), so user text is a parameter and never concatenated. Search wildcards escaped. | `customerService.js` |
| Oversized/malformed requests | 100 KB body limit (413 with a JSON error); invalid JSON -> clean 400; a NUL character in a query or body is refused with 400 (PostgreSQL cannot store it); the `X-Powered-By` banner is disabled. Tested in `server/tests/api.hardening.test.js`. | `app.js`, `middleware/errorHandler.js`, `middleware/rejectNulCharacters.js` |
| Real data in demos | All seed/test PANs and Aadhaar are random synthetic values. | `scripts/generateCustomers.js` |

Important honesty points: format validation does **not** prove an identifier is real; there is no login yet; key rotation/KMS is a production topic not done here.

---

## 11. Risk engine in detail

Code: `services/riskService.js`. Rules: `config/riskRules.js`. **All values are prototype assumptions, not regulatory rules.**

```
score = min( sum(points of every matching factor), 100 )
level = High if score >= 60, Medium if score >= 30, else Low
```

| # | Factor | Applies to | Points |
|---|---|---|---|
| 1 | Customer type | all | Individual 5, Company 15 |
| 2 | Country exposure | all | India 0, other 10, "elevated" list 25, "high" list 40 |
| 3 | Business activity | company | 0-30 per industry |
| 4 | Occupation keywords | individual | jewel/bullion 15, real estate 10, self-employed/business owner/trader 5 |
| 5 | PEP indicator **(simulated)** | individual (name list also any) | 30 |
| 6 | Sanctions screening **(simulated)** | all | 40 |
| 7 | Other: under 21; company incorporated within a year | individual / company | 5 / 10 |

Example: a Nigerian crypto company = 15 (company) + 25 (elevated country) + 30 (crypto) = **70 -> High**.

Simulated screening: names are compared (lower-cased) with a small invented list in `riskRules.js`; PEP also triggers on occupation words like "politician". The output says `simulated: true`. A potential match adds points and sets `requiresManualReview = true`. The customer is **still registered**. Risk is kept separate from KYC completeness.

Every assessment returns `reasons[]`, so the profile page can explain exactly why a customer got their level.

---

## 12. Validation in detail

Two layers: the browser (instant, convenience) and the server (authoritative, `utils/validation.js` with zod). The server never trusts the browser.

| Field | Rule |
|---|---|
| Required text | Trimmed, not empty, max length. |
| Email | `name@domain.tld`, lower-cased. |
| Phone | Indian mobile (10 digits starting 6-9, optional `+91`/`91`/`0`) -> stored `+91XXXXXXXXXX`; or international `+` then 8-15 digits. Spaces/dashes ignored. |
| PAN (individual) | `^[A-Z]{5}[0-9]{4}[A-Z]$`, uppercase, 4th letter `P`. |
| PAN (company) | Same shape, 4th letter in `C F H A T B L J G`. Configured by `COMPANY_PAN_HOLDER_TYPES`. |
| Aadhaar | Spaces/dashes removed, then exactly 12 digits. |
| Date of birth | Real date (31 Feb rejected), not future, age 18+. |
| Date of incorporation | Real date, not future. |
| Country | Must be a code from the supported list. |
| Business activity | Must be one of the listed options. |

Remember: this checks **format only**. It cannot prove the number is genuine.

---

## 13. Error handling

| Case | Status / code | What the user sees |
|---|---|---|
| Missing/invalid fields | 400 `VALIDATION_ERROR` + `details` per field | Messages under each input |
| Bad JSON body | 400 `INVALID_JSON` | Error banner |
| Duplicate PAN / Aadhaar / registration no. | 409 `DUPLICATE_CUSTOMER` + `existingCustomerId` | Field message + link to the existing customer |
| Unknown customer / route | 404 `NOT_FOUND` | Error banner / Not found page |
| Database down | 503 `DATABASE_UNAVAILABLE` | Banner with **Try again**; recovers automatically when DB returns |
| ID could not be allocated after retries | 503 `CUSTOMER_ID_CONFLICT` | Error banner |
| Server bug | 500 `INTERNAL_ERROR` | Generic message |
| API unreachable / timeout | none (network) | "Cannot reach the server..." / "took too long" |

Double submits: the button is disabled, a ref blocks rapid double clicks, and the database UNIQUE constraints are the final guard.

---

## 14. Synthetic data generator

File: `scripts/generateCustomers.js`.

- **Seeded random generator** (mulberry32) with default seed `20261022`. Same seed -> same names, countries, PANs, risk levels.
- Fixed "today" (`2026-10-22`) for age rules so results do not change when you run it on another day.
- Realistic fictional data: name pools, example.com emails, 82% domestic customers, 70% individuals / 30% companies.
- PANs begin with `Z` and Aadhaar are random: format-correct, fictional, unique within a run.
- Uses the **same** `toCustomerRow` (encryption/hashes) and `assessRisk` as the API.
- Customers are inserted one at a time in order, so IDs are `CUS-000001, 000002...` deterministically.
- Options: `--count=N`, `--seed=N`, `--reset` (truncate and restart the sequence so IDs start at 1), `--dry-run`.
- Without `--reset` it appends and IDs continue from the sequence.

---

## 15. Tests

Run `npm test` (database must be running).

- `server/tests/unit.test.js` (14): validation rules, risk rules and thresholds, PEP/sanctions never rejecting, score cap, determinism, encryption round trip and tamper detection, masking.
- `server/tests/api.test.js` (14): real HTTP calls to the app and real database - registration, encryption at rest, per-field errors, duplicates, 5 simultaneous identical submissions -> one customer, 12 parallel registrations -> 12 distinct IDs, no ID reuse after delete, list search/filter/pagination, dashboard counts, direct DB constraint violations, 404 and `/meta`.

The API tests create customers with `QTE...` PANs and delete them afterwards.

---

## 16. How to change things (recipes)

| I want to... | Edit |
|---|---|
| Change risk points, thresholds, country lists | `server/src/config/riskRules.js` |
| Add a country / industry / occupation suggestion | `server/src/config/options.js` (and a points entry in `riskRules.js` for a new industry) |
| Change PAN holder letters or minimum age | `server/src/utils/validation.js` (and `client/src/utils/validators.js` to match) |
| Add a new form field | `schema.prisma` + new migration (`npx prisma migrate dev --name x`), `validation.js`, `toCustomerRow`, `customerDto` in `customerService.js`, the form page, the profile page |
| Change the Customer ID format | `next_customer_code()` in a new migration, plus the CHECK constraint |
| Change page size | `PAGE_SIZE` in `CustomerDirectoryPage.jsx` |
| Change colours | `@theme` in `client/src/index.css` |
| Move to another database server | `DATABASE_URL` in `.env`, then `npm run db:migrate` |
| Use a new encryption key | Generate a new hex key in `.env`. Old rows become unreadable, so `npm run generate:customers -- --reset` for demo data. |

---

## 17. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| API says `DATABASE_UNAVAILABLE` | `npm run db:local` is not running. Start it first. |
| `ENCRYPTION_KEY must be set to 64 hex characters` | Fix `.env` (generate with the node command in `.env.example`). |
| Page shows "Cannot reach the server" | API (`npm run dev`) not running. |
| Port already in use | Another copy is running. Stop it with Ctrl+C, or change `PORT` / `LOCAL_PG_PORT` in `.env`. |
| `Cannot find module ...` or Postgres "could not open directory ... timezone" | Files vanished from `node_modules` (OneDrive). Delete `node_modules/@embedded-postgres` (or the whole `node_modules`), run `npm install`. Best fix: move the project out of OneDrive. |
| `A generated value already exists` from the generator | Use `--reset`. |
| Tests fail with connection errors | Start the database first. |
| Want a clean start | Stop everything, delete `.pgdata`, then `npm run db:local`, `npm run db:migrate`, `npm run generate:customers -- --reset`. |

---

## 18. Limitations

- No login or role control. Anyone who can reach the API can use it.
- PAN/Aadhaar format-checked only; no registry verification; no Aadhaar checksum.
- Risk rules and country lists are prototype assumptions; screening is simulated.
- No customer editing/deleting UI, and no re-assessment after registration (schema supports it).
- Keys live in `.env`; no key rotation/KMS.
- Tests no longer use the development database: `npm test` and `npm run test:browser` run on the dedicated test database `clearkyc_test` (`scripts/testDatabase.js`). A recoverable backup of the development database can be taken with `npm run db:backup`.
- `embedded-postgres` and the OneDrive location are for development convenience only.
