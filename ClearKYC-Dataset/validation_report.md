# Dataset validation report

Reference date 2026-10-31 - **PASSED**

* 182 checks: 179 passed, 3 passed with expected exceptions, 0 failed.
* Deliberately planted anomalies (expected): 310 labelled issues; 150 violations are explained by them.
* Unexpected data errors (accidental corruption): **0**.

| Group | Check | Result | Violations | Expected | Unexpected | Planted issues involved |
|---|---|---|---:|---:|---:|---|
| Primary keys | CustomerType primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | Reviewer primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | KYCRequirement primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | Customer primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | BeneficialOwner primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | OwnerScreening primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | OwnershipValidation primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | CompanyOwnership primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | Document primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | Verification primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | RiskRating primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | OnboardingDecision primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | ReviewSchedule primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | Exception primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | ReviewCase primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | CaseHistory primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | CaseNote primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | Alert primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | AuditEvent primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | ValidationRun primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | ValidationIssue primary key is unique | PASS | 0 | 0 | 0 |  |
| Primary keys | IdCounter primary key (scope, period) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Customer ID (CUS-000001) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | Customer ID (CUS-000001) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | Customer ID (CUS-000001) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | KYC requirement ID (KYC-2026-000001) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | KYC requirement ID (KYC-2026-000001) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | KYC requirement ID (KYC-2026-000001) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Document ID (DOC-CUS-000001-001) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | Document ID (DOC-CUS-000001-001) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | Document ID (DOC-CUS-000001-001) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Review ID (REV-CUS-000001-2026) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | Review ID (REV-CUS-000001-2026) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | Review ID (REV-CUS-000001-2026) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Case ID (CASE-000001) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | Case ID (CASE-000001) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | Case ID (CASE-000001) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Alert ID (ALT-2026-000001) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | Alert ID (ALT-2026-000001) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | Alert ID (ALT-2026-000001) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Alert code (ALT-000001) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | Alert code (ALT-000001) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | Alert code (ALT-000001) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Exception ID (EXC-000001) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | Exception ID (EXC-000001) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | Exception ID (EXC-000001) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Risk assessment ID (RSK-000001) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | Risk assessment ID (RSK-000001) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | Risk assessment ID (RSK-000001) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Audit event ID (AUD-000001) is present | PASS | 0 | 0 | 0 |  |
| Identifiers | Audit event ID (AUD-000001) follows the documented format | PASS | 0 | 0 | 0 |  |
| Identifiers | Audit event ID (AUD-000001) is unique | PASS | 0 | 0 | 0 |  |
| Identifiers | Document ID belongs to its own customer | PASS | 0 | 0 | 0 |  |
| Identifiers | Review ID belongs to its own customer and year | PASS | 0 | 0 | 0 |  |
| Identifiers | Alert ID year matches the year the alert was created | PASS | 0 | 0 | 0 |  |
| Identifiers | KYC requirement ID year matches its effective year | PASS | 0 | 0 | 0 |  |
| Foreign keys | Alert.acknowledged_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | Alert.customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | Alert.exception_id references an existing Exception | PASS | 0 | 0 | 0 |  |
| Foreign keys | Alert.resolved_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | AuditEvent.user_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | BeneficialOwner.created_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | BeneficialOwner.customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | BeneficialOwner.updated_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | CaseHistory.changed_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | CaseHistory.review_case_id references an existing ReviewCase | PASS | 0 | 0 | 0 |  |
| Foreign keys | CaseNote.author_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | CaseNote.review_case_id references an existing ReviewCase | PASS | 0 | 0 | 0 |  |
| Foreign keys | CompanyOwnership.beneficial_owner_id references an existing BeneficialOwner | PASS | 0 | 0 | 0 |  |
| Foreign keys | CompanyOwnership.company_customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | Customer.customer_type_id references an existing CustomerType | PASS | 0 | 0 | 0 |  |
| Foreign keys | Document.customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | Document.requirement_id references an existing KYCRequirement | PASS | 0 | 0 | 0 |  |
| Foreign keys | Exception.customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | Exception.resolved_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | KYCRequirement.customer_type_id references an existing CustomerType | PASS | 0 | 0 | 0 |  |
| Foreign keys | OnboardingDecision.customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | OnboardingDecision.decided_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | OwnerScreening.beneficial_owner_id references an existing BeneficialOwner | PASS | 0 | 0 | 0 |  |
| Foreign keys | OwnerScreening.screened_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | OwnershipValidation.checked_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | OwnershipValidation.customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | ReviewCase.assigned_analyst_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | ReviewCase.assigned_reviewer_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | ReviewCase.created_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | ReviewCase.customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | ReviewCase.exception_id references an existing Exception | PASS | 0 | 0 | 0 |  |
| Foreign keys | ReviewCase.proposed_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | ReviewCase.review_schedule_id references an existing ReviewSchedule | PASS | 0 | 0 | 0 |  |
| Foreign keys | ReviewSchedule.completed_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | ReviewSchedule.customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | RiskRating.assessed_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | RiskRating.customer_id references an existing Customer | PASS | 0 | 0 | 0 |  |
| Foreign keys | ValidationIssue.validation_run_id references an existing ValidationRun | PASS | 0 | 0 | 0 |  |
| Foreign keys | ValidationRun.created_by_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | Verification.document_id references an existing Document | PASS | 0 | 0 | 0 |  |
| Foreign keys | Verification.reviewer_id references an existing Reviewer | PASS | 0 | 0 | 0 |  |
| Foreign keys | Alert source record exists (document, requirement, owner, customer, schedule) | PASS | 0 | 0 | 0 |  |
| Foreign keys | Exception source record exists | PASS | 0 | 0 | 0 |  |
| Foreign keys | Audit event points at an existing entity | PASS | 0 | 0 | 0 |  |
| Foreign keys | Audit event reference code matches the record it names | PASS | 0 | 0 | 0 |  |
| Customers | Customer type is Individual (1) or Company (2) | PASS | 0 | 0 | 0 |  |
| Customers | Required fields are present | PASS | 0 | 0 | 0 |  |
| Customers | Country is one of the known country codes | PASS | 0 | 0 | 0 |  |
| Customers | E-mail and phone have a valid shape | PASS | 0 | 0 | 0 |  |
| Customers | Individual fields: date of birth + occupation, no company fields | PASS | 0 | 0 | 0 |  |
| Customers | Company fields: registration number, activity, incorporation date, no personal fields | PASS | 0 | 0 | 0 |  |
| Customers | Individuals were adults when onboarded and are not born in the future | PASS | 0 | 0 | 0 |  |
| Customers | Companies were incorporated on or before the onboarding day | PASS | 0 | 0 | 0 |  |
| Customers | Onboarding dates are valid and not after the reference date | PASS | 0 | 0 | 0 |  |
| Customers | Registration status is an allowed value | PASS | 0 | 0 | 0 |  |
| Documents | Issue date is not after the submission date | PASS | 0 | 0 | 0 |  |
| Documents | Expiry date is not before the issue date | PASS | 0 | 0 | 0 |  |
| Documents | Document type is an allowed value | PASS | 0 | 0 | 0 |  |
| Documents | Document status is an allowed value | PASS | 0 | 0 | 0 |  |
| Documents | Submitted on or after onboarding and not after the reference date | PASS | 0 | 0 | 0 |  |
| Documents | Type matches its requirement and the requirement matches the customer type | PASS | 0 | 0 | 0 |  |
| Documents | The name written on the document is captured | PASS | 0 | 0 | 0 |  |
| Documents | A document is not verified after it has expired | PASS (expected exceptions) | 60 | 60 | 0 | 60 (ISSUE-000001, ISSUE-000002, ISSUE-000003, ...) |
| Verifications | Verification status is an allowed value | PASS | 0 | 0 | 0 |  |
| Verifications | Every document has a history that starts with one system Pending record | PASS | 0 | 0 | 0 |  |
| Verifications | History is in time order (a later record never carries an earlier date) | PASS | 0 | 0 | 0 |  |
| Verifications | The latest decision (by date, then id) is the document status | PASS | 0 | 0 | 0 |  |
| Verifications | Decisions are made by active Reviewers or Admins | PASS | 0 | 0 | 0 |  |
| Verifications | A rejection or resubmission request explains itself | PASS | 0 | 0 | 0 |  |
| Ownership | Each ownership percentage is above 0 and at most 100 | PASS | 0 | 0 | 0 |  |
| Ownership | Beneficial owners belong to companies only | PASS | 0 | 0 | 0 |  |
| Ownership | Every company has at least one owner recorded | PASS | 0 | 0 | 0 |  |
| Ownership | Ownership above 100% is flagged: the owners of a company must not total more than 100 | PASS (expected exceptions) | 40 | 40 | 0 | 40 (ISSUE-000111, ISSUE-000112, ISSUE-000113, ...) |
| Ownership | Ownership below 100% is flagged: the owners of a company must total 100 | PASS | 0 | 0 | 0 |  |
| Ownership | Owners were recorded after their company was onboarded | PASS | 0 | 0 | 0 |  |
| Ownership | Company-owner relationships mirror the owner rows (company, owner, percentage) | PASS | 0 | 0 | 0 |  |
| Ownership | Only one current relationship per company and owner | PASS | 0 | 0 | 0 |  |
| Ownership | A person appears at most once per company | PASS | 0 | 0 | 0 |  |
| Ownership | Relationship history is consistent (ends after it starts, no overlap for one owner) | PASS | 0 | 0 | 0 |  |
| Risk | Every customer has a risk assessment | PASS | 0 | 0 | 0 |  |
| Risk | Risk category matches the configured score thresholds | PASS | 0 | 0 | 0 |  |
| Risk | History: the first assessment has no previous level, later ones record the earlier level | PASS | 0 | 0 | 0 |  |
| Risk | History is in date order and inside the dataset period | PASS | 0 | 0 | 0 |  |
| Decisions | Every customer has a Pending Review entry from onboarding | PASS | 0 | 0 | 0 |  |
| Decisions | Decisions are dated between onboarding and the reference date | PASS | 0 | 0 | 0 |  |
| Decisions | Approvals and rejections are by active Reviewers or Admins | PASS | 0 | 0 | 0 |  |
| Decisions | A customer is approved at most once and never after being rejected | PASS | 0 | 0 | 0 |  |
| Review cases | Case status and priority are allowed values | PASS | 0 | 0 | 0 |  |
| Review cases | Closed cases have resolution notes | PASS (expected exceptions) | 50 | 50 | 0 | 50 (ISSUE-000151, ISSUE-000152, ISSUE-000153, ...) |
| Review cases | Resolved cases have resolution notes | PASS | 0 | 0 | 0 |  |
| Review cases | Resolved and closed cases carry their resolved / closed dates, in order | PASS | 0 | 0 | 0 |  |
| Review cases | Due date = creation date + the SLA of its priority (periodic reviews: the schedule date) | PASS | 0 | 0 | 0 |  |
| Review cases | Cases belong to the customer of their exception and schedule | PASS | 0 | 0 | 0 |  |
| Review cases | Active cases belong to active exceptions; Resolved / Closed cases to resolved ones | PASS | 0 | 0 | 0 |  |
| Review cases | Cases are created after their exception was detected | PASS | 0 | 0 | 0 |  |
| Review cases | Overdue active cases (past their due date) - informational | INFO | 633 | 0 | 0 |  |
| Review cases | Every overdue periodic review has its active case | PASS | 0 | 0 | 0 |  |
| Review cases | Exactly one current review schedule per customer | PASS | 0 | 0 | 0 |  |
| Review cases | Active exceptions are unique per condition | PASS | 0 | 0 | 0 |  |
| Review cases | Resolved exceptions record how and when they were resolved | PASS | 0 | 0 | 0 |  |
| Alerts | No duplicate active alert for the same source issue and threshold | PASS | 0 | 0 | 0 |  |
| Alerts | One expiry alert per document and threshold | PASS | 0 | 0 | 0 |  |
| Alerts | Expiry thresholds are 90, 60, 30 or 7 | PASS | 0 | 0 | 0 |  |
| Alerts | Resolved and dismissed alerts record how, when and why | PASS | 0 | 0 | 0 |  |
| Alerts | Active alerts have no resolution data; acknowledged alerts name who acknowledged | PASS | 0 | 0 | 0 |  |
| Alerts | The linked exception belongs to the same customer | PASS | 0 | 0 | 0 |  |
| Alerts | Active expiry alerts are for verified, unexpired documents and use the closest threshold | PASS | 0 | 0 | 0 |  |
| Alerts | Alerts are created inside the dataset period | PASS | 0 | 0 | 0 |  |
| Audit | Actor and role agree (System = no user) | PASS | 0 | 0 | 0 |  |
| Audit | Audit events are inside the dataset period | PASS | 0 | 0 | 0 |  |
| Audit | Every customer and every review case has its creation event | PASS | 0 | 0 | 0 |  |
| Audit | Audit events hold no PAN-like or Aadhaar-like text | PASS | 0 | 0 | 0 |  |
| Documents | An expired document never counts as currently valid evidence (KYC engine) | PASS | 0 | 0 | 0 |  |
| Risk | Risk score and reasons are consistent (score = sum of reason points, level = score band) | PASS | 0 | 0 | 0 |  |
| Risk | Onboarding risk scores follow the documented rules (recomputed from the customer record) | PASS | 0 | 0 | 0 |  |
| Ownership | The application ownership calculation agrees with a direct sum of the owner rows | PASS | 0 | 0 | 0 |  |
| Review cases | Every case history starts with creation and follows the allowed workflow transitions | PASS | 0 | 0 | 0 |  |
| Risk | Risk thresholds in use are the configured ones (Medium from 30, High from 60) | PASS | 0 | 0 | 0 |  |
| Ground truth | The answer key was made with the fixed seed | PASS | 0 | 0 | 0 |  |
| Ground truth | Every planted issue has a unique, well-formed issue ID | PASS | 0 | 0 | 0 |  |
| Ground truth | Every planted issue is a distinct record + issue type | PASS | 0 | 0 | 0 |  |
| Ground truth | Every planted issue has a type, severity, rule and injection method | PASS | 0 | 0 | 0 |  |
| Ground truth | Every labelled issue references an existing record of the right customer | PASS | 0 | 0 | 0 |  |
| Ground truth | Ground truth is separate from the operational records (database and exports) | PASS | 0 | 0 | 0 |  |
| Ground truth | No unlabelled planted anomalies: everything the independent detector finds is in the answer key | PASS | 0 | 0 | 0 |  |
| Ground truth | Every labelled issue is observable in the data (found by the independent detector) | PASS | 0 | 0 | 0 |  |
