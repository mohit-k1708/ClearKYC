# Scene 4: Review Cases & Exception Management

Scene 4 detects exceptions from the real records of Scenes 1 to 3, lets analysts open **review cases** to investigate
them, routes high-risk work through a compliance reviewer, and tracks **periodic KYC reviews**. Scenes 1, 2 and 3 keep
working unchanged: Scene 4 only reads their data.

> **Prototype rules, synthetic data.** Severities, SLA days, approval rules and the review intervals (Low 36 months,
> Medium 24, High 12) are illustrative and configurable in `server/src/config/reviewRules.js`. They are not legal
> requirements. A potential sanctions or PEP match is **investigated, never auto-confirmed**, and nothing rejects a
> customer automatically. There is no login: the "Acting as" selector in the sidebar is a prototype stand-in.

## 1. Run it

Scene 1 to 3 steps still apply. Then, once:

```powershell
npm install
npm run db:migrate                          # applies the Scene 4 migration
npm run generate:reviews -- --reset         # detects exceptions, creates the demo cases and schedules
```

Start the servers as before (`npm run db:local`, `npm run dev`, `npm run client`) and open http://localhost:5173.
`npm test` runs every test file one after another (the database must be running).

Rebuilding everything from scratch, in order (a fixed `--as-of` makes the date-based results identical on any day):

```powershell
npm run generate:customers -- --reset
npm run generate:kyc -- --reset --as-of=2026-10-22
npm run generate:ownership -- --reset
npm run generate:reviews -- --reset --as-of=2026-10-22
```

The Scene 1 `--reset` also empties every table that points at a customer, including the Scene 4 tables, and restarts
the `EXC-` and `CASE-` numbering. **Any future table that references a customer must be added to that reset.**

### Demo users ("Acting as")

There are no passwords. Choose a person in the sidebar; the app sends their ID in the `X-Reviewer-Id` header.

| Person | Role | Can do |
| --- | --- | --- |
| Vikram Analyst, Priya Analyst, Arjun Analyst | Operations Analyst | Work cases assigned to them, add notes, request information, start investigation, submit for review, escalate, resolve ordinary cases. Self-assign only. |
| Asha Reviewer, Rahul Reviewer, Neha Compliance | Compliance Reviewer | Assign anyone, review escalated and high-risk cases, approve or reject proposals, escalate, set Critical priority, complete periodic reviews |
| Meera Admin | Administrator | Everything the two roles can do |

The server re-checks every action. Hiding a button is a convenience, not security. This header is spoofable, so it is not
real authentication.

## 2. What each role can do

**Operations analyst:** see exceptions, create a case from one (or manually), assign it to themselves, start the
investigation, add notes, ask the customer for information, mark the customer as responded, send the case for compliance
review, and resolve cases that do not need approval.

**Compliance reviewer:** see every case, review High-Risk, PEP, Sanctions and Ownership cases, approve or reject a
proposed resolution, return a case to the analyst, escalate, reopen, and complete periodic reviews.

Screens: **Exceptions & Issues** (`/exceptions`), **Review Cases** (`/cases`), **Case Details** (`/cases/:id`, with
assignment, notes, timeline and resolution), **New case** (`/cases/new`, optionally `?exception=ID`), **Periodic Reviews**
(`/reviews`), six dashboard cards, and a review section on each customer profile.

## 3. Business rules

### 3.1 Exception detection

Detection reads the current Scene 1 to 3 records and records an exception for each condition that is true today:

| Area | Types |
| --- | --- |
| Document | mandatory missing, expired, expiring within 30 days, rejected, awaiting verification, requires resubmission |
| Ownership | no beneficial owners, above 100%, incomplete, requires investigation |
| Risk | high-risk customer, potential PEP, potential sanctions, risk assessment requires manual review |
| Review | periodic review overdue, approaching due date, previous review closed without proper resolution |

* Each exception has an ID (`EXC-000001`), customer, type, description, severity, detection date, status and a link to the
  source document, owner or review.
* **No duplicates:** a partial unique index on a dedupe key allows one active exception per condition. Detection can be
  run any number of times, even at the same moment, and creates nothing new while the condition persists.
* **Resolves itself:** when the condition clears, the exception is resolved with a recorded resolution type and notes. It
  is never deleted. If the condition returns later, a new exception is created and the old one stays as history.
* Severity comes from the rules file (for example Critical for a potential sanctions match; an overdue review rises to
  High after 30 days and Critical after 90).
* Risk "manual review" stays a **status**, separate from the risk level, as in Scene 3.

### 3.2 Review cases

* **Types:** Missing Documents, Expired Documents, Verification Issues, Ownership Issues, High-Risk Review, PEP
  Investigation, Sanctions Investigation, Periodic KYC Review, Other.
* **Statuses:** Open, Assigned, In Progress, Pending Customer, Escalated, Resolved, Closed.
* **Priority and due date:** Low, Medium, High, Critical. The default due date follows the SLA table (Critical 3 days,
  High 7, Medium 14, Low 30).
* A case from an exception takes the customer, type, priority and description from it. Only one active case may exist per
  exception (a duplicate is refused with `CASE_EXISTS` and a link to the existing case).

### 3.3 Workflow (decided by the backend)

```
Open -> Assigned -> In Progress <-> Pending Customer
                       |  \
                       |   -> Escalated -> Resolved   (approved by a compliance reviewer)
                       |                -> In Progress (rejected / returned)
                       -> Resolved -> Closed
Resolved / Closed -> reopened (a recorded transition)
```

* **Cannot resolve or close without resolution notes.** Enforced by the service and by a database CHECK constraint.
* **Compliance approval** is required for High-Risk, PEP, Sanctions and Ownership cases, for customers whose current risk
  is High, and for Critical priority. The analyst *submits for review*; the case becomes Escalated with a pending
  proposal; a reviewer approves (resolved) or rejects (back to In Progress).
* **Segregation of duties:** the person who proposed a resolution cannot approve it.
* **Never deleted:** history and notes are insert-only (database triggers); resolved cases stay. Reopening writes a
  `REOPENED` history row and the case continues with its earlier history intact.
* Every status change, assignment, priority change, note and resolution is a history row with who, when and why. The
  case timeline shows them all, newest first.
* When the underlying condition clears, linked exceptions resolve and the history records `EXCEPTION_RESOLVED`.

### 3.4 Periodic KYC reviews

* Intervals by risk level: **Low 36, Medium 24, High 12 months** (illustrative, configurable).
* Each customer has one *Scheduled* review (last review date, next due date, interval, cycle number). Completing it
  closes that row, and creates the next cycle from the review date, so the next due date is recalculated. If the risk
  level changed, detection re-bases the schedule on the new interval and notes it.
* **Overdue** and **upcoming (30 days)** lists, with days overdue.
* When a review is due, detection creates a *Periodic KYC Review* case. A partial unique index prevents two active
  periodic cases for the same customer and cycle.
* Completing a review needs completion notes and a compliance reviewer or administrator. It resolves the periodic case.

## 4. Database changes

Migration `prisma/migrations/20261101090000_scene4_review_cases/migration.sql`. Nothing from Scenes 1 to 3 was changed
except new back-relations on `Customer` and `Reviewer`.

| Table | Purpose |
| --- | --- |
| `Exception` | detected issues: code, customer, type, description, severity, source link, dedupe key, status, detected and resolved dates, resolution type and notes |
| `ReviewCase` | cases: code, customer, optional exception or schedule, title, type, description, priority, analyst, reviewer, status, due date, resolution notes, approval flags |
| `CaseHistory` | insert-only status and action history |
| `CaseNote` | insert-only internal notes |
| `ReviewSchedule` | periodic review cycles: risk level, last review, next review, interval, status, completion |

Notable constraints:

* `Exception_active_dedupe_key` (partial unique): one active exception per condition.
* `ReviewSchedule_one_scheduled_per_customer` and `ReviewCase_one_active_periodic_per_cycle` (partial unique).
* CHECKs on every status, priority and type list; `ReviewCase_resolution_notes_check` (Resolved/Closed need notes).
* Triggers block updates and deletes on history and notes, protect resolved exceptions, and guard status changes.
* Sequences give `EXC-` and `CASE-` codes. Writes that touch several tables run in transactions, with a per-customer
  advisory lock so two detection runs cannot interleave.

Migration instructions: `npm run db:migrate` (runs `prisma migrate deploy`; run `npm run db:generate` if the client needs regenerating).

## 5. API

All list endpoints take `page`, `pageSize`, `search` and filters; responses are `{ data, pagination }`.

| Method and path | Who | What |
| --- | --- | --- |
| GET `/api/exceptions` | anyone | list; filters `status` (active, Open, In Review, Resolved, all), `severity`, `type`, `group`, `customerId`, `withoutCase` |
| GET `/api/exceptions/:id` | anyone | one exception with linked cases |
| POST `/api/exceptions/detect` | any acting person | run detection (all customers or `{ customerId }`) |
| PATCH `/api/exceptions/:id/resolve` | any acting person | resolve manually with notes |
| GET `/api/review-cases` | anyone | list; filters `status` (or comma list, `active`, `closed`), `priority` (comma list), `caseType`, `customerId`, `assignedAnalystId`, `assignedReviewerId`, `unassigned`, `overdue` |
| POST `/api/review-cases` | any acting person | create from `exceptionId` / `reviewScheduleId`, or manually |
| GET `/api/review-cases/:id` | anyone (more detail when acting) | full case: customer, risk, exceptions, documents, ownership, timeline, `allowedActions`, `permissions` |
| PATCH `/api/review-cases/:id/assign` | role-limited | analyst, reviewer, priority |
| PATCH `/api/review-cases/:id/status` | role-limited | `action` (start, escalate, submit_for_review, approve, reject, resolve, close, reopen ...) with `remarks`, `resolutionNotes`, `reviewerId` |
| POST `/api/review-cases/:id/notes` | assigned people | add a note |
| GET `/api/review-cases/:id/history` | anyone | full history |
| GET `/api/review-schedules` | anyone | schedules; filters `status`, `riskLevel`, `customerId` |
| POST `/api/review-schedules` | reviewer, admin | create a schedule |
| POST `/api/review-schedules/:id/complete` | reviewer, admin | complete a review; returns the next cycle |
| GET `/api/reviews/upcoming`, `/api/reviews/overdue` | anyone | due in 30 days / past due |
| GET `/api/review-dashboard/summary` | anyone | card numbers |
| GET `/api/review-options` | anyone | lists for the forms |

Errors: 400 or 422 validation, 401 no acting person, 403 not allowed for this role or case, 404 not found, 409 duplicate or
invalid transition. Status changes are only accepted if the backend workflow allows them.

## 6. Synthetic data

`npm run generate:reviews -- --reset [--seed=20261022] [--as-of=2026-10-22]` uses seed **20261022**. It does not invent
exceptions or outcomes: it runs the real detection over the Scene 1 to 3 data, creates three extra demo users, five
explicit schedules (overdue by 20, 45 and 100 days; due in 15 and 25 days), then opens and moves cases through the real
services (so all history is genuine). Scenarios covered:

1 missing document, 2 expired document, 3 rejected document, 4 company ownership above 100%, 5 company with no owners,
6 high-risk customer needing manual review, 7 potential PEP match, 8 overdue periodic review, 9 upcoming periodic review,
10 escalated case, 11 case waiting for the customer, 12 case resolved with full notes (plus a resolved-and-closed case and
one closed without fixing the issue, which the next detection flags). Results with the default chain: 15 cases and about
122 exceptions.

## 7. Files

New: `prisma/migrations/20261101090000_scene4_review_cases/`; `server/src/config/reviewRules.js`;
`services/exceptionEngine.js`, `caseWorkflow.js`, `exceptionService.js`, `reviewScheduleService.js`,
`reviewCaseService.js`, `reviewDashboardService.js`; `utils/reviewValidation.js`; `middleware/optionalActor.js`;
`controllers/exceptionController.js`, `reviewCaseController.js`; `routes/reviews.js`; `scripts/generateReviewData.js`;
`server/tests/reviews.engine.test.js`, `reviews.api.test.js`; client `services/reviewApi.js`, `components/reviewUi.jsx`,
`CaseActionPanels.jsx`, `ReviewCards.jsx`, `CustomerReviewSection.jsx`, and pages `ExceptionsPage`, `ReviewCasesPage`,
`CaseDetailsPage`, `CaseFormPage`, `PeriodicReviewsPage`.

Changed: `prisma/schema.prisma`; `routes/index.js`; `utils/dates.js` (`addMonths`); `services/ownershipService.js`
(exports `buildOwnerAnalysis`, no behaviour change); `scripts/generateCustomers.js` (reset list); `package.json`;
client `App.jsx`, `Layout.jsx`, `DashboardPage.jsx`, `CustomerProfilePage.jsx`.

## 8. Test results

* `npm test`: **165 of 165 pass** (51 new: 22 engine tests and 29 API tests, plus the 114 from Scenes 1 to 3).
  New tests cover detection of missing and expired documents, ownership and high-risk conditions, no duplicate active
  exceptions (also under concurrent runs), cases from exceptions, assignment, blocked unauthorized actions, history,
  closure refused without notes, reviewer approval, reopening with history, overdue periodic reviews, and no duplicate
  periodic cases.
* Browser tests (headless Chrome): Scene 4 **46 of 46**; Scene 1 20 of 20, Scene 2 36 of 36, Scene 3 43 of 43 (regression).
  They cover the dashboard cards and their links, exception filters and idempotent detection, creating a case from an
  exception, assignment, role-based buttons, the submit, approve path, resolve refused without notes, reopening, the
  periodic review page, and mobile width (390 px) without horizontal scroll.

## 9. Known limitations

* No real login. "Acting as" is spoofable and stands in for authentication.
* Detection runs when asked (button or API) and after case changes; there is no background scheduler.
* Customers are not notified; "Pending Customer" is a status only.
* Intervals, SLA days and severities are illustrative assumptions, not regulatory rules.
* Sanctions and PEP outcomes come from Scene 3's synthetic screening. Nothing connects to a real list.
* Timestamps in the demo data are the run time, so only the structure is reproducible across runs.
* Scene 5 is not implemented.
