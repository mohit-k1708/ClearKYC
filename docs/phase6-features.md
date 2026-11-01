# Phase 6: the remaining high-priority KYC requirements

Five additions from the final audit. Nothing was reset or deleted; the schema change is one additive migration; every test ran on the dedicated test database `clearkyc_test`.

| # | Feature | Where to find it |
|---|---|---|
| 1 | Onboarding decisions (approve / reject) | Customer profile → "Onboarding decision"; `GET/POST /api/customers/:id/onboarding-decisions` |
| 2 | Name on the document vs. the registered name | Document form, list ("Name differs" badge), details, review screen, customer profile; data-quality check `DOC_NAME_MATCHES_CUSTOMER` |
| 3 | One owner across companies | Owner details → "All companies of this person"; `GET /api/beneficial-owners/:id/person`, `GET /api/people/:personRef` |
| 4 | Expiry alert settings | Sidebar → Reporting → "Expiry Alert Settings" (`/settings/expiry-alerts`); `GET/PUT /api/settings/expiry-alerts` |
| 5 | Detection as a background job | "Run detection" (Exceptions, Periodic Reviews) and "Refresh alerts" now start a job and show progress; `POST /api/detection-jobs`, `GET /api/detection-jobs[/:jobId]` |

Who may do what (the simulated "Acting as" identity, header `X-Reviewer-Id`): anyone can read; **Reviewer / Admin** record decisions and change settings (401 without a person, 403 for an Analyst); any identified person can start a detection job.

## 1. Onboarding decisions

* Table `OnboardingDecision` already existed (insert-only, reviewer-only trigger). It stores the decision, `decided_by_id`, `decided_at` and the reason (`notes`).
* **Workflow:** Pending Review → **Approved** or **Rejected**. Both are final: a customer has at most one final decision (partial unique index), so a second decision is refused with `409 DECISION_FINAL` and nothing is overwritten. History is returned newest first.
* **Reason is required** for both decisions (API validation and a database CHECK).
* **Approval needs complete evidence:** every mandatory document must be verified and unexpired today (the same standard the Phase 3 detector `APPROVED_WITH_MISSING_EVIDENCE` applies to existing approvals). Otherwise `409 APPROVAL_NOT_PERMITTED` with the list of blockers; the UI does not offer Approve and lists them. Rejecting never needs evidence.
* Unknown customer → 404. Each decision writes an `ONBOARDING_DECISION_RECORDED` audit event in the same transaction. Two simultaneous decisions: exactly one is recorded.

## 2. Name on the document

* The field `Document.name_on_document` already existed (Phase 3); it is now captured on the document form (optional), returned as `nameOnDocument` and compared (`nameCheck`: `Match`, `Mismatch` or `Not recorded`).
* **Normalisation strategy** (`server/src/utils/nameMatching.js`): both names are lower-cased, accents removed, punctuation turned into spaces, spaces collapsed; titles (Mr, Mrs, Shri, Dr ...) are dropped for people and legal-form words (Pvt, Private, Ltd, Limited, LLP, Inc, Corp, Co) for companies. Then the names match if they are identical, or have the same words in any order, or each word of the shorter name is matched by a different word of the longer one (initials like "A. Sharma", a missing middle name), or are at least 80% similar (one-letter spelling slips, edit distance). "A. S." can never match on initials alone.
* So **exact matches, case differences and extra or odd whitespace are matches**; a genuinely different name ("Pooja Deshmukh" for "Neha Kulkarni") is a mismatch.
* **A mismatch only flags.** The document is not rejected, its status does not change, and a reviewer can still verify it (noting a legitimate name change). It is shown on the document details and the review screen (with both names), as a badge in the documents list and on the customer profile. A `DOCUMENT_NAME_MISMATCH_FLAGGED` audit event is written on create, and on update only when the printed name changed. The Warning-level data-quality check lists every mismatch.
* Changing the printed name counts as a material change: an already-reviewed document goes back to Pending (like a changed date or file). On an edit, an absent field keeps the stored name and a blank field clears it. A document with no name is "Not recorded", never a mismatch.
* The matcher is the application's own code. `detector/nameMatcher.js` (Phase 3) stays independent; `server/tests/phase6.names.test.js` checks that both agree on the same cases and on every harmless variant the dataset generator can produce.

## 3. One owner across companies

A person who owns several companies has one `BeneficialOwner` row per company, grouped by `CompanyOwnership.person_ref` (`PER-` + 12 hex of a keyed hash of normalised name + date of birth; trigger-maintained). The view only **reads** these existing rows, with current companies (percentage, ownership type, control type, company risk, since when), earlier relationships, and the person's details (year of birth only, declared PEP in any company, highest owner risk). A person with one company shows one row.
**Limit:** an owner without a date of birth has reference `OWN-<id>` and cannot be recognised in other companies; the same name with a different date of birth is a different person. The page says so.

## 4. Expiry alert settings

* Default 90 / 60 / 30 / 7 (still in `config/expiryRules.js` as the fallback). Saved values live in the insert-only table `SystemSetting` (newest row = current; each row keeps who, when and why). The database refuses invalid values and non-reviewers too.
* **Validation** (API, screen messages and database CHECK): 1 to 8 values, whole numbers, greater than zero, at most 3650, no duplicates, **listed from largest to smallest** (an unordered list is rejected, never silently re-sorted). An unchanged list is refused.
* **Detection reads the saved value at the start of every run** (`exceptionService.loadContexts` → `detectConditions`), so alerts use the saved settings, not hard-coded ones; the change applies the next time detection runs (Refresh alerts). Alerts for old windows are closed with their history kept. Each change writes a `SETTING_CHANGED` audit event.

## 5. Detection as a background job

`POST /api/detection-jobs` answers **202 at once** with a job ID (`DET-yyyymmdd-xxxxxx`). `GET /api/detection-jobs/:jobId` returns status (`Running` / `Completed` / `Failed`), `processed`, `total`, `percent`, timings, who started it, the result or the error. The screens poll every 0.7 s and show "Checking… n/total (p%)".

* **One job at a time:** a second start gets `409 DETECTION_ALREADY_RUNNING` with the running job's ID; the screens join that job instead of failing.
* The work is the same `exceptionService.detect`: one transaction per customer, safe to repeat, same results, alerts and audit events as before (plus a `DETECTION_JOB_FINISHED` event). The synchronous `POST /api/exceptions/detect` and `/api/alerts/refresh` still work.
* **Failure:** the job is `Failed` with the message and the progress reached; customers already checked stay saved and running detection again finishes the rest.
* **Limits:** jobs are kept in the server's memory (last 20), so a restart forgets them (a running job stops with the server; re-run it); only one API process is supported. The job does not make detection itself faster (about 78 s at 8,000 customers); it stops that time from blocking one request.

## Schema change and rollback

Migration `prisma/migrations/20261107090000_phase6_settings_and_decisions/migration.sql` (additive): table `SystemSetting` with its CHECK, immutability triggers and reviewer-role trigger; on `OnboardingDecision` a unique index "one final decision per customer" and a CHECK "a decision needs a reason". Existing rows must satisfy both (the generator and the edge-case injector already do).

* **Apply:** `npm run db:migrate` (`prisma migrate deploy`). The test database receives it automatically. **The development database `clearkyc` has not been migrated yet**: stop the API, run `npm run db:migrate`, restart.
* **Rollback:** Prisma has no automatic rollback, so `rollback.sql` in the same folder undoes it (drops the constraint, index, `SystemSetting` and the two functions); then delete this migration's row from `_prisma_migrations`. Run it only against a database you have backed up (`npm run db:backup`). The rollback was exercised on a scratch copy of the test database.
* The dataset export treats `SystemSetting` as application configuration, not KYC data: it is left out of `ClearKYC-Dataset/` and the generator reset truncates it with `Reviewer`. The dataset package was rebuilt after Phase 6 on disposable databases (`docs/submission-readiness.md`, section 10); the generated data is unchanged.

## Tests

Backend (`npm test`): `phase6.settings`, `phase6.decisions`, `phase6.names`, `phase6.person`, `phase6.detectionJob`. Browser (`npm run test:browser`): `tests/browser/phase6-features.js`. Results: `docs/submission-readiness.md`.

## Not done / limits

No real authentication (unchanged). Job state is in memory. People without a date of birth are not linked across companies. The approval rule needs verified, unexpired mandatory evidence and does not consider open exceptions. Name matching is text-only: a genuine change of name is flagged for a person to decide.

---

# Policy review (final submission phase)

This section documents what the application does **today**. No business rule was changed in this phase. Where a policy choice exists it is marked **DECISION NEEDED**.

## A. Approval policy for open exceptions (decided and implemented)

Decided by the product owner and implemented without a database migration (`server/src/config/approvalPolicy.js`, `services/onboardingDecisionService.js`). "Open" means an exception whose status is **Open** or **In Review**; Resolved exceptions never count.

| Situation | What happens |
|---|---|
| An open **Critical or High** exception | **Blocks approval** (409 `APPROVAL_BLOCKED_BY_EXCEPTIONS`, with the list). The screen shows each blocking exception (ID, severity, type, description) and explains why approval is unavailable. |
| An open **Medium or Low** exception | Does **not** block. Approving needs the **rationale** (the decision reason, always required) **and a follow-up action** (400 with a message on the field if it is missing). |
| **No** open exception | Approval follows the existing rule: every mandatory document verified and unexpired. No follow-up needed. |
| A **waiver** | An authorised reviewer (Reviewer or Admin; an Analyst gets 403) may waive a blocking exception **for one approval**, only with a **non-empty reason per exception** (max 500 characters). Every blocking exception needs its own waiver; a partial waiver is refused. |
| Missing or invalid **mandatory evidence** | **Never waivable**: the evidence rule is checked first and refuses the approval whatever the waivers say. |
| **Rejecting** | Not affected by exceptions; a waiver sent with a rejection is refused (400). |

How a waiver is recorded: in the same transaction as the decision, one audit event `ONBOARDING_EXCEPTION_WAIVED` per waived exception (who, the exception ID and severity, the reason, the decision it belongs to; visible in the Audit Trail), plus the decision's own audit event with the follow-up action and the exceptions open at that moment (marked waived or not). The waiver does **not** change the exception: it stays open (resolve it through the normal workflow) and its history is untouched. The decision history screen shows the follow-up action, the open exceptions and the waivers of every decision. Refused attempts record nothing.

How the policy stays current: before an approval is judged, the customer's exceptions are refreshed (the same per-customer detection the Exceptions page runs, without creating cases), so a problem that appeared since the last detection run cannot slip through, and the judgement is repeated inside the transaction. The decision screen reads the stored exceptions, so it can show a blocker only after the next detection or approval attempt; the refusal then shows it.

Notes and limits:

* Severity is the exception's own severity (set by the detection rules, for example a potential sanctions match is Critical and ownership above 100% is High); the policy does not re-rate it.
* Where the follow-up action and waivers are stored: in the audit trail (immutable, written in the same transaction), not in new columns, so the `OnboardingDecision` table and the dataset export are unchanged. The decision history screen reads them back from there.
* The Phase 3 detector rule `APPROVED_WITH_MISSING_EVIDENCE` still judges only evidence; it does not know about exceptions, so an approval made under a waiver is not flagged by it (it is allowed by policy and has its own audit trail).
* The follow-up action is recorded, not scheduled: no task, case or reminder is created from it.
* While building this a latent race was found and fixed: two detections reaching the same new customer at the same moment both tried to create its first review schedule and one failed with a 500. The loser now treats the unique-index violation as "already done" (`reviewScheduleService.ensureSchedules`). Regression test: `phase7.approvalPolicy.test.js` ("concurrent detections and concurrent approvals").

## B. The exact conditions for a decision

A decision is recorded only when **all** of these hold (otherwise nothing is written):

1. The caller is an identified, active **Reviewer or Admin** (header `X-Reviewer-Id`): 401 if missing or unknown, 403 for an Analyst. The database trigger checks the role again.
2. The customer exists (404) and the ID is well-formed (400).
3. `decision` is exactly `Approved` or `Rejected` (400 otherwise; "Pending Review" cannot be recorded by the API).
4. `reason` is not blank and at most 1,000 characters (400; also a database CHECK).
5. The customer has **no final decision yet** (409 `DECISION_FINAL`; a database unique index also stops two simultaneous decisions).
6. For **Approved** only: the customer has a risk rating, and **every mandatory document** required for the customer's type and current risk level (requirements in force today) is **Verified** (the latest verification decision) **and not expired today** (409 `APPROVAL_NOT_PERMITTED` with the list). A document that is verified and expiring soon still counts. Rejecting never needs evidence.
7. For **Approved** only, the approval policy of section A: no open Critical or High exception unless waived by a Reviewer or Admin with a reason each (409 `APPROVAL_BLOCKED_BY_EXCEPTIONS`; 400 for a missing or blank waiver reason), and a follow-up action when Medium or Low exceptions are open (400).

What does **not** matter: open Medium or Low exceptions (they only need a follow-up action), alerts, the risk level by itself, a name-on-document mismatch, optional documents, and whether a review case is open. (Open Critical and High exceptions do matter: section A.)

## C. How cross-company owner matching works, and its limits

* Two owner records are the same person when they have the same **identity hash**: a keyed HMAC-SHA-256 (key `HASH_KEY`) of `lower-cased name with spaces collapsed | date of birth`. The bridge table `CompanyOwnership` stores `person_ref = PER-<first 12 hex>` for each relationship; database triggers keep it in step with the owner rows (including when an owner is edited: adding or correcting a date of birth re-links the owner, covered by a test).
* **Missing date of birth:** no hash can be made, the owner gets `OWN-<id>` and is shown with **their one company only**. A name alone is not a safe identity, so the application never guesses. The person page says so.
* **Only capitals and repeated spaces are normalised.** "Kavita Rao", "KAVITA  RAO" and "kavita rao" are one person; but "Dr Kavita Rao", "Kavita R.", "Kavita  Rao-Iyer" or a different spelling are **different** people (missed links, never wrong links). The name-on-document check is deliberately more tolerant (titles, initials, spelling) because a human then reviews it; owner identity is stricter because a wrong merge would mix two people's companies.
* The same name with a different date of birth is a different person. A genuine duplicate that was entered with a typo in the date of birth stays two people until someone corrects it.
* Changing `HASH_KEY` breaks the links of existing rows (also documented for duplicate detection); the dates of birth are encrypted and only the birth year is shown on the page.

## D. Detection jobs after a restart, and the single-process limit

* Jobs are held in the memory of the one API process (the 20 most recent). **After a restart every job is forgotten**: `GET /api/detection-jobs/<old id>` answers 404, and the list is empty.
* A job that was **running when the server stopped is lost, not resumed**. Detection commits one customer at a time and is safe to repeat, so customers already processed stay saved, nothing is duplicated, and starting a new job finishes the rest. The audit trail only has a "Detection run finished" event for jobs that ended while the server was up.
* **Single process only.** The "one job at a time" guard lives in that process. If two API processes were started against the same database, each could run a job at the same time; data would stay correct (detection takes a per-customer database lock) but the work would be duplicated. The synchronous endpoints (`POST /exceptions/detect`, `POST /alerts/refresh`) are not counted by the guard either, for the same reason. A shared guard would need a database-backed job table; it was not built.
* The screens that start a job poll it; if the server restarts while a screen is waiting, the screen shows an error (the job id is unknown) and the user can start detection again.

## E. The reviewer selector is a simulated identity, not authentication

The sidebar "Acting as" selector lists the demo people; the choice is remembered in the browser and sent as the header `X-Reviewer-Id`. There is **no password, session or token**: anyone who can reach the API can send any ID (the list of people is itself open). What is enforced is the **role of the chosen ID** (Analyst / Reviewer / Admin) by the API and again by database triggers, and every audited action records the chosen person. It demonstrates authorisation rules; it does not prove who is calling. Production would need real authentication (and then the same role checks would apply to the authenticated user). Requirement A18 stays **Partial** for this reason.
