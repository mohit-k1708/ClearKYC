# Validation report - scale full

**PASSED** - 127/127 database checks passed. Application data-quality checks: 33 run, 0 failed, 1 with warnings.

| Group | Check | Result | Detail |
|---|---|---|---|
| Counts | Customers = 8000 | PASS | found 8000, expected 8000 |
| Counts | Individuals = 7000 | PASS | found 7000, expected 7000 |
| Counts | Companies = 1000 | PASS | found 1000, expected 1000 |
| Counts | Documents = 20000 | PASS | found 20000, expected 20000 |
| Counts | Review cases = 3000 | PASS | found 3000, expected 3000 |
| Uniqueness | Customer.id is unique | PASS | no violations |
| Uniqueness | Document.id is unique | PASS | no violations |
| Uniqueness | Verification.id is unique | PASS | no violations |
| Uniqueness | RiskRating.id is unique | PASS | no violations |
| Uniqueness | BeneficialOwner.id is unique | PASS | no violations |
| Uniqueness | OwnerScreening.id is unique | PASS | no violations |
| Uniqueness | OwnershipValidation.id is unique | PASS | no violations |
| Uniqueness | ReviewSchedule.id is unique | PASS | no violations |
| Uniqueness | Exception.id is unique | PASS | no violations |
| Uniqueness | ReviewCase.id is unique | PASS | no violations |
| Uniqueness | CaseHistory.id is unique | PASS | no violations |
| Uniqueness | CaseNote.id is unique | PASS | no violations |
| Uniqueness | Alert.id is unique | PASS | no violations |
| Uniqueness | AuditEvent.id is unique | PASS | no violations |
| Uniqueness | KYCRequirement.id is unique | PASS | no violations |
| Uniqueness | Reviewer.id is unique | PASS | no violations |
| Uniqueness | Customer.customer_id is unique | PASS | no violations |
| Uniqueness | KYCRequirement.business_id is unique | PASS | no violations |
| Uniqueness | Document.business_id is unique | PASS | no violations |
| Uniqueness | ReviewCase.review_code is unique | PASS | no violations |
| Uniqueness | ReviewCase.case_code is unique | PASS | no violations |
| Uniqueness | Alert.business_id is unique | PASS | no violations |
| Uniqueness | Alert.alert_code is unique | PASS | no violations |
| Uniqueness | Exception.exception_code is unique | PASS | no violations |
| Uniqueness | RiskRating.assessment_code is unique | PASS | no violations |
| Uniqueness | AuditEvent.event_code is unique | PASS | no violations |
| ID formats | Customer ID (CUS-000001) follows its format | PASS | no violations |
| ID formats | KYC requirement ID (KYC-2026-000001) follows its format | PASS | no violations |
| ID formats | Document ID (DOC-CUS-000001-001) follows its format | PASS | no violations |
| ID formats | Review ID (REV-CUS-000001-2026) follows its format | PASS | no violations |
| ID formats | Alert ID (ALT-2026-000001) follows its format | PASS | no violations |
| ID formats | Document ID belongs to its own customer | PASS | no violations |
| ID formats | Review ID belongs to its own customer and year | PASS | no violations |
| ID formats | Alert ID year matches the alert creation year | PASS | no violations |
| Foreign keys | Customer.customer_type_id -> CustomerType | PASS | no violations |
| Foreign keys | Document.customer_id -> Customer | PASS | no violations |
| Foreign keys | Document.requirement_id -> KYCRequirement | PASS | no violations |
| Foreign keys | Verification.document_id -> Document | PASS | no violations |
| Foreign keys | Verification.reviewer_id -> Reviewer | PASS | no violations |
| Foreign keys | RiskRating.customer_id -> Customer | PASS | no violations |
| Foreign keys | RiskRating.assessed_by_id -> Reviewer | PASS | no violations |
| Foreign keys | BeneficialOwner.customer_id -> Customer | PASS | no violations |
| Foreign keys | OwnerScreening.beneficial_owner_id -> BeneficialOwner | PASS | no violations |
| Foreign keys | OwnershipValidation.customer_id -> Customer | PASS | no violations |
| Foreign keys | ReviewSchedule.customer_id -> Customer | PASS | no violations |
| Foreign keys | Exception.customer_id -> Customer | PASS | no violations |
| Foreign keys | ReviewCase.customer_id -> Customer | PASS | no violations |
| Foreign keys | ReviewCase.exception_id -> Exception | PASS | no violations |
| Foreign keys | ReviewCase.review_schedule_id -> ReviewSchedule | PASS | no violations |
| Foreign keys | ReviewCase.assigned_analyst_id -> Reviewer | PASS | no violations |
| Foreign keys | ReviewCase.assigned_reviewer_id -> Reviewer | PASS | no violations |
| Foreign keys | CaseHistory.review_case_id -> ReviewCase | PASS | no violations |
| Foreign keys | CaseNote.review_case_id -> ReviewCase | PASS | no violations |
| Foreign keys | Alert.customer_id -> Customer | PASS | no violations |
| Foreign keys | Alert.exception_id -> Exception | PASS | no violations |
| Foreign keys | AuditEvent.user_id -> Reviewer | PASS | no violations |
| Foreign keys | CompanyOwnership -> company and owner | PASS | no violations |
| Customer types | Individuals have date of birth + occupation and no company fields | PASS | no violations |
| Customer types | Companies have registration number, activity, incorporation date and no personal fields | PASS | no violations |
| Customer types | Individuals are adults at onboarding | PASS | no violations |
| Customer types | Companies were incorporated before onboarding | PASS | no violations |
| Customer types | Customers are onboarded on or before the reference date | PASS | no violations |
| Customer types | Beneficial owners belong to companies only | PASS | no violations |
| Documents | Dates are consistent (issue <= submission, issue <= expiry) | PASS | no violations |
| Documents | No document is submitted before its customer was onboarded | PASS | no violations |
| Documents | No document is submitted after the reference date | PASS | no violations |
| Documents | Document type matches its requirement | PASS | no violations |
| Documents | Requirement matches the customer type | PASS | no violations |
| Documents | Document status equals the newest verification | PASS | no violations |
| Verifications | Every document starts with one Pending record by the system | PASS | no violations |
| Verifications | Decisions are by active Reviewers or Admins | PASS | no violations |
| Verifications | Verification dates are in order and not before submission | PASS | no violations |
| Verifications | A document is never verified after its expiry date | PASS | no violations |
| Ownership | Every company has at least one owner | PASS | no violations |
| Ownership | Ownership of every company adds up to exactly 100.00% | PASS | no violations |
| Ownership | Each owner holds a valid share (0 < % <= 100) | PASS | no violations |
| Ownership | Every company has a RECONCILED ownership check | PASS | no violations |
| Ownership | CompanyOwnership mirrors every owner (company, owner, percentage) | PASS | no violations |
| Ownership | Only one active ownership row per company and owner | PASS | no violations |
| Ownership | A person appears at most once per company | PASS | no violations |
| Ownership | Owners were added after their company was onboarded | PASS | no violations |
| Risk | Every customer has a risk assessment | PASS | no violations |
| Risk | The first assessment has no previous level; later ones record it | PASS | no violations |
| Risk | Previous level equals the earlier assessment level | PASS | no violations |
| Risk | Every company has both onboarding and ownership assessments | PASS | no violations |
| Risk | Assessments are not dated before the customer or after the reference date | PASS | no violations |
| Reviews | Exactly one current schedule per customer | PASS | no violations |
| Reviews | Schedule interval matches the risk level (36 / 24 / 12 months) | PASS | no violations |
| Reviews | Next review date = last review date + interval | PASS | no violations |
| Reviews | Cases belong to the same customer as their exception and schedule | PASS | no violations |
| Reviews | Active cases belong to active exceptions; Resolved / Closed cases to resolved ones | PASS | no violations |
| Reviews | An exception is "In Review" exactly when it has an active case | PASS | no violations |
| Reviews | Every overdue periodic review already has its active case | PASS | no violations |
| Reviews | Case history starts with CREATED and ends in the case status | PASS | no violations |
| Reviews | Case history is in time order | PASS | no violations |
| Reviews | Cases are not created before their exception was detected | PASS | no violations |
| Reviews | Escalated or approved cases name a compliance reviewer | PASS | no violations |
| Reviews | No active exception is duplicated | PASS | no violations |
| Reviews | Exceptions are detected after the customer was onboarded | PASS | no violations |
| Reviews | Exception source records exist | PASS | no violations |
| Alerts | No duplicate active alert for one condition | PASS | no violations |
| Alerts | Expiry thresholds are 90, 60, 30 or 7 only | PASS | no violations |
| Alerts | One expiry alert per document and threshold | PASS | no violations |
| Alerts | The active expiry alert is the closest threshold the document has reached | PASS | no violations |
| Alerts | Active expiry alerts exist only for valid documents expiring within 90 days | PASS | no violations |
| Alerts | Alert source records exist | PASS | no violations |
| Alerts | Linked exception belongs to the same customer | PASS | no violations |
| Alerts | Closed alerts are closed after they were created and not after the reference date | PASS | no violations |
| Alerts | Acknowledged alerts name who acknowledged them | PASS | no violations |
| Foreign keys | OnboardingDecision.customer_id -> Customer | PASS | no violations |
| Foreign keys | OnboardingDecision.decided_by_id -> Reviewer | PASS | no violations |
| Decisions | Every customer has a Pending Review entry from onboarding | PASS | no violations |
| Decisions | Decisions are dated between onboarding and the reference date | PASS | no violations |
| Decisions | Approvals and rejections are by active Reviewers or Admins | PASS | no violations |
| Decisions | A customer is approved at most once and never after being rejected | PASS | no violations |
| Decisions | Every document records the name written on it | PASS | no violations |
| Audit | Audit event references point to existing records | PASS | no violations |
| Audit | Audit event customers exist | PASS | no violations |
| Audit | Audit event references match the record business code | PASS | no violations |
| Audit | Audit events are not dated after the reference date | PASS | no violations |
| Audit | Every customer and every case has its creation event | PASS | no violations |
| Audit | Audit events hold no PAN-like or Aadhaar-like text | PASS | no violations |

## Application data-quality checks

| Code | Check | Outcome | Issues |
|---|---|---|---:|
| PK_CUSTOMER_CODE | No duplicate Customer ID | Passed | 0 |
| PK_RISK_ASSESSMENT_CODE | No duplicate risk assessment ID | Passed | 0 |
| PK_CASE_CODE | No duplicate review case ID | Passed | 0 |
| PK_EXCEPTION_CODE | No duplicate exception ID | Passed | 0 |
| PK_ALERT_CODE | No duplicate alert ID | Passed | 0 |
| PK_AUDIT_EVENT_CODE | No duplicate audit event ID | Passed | 0 |
| PK_DOCUMENT_DUPLICATE | No duplicate document submissions | Passed | 0 |
| PK_OWNER_DUPLICATE | No duplicate beneficial owners | Passed | 0 |
| FK_DOCUMENT_CUSTOMER | Documents belong to existing customers | Passed | 0 |
| FK_VERIFICATION_DOCUMENT | Verification records belong to existing documents | Passed | 0 |
| FK_CASE_CUSTOMER | Review cases belong to existing customers | Passed | 0 |
| FK_ALERT_CUSTOMER | Alerts belong to existing customers | Passed | 0 |
| FK_OWNER_COMPANY | Beneficial owners belong to existing company customers | Passed | 0 |
| FK_CASE_LINKS | Cases link to existing exceptions and review schedules | Passed | 0 |
| DOC_ISSUE_AFTER_SUBMISSION | Issue date is not after the submission date | Passed | 0 |
| DOC_EXPIRY_BEFORE_ISSUE | Expiry date is not before the issue date | Passed | 0 |
| DOC_INVALID_STATUS | Documents have a valid status | Passed | 0 |
| DOC_STATUS_MATCHES_VERIFICATION | Document status matches its latest verification | Passed | 0 |
| OWN_PERCENTAGE_RANGE | Ownership percentage is between 0 and 100 | Passed | 0 |
| OWN_TOTAL_OVER_100 | Total ownership does not exceed 100% | Passed | 0 |
| OWN_MISSING_OWNERS | Companies have beneficial owners recorded | Passed | 0 |
| OWN_MISSING_PERCENTAGE | Beneficial owners have an ownership percentage | Passed | 0 |
| RISK_RULES_FOLLOWED | Risk scores and levels follow the configured rules | Passed | 0 |
| RISK_HISTORY_PRESERVED | Risk assessment history is complete and in order | Passed | 0 |
| CASE_CLOSED_WITHOUT_NOTES | Resolved and closed cases have resolution notes | Passed | 0 |
| CASE_STATUS_TRANSITIONS | Case status changes follow the workflow | Passed | 0 |
| CASE_TIMESTAMPS_CONSISTENT | Case dates match the case status | Passed | 0 |
| CASE_OVERDUE_IDENTIFIED | No active case is past its due date | Warning | 633 |
| KYC_COMPLETENESS_CONSISTENT | KYC completeness matches documents and requirements | Passed | 0 |
| KYC_REQUIREMENTS_DEFINED | Every customer has KYC requirements to be measured against | Passed | 0 |
| ALERT_ACTIVE_VALID | Active alerts reference a valid, current issue | Passed | 0 |
| ALERT_NO_DUPLICATE_ACTIVE | No duplicate active alerts for the same issue | Passed | 0 |
| PERIODIC_REVIEW_DATES | Periodic review dates are logically consistent | Passed | 0 |