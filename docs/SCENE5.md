# Scene 5: Audit History, Alerts, Analytics & Final Reporting

Scene 5 adds an **immutable audit trail**, **alerts**, an **analytics dashboard**, **data quality checks** and **report exports** on top of
Scenes 1 to 4. Nothing from Scenes 1 to 4 was rebuilt: their services gained audit calls, and detection gained alert generation.
All data is synthetic. Every analytics number is calculated from the database on each request.

## 1. Run it

```powershell
npm install
npm run db:local              # PostgreSQL (leave running)
npm run db:migrate            # applies 20261102090000_scene5_audit_alerts
npm run db:generate           # only if the Prisma client needs regenerating (stop the API first on Windows)
npm run dev                   # API on :4000
npm run client                # React app on :5173
```

Rebuild the complete demo data in order (seed 20261022, fixed detection date):

```powershell
npm run generate:customers -- --reset
npm run generate:kyc -- --reset --as-of=2026-10-22
npm run generate:ownership -- --reset
npm run generate:reviews -- --reset --as-of=2026-10-22
npm run generate:scene5 -- --reset --as-of=2026-10-22
```

Choose a person under **Acting as** in the sidebar (no passwords; this is the prototype stand-in for login):
Vikram, Priya, Arjun = Operations Analyst; Asha, Rahul, Neha = Compliance Reviewer; Meera = Administrator.

New sidebar pages: **Alerts & Notifications** (`/alerts`), **Audit Trail** (`/audit`), **Analytics & Reports** (`/analytics`),
**Data Quality & Validation** (`/data-quality`), **Reports & Exports** (`/reports`). The Overview gains four alert cards.

## 2. Roles

| Capability | Analyst | Reviewer / Admin |
|---|---|---|
| Read the audit trail (page, API, export) | no (403) | yes |
| Alerts: view, acknowledge, start work, refresh | yes | yes |
| Resolve a Low/Medium alert | yes | yes |
| Resolve a High/Critical alert or a potential PEP/sanctions alert | no | yes |
| Dismiss an alert (Low/Medium/High, with remarks) | no | yes |
| Dismiss a Critical or a potential PEP/sanctions alert | no | **no one** |
| Analytics, validation results | view | view |
| Run data validation | no | yes |
| Export documents, completeness, review cases, alerts | yes | yes |
| Export customers, risk, ownership, audit trail, seed data, schema | no (403) | yes |

Identity is the `X-Reviewer-Id` header chosen in the sidebar. It can be spoofed by anyone who can call the API (see limitations).

## 3. Audit trail

* `AuditEvent` rows are written **by the backend, inside the same database transaction** as the change (`services/auditService.js`
  `record(tx, …)`). A failed change leaves no event; a failed audit write rolls the change back. There is no endpoint that creates,
  edits or deletes an event: `POST/PUT/PATCH/DELETE /api/audit-events…` return 404.
* The database refuses `UPDATE`, `DELETE` and `TRUNCATE` on `AuditEvent` with triggers. Only the explicit maintenance switch
  `SET LOCAL app.allow_history_delete = 'on'` (used by the seed reset scripts and test cleanup, never by the API) lifts the delete and
  truncate guard. `UPDATE` is never allowed.
* Fields: Event ID (`AUD-000001`), user id + role snapshot (`System` when the backend itself acted), action type, entity type, entity
  id + business reference, customer, previous values, new values, reason, IP address (from the request, no proxy headers trusted),
  timestamp. `customer_id` has no foreign key on purpose: the trail outlives records.
* **Sensitive data**: previous/new values are small summaries chosen by the caller and sanitised again: keys such as PAN, Aadhaar,
  document number, date of birth, password, token, secret and any `*hash` are `[redacted]`; PAN/Aadhaar-looking text is masked; long text is cut.
  Owner names and dates of birth, case-note text and the customer's name/contact details are not copied into events.
* Tracked actions (28 types are used by the seed; all listed in `config/auditRules.js`): customer created, risk assessment created, risk
  classification changed; document submitted, updated, verification started, verified, rejected, resubmission requested, reset to pending;
  KYC requirement created/updated/activated; owner added/updated, ownership percentage changed, ownership validated, screening recorded;
  case created, assigned, priority changed, status changed, escalated, resolved, closed, reopened, note added; periodic review scheduled,
  re-scheduled, completed; exception detected/resolved; alert generated, acknowledged, status changed, resolved, dismissed; data
  validation run; report exported. "Customer details updated" is defined but never emitted: no earlier scene has an edit-customer feature.

## 4. Alerts

Alerts are **derived from the exception engine's conditions** (the real records), in the same transaction as detection
(`POST /api/exceptions/detect`, `POST /api/alerts/refresh`, or any case change that re-runs detection).

| Alert type | Raised from |
|---|---|
| Document Expiry | verified document expiring within 30 days |
| Document Expired | document past its expiry date |
| Missing Mandatory Document | mandatory requirement with no document |
| Verification Pending | document waiting for verification |
| High-Risk Customer | current rating is High |
| Ownership Issue | no owners, over 100%, below 100%/missing percentage, complex structure |
| Periodic Review Due / Overdue | review schedule within 30 days / past due |
| Potential PEP / Sanctions Match | customer or owner screening says **Potential Match** |

* **No duplicate active alerts**: one per condition key, enforced by a partial unique index (`Alert_active_dedupe_key`) and `createMany(skipDuplicates)`.
* **Linked to sources**: `relatedEntityType/Id` (document, owner, schedule, customer) and the exception detected from the same condition.
* **Auto-resolved** when the records no longer show the condition (resolution type "Condition cleared", resolved by the System). A returning
  condition raises a **new** alert. A person who closes an alert while the condition still exists suppresses re-raising until it clears once.
* Statuses New, Acknowledged, In Progress, Resolved, Dismissed. Resolved/Dismissed are final: the database freezes them (`Alert_guard`).
  Resolving or dismissing needs remarks (10+ characters). **History = the alert's audit events.**
* A potential sanctions/PEP match is never confirmed or dismissed by the system or by anyone: it stays a *potential* match until a
  reviewer investigates and resolves it; the screening record itself is untouched.
* Not every exception raises an alert (rejected documents, resubmission requests, manual-review flags and "closed without resolution" stay exceptions only).

## 5. Analytics

`GET /api/analytics/overview` (and the section endpoints) return numbers computed from SQL aggregates and the Scene 2 KYC engine.
Two kinds of figures, labelled in the UI: **now** (risk levels, completeness, document statuses, open cases, ownership: unaffected by the
filter) and **in this period** (customers onboarded, documents submitted, cases opened, alerts raised, assessments, the monthly trend).
Filters: `range=7d|30d|90d|all` or `from`/`to` (custom). "Last 7 days" = today and the six days before. Partial or inverted ranges are rejected (400).
Six charts (Recharts): risk distribution, KYC completeness distribution, document verification status, monthly onboarding trend, case status
distribution, alerts by severity. Each chart has a "Show data" table.

Definitions: *Open cases* = Open + Assigned; *In progress* = In Progress + Pending Customer; *Overdue* = active and past due (same as Scene 4);
*Pending verification* = Pending + In Review; *Expiring within 30 days* = expiry between today and +30 days; *Partially complete* =
partially complete + nothing verified yet; *Potential PEP/sanctions matches* = customers with at least one potential match (own screening or an owner's latest result).

Sample output (seed data, `range=all`; full file in `docs/samples/analytics-overview.json`):

| Area | Figures |
|---|---|
| Customers | 50 total, 33 individual, 17 company; risk Low 27 / Medium 19 / High 4 |
| KYC completeness | 11 fully complete, 38 partially complete (+1 nothing verified), 0 with no documents, average 61.1% |
| Documents | 152 total, 119 verified, 19 pending, 7 rejected, 10 expired, 7 expiring within 30 days |
| Risk | 13 manual review, 12 potential PEP, 2 potential sanctions (all *potential*) |
| Review cases | 15 total, 4 open, 6 in progress, 2 escalated, 1 resolved, 3 overdue |
| Ownership | 17 companies, 40 owners, 5 validation issues, 2 with missing ownership information |
| Alerts | 94 raised, 89 active, 77 new |

## 6. Data quality & validation

33 read-only checks (`services/dataQualityChecks.js`): duplicate business IDs (customers, assessments, cases, exceptions, alerts, audit
events, documents, owners); orphaned documents/verifications/cases/alerts/owners; issue date after submission, expiry before issue, invalid
status, status vs latest verification; ownership percentage range, total over 100%, missing owners/percentages; risk score range,
score vs reasons, level vs configured thresholds, assessment history chain; closed cases without notes, case status transitions replayed
from history, case dates vs status, overdue cases; KYC completeness vs requirements, requirements defined, active alerts still valid and
not duplicated, periodic review dates. A check is **Passed** (no violations), **Failed** (an error rule is broken) or **Warning**.
A run stores totals, failed record IDs, per-check results and issues with a **recommended fix**; the page links each issue to the screen
where a person fixes it (customer, document, ownership, case, alert, reviews). Nothing is corrected automatically: run again afterwards and
earlier issues the run no longer finds are shown as "Resolved". Many rules are also database constraints, so those checks normally pass.
On the seed data: 33 checks, 30 passed, 1 failed (two companies with 110% ownership, a seeded scenario), 2 warnings (companies with no owners; overdue cases).

## 7. Exports

`GET /api/exports` lists reports and who may export them. CSV is UTF-8 with a byte-order mark, RFC 4180 quoting, fixed column names, and
spreadsheet-formula protection (cells starting with `= + - @` are prefixed with `'`). Filters (including date ranges) apply before the file is built.
PAN, Aadhaar, document numbers, e-mail and phone are masked; dates of birth, encrypted columns and hashes are never exported. Limit 20,000 rows.
Every export (who, report, filters, row count) is audited **before** the file is returned. Extra endpoints: `/exports/seed-data` (JSON, seed 20261022)
and `/exports/schema` (SQL generated from the live catalog: sequences, functions, tables, constraints, indexes, triggers; no data).
Excerpts of each CSV are in `docs/samples/*-sample.csv` (regenerate with `node scripts/writeSceneSamples.js`).

## 8. Database changes (migration `20261102090000_scene5_audit_alerts`)

* New tables: `AuditEvent`, `Alert`, `ValidationRun`, `ValidationIssue` (Prisma models in `prisma/schema.prisma`).
* Sequences/functions: `audit_event_seq` / `next_audit_event_code()` (AUD-), `alert_seq` / `next_alert_code()` (ALT-).
* Constraints: code formats; role/actor consistency on audit events (a person has a role, the system has no user id); alert status, severity, type,
  related-entity and resolution rules (a closed alert records how, when and why; dismissal is manual); validation counts add up.
* Indexes: audit by time, entity, customer, action, user; alerts by customer/status, type/status, severity/status, key; **partial unique** `Alert_active_dedupe_key`.
* Foreign keys: `AuditEvent.user_id → Reviewer`, `Alert → Customer (cascade) / Exception (set null) / Reviewer`, `ValidationRun → Reviewer`, `ValidationIssue → ValidationRun`.
* Triggers: audit update/delete/truncate refusal; `Alert_guard` (closed alerts frozen, identity fixed); `Alert`, `ValidationRun`, `ValidationIssue` direct deletes refused.
* Scenes 1 to 4 tables are unchanged. The reset scripts of Scenes 1 to 4 were extended to include the new tables.

## 9. API

| Method and path | Purpose | Who |
|---|---|---|
| GET `/api/audit-events`, `/audit-events/:id`, `/audit-events/options` | list (filters, paging), detail, filter values | Reviewer, Admin |
| GET `/api/activity/recent` | latest business activity for the Overview (limited fields) | open |
| GET `/api/alerts`, `/alerts/:id`, `/alerts/summary`, `/alerts/options` | list (severity, type, status, customerId, search, dates), detail with history | open (detail lists the person's allowed actions) |
| POST `/api/alerts/refresh` | run detection for everyone | any active person |
| PATCH `/api/alerts/:id/acknowledge`, `/status`, `/resolve` | workflow | any active person (finer rules in the service) |
| GET `/api/analytics/overview`, `/customers`, `/documents`, `/risks`, `/review-cases`, `/ownership` | analytics (`range` or `from`+`to`) | open |
| POST `/api/data-validation/run` | run the checks | Reviewer, Admin |
| GET `/api/data-validation/runs`, `/runs/:id`, `/issues`, `/checks` | results | open |
| GET `/api/exports` | catalogue | open (shows what the person may export) |
| GET `/api/exports/customers`, `documents`, `completeness`, `risks`, `ownership`, `review-cases`, `alerts`, `audit-events`, `seed-data`, `schema` | downloads | by report (section 2) |

Errors always look like `{ error: { code, message, details } }` (400 validation, 401 no person, 403 role, 404, 409 conflict, 413 export too large).

## 10. Files

Created: `prisma/migrations/20261102090000_scene5_audit_alerts/`, `server/src/config/{auditRules,alertRules}.js`,
`server/src/services/{auditService,alertEngine,alertService,analyticsService,dataQualityChecks,dataQualityService,exportService}.js`,
`server/src/utils/{requestContext,csv,reportValidation}.js`, `server/src/middleware/requireRole.js`,
`server/src/controllers/reportingController.js`, `server/src/routes/reporting.js`, `scripts/{generateScene5Data,writeSceneSamples}.js`,
`server/tests/{scene5.engine,scene5.api}.test.js`, `client/src/pages/{AuditTrail,Alerts,Analytics,DataQuality,Reports}Page.jsx`,
`client/src/components/{reportUi,AlertCards}.jsx`, `client/src/services/reportApi.js`, `docs/SCENE5.md`, `docs/samples/`.

Modified: `prisma/schema.prisma`; `server/src/app.js` (request context), `routes/index.js`, `middleware/upload.js`; audit calls in
`customerService`, `documentService`, `verificationService`, `ownershipService`, `screeningService`, `riskAssessmentService`,
`reviewCaseService`, `reviewScheduleService`, `requirementService`; `exceptionService` (audit + alert sync; exports `loadContexts`);
`ownershipService` exports `COMPANY_BASE`/`STATUS_SQL`; the four generator scripts (reset lists, audit events); the four earlier test files
(cleanup also removes the audit events they created); `client` `App.jsx`, `Layout.jsx`, `DashboardPage.jsx`, `package.json` (recharts); `package.json` (`generate:scene5`); `README.md`.

## 11. Tests

`npm test`: **214 / 214 pass** (165 from Scenes 1 to 4 + 14 pure-logic + 35 API/database for Scene 5). Scene 5 covers: audit events for every
area with correct user/role/previous/new values and no sensitive data; atomicity (failed change = no event); immutability through APIs and
the database; role-restricted audit access; alert generation, source links, duplicate prevention (including simultaneous detections),
acknowledge/progress/resolve/dismiss, automatic resolution and re-raising, potential sanctions safeguards; analytics figures equal direct
database counts, section endpoints agree with the overview, date filters; data quality checks (found, fixed, re-run) and that validation changes
no business data; CSV/JSON/SQL exports, masking, filters, formula protection, role restrictions and export auditing; referential integrity.
Browser check (headless Chrome, 74 checks): dashboard cards, all five pages, filters, side panels, role-based buttons, charts vs API numbers, date
range, downloads (BOM, filters, masking), no horizontal scroll at 390 px, no console errors, Scene 1/3/4 pages still working.

## 12. Known limitations

* No real login: the "Acting as" header is spoofable, so audit user ids are only as trustworthy as that header. IP addresses are the socket address.
* Detection (and therefore alerts) runs on demand and after case changes; there is no background scheduler and no e-mail/SMS notification.
* Seeded customers are all created on the day the data is generated, so the monthly onboarding chart shows one month; real use fills it over time.
* "Customer details updated" cannot occur until an edit-customer feature exists. Audit events written before Scene 5 do not exist (none were recorded then).
* Audit coverage is for actions made through the application. A database administrator can still bypass triggers (for example by disabling them): this is not a tamper-proof ledger.
* Validation checks that duplicate database constraints normally pass; the data-quality page is most useful for data loaded outside the app.
* Alert severities, which roles may close which alerts, and the 30-day windows are illustrative prototype assumptions. Screening is synthetic: a potential match is never a confirmed match.
* Exports are generated in memory (limit 20,000 rows) rather than streamed.
