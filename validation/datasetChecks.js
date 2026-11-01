/**
 * The checks of the dataset validator. Each check inspects the actual records of one database and returns the VIOLATING rows
 * ({ table, id, detail }). A check also names the planted issue types (Phase 3) that can legitimately make it fail: the validator
 * then classifies each violation as EXPECTED (it belongs to a labelled planted anomaly) or UNEXPECTED (accidental corruption).
 * Nothing is excluded or hidden: expected exceptions are reported next to the passes.
 */
const { DOCUMENT_TYPES, VERIFICATION_STATUSES } = require('../server/src/config/kycRules');
const { COUNTRIES } = require('../server/src/config/options');
const { RISK_RULES } = require('../server/src/config/riskRules');
const { SLA_DAYS, CASE_STATUSES, PRIORITIES } = require('../server/src/config/reviewRules');
const { isCurrentlyValid } = require('../server/src/services/kycEngine');
const { assessRisk, levelForScore } = require('../server/src/services/riskService');
const { validateOwnership } = require('../server/src/services/ownershipEngine');
const { validateRiskRow, validateCaseHistory } = require('../server/src/services/dataQualityChecks');

const TABLES = [
  'CustomerType', 'Reviewer', 'KYCRequirement', 'Customer', 'BeneficialOwner', 'OwnerScreening', 'OwnershipValidation', 'CompanyOwnership', 'Document', 'Verification',
  'RiskRating', 'OnboardingDecision', 'ReviewSchedule', 'Exception', 'ReviewCase', 'CaseHistory', 'CaseNote', 'Alert', 'AuditEvent', 'ValidationRun', 'ValidationIssue', 'IdCounter',
];
const EXPIRED = ['EXPIRED_DOCUMENT_MARKED_VALID'];
const OVER_100 = ['OWNERSHIP_OVER_100'];
const CLOSED = ['CLOSED_WITHOUT_RESOLUTION'];
const q = (list) => list.map((s) => `'${s}'`).join(', ');
const slaCase = `CASE rc.priority ${Object.entries(SLA_DAYS).map(([p, d]) => `WHEN '${p}' THEN ${d}`).join(' ')} ELSE 0 END`;
const ACTIVE = `'Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated'`;

/** SQL checks: { group, name, table, sql, planted?, info? }. The sql returns rows with an `id` column (the id of a row of `table`). */
function sqlChecks(ref, foreignKeys) {
  const refEnd = `${ref} 23:59:59`;
  const list = [];
  const add = (group, name, table, sql, opts = {}) => list.push({ group, name, table, sql, planted: opts.planted || [], info: Boolean(opts.info) });

  // ---- primary keys and identifiers ---------------------------------------------------------------------------------------
  for (const t of TABLES) {
    if (t === 'IdCounter') add('Primary keys', 'IdCounter primary key (scope, period) is unique', t, `SELECT scope AS id FROM "IdCounter" GROUP BY scope, period HAVING count(*) > 1`);
    else add('Primary keys', `${t} primary key is unique`, t, `SELECT id FROM "${t}" GROUP BY id HAVING count(*) > 1`);
  }
  const identifiers = [
    ['Customer', 'customer_id', '^CUS-[0-9]{6}$', 'Customer ID (CUS-000001)'], ['KYCRequirement', 'business_id', '^KYC-[0-9]{4}-[0-9]{6}$', 'KYC requirement ID (KYC-2026-000001)'],
    ['Document', 'business_id', '^DOC-CUS-[0-9]{6}-[0-9]{3}$', 'Document ID (DOC-CUS-000001-001)'], ['ReviewCase', 'review_code', '^REV-CUS-[0-9]{6}-[0-9]{4}(-[0-9]{2})?$', 'Review ID (REV-CUS-000001-2026)'],
    ['ReviewCase', 'case_code', '^CASE-[0-9]{6}$', 'Case ID (CASE-000001)'], ['Alert', 'business_id', '^ALT-[0-9]{4}-[0-9]{6}$', 'Alert ID (ALT-2026-000001)'], ['Alert', 'alert_code', '^ALT-[0-9]{6}$', 'Alert code (ALT-000001)'],
    ['Exception', 'exception_code', '^EXC-[0-9]{6}$', 'Exception ID (EXC-000001)'], ['RiskRating', 'assessment_code', '^RSK-[0-9]{6}$', 'Risk assessment ID (RSK-000001)'], ['AuditEvent', 'event_code', '^AUD-[0-9]{6}$', 'Audit event ID (AUD-000001)'],
  ];
  for (const [t, col, regex, label] of identifiers) {
    add('Identifiers', `${label} is present`, t, `SELECT id FROM "${t}" WHERE "${col}" IS NULL OR btrim("${col}") = ''`);
    add('Identifiers', `${label} follows the documented format`, t, `SELECT id FROM "${t}" WHERE "${col}" IS NOT NULL AND "${col}" !~ '${regex}'`);
    add('Identifiers', `${label} is unique`, t, `SELECT min(id) AS id FROM "${t}" GROUP BY "${col}" HAVING count(*) > 1`);
  }
  add('Identifiers', 'Document ID belongs to its own customer', 'Document', `SELECT d.id FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.business_id NOT LIKE 'DOC-' || c.customer_id || '-%'`);
  add('Identifiers', 'Review ID belongs to its own customer and year', 'ReviewCase', `SELECT rc.id FROM "ReviewCase" rc JOIN "Customer" c ON c.id = rc.customer_id WHERE rc.review_code NOT LIKE 'REV-' || c.customer_id || '-' || EXTRACT(YEAR FROM rc.created_at)::int || '%'`);
  add('Identifiers', 'Alert ID year matches the year the alert was created', 'Alert', `SELECT id FROM "Alert" WHERE business_id NOT LIKE 'ALT-' || EXTRACT(YEAR FROM created_at)::int || '-%'`);
  add('Identifiers', 'KYC requirement ID year matches its effective year', 'KYCRequirement', `SELECT id FROM "KYCRequirement" WHERE business_id NOT LIKE 'KYC-' || EXTRACT(YEAR FROM effective_from)::int || '-%'`);

  // ---- foreign keys: one check per foreign key in the catalogue ----------------------------------------------------------
  for (const fk of foreignKeys) {
    add('Foreign keys', `${fk.child}.${fk.column} references an existing ${fk.parent}`, fk.child,
      `SELECT c.${fk.child === 'IdCounter' ? 'scope' : 'id'} AS id FROM "${fk.child}" c LEFT JOIN "${fk.parent}" p ON p."${fk.parentColumn}" = c."${fk.column}" WHERE c."${fk.column}" IS NOT NULL AND p."${fk.parentColumn}" IS NULL`);
  }
  add('Foreign keys', 'Alert source record exists (document, requirement, owner, customer, schedule)', 'Alert', `SELECT a.id FROM "Alert" a WHERE
      (a.related_entity_type = 'Document' AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d.id = a.related_entity_id AND d.customer_id = a.customer_id))
   OR (a.related_entity_type = 'KYCRequirement' AND NOT EXISTS (SELECT 1 FROM "KYCRequirement" r WHERE r.id = a.related_entity_id))
   OR (a.related_entity_type = 'BeneficialOwner' AND NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.id = a.related_entity_id AND b.customer_id = a.customer_id))
   OR (a.related_entity_type = 'Customer' AND a.related_entity_id <> a.customer_id)
   OR (a.related_entity_type = 'ReviewSchedule' AND NOT EXISTS (SELECT 1 FROM "ReviewSchedule" s WHERE s.id = a.related_entity_id AND s.customer_id = a.customer_id))`);
  add('Foreign keys', 'Exception source record exists', 'Exception', `SELECT e.id FROM "Exception" e WHERE
      (e.source_entity_type = 'Document' AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d.id = e.source_entity_id AND d.customer_id = e.customer_id))
   OR (e.source_entity_type = 'KYCRequirement' AND NOT EXISTS (SELECT 1 FROM "KYCRequirement" r WHERE r.id = e.source_entity_id))
   OR (e.source_entity_type = 'BeneficialOwner' AND NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.id = e.source_entity_id AND b.customer_id = e.customer_id))
   OR (e.source_entity_type = 'Customer' AND e.source_entity_id <> e.customer_id)
   OR (e.source_entity_type = 'ReviewSchedule' AND NOT EXISTS (SELECT 1 FROM "ReviewSchedule" s WHERE s.id = e.source_entity_id AND s.customer_id = e.customer_id))`);
  add('Foreign keys', 'Audit event points at an existing entity', 'AuditEvent', `SELECT a.id FROM "AuditEvent" a WHERE a.entity_id IS NOT NULL AND NOT (
      CASE a.entity_type
        WHEN 'Customer' THEN EXISTS (SELECT 1 FROM "Customer" x WHERE x.id = a.entity_id) WHEN 'RiskRating' THEN EXISTS (SELECT 1 FROM "RiskRating" x WHERE x.id = a.entity_id)
        WHEN 'Document' THEN EXISTS (SELECT 1 FROM "Document" x WHERE x.id = a.entity_id) WHEN 'KYCRequirement' THEN EXISTS (SELECT 1 FROM "KYCRequirement" x WHERE x.id = a.entity_id)
        WHEN 'BeneficialOwner' THEN EXISTS (SELECT 1 FROM "BeneficialOwner" x WHERE x.id = a.entity_id) WHEN 'OwnerScreening' THEN EXISTS (SELECT 1 FROM "OwnerScreening" x WHERE x.id = a.entity_id)
        WHEN 'OwnershipValidation' THEN EXISTS (SELECT 1 FROM "OwnershipValidation" x WHERE x.id = a.entity_id) WHEN 'OnboardingDecision' THEN EXISTS (SELECT 1 FROM "OnboardingDecision" x WHERE x.id = a.entity_id)
        WHEN 'ReviewCase' THEN EXISTS (SELECT 1 FROM "ReviewCase" x WHERE x.id = a.entity_id) WHEN 'ReviewSchedule' THEN EXISTS (SELECT 1 FROM "ReviewSchedule" x WHERE x.id = a.entity_id)
        WHEN 'Exception' THEN EXISTS (SELECT 1 FROM "Exception" x WHERE x.id = a.entity_id) WHEN 'Alert' THEN EXISTS (SELECT 1 FROM "Alert" x WHERE x.id = a.entity_id)
        ELSE false END)`);
  add('Foreign keys', 'Audit event reference code matches the record it names', 'AuditEvent', `SELECT a.id FROM "AuditEvent" a WHERE a.entity_ref IS NOT NULL AND a.entity_id IS NOT NULL AND NOT (
      CASE a.entity_type
        WHEN 'Customer' THEN EXISTS (SELECT 1 FROM "Customer" x WHERE x.id = a.entity_id AND x.customer_id = a.entity_ref) WHEN 'Document' THEN EXISTS (SELECT 1 FROM "Document" x WHERE x.id = a.entity_id AND x.business_id = a.entity_ref)
        WHEN 'ReviewCase' THEN EXISTS (SELECT 1 FROM "ReviewCase" x WHERE x.id = a.entity_id AND x.case_code = a.entity_ref) WHEN 'Exception' THEN EXISTS (SELECT 1 FROM "Exception" x WHERE x.id = a.entity_id AND x.exception_code = a.entity_ref)
        WHEN 'Alert' THEN EXISTS (SELECT 1 FROM "Alert" x WHERE x.id = a.entity_id AND x.alert_code = a.entity_ref) WHEN 'RiskRating' THEN EXISTS (SELECT 1 FROM "RiskRating" x WHERE x.id = a.entity_id AND x.assessment_code = a.entity_ref)
        WHEN 'KYCRequirement' THEN EXISTS (SELECT 1 FROM "KYCRequirement" x WHERE x.id = a.entity_id AND x.business_id = a.entity_ref) ELSE true END)`);

  // ---- customers ----------------------------------------------------------------------------------------------------------
  add('Customers', 'Customer type is Individual (1) or Company (2)', 'Customer', `SELECT id FROM "Customer" WHERE customer_type_id NOT IN (1, 2)`);
  add('Customers', 'Required fields are present', 'Customer', `SELECT id FROM "Customer" WHERE btrim(full_name) = '' OR btrim(email) = '' OR btrim(phone) = '' OR btrim(address) = '' OR btrim(country) = '' OR btrim(pan_number) = '' OR btrim(pan_hash) = ''`);
  add('Customers', 'Country is one of the known country codes', 'Customer', `SELECT id FROM "Customer" WHERE country <> ALL(ARRAY[${q(Object.keys(COUNTRIES))}])`);
  add('Customers', 'E-mail and phone have a valid shape', 'Customer', `SELECT id FROM "Customer" WHERE email !~ '^[^@ ]+@[^@ ]+\\.[^@ ]+$' OR phone !~ '^\\+?[0-9]{8,15}$'`);
  add('Customers', 'Individual fields: date of birth + occupation, no company fields', 'Customer', `SELECT id FROM "Customer" WHERE customer_type_id = 1 AND (date_of_birth IS NULL OR occupation IS NULL OR aadhaar_number IS NULL OR company_registration_number IS NOT NULL OR business_activity IS NOT NULL OR date_of_incorporation IS NOT NULL)`);
  add('Customers', 'Company fields: registration number, activity, incorporation date, no personal fields', 'Customer', `SELECT id FROM "Customer" WHERE customer_type_id = 2 AND (company_registration_number IS NULL OR business_activity IS NULL OR date_of_incorporation IS NULL OR date_of_birth IS NOT NULL OR occupation IS NOT NULL OR aadhaar_number IS NOT NULL)`);
  add('Customers', 'Individuals were adults when onboarded and are not born in the future', 'Customer', `SELECT id FROM "Customer" WHERE customer_type_id = 1 AND (date_of_birth > created_at::date - interval '18 years' OR date_of_birth > DATE '${ref}')`);
  add('Customers', 'Companies were incorporated on or before the onboarding day', 'Customer', `SELECT id FROM "Customer" WHERE customer_type_id = 2 AND date_of_incorporation > created_at::date`);
  add('Customers', 'Onboarding dates are valid and not after the reference date', 'Customer', `SELECT id FROM "Customer" WHERE created_at > '${refEnd}' OR updated_at < created_at`);
  add('Customers', 'Registration status is an allowed value', 'Customer', `SELECT id FROM "Customer" WHERE registration_status NOT IN ('Registered', 'Pending Review', 'Closed')`);

  // ---- documents ----------------------------------------------------------------------------------------------------------
  add('Documents', 'Issue date is not after the submission date', 'Document', `SELECT id FROM "Document" WHERE issue_date > submission_date`);
  add('Documents', 'Expiry date is not before the issue date', 'Document', `SELECT id FROM "Document" WHERE expiry_date IS NOT NULL AND expiry_date < issue_date`);
  add('Documents', 'Document type is an allowed value', 'Document', `SELECT id FROM "Document" WHERE document_type <> ALL(ARRAY[${q(DOCUMENT_TYPES.map((t) => t.name))}])`);
  add('Documents', 'Document status is an allowed value', 'Document', `SELECT id FROM "Document" WHERE status <> ALL(ARRAY[${q(VERIFICATION_STATUSES)}])`);
  add('Documents', 'Submitted on or after onboarding and not after the reference date', 'Document', `SELECT d.id FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.submission_date < c.created_at::date OR d.submission_date > DATE '${ref}'`);
  add('Documents', 'Type matches its requirement and the requirement matches the customer type', 'Document', `SELECT d.id FROM "Document" d JOIN "KYCRequirement" r ON r.id = d.requirement_id JOIN "Customer" c ON c.id = d.customer_id WHERE r.document_type <> d.document_type OR r.customer_type_id <> c.customer_type_id`);
  add('Documents', 'The name written on the document is captured', 'Document', `SELECT id FROM "Document" WHERE name_on_document IS NULL OR btrim(name_on_document) = ''`);
  add('Documents', 'A document is not verified after it has expired', 'Document', `SELECT d.id FROM "Document" d JOIN LATERAL (SELECT status, verification_date FROM "Verification" v WHERE v.document_id = d.id ORDER BY v.id DESC LIMIT 1) v ON true
      WHERE d.expiry_date IS NOT NULL AND v.status = 'Verified' AND v.verification_date::date > d.expiry_date`, { planted: EXPIRED });

  // ---- verifications ------------------------------------------------------------------------------------------------------
  add('Verifications', 'Verification status is an allowed value', 'Verification', `SELECT id FROM "Verification" WHERE status <> ALL(ARRAY[${q(VERIFICATION_STATUSES)}])`);
  add('Verifications', 'Every document has a history that starts with one system Pending record', 'Document', `SELECT d.id FROM "Document" d WHERE (SELECT count(*) FROM "Verification" v WHERE v.document_id = d.id AND v.status = 'Pending') <> 1
      OR NOT EXISTS (SELECT 1 FROM "Verification" v WHERE v.document_id = d.id AND v.status = 'Pending' AND v.reviewer_id IS NULL AND v.id = (SELECT min(id) FROM "Verification" v2 WHERE v2.document_id = d.id))`);
  add('Verifications', 'History is in time order (a later record never carries an earlier date)', 'Verification', `SELECT v.id FROM "Verification" v WHERE EXISTS (SELECT 1 FROM "Verification" p WHERE p.document_id = v.document_id AND p.id < v.id AND p.verification_date > v.verification_date)
      OR v.verification_date::date < (SELECT submission_date FROM "Document" d WHERE d.id = v.document_id) OR v.verification_date > '${refEnd}'`);
  add('Verifications', 'The latest decision (by date, then id) is the document status', 'Document', `SELECT d.id FROM "Document" d JOIN LATERAL (SELECT status FROM "Verification" v WHERE v.document_id = d.id ORDER BY v.verification_date DESC, v.id DESC LIMIT 1) t ON true WHERE t.status <> d.status`);
  add('Verifications', 'Decisions are made by active Reviewers or Admins', 'Verification', `SELECT v.id FROM "Verification" v LEFT JOIN "Reviewer" r ON r.id = v.reviewer_id WHERE v.status <> 'Pending' AND (r.id IS NULL OR r.role NOT IN ('Reviewer', 'Admin') OR r.is_active IS NOT TRUE)`);
  add('Verifications', 'A rejection or resubmission request explains itself', 'Verification', `SELECT id FROM "Verification" WHERE status IN ('Rejected', 'Requires Resubmission') AND btrim(coalesce(remarks, '')) = ''`);

  // ---- ownership ----------------------------------------------------------------------------------------------------------
  add('Ownership', 'Each ownership percentage is above 0 and at most 100', 'BeneficialOwner', `SELECT id FROM "BeneficialOwner" WHERE ownership_percentage IS NULL OR ownership_percentage <= 0 OR ownership_percentage > 100`);
  add('Ownership', 'Beneficial owners belong to companies only', 'BeneficialOwner', `SELECT b.id FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE c.customer_type_id <> 2`);
  add('Ownership', 'Every company has at least one owner recorded', 'Customer', `SELECT c.id FROM "Customer" c WHERE c.customer_type_id = 2 AND NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.customer_id = c.id)`);
  add('Ownership', 'Ownership above 100% is flagged: the owners of a company must not total more than 100', 'Customer', `SELECT customer_id AS id FROM "BeneficialOwner" GROUP BY customer_id HAVING sum(ownership_percentage) > 100`, { planted: OVER_100 });
  add('Ownership', 'Ownership below 100% is flagged: the owners of a company must total 100', 'Customer', `SELECT customer_id AS id FROM "BeneficialOwner" GROUP BY customer_id HAVING sum(ownership_percentage) < 100`);
  add('Ownership', 'Owners were recorded after their company was onboarded', 'BeneficialOwner', `SELECT b.id FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE b.created_at < c.created_at OR b.created_at > '${refEnd}'`);
  add('Ownership', 'Company-owner relationships mirror the owner rows (company, owner, percentage)', 'BeneficialOwner', `SELECT b.id FROM "BeneficialOwner" b LEFT JOIN "CompanyOwnership" o ON o.beneficial_owner_id = b.id AND o.effective_to IS NULL WHERE o.id IS NULL OR o.company_customer_id <> b.customer_id OR o.ownership_percentage IS DISTINCT FROM b.ownership_percentage`);
  add('Ownership', 'Only one current relationship per company and owner', 'CompanyOwnership', `SELECT min(id) AS id FROM "CompanyOwnership" WHERE effective_to IS NULL GROUP BY company_customer_id, beneficial_owner_id HAVING count(*) > 1`);
  add('Ownership', 'A person appears at most once per company', 'CompanyOwnership', `SELECT min(id) AS id FROM "CompanyOwnership" WHERE effective_to IS NULL GROUP BY company_customer_id, person_ref HAVING count(*) > 1`);
  add('Ownership', 'Relationship history is consistent (ends after it starts, no overlap for one owner)', 'CompanyOwnership', `SELECT a.id FROM "CompanyOwnership" a WHERE a.effective_to < a.effective_from OR EXISTS (SELECT 1 FROM "CompanyOwnership" b WHERE b.beneficial_owner_id = a.beneficial_owner_id AND b.id < a.id AND (b.effective_to IS NULL OR b.effective_to > a.effective_from))`);

  // ---- risk ---------------------------------------------------------------------------------------------------------------
  add('Risk', 'Every customer has a risk assessment', 'Customer', `SELECT c.id FROM "Customer" c WHERE NOT EXISTS (SELECT 1 FROM "RiskRating" r WHERE r.customer_id = c.id)`);
  add('Risk', 'Risk category matches the configured score thresholds', 'RiskRating', `SELECT id FROM "RiskRating" WHERE risk_level <> CASE WHEN risk_score >= ${RISK_RULES.thresholds.highFrom} THEN 'High' WHEN risk_score >= ${RISK_RULES.thresholds.mediumFrom} THEN 'Medium' ELSE 'Low' END`);
  add('Risk', 'History: the first assessment has no previous level, later ones record the earlier level', 'RiskRating', `SELECT r.id FROM "RiskRating" r LEFT JOIN LATERAL (SELECT risk_level FROM "RiskRating" p WHERE p.customer_id = r.customer_id AND p.id < r.id ORDER BY p.id DESC LIMIT 1) p ON true WHERE r.previous_risk_level IS DISTINCT FROM p.risk_level`);
  add('Risk', 'History is in date order and inside the dataset period', 'RiskRating', `SELECT r.id FROM "RiskRating" r JOIN "Customer" c ON c.id = r.customer_id WHERE r.assessment_date < c.created_at OR r.assessment_date > '${refEnd}'
      OR EXISTS (SELECT 1 FROM "RiskRating" p WHERE p.customer_id = r.customer_id AND p.id < r.id AND p.assessment_date > r.assessment_date)`);

  // ---- onboarding decisions -----------------------------------------------------------------------------------------------
  add('Decisions', 'Every customer has a Pending Review entry from onboarding', 'Customer', `SELECT c.id FROM "Customer" c WHERE NOT EXISTS (SELECT 1 FROM "OnboardingDecision" d WHERE d.customer_id = c.id AND d.decision = 'Pending Review')`);
  add('Decisions', 'Decisions are dated between onboarding and the reference date', 'OnboardingDecision', `SELECT d.id FROM "OnboardingDecision" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.decided_at < c.created_at OR d.decided_at > '${refEnd}'`);
  add('Decisions', 'Approvals and rejections are by active Reviewers or Admins', 'OnboardingDecision', `SELECT d.id FROM "OnboardingDecision" d JOIN "Reviewer" r ON r.id = d.decided_by_id WHERE d.decision <> 'Pending Review' AND (r.role NOT IN ('Reviewer', 'Admin') OR r.is_active IS NOT TRUE)`);
  add('Decisions', 'A customer is approved at most once and never after being rejected', 'Customer', `SELECT customer_id AS id FROM "OnboardingDecision" GROUP BY 1 HAVING count(*) FILTER (WHERE decision = 'Approved') > 1 OR (count(*) FILTER (WHERE decision = 'Approved') > 0 AND count(*) FILTER (WHERE decision = 'Rejected') > 0)`);

  // ---- review cases -------------------------------------------------------------------------------------------------------
  add('Review cases', 'Case status and priority are allowed values', 'ReviewCase', `SELECT id FROM "ReviewCase" WHERE status <> ALL(ARRAY[${q(CASE_STATUSES)}]) OR priority <> ALL(ARRAY[${q(PRIORITIES)}])`);
  add('Review cases', 'Closed cases have resolution notes', 'ReviewCase', `SELECT id FROM "ReviewCase" WHERE status = 'Closed' AND btrim(coalesce(resolution_notes, '')) = ''`, { planted: CLOSED });
  add('Review cases', 'Resolved cases have resolution notes', 'ReviewCase', `SELECT id FROM "ReviewCase" WHERE status = 'Resolved' AND btrim(coalesce(resolution_notes, '')) = ''`, { planted: CLOSED });
  add('Review cases', 'Resolved and closed cases carry their resolved / closed dates, in order', 'ReviewCase', `SELECT id FROM "ReviewCase" WHERE (status IN ('Resolved', 'Closed') AND resolved_at IS NULL) OR (status = 'Closed' AND closed_at IS NULL) OR (status NOT IN ('Resolved', 'Closed') AND (resolved_at IS NOT NULL OR closed_at IS NOT NULL))
      OR (closed_at IS NOT NULL AND resolved_at IS NOT NULL AND closed_at < resolved_at) OR (resolved_at IS NOT NULL AND resolved_at < created_at)`);
  add('Review cases', 'Due date = creation date + the SLA of its priority (periodic reviews: the schedule date)', 'ReviewCase', `SELECT rc.id FROM "ReviewCase" rc LEFT JOIN "ReviewSchedule" s ON s.id = rc.review_schedule_id
      WHERE (rc.case_type <> 'Periodic KYC Review' AND rc.due_date <> rc.created_at::date + ${slaCase}) OR (rc.case_type = 'Periodic KYC Review' AND s.id IS NOT NULL AND rc.due_date <> s.next_review_date)`);
  add('Review cases', 'Cases belong to the customer of their exception and schedule', 'ReviewCase', `SELECT rc.id FROM "ReviewCase" rc LEFT JOIN "Exception" e ON e.id = rc.exception_id LEFT JOIN "ReviewSchedule" s ON s.id = rc.review_schedule_id WHERE (e.id IS NOT NULL AND e.customer_id <> rc.customer_id) OR (s.id IS NOT NULL AND s.customer_id <> rc.customer_id)`);
  add('Review cases', 'Active cases belong to active exceptions; Resolved / Closed cases to resolved ones', 'ReviewCase', `SELECT rc.id FROM "ReviewCase" rc JOIN "Exception" e ON e.id = rc.exception_id WHERE (rc.status IN ('Resolved', 'Closed')) <> (e.status = 'Resolved')`);
  add('Review cases', 'Cases are created after their exception was detected', 'ReviewCase', `SELECT rc.id FROM "ReviewCase" rc JOIN "Exception" e ON e.id = rc.exception_id WHERE rc.created_at < e.detected_at`);
  add('Review cases', 'Overdue active cases (past their due date) - informational', 'ReviewCase', `SELECT id FROM "ReviewCase" WHERE status IN (${ACTIVE}) AND due_date < DATE '${ref}'`, { info: true });
  add('Review cases', 'Every overdue periodic review has its active case', 'ReviewSchedule', `SELECT s.id FROM "ReviewSchedule" s WHERE s.status = 'Scheduled' AND s.next_review_date <= DATE '${ref}' AND NOT EXISTS (SELECT 1 FROM "ReviewCase" rc WHERE rc.review_schedule_id = s.id AND rc.status IN (${ACTIVE}))`);
  add('Review cases', 'Exactly one current review schedule per customer', 'Customer', `SELECT c.id FROM "Customer" c WHERE (SELECT count(*) FROM "ReviewSchedule" s WHERE s.customer_id = c.id AND s.status = 'Scheduled') <> 1`);
  add('Review cases', 'Active exceptions are unique per condition', 'Exception', `SELECT min(id) AS id FROM "Exception" WHERE status <> 'Resolved' GROUP BY dedupe_key HAVING count(*) > 1`);
  add('Review cases', 'Resolved exceptions record how and when they were resolved', 'Exception', `SELECT id FROM "Exception" WHERE status = 'Resolved' AND (resolved_at IS NULL OR resolution_type IS NULL OR btrim(coalesce(resolution_notes, '')) = '')`);

  // ---- alerts -------------------------------------------------------------------------------------------------------------
  add('Alerts', 'No duplicate active alert for the same source issue and threshold', 'Alert', `SELECT min(id) AS id FROM "Alert" WHERE status NOT IN ('Resolved', 'Dismissed') GROUP BY dedupe_key HAVING count(*) > 1`);
  add('Alerts', 'One expiry alert per document and threshold', 'Alert', `SELECT min(id) AS id FROM "Alert" WHERE alert_type = 'DOCUMENT_EXPIRY' GROUP BY related_entity_id, threshold HAVING count(*) > 1`);
  add('Alerts', 'Expiry thresholds are 90, 60, 30 or 7', 'Alert', `SELECT id FROM "Alert" WHERE alert_type = 'DOCUMENT_EXPIRY' AND (threshold IS NULL OR threshold NOT IN (90, 60, 30, 7))`);
  add('Alerts', 'Resolved and dismissed alerts record how, when and why', 'Alert', `SELECT id FROM "Alert" WHERE status IN ('Resolved', 'Dismissed') AND (resolved_at IS NULL OR resolution_type IS NULL OR btrim(coalesce(resolution_notes, '')) = '' OR resolved_at < created_at)`);
  add('Alerts', 'Active alerts have no resolution data; acknowledged alerts name who acknowledged', 'Alert', `SELECT id FROM "Alert" WHERE (status NOT IN ('Resolved', 'Dismissed') AND (resolved_at IS NOT NULL OR resolution_type IS NOT NULL)) OR (status IN ('Acknowledged', 'In Progress') AND (acknowledged_by_id IS NULL OR acknowledged_at IS NULL))`);
  add('Alerts', 'The linked exception belongs to the same customer', 'Alert', `SELECT a.id FROM "Alert" a JOIN "Exception" e ON e.id = a.exception_id WHERE e.customer_id <> a.customer_id`);
  add('Alerts', 'Active expiry alerts are for verified, unexpired documents and use the closest threshold', 'Alert', `SELECT a.id FROM "Alert" a JOIN "Document" d ON d.id = a.related_entity_id WHERE a.alert_type = 'DOCUMENT_EXPIRY' AND a.status NOT IN ('Resolved', 'Dismissed')
      AND (d.status <> 'Verified' OR d.expiry_date < DATE '${ref}' OR d.expiry_date > DATE '${ref}' + 90 OR a.threshold <> (SELECT min(t) FROM unnest(ARRAY[90, 60, 30, 7]) t WHERE t >= (d.expiry_date - DATE '${ref}')))`, { planted: EXPIRED });
  add('Alerts', 'Alerts are created inside the dataset period', 'Alert', `SELECT a.id FROM "Alert" a JOIN "Customer" c ON c.id = a.customer_id WHERE a.created_at < c.created_at OR a.created_at > '${refEnd}'`);

  // ---- audit trail --------------------------------------------------------------------------------------------------------
  add('Audit', 'Actor and role agree (System = no user)', 'AuditEvent', `SELECT id FROM "AuditEvent" WHERE NOT ((user_id IS NULL AND user_role = 'System') OR (user_id IS NOT NULL AND user_role <> 'System'))`);
  add('Audit', 'Audit events are inside the dataset period', 'AuditEvent', `SELECT id FROM "AuditEvent" WHERE created_at > '${refEnd}'`);
  add('Audit', 'Every customer and every review case has its creation event', 'Customer', `SELECT c.id FROM "Customer" c WHERE NOT EXISTS (SELECT 1 FROM "AuditEvent" a WHERE a.entity_type = 'Customer' AND a.entity_id = c.id AND a.action_type = 'CUSTOMER_CREATED')`);
  add('Audit', 'Audit events hold no PAN-like or Aadhaar-like text', 'AuditEvent', `SELECT id FROM "AuditEvent" WHERE coalesce(new_values::text, '') || coalesce(previous_values::text, '') || coalesce(reason, '') ~ '[A-Z]{5}[0-9]{4}[A-Z]|[0-9]{4} ?[0-9]{4} ?[0-9]{4}'`);
  return list;
}

/** Checks that apply the application's own pure engines to the stored records. Each returns violations [{ table, id, detail }]. */
const engineChecks = (ref) => [
  {
    group: 'Documents', name: 'An expired document never counts as currently valid evidence (KYC engine)', planted: [],
    async run(db) {
      const rows = (await db.query(`SELECT d.id, d.status, d.expiry_date::text AS expiry FROM "Document" d WHERE d.expiry_date < $1::date`, [ref])).rows;
      return rows.filter((d) => isCurrentlyValid({ status: d.status, expiryDate: d.expiry }, ref)).map((d) => ({ table: 'Document', id: d.id, detail: `expired ${d.expiry} yet counted as valid` }));
    },
  },
  {
    group: 'Risk', name: 'Risk score and reasons are consistent (score = sum of reason points, level = score band)', planted: [],
    async run(db) {
      const rows = (await db.query(`SELECT id, risk_score, risk_level, risk_reasons FROM "RiskRating" ORDER BY id`)).rows;
      const out = [];
      for (const r of rows) {
        const problems = validateRiskRow({ riskScore: r.risk_score, riskLevel: r.risk_level, reasons: r.risk_reasons?.reasons });
        if (problems.length) out.push({ table: 'RiskRating', id: r.id, detail: problems.map((p) => p.message).join('; ') });
      }
      return out;
    },
  },
  {
    group: 'Risk', name: 'Onboarding risk scores follow the documented rules (recomputed from the customer record)', planted: [],
    async run(db) {
      const rows = (await db.query(`SELECT r.id, r.risk_score, r.risk_level, to_char(r.assessment_date, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at, t.type_name AS type, c.full_name, c.country, c.occupation, c.business_activity,
                                          c.date_of_birth::text AS dob, c.date_of_incorporation::text AS inc
                                     FROM "RiskRating" r JOIN "Customer" c ON c.id = r.customer_id JOIN "CustomerType" t ON t.id = c.customer_type_id WHERE r.previous_risk_level IS NULL ORDER BY r.id`)).rows;
      const out = [];
      for (const r of rows) {
        const a = assessRisk({ customerType: r.type, fullName: r.full_name, country: r.country, occupation: r.occupation, businessActivity: r.business_activity, dateOfBirth: r.dob, dateOfIncorporation: r.inc }, new Date(r.at));
        if (a.score !== r.risk_score || a.level !== r.risk_level) out.push({ table: 'RiskRating', id: r.id, detail: `stored ${r.risk_score}/${r.risk_level}, rules give ${a.score}/${a.level}` });
      }
      return out;
    },
  },
  {
    group: 'Ownership', name: 'The application ownership calculation agrees with a direct sum of the owner rows', planted: [],
    async run(db) {
      const rows = (await db.query(`SELECT customer_id, array_agg(ownership_percentage::text ORDER BY id) AS pcts, sum(ownership_percentage)::text AS total FROM "BeneficialOwner" GROUP BY customer_id ORDER BY customer_id`)).rows;
      const out = [];
      for (const r of rows) {
        const v = validateOwnership(r.pcts.map((p) => ({ ownershipPercentage: Number(p) })));
        const expected = Number(r.total) > 100 ? 'EXCEEDS_100' : Number(r.total) < 100 ? 'BELOW_100' : 'RECONCILED';
        if (v.status !== expected) out.push({ table: 'Customer', id: r.customer_id, detail: `engine says ${v.status}, direct sum ${r.total} says ${expected}` });
      }
      return out;
    },
  },
  {
    group: 'Review cases', name: 'Every case history starts with creation and follows the allowed workflow transitions', planted: [],
    async run(db) {
      const cases = (await db.query(`SELECT id, status FROM "ReviewCase" ORDER BY id`)).rows;
      const history = (await db.query(`SELECT id, review_case_id, action, previous_status, new_status FROM "CaseHistory" ORDER BY review_case_id, id`)).rows;
      const by = new Map();
      for (const h of history) by.set(h.review_case_id, [...(by.get(h.review_case_id) || []), { id: h.id, action: h.action, previousStatus: h.previous_status, newStatus: h.new_status }]);
      const out = [];
      for (const c of cases) {
        const problems = validateCaseHistory(by.get(c.id) || [], c.status);
        if (problems.length) out.push({ table: 'ReviewCase', id: c.id, detail: problems.map((p) => p.message).join('; ') });
      }
      return out;
    },
  },
  {
    group: 'Risk', name: `Risk thresholds in use are the configured ones (Medium from ${RISK_RULES.thresholds.mediumFrom}, High from ${RISK_RULES.thresholds.highFrom})`, planted: [],
    async run() {
      const bad = [0, 29, 30, 59, 60, 100].filter((s) => levelForScore(s) !== (s >= RISK_RULES.thresholds.highFrom ? 'High' : s >= RISK_RULES.thresholds.mediumFrom ? 'Medium' : 'Low'));
      return bad.map((s) => ({ table: 'RiskRating', id: `score-${s}`, detail: 'threshold function disagrees with configuration' }));
    },
  },
];

module.exports = { sqlChecks, engineChecks, TABLES };
