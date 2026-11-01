# Document Expiry: Current Implementation, the Gap, and the Plan

> **Phase 6 status (implemented, simpler than the design in section 4).** The lead times can now be changed on a screen (Expiry Alert Settings, `/settings/expiry-alerts`; `GET` and `PUT /api/settings/expiry-alerts`; Reviewer or Admin only). What was built differs from the proposal below: the table `SystemSetting` has the columns `id, key, value, changed_by_id, reason, created_at` (the newest row is current; there is no `version` or `effective_from`), the only key is `expiry_alert_days` (a JSON list of 1 to 8 whole numbers from 1 to 3650, unique, largest first; rejected, never re-sorted), `expiringSoonDays` and severity-by-threshold are **not** configurable (the 30-day "expiring soon" window stays fixed), and the audit action is `SETTING_CHANGED` (not `SETTINGS_CHANGED`). Detection reads the saved list at the start of every run (so no restart is needed), alerts for a window that is no longer configured are closed with their history kept, and `enabled` is still a code constant. See `docs/phase6-features.md`. The text below is kept as the original design record.
>
> **Phase 2 status (implemented).** Configurable expiry lead times now exist. `server/src/config/expiryRules.js` holds `EXPIRY_ALERT_CONFIG = { enabled: true, expiryAlertDays: [90, 60, 30, 7] }` and `leadTimeFor(daysToExpiry)` (the tightest threshold that is at least the days left; `null` when disabled, already expired or beyond the largest threshold). The exception engine raises an alert-only condition for verified, still-valid documents 31-90 days from expiry (`expiryLeadConditions`) and tags the existing "expiring within 30 days" condition with its threshold (30 or 7). The alert key is `<condition key>|T<threshold>`, so there is **one alert per document, expiry date and threshold**; when a document reaches a closer threshold the earlier alert is resolved ("Condition cleared") by the existing sync, and only the closest threshold is active. `Alert.threshold` stores the lead time. An expired document is never a lead-time alert, even if its verification says Verified. Boundary tests (91, 90, 61, 60, 31, 30, 8, 7, 1, 0, -1 days) are in `server/tests/generator.test.js`. The configuration lives in a code file, not in a database settings table (see the known limitations in `generator/README.md`). The sections below describe the state **before** this change.

This document explains exactly how document expiry and expiry alerts work **today**, how that compares with the required configurable lead times (90, 60, 30 and 7 days), and a safe plan to close the gap. Nothing has been changed in the database or the code.

## 1. Requirements at a glance

| Requirement | Today |
|---|---|
| Expiry calculated from the actual document expiry date | **Yes** |
| Configurable lead times 90 / 60 / 30 / 7 days | **No.** One fixed 30-day window |
| Configuration model (suggested `{ "expiryAlertDays": [90,60,30,7], "enabled": true }`) | **No.** A constant in a code file |
| No duplicate alerts for the same document and threshold | **Partly.** One active alert per document; there is no per-threshold alert |
| An expired document identified separately | **Yes** (its own exception type and alert type) |
| An expired document is not counted as valid verified evidence | **Yes** |
| Configuration changes without modifying business logic | **No.** Needs a code edit and restart |
| Existing alert history preserved | **Yes** |

## 2. How it works today

### 2.1 The setting

`server/src/config/kycRules.js`:

```js
const EXPIRY_WARNING_DAYS = 30;   // "expiring soon" = expires within 30 days (inclusive)
```

`server/src/config/reviewRules.js` holds one related number, used only for severity:

```js
SEVERITY_RULES.expiringSoonDaysToMedium = 7   // 7 days or fewer = Medium, otherwise Low
```

Changing either means editing a file and restarting the server. There is no database table or screen for it.

### 2.2 Where the setting is used

| File | Use |
|---|---|
| `server/src/services/kycEngine.js` | `expiryInfo(expiryDate, asOf, warningDays = EXPIRY_WARNING_DAYS)` decides **Expired / Expiring Soon / Valid / No Expiry**; `effectiveStatus()` and `isCurrentlyValid()` |
| `server/src/services/exceptionEngine.js` | Creates the `DOCUMENT_EXPIRING_SOON` and `DOCUMENT_EXPIRED` conditions and their severity |
| `server/src/services/alertEngine.js`, `alertService.js` | Turn those conditions into alerts of type `DOCUMENT_EXPIRY` and `DOCUMENT_EXPIRED` |
| `server/src/services/documentService.js` | The "expiring soon / valid" filter of the document list |
| `server/src/services/analyticsService.js` | The "documents expiring within 30 days" KPI |
| `server/src/services/kycService.js` | The text "Verified, but expires within 30 days" |
| Frontend | The words "within 30 days" on several screens |

### 2.3 Rules of the calculation

All dates are calendar dates (UTC), compared as whole days from the "as of" date (today in normal use; a fixed date in the generator and tests).

| Situation | State | Test that proves it |
|---|---|---|
| `expiry_date < today` | **Expired** | `kyc.engine.test.js`: "expiry boundaries …" |
| `expiry_date = today` | Expiring Soon (still valid today) | same |
| `expiry_date` within 30 days (inclusive) | Expiring Soon | same |
| `expiry_date` on day 31 or later | Valid | same |
| no expiry date | No Expiry | same |

An expired document is overridden to **Expired** whatever its verification status says (`effectiveStatus`). In the completeness calculation an Expired requirement is its own bucket and is never counted as verified (`kyc.engine.test.js`: "an expired document with a Verified status does NOT count as currently valid"). Completeness = verified ÷ mandatory, where verified excludes expired documents.

### 2.4 How alerts come from it

1. Detection evaluates each customer's documents with the engine.
2. A verified document inside the 30-day window produces the condition `DOCUMENT_EXPIRING_SOON` (severity **Medium** if 7 days or fewer remain, otherwise **Low**). A document past its expiry date produces `DOCUMENT_EXPIRED` (severity **High** if the document is mandatory, otherwise Medium).
3. Each condition has a key: `customer | type | Document | document id`. Only one **active** alert (and exception) can exist for a key (partial unique index).
4. The alert's `due_date` is the document's expiry date.
5. When the document is renewed or the date moves out of the window, the condition disappears and the alert is resolved automatically ("Condition cleared"). When the document passes its expiry date, the "expiring soon" alert clears and a separate "expired" alert is raised. Closed alerts stay as history.

### 2.5 What this means for the four lead times

* The system only alerts from **30 days** before expiry. Nothing happens at 90 or 60 days.
* Because the key is per document, there is **one** expiry alert per document, not one per threshold. As the date approaches, the same alert's severity is updated in place at 7 days (no new alert, no audit event for that refresh).
* The 7-day severity rule is a second, separate constant.

## 3. Gap analysis

| # | Gap | Impact |
|---|---|---|
| 1 | Lead times are a single constant (30) | Cannot alert at 90, 60 or 7 days |
| 2 | No configuration store | Changing a lead time needs a code change and restart |
| 3 | No alert per (document, threshold) | "Avoid duplicates for the same document and threshold" cannot even be expressed |
| 4 | Severity by threshold is another hard-coded rule | Severity cannot follow the lead time |
| 5 | The 30-day wording and KPI are fixed | Screens and analytics would need to follow the setting |
| 6 | Configuration changes are not audited | No record of who changed a lead time and when |

## 4. Proposed design (not executed)

### 4.1 Configuration model: a versioned settings table

Use the database, so an administrator can change it without touching code. A new small table `SystemSetting`:

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK | |
| `setting_key` | TEXT | e.g. `expiry_alerts` |
| `value` | JSONB | the configuration (below) |
| `version` | INTEGER | 1, 2, 3 … per key |
| `effective_from` | TIMESTAMP | when this version applies |
| `created_by_id` | INTEGER → Reviewer | who changed it |
| `created_at` | TIMESTAMP | |

Insert-only: a change is a **new version**, so every earlier configuration is preserved. The current setting is the newest version. If no row exists, the system falls back to the defaults in code (the values below), so behaviour never depends on a seed row.

Value (the suggested shape, plus two optional keys with safe defaults):

```json
{
  "enabled": true,
  "expiryAlertDays": [90, 60, 30, 7],
  "expiringSoonDays": 30,
  "severityByDays": { "90": "Low", "60": "Low", "30": "Medium", "7": "High" }
}
```

Validation (rejected with a clear message): `expiryAlertDays` is a non-empty list of **unique whole numbers from 1 to 365**, at most 8 entries (stored sorted, largest first); `expiringSoonDays` is one of them or a number from 1 to 365; severities are Low, Medium, High or Critical; `enabled` is true or false.

API (Admin only; changes are audited as a new `SETTINGS_CHANGED` event): `GET /api/settings/expiry-alerts` and `PUT /api/settings/expiry-alerts` (creates the next version).

### 4.2 Alert behaviour per threshold

For each document with an expiry date and `days = expiry_date − today`:

* The document is in the **current threshold** `T` = the smallest configured value that is greater than or equal to `days` (for example 45 days left → T = 60; 20 days left → T = 30; 5 days left → T = 7). More than the largest threshold away → no alert.
* **One alert per document, expiry date and threshold.** Its key is `customer | DOCUMENT_EXPIRING_SOON | Document | document id | expiry date | T`. Including the expiry date means a renewed document (new date) starts fresh; including `T` means each threshold is raised **once**.
* When the document moves from threshold 90 to 60, the new 60-day alert is created and the 90-day alert is closed ("superseded by a closer threshold"). Closed alerts stay as history, and the same (document, date, threshold) is never raised twice even if detection runs many times or runs again after the alert was closed.
* The exception for the document stays **one** exception (its severity follows the current threshold), so the Exceptions screen and the review cases do not multiply.
* **Expired** is unchanged and separate: `expiry_date < today` raises `DOCUMENT_EXPIRED` and closes the lead-time alert.
* An expired document is never counted as valid evidence (unchanged; it is in the completeness engine).

### 4.3 Changing the configuration

* Applied at the next detection run; no code change, no restart.
* Alerts already raised are **not deleted**. Active alerts for a threshold that is no longer configured are closed at the next detection ("Condition cleared"), so history is preserved and the active list matches the configuration.
* `enabled: false`: no lead-time alerts are raised (expired alerts still are); active lead-time alerts clear. Documents still show their expiry state.

### 4.4 Other places that follow the setting

The "expiring soon" window in `expiryInfo` takes `expiringSoonDays` (default 30) so the document filter, completeness and the KPI keep their current meaning. The analytics KPI keeps the existing `documentsExpiringWithin30Days` field and gains a count per configured threshold. Screen text reads the number instead of saying "30".

## 5. Migration plan

| Step | Change | Risk |
|---|---|---|
| 1 | Create `SystemSetting` (new table, additive); add the audit action `SETTINGS_CHANGED` | None for existing data |
| 2 | Add a settings reader with in-code defaults identical to today's behaviour plus the lead times | Behaviour unchanged until a setting is saved |
| 3 | Thread the configuration into `kycEngine`, `exceptionEngine`, `alertEngine` (the engines stay pure functions: configuration is passed in) | Covered by the existing engine tests |
| 4 | Per-threshold alert key and supersede logic | Existing alerts keep their old keys and close normally when their condition clears |
| 5 | Settings endpoints and a small Admin screen | New only |
| 6 | Update the "30 days" wording and KPI | Cosmetic |

**Existing data is preserved:** no existing row is edited or deleted. Existing alerts (94 in the seed) keep their codes, keys and history. The next detection run reconciles them with the configuration in the normal way (old per-document alerts close as "Condition cleared" and per-threshold alerts open), which is recorded in the audit trail.

**API compatibility:** no existing endpoint changes shape. Alert responses may gain a `threshold` field; the `DOCUMENT_EXPIRY` alert type and exception type names stay.

## 6. Tests

* Pure unit tests with boundaries: 91, 90, 61, 60, 31, 30, 8, 7, 1, 0 and −1 days; no expiry date; each returns the expected threshold and state.
* One alert per (document, expiry date, threshold) after repeated and simultaneous detections; a second threshold supersedes the first; renewing the document (new date) starts a new sequence.
* `enabled: false`, a changed list, and invalid configurations (empty list, duplicates, 0, 366, text) behave as described.
* The configuration is versioned: an old version can still be read; a change writes an audit event; only an Admin can change it.
* An expired but "Verified" document is not counted as valid evidence (existing test kept).
* The existing 216 backend tests and the browser suites still pass; the seed data is regenerated with `--as-of` to prove the same results.

## 7. Verdict

**PARTIALLY COMPLETE.** The date calculations, the separate handling of expired documents, the rule that expired documents are not valid evidence, duplicate prevention per document and history preservation are all in place and tested. Configurable lead times (90/60/30/7), a configuration store, per-threshold alerts and audited configuration changes are **not implemented**.
