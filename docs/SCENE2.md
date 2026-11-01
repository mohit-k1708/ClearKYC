# Scene 2: Document Management & Verification

Scene 2 adds KYC requirements, document records (with optional file upload), a manual verification workflow with
immutable history, missing/expired detection, and a server-calculated KYC completeness percentage. Scene 1 is unchanged
apart from the small additive edits listed in section 6.

> **Verification is a simulated manual review inside this prototype.** It is not a government or identity-provider
> check. A "Verified" status and a correctly formatted document number do not prove a document is genuine.
> Use **synthetic data only**: never enter real PAN, Aadhaar, passport or other identity numbers, and never upload real
> identity documents.

## 1. Run it

Scene 1 steps still apply (database running, API, website). Then, once:

```powershell
npm install                              # adds multer (file uploads)
npm run db:migrate                       # applies the two Scene 2 migrations
npm run generate:kyc -- --reset          # reviewers + sample requirements + documents + verification history
```

`npm run generate:kyc` options: `--reset` (delete all documents and history first), `--limit=300` (customers to give
documents to, default 100), `--as-of=2026-10-22` (fixed "today" so dates are identical on any day), `--seed=N` (default
`20261022`), `--requirements-only`. If no customers exist it runs the Scene 1 generator first. Same seed + same `--as-of`
+ `--reset` gives identical records (verified by fingerprinting the stored rows).

Start the servers as before (`npm run db:local`, `npm run dev`, `npm run client`) and open http://localhost:5173.
Tests: `npm test` (runs all test files one after another; the database must be running).

## 2. What the analyst can do

| Page (sidebar) | Route | What it does |
|---|---|---|
| KYC Requirements | `/kyc-requirements` | List and filter requirements; add, edit, activate or deactivate; mandatory flag; effective dates |
| Documents | `/documents` | Search by customer ID/name or document type; filter by status, expiry, type; paginated |
| Add / edit document | `/documents/new`, `/documents/:id/edit` | Pick an existing customer, enter metadata, optional file (PDF/JPG/PNG up to 2 MB) |
| Document details | `/documents/:id` | Metadata, expiry state, file download, full verification history |
| Verification Review | `/verification`, `/documents/:id/review` | Work queue and the decision screen |
| KYC Completeness | `/kyc`, `/kyc/:customerId` | Exceptions across customers; one customer's percentage and every requirement |
| Customer profile (Scene 1) | `/customers/:id` | New **Documents & KYC** section |

**Acting as (sidebar).** There is no login in this prototype. The analyst chooses a person to act as, and the choice is
sent as an `X-Reviewer-Id` header. Only **Reviewer** and **Admin** can record decisions; an **Analyst** gets a clear message
(403 from the API). This is a stand-in for real authentication: anyone who can call the API can send any id. The decision
rule is still enforced twice, in the API and by a database trigger.

## 3. Business rules

**Sample requirements** (configurable on the page, defaults in `server/src/config/kycRules.js`; not regulatory rules):

| Customer | Low | Medium | High |
|---|---|---|---|
| Individual | PAN, Address Proof, Photograph | + Bank Statement | + Additional Evidence |
| Company | Certificate of Incorporation, Business PAN, Address Proof | + Ownership Details | + Financial Statements, Additional Evidence |

- The requirements that apply to a customer are the **active** ones, **in effect today**, for the customer's **type** and
  **current risk level** (newest Scene 1 risk rating). Two active rules for the same type, risk level and document may not
  cover the same dates (409).
- **A new document starts as Pending.** Uploading never verifies. Only a reviewer's decision does.
- **Decisions:** In Review, Verified, Rejected, Requires Resubmission. *Pending* is system-only. Rejected and Requires
  Resubmission need remarks. Repeating the current status is a 409. An **expired document cannot be verified** (it can be
  rejected).
- **History is immutable.** Each decision is a new `Verification` row (reviewer, date, remarks). The database blocks UPDATE
  and DELETE on that table, and `Document.status` is set by a trigger from the newest row, so it can never disagree with the
  history. Editing the type, number, dates or file of an already-reviewed document records a new Pending row
  ("Re-verification required") in the same transaction. Editing only the notes keeps the status.
- **Expiry:** expired means the expiry date is **before** today. Expiring soon means within **30 days** (today to day 30,
  inclusive). Dates are compared as UTC calendar dates.
- **Valid** means verified by a reviewer **and** not expired. A document with status Verified but a past expiry date is
  reported as **Expired** and never counts as valid.
- **Per document type, the best document decides** the state (Verified, then Pending/In Review, Requires Resubmission,
  Rejected, Expired, Missing). A verified replacement hides an older rejected or expired copy.
- **Completeness % = verified mandatory requirements / total mandatory requirements x 100** (one decimal). 100 is Complete,
  1 to 99 is Partially Complete, 0 is Not Started, and no mandatory requirements gives "No Requirements" (no percentage).
  It is calculated from the database on every request and never stored. Each mandatory requirement falls in exactly one
  bucket: verified, missing, pending verification, rejected, requires resubmission or expired. Verified documents expiring
  within 30 days still count but are flagged (`expiringSoon`).
- **Exceptions** (`/api/kyc/exceptions`): Missing (mandatory only), Pending verification, Rejected, Requires resubmission,
  Expired, Expiring soon, one per customer and document type. `submittedNotVerified` counts submitted documents that are not
  verified.

## 4. Database changes

Migrations `*_scene2_documents` and `*_scene2_utc_trigger`.

| Table | Purpose |
|---|---|
| `KYCRequirement` | `customer_type_id` FK, `risk_level`, `document_type`, `is_mandatory`, `effective_from`, `effective_to`, `is_active`. UNIQUE (type, risk, document, effective_from). CHECK on risk level and dates |
| `Document` | `customer_id` FK (RESTRICT), `requirement_id` nullable FK, `document_type`, `document_number` (**AES-256-GCM encrypted**, shown masked) and `document_number_hash` (duplicate detection), `issue_date`, `expiry_date`, `submission_date`, `notes`, file metadata (`file_reference`, `original_file_name`, `file_mime_type`, `file_size_bytes`), `status`. UNIQUE (customer, type, number hash, issue date, submission date). CHECKs for date order, status values and all-or-nothing file metadata |
| `Verification` | `document_id` FK, `reviewer_id` nullable FK, `status`, `remarks`, `verification_date`. Insert-only (triggers). CHECK: remarks required for Rejected and Requires Resubmission; every decision has a reviewer |
| `Reviewer` | Prototype people for the workflow: `name`, unique `email`, `role` (Analyst, Reviewer, Admin), `is_active` |

Relationships: Customer 1-* Document, KYCRequirement 1-* Document, Document 1-* Verification, Reviewer 1-* Verification,
CustomerType 1-* KYCRequirement.

Triggers: verification immutability, authorised-reviewer check, status sync to `Document`, and a guard so a document can
neither move to another customer nor have its status edited directly.

**Files are never stored in PostgreSQL.** Only metadata and a generated reference are. Files go to `server/uploads/`
(override with `UPLOAD_DIR`) under random names. The type is checked by extension, MIME type **and the file's first bytes**,
and files are only served as attachments through the API.

## 5. API

All responses are JSON: `{ data, pagination? }` or `{ error: { code, message, details? } }`.

| Method and path | Purpose |
|---|---|
| `GET /api/kyc-requirements` | List (filters `customerType`, `riskLevel`, `isActive`, `search`) |
| `GET /api/kyc-requirements/document-types` | Known document types and whether each needs a number |
| `POST /api/kyc-requirements` | Create (201). 409 on overlap or duplicate |
| `PUT /api/kyc-requirements/:id` | Edit |
| `PATCH /api/kyc-requirements/:id/status` | Body `{ "isActive": true }` |
| `GET /api/documents` | Paginated list: `page`, `pageSize`, `search`, `status`, `expiry` (Valid, Expiring Soon, Expired, No Expiry), `documentType`, `customerId` |
| `POST /api/documents` | Create (multipart with optional `file`, or JSON). 404 `CUSTOMER_NOT_FOUND`, 409 `DUPLICATE_DOCUMENT`, 413 `FILE_TOO_LARGE` |
| `GET /api/documents/:id` | Details with verification history (newest first) |
| `PUT /api/documents/:id` | Edit metadata (the customer cannot change) |
| `GET /api/documents/:id/file` | Download the stored file |
| `GET /api/customers/:customerId/documents` | One customer's documents |
| `POST /api/documents/:documentId/verifications` | Record a decision. Needs `X-Reviewer-Id` of an active Reviewer or Admin: 401 or 403 otherwise |
| `GET /api/documents/:documentId/verifications` | Full history |
| `GET /api/customers/:customerId/kyc-completeness` | Percentage, status, counters, per-requirement state, exceptions |
| `GET /api/kyc/exceptions` | Paginated exceptions (`type`, `customerType`, `risk`, `search`) plus summary counts |
| `GET /api/reviewers` | Active people for the "Acting as" selector |

Completeness, expiry and exception logic all run on the server (`server/src/services/kycEngine.js`). The browser only
displays the results.

## 6. Files

**Created (backend):** `server/src/config/kycRules.js`, `utils/dates.js`, `utils/kycValidation.js`, `utils/fileStorage.js`,
`middleware/upload.js`, `middleware/requireReviewer.js`,
`services/kycEngine.js`, `kycService.js`, `requirementService.js`, `documentService.js`, `verificationService.js`,
`controllers/requirementController.js`, `documentController.js`, `verificationController.js`, `kycController.js`,
`routes/kyc.js`. Also `scripts/generateKycData.js`, `prisma/migrations/*_scene2_documents`, `*_scene2_utc_trigger`,
`server/tests/kyc.engine.test.js`, `server/tests/kyc.api.test.js`.

**Created (frontend):** `services/kycApi.js`, `hooks/useReviewer.js`, `components/kycUi.jsx`, `KycPanel.jsx`,
`DocumentsKycSection.jsx`, and the pages `KycRequirementsPage`, `DocumentsPage`, `DocumentFormPage`, `DocumentDetailsPage`,
`DocumentReviewPage`, `VerificationQueuePage`, `KycCompletenessPage`, `CustomerKycPage`.

**Changed from Scene 1 (all additive):**
- `prisma/schema.prisma`: new models and back-relations.
- `server/src/routes/index.js`: mounts the Scene 2 router.
- `server/src/utils/mask.js`: `maskDocumentNumber`.
- `scripts/generateCustomers.js`: `--reset` now also empties the Scene 2 tables (it would fail otherwise).
- `package.json`: multer, `generate:kyc`, tests run one file at a time (parallel files interfered with Scene 1's before/after counts).
- `.gitignore`, `.env.example`.
- Client: `services/api.js` (exports the shared client, adds the reviewer header), `components/Layout.jsx` (menu items and
  "Acting as"), `App.jsx`, `main.jsx`, `pages/CustomerProfilePage.jsx` (Documents & KYC section).

## 7. Test results

| What | Result |
|---|---|
| `npm test`: Scene 1 (28) + Scene 2 engine unit tests (15) + Scene 2 API and database tests (24) | **67 / 67 passed** |
| Scene 2 browser run in headless Chrome: requirements add, edit and deactivate; document add with file; review authorisation (no reviewer, Analyst, Reviewer); remarks rule; history; edit resets to Pending; search and filters; exception tiles; customer lookup; mobile widths | **36 / 36 passed** |
| Scene 1 browser run, re-executed after the changes | **20 / 20 passed** |
| Seed reproducibility (same seed and date twice; a different seed) | Identical fingerprints for the same seed, different for another |

The tests cover every case in the brief: adding a document, refusing a nonexistent customer (API and foreign key), creating
verification records, preserving history (and database-level immutability), rejecting invalid statuses, missing, expired and
expiring-within-30-days detection, the 3-of-5 = 60% example, and an expired Verified document not counting as valid.

## 8. Limitations

- **No real authentication.** "Acting as" is a prototype stand-in (a spoofable header). Anyone can edit requirements.
- Verification is a simulated manual review. There is no OCR, no external identity or registry check, and no virus scanning.
  Document numbers are only format-checked.
- Files are stored on local disk (development only). Production needs private object storage, scanning and retention rules.
  Seeded documents have no file attached.
- Completeness and exceptions for all customers are computed in memory by the API. That is fine for thousands of customers;
  very large datasets need a precomputed or SQL-based approach.
- Dates are UTC calendar dates, so near midnight in India the "today" used for expiry can be one day behind the local date.
- A requirement change applies immediately to every customer it covers (completeness is live, not snapshotted), and
  requirement edits have no history.
- Documents cannot be deleted from the UI. A rejected document stays in history, and a resubmission is a new document or an edit.
- No notifications, SLAs or escalation for expiring documents (later scenes).
