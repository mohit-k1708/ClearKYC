/**
 * Post-generation validation. Every check is a query that returns the VIOLATING rows (so an empty result = pass); the report
 * shows the number of violations and up to five example rows for each failed check. Nothing is corrected silently.
 *
 * After the SQL checks, the application's own data-quality checks (Scene 5) are run on the generated data as well.
 */
const EXAMPLES = 5;

function sqlChecks(cfg) {
  const ref = cfg.referenceDate;
  const refEnd = `${ref} 23:59:59`; // timestamps are stored without a time zone (UTC), so compare with a plain timestamp
  const { customers, companies, documents, reviewCases } = cfg.counts;
  const C = [];
  const count = (group, name, sql, expected) => C.push({ group, name, kind: 'count', sql, expected });
  const none = (group, name, sql) => C.push({ group, name, kind: 'violations', sql });

  // ---- volumes ------------------------------------------------------------------------------------------------------------
  count('Counts', `Customers = ${customers}`, 'SELECT count(*)::int AS n FROM "Customer"', customers);
  count('Counts', `Individuals = ${customers - companies}`, `SELECT count(*)::int AS n FROM "Customer" WHERE customer_type_id = 1`, customers - companies);
  count('Counts', `Companies = ${companies}`, `SELECT count(*)::int AS n FROM "Customer" WHERE customer_type_id = 2`, companies);
  count('Counts', `Documents = ${documents}`, 'SELECT count(*)::int AS n FROM "Document"', documents);
  count('Counts', `Review cases = ${reviewCases}`, 'SELECT count(*)::int AS n FROM "ReviewCase"', reviewCases);

  // ---- primary keys and business IDs are unique and well formed --------------------------------------------------
  const unique = (table, col) => none('Uniqueness', `${table}.${col} is unique`, `SELECT "${col}" AS value, count(*)::int AS n FROM "${table}" GROUP BY 1 HAVING count(*) > 1`);
  for (const table of ['Customer', 'Document', 'Verification', 'RiskRating', 'BeneficialOwner', 'OwnerScreening', 'OwnershipValidation', 'ReviewSchedule', 'Exception', 'ReviewCase', 'CaseHistory', 'CaseNote', 'Alert', 'AuditEvent', 'KYCRequirement', 'Reviewer']) unique(table, 'id');
  unique('Customer', 'customer_id');
  unique('KYCRequirement', 'business_id');
  unique('Document', 'business_id');
  unique('ReviewCase', 'review_code');
  unique('ReviewCase', 'case_code');
  unique('Alert', 'business_id');
  unique('Alert', 'alert_code');
  unique('Exception', 'exception_code');
  unique('RiskRating', 'assessment_code');
  unique('AuditEvent', 'event_code');
  const format = (table, col, regex, label) => none('ID formats', `${label} follows its format`, `SELECT id, "${col}" AS value FROM "${table}" WHERE "${col}" IS NULL OR "${col}" !~ '${regex}'`);
  format('Customer', 'customer_id', '^CUS-[0-9]{6}$', 'Customer ID (CUS-000001)');
  format('KYCRequirement', 'business_id', '^KYC-[0-9]{4}-[0-9]{6}$', 'KYC requirement ID (KYC-2026-000001)');
  format('Document', 'business_id', '^DOC-CUS-[0-9]{6}-[0-9]{3}$', 'Document ID (DOC-CUS-000001-001)');
  format('ReviewCase', 'review_code', '^REV-CUS-[0-9]{6}-[0-9]{4}(-[0-9]{2})?$', 'Review ID (REV-CUS-000001-2026)');
  format('Alert', 'business_id', '^ALT-[0-9]{4}-[0-9]{6}$', 'Alert ID (ALT-2026-000001)');
  none('ID formats', 'Document ID belongs to its own customer', `SELECT d.id FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.business_id NOT LIKE 'DOC-' || c.customer_id || '-%'`);
  none('ID formats', 'Review ID belongs to its own customer and year', `SELECT rc.id FROM "ReviewCase" rc JOIN "Customer" c ON c.id = rc.customer_id WHERE rc.review_code NOT LIKE 'REV-' || c.customer_id || '-' || EXTRACT(YEAR FROM rc.created_at)::int || '%'`);
  none('ID formats', 'Alert ID year matches the alert creation year', `SELECT id FROM "Alert" WHERE business_id NOT LIKE 'ALT-' || EXTRACT(YEAR FROM created_at)::int || '-%'`);

  // ---- foreign keys (no orphans) -----------------------------------------------------------------------------------------
  const orphan = (child, col, parent, label = `${child}.${col} -> ${parent}`) => none('Foreign keys', label, `SELECT c.id FROM "${child}" c LEFT JOIN "${parent}" p ON p.id = c."${col}" WHERE c."${col}" IS NOT NULL AND p.id IS NULL`);
  orphan('Customer', 'customer_type_id', 'CustomerType');
  orphan('Document', 'customer_id', 'Customer');
  orphan('Document', 'requirement_id', 'KYCRequirement');
  orphan('Verification', 'document_id', 'Document');
  orphan('Verification', 'reviewer_id', 'Reviewer');
  orphan('RiskRating', 'customer_id', 'Customer');
  orphan('RiskRating', 'assessed_by_id', 'Reviewer');
  orphan('BeneficialOwner', 'customer_id', 'Customer');
  orphan('OwnerScreening', 'beneficial_owner_id', 'BeneficialOwner');
  orphan('OwnershipValidation', 'customer_id', 'Customer');
  orphan('ReviewSchedule', 'customer_id', 'Customer');
  orphan('Exception', 'customer_id', 'Customer');
  orphan('ReviewCase', 'customer_id', 'Customer');
  orphan('ReviewCase', 'exception_id', 'Exception');
  orphan('ReviewCase', 'review_schedule_id', 'ReviewSchedule');
  orphan('ReviewCase', 'assigned_analyst_id', 'Reviewer');
  orphan('ReviewCase', 'assigned_reviewer_id', 'Reviewer');
  orphan('CaseHistory', 'review_case_id', 'ReviewCase');
  orphan('CaseNote', 'review_case_id', 'ReviewCase');
  orphan('Alert', 'customer_id', 'Customer');
  orphan('Alert', 'exception_id', 'Exception');
  orphan('AuditEvent', 'user_id', 'Reviewer');
  none('Foreign keys', 'CompanyOwnership -> company and owner', `SELECT o.id FROM "CompanyOwnership" o LEFT JOIN "Customer" c ON c.id = o.company_customer_id LEFT JOIN "BeneficialOwner" b ON b.id = o.beneficial_owner_id WHERE c.id IS NULL OR b.id IS NULL`);

  // ---- customers ----------------------------------------------------------------------------------------------------------
  none('Customer types', 'Individuals have date of birth + occupation and no company fields', `SELECT id FROM "Customer" WHERE customer_type_id = 1 AND (date_of_birth IS NULL OR occupation IS NULL OR company_registration_number IS NOT NULL OR business_activity IS NOT NULL OR date_of_incorporation IS NOT NULL)`);
  none('Customer types', 'Companies have registration number, activity, incorporation date and no personal fields', `SELECT id FROM "Customer" WHERE customer_type_id = 2 AND (company_registration_number IS NULL OR business_activity IS NULL OR date_of_incorporation IS NULL OR date_of_birth IS NOT NULL OR occupation IS NOT NULL OR aadhaar_number IS NOT NULL)`);
  none('Customer types', 'Individuals are adults at onboarding', `SELECT id FROM "Customer" WHERE customer_type_id = 1 AND date_of_birth > (created_at::date - interval '18 years')`);
  none('Customer types', 'Companies were incorporated before onboarding', `SELECT id FROM "Customer" WHERE customer_type_id = 2 AND date_of_incorporation > created_at::date`);
  none('Customer types', 'Customers are onboarded on or before the reference date', `SELECT id FROM "Customer" WHERE created_at > '${refEnd}'`);
  none('Customer types', 'Beneficial owners belong to companies only', `SELECT b.id FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE c.customer_type_id <> 2`);

  // ---- documents and verifications -----------------------------------------------------------------------------------
  none('Documents', 'Dates are consistent (issue <= submission, issue <= expiry)', `SELECT id FROM "Document" WHERE submission_date < issue_date OR (expiry_date IS NOT NULL AND expiry_date < issue_date)`);
  none('Documents', 'No document is submitted before its customer was onboarded', `SELECT d.id FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.submission_date < c.created_at::date`);
  none('Documents', 'No document is submitted after the reference date', `SELECT id FROM "Document" WHERE submission_date > DATE '${ref}'`);
  none('Documents', 'Document type matches its requirement', `SELECT d.id FROM "Document" d JOIN "KYCRequirement" q ON q.id = d.requirement_id WHERE q.document_type <> d.document_type`);
  none('Documents', 'Requirement matches the customer type', `SELECT d.id FROM "Document" d JOIN "KYCRequirement" q ON q.id = d.requirement_id JOIN "Customer" c ON c.id = d.customer_id WHERE q.customer_type_id <> c.customer_type_id`);
  none('Documents', 'Document status equals the newest verification', `SELECT d.id FROM "Document" d JOIN LATERAL (SELECT status FROM "Verification" v WHERE v.document_id = d.id ORDER BY v.id DESC LIMIT 1) v ON true WHERE v.status <> d.status`);
  none('Verifications', 'Every document starts with one Pending record by the system', `SELECT d.id FROM "Document" d WHERE (SELECT count(*) FROM "Verification" v WHERE v.document_id = d.id AND v.status = 'Pending') <> 1 OR NOT EXISTS (SELECT 1 FROM "Verification" v WHERE v.document_id = d.id AND v.status = 'Pending' AND v.reviewer_id IS NULL AND v.id = (SELECT min(id) FROM "Verification" v2 WHERE v2.document_id = d.id))`);
  none('Verifications', 'Decisions are by active Reviewers or Admins', `SELECT v.id FROM "Verification" v LEFT JOIN "Reviewer" r ON r.id = v.reviewer_id WHERE v.status <> 'Pending' AND (r.id IS NULL OR r.role NOT IN ('Reviewer', 'Admin') OR r.is_active IS NOT TRUE)`);
  none('Verifications', 'Verification dates are in order and not before submission', `SELECT v.id FROM "Verification" v JOIN "Document" d ON d.id = v.document_id WHERE v.verification_date::date < d.submission_date OR v.verification_date > '${refEnd}'
    OR EXISTS (SELECT 1 FROM "Verification" p WHERE p.document_id = v.document_id AND p.id < v.id AND p.verification_date > v.verification_date)`);
  none('Verifications', 'A document is never verified after its expiry date', `SELECT v.id FROM "Verification" v JOIN "Document" d ON d.id = v.document_id WHERE v.status = 'Verified' AND d.expiry_date IS NOT NULL AND v.verification_date::date > d.expiry_date`);

  // ---- ownership ------------------------------------------------------------------------------------------------------------
  none('Ownership', 'Every company has at least one owner', `SELECT c.id FROM "Customer" c WHERE c.customer_type_id = 2 AND NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.customer_id = c.id)`);
  none('Ownership', 'Ownership of every company adds up to exactly 100.00%', `SELECT customer_id AS id, sum(ownership_percentage) AS total FROM "BeneficialOwner" GROUP BY 1 HAVING sum(ownership_percentage) <> 100`);
  none('Ownership', 'Each owner holds a valid share (0 < % <= 100)', `SELECT id FROM "BeneficialOwner" WHERE ownership_percentage IS NULL OR ownership_percentage <= 0 OR ownership_percentage > 100`);
  none('Ownership', 'Every company has a RECONCILED ownership check', `SELECT c.id FROM "Customer" c WHERE c.customer_type_id = 2 AND NOT EXISTS (SELECT 1 FROM "OwnershipValidation" v WHERE v.customer_id = c.id AND v.validation_status = 'RECONCILED')`);
  none('Ownership', 'CompanyOwnership mirrors every owner (company, owner, percentage)', `SELECT b.id FROM "BeneficialOwner" b LEFT JOIN "CompanyOwnership" o ON o.beneficial_owner_id = b.id AND o.effective_to IS NULL WHERE o.id IS NULL OR o.company_customer_id <> b.customer_id OR o.ownership_percentage IS DISTINCT FROM b.ownership_percentage`);
  none('Ownership', 'Only one active ownership row per company and owner', `SELECT company_customer_id, beneficial_owner_id FROM "CompanyOwnership" WHERE effective_to IS NULL GROUP BY 1, 2 HAVING count(*) > 1`);
  none('Ownership', 'A person appears at most once per company', `SELECT company_customer_id, person_ref FROM "CompanyOwnership" WHERE effective_to IS NULL GROUP BY 1, 2 HAVING count(*) > 1`);
  none('Ownership', 'Owners were added after their company was onboarded', `SELECT b.id FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE b.created_at < c.created_at`);

  // ---- risk -----------------------------------------------------------------------------------------------------------------
  none('Risk', 'Every customer has a risk assessment', `SELECT c.id FROM "Customer" c WHERE NOT EXISTS (SELECT 1 FROM "RiskRating" r WHERE r.customer_id = c.id)`);
  none('Risk', 'The first assessment has no previous level; later ones record it', `SELECT r.id FROM "RiskRating" r WHERE (r.previous_risk_level IS NULL) <> (r.id = (SELECT min(id) FROM "RiskRating" r2 WHERE r2.customer_id = r.customer_id))`);
  none('Risk', 'Previous level equals the earlier assessment level', `SELECT r.id FROM "RiskRating" r JOIN LATERAL (SELECT risk_level FROM "RiskRating" p WHERE p.customer_id = r.customer_id AND p.id < r.id ORDER BY p.id DESC LIMIT 1) p ON true WHERE r.previous_risk_level IS DISTINCT FROM p.risk_level`);
  none('Risk', 'Every company has both onboarding and ownership assessments', `SELECT c.id FROM "Customer" c WHERE c.customer_type_id = 2 AND (SELECT count(*) FROM "RiskRating" r WHERE r.customer_id = c.id) <> 2`);
  none('Risk', 'Assessments are not dated before the customer or after the reference date', `SELECT r.id FROM "RiskRating" r JOIN "Customer" c ON c.id = r.customer_id WHERE r.assessment_date < c.created_at OR r.assessment_date > '${refEnd}'`);

  // ---- schedules, exceptions, cases ---------------------------------------------------------------------------------
  none('Reviews', 'Exactly one current schedule per customer', `SELECT c.id FROM "Customer" c WHERE (SELECT count(*) FROM "ReviewSchedule" s WHERE s.customer_id = c.id AND s.status = 'Scheduled') <> 1`);
  none('Reviews', 'Schedule interval matches the risk level (36 / 24 / 12 months)', `SELECT id FROM "ReviewSchedule" WHERE review_interval_months <> CASE risk_level WHEN 'Low' THEN 36 WHEN 'Medium' THEN 24 ELSE 12 END`);
  none('Reviews', 'Next review date = last review date + interval', `SELECT id FROM "ReviewSchedule" WHERE next_review_date <> (last_review_date + make_interval(months => review_interval_months))::date`);
  none('Reviews', 'Cases belong to the same customer as their exception and schedule', `SELECT rc.id FROM "ReviewCase" rc LEFT JOIN "Exception" e ON e.id = rc.exception_id LEFT JOIN "ReviewSchedule" s ON s.id = rc.review_schedule_id WHERE (e.id IS NOT NULL AND e.customer_id <> rc.customer_id) OR (s.id IS NOT NULL AND s.customer_id <> rc.customer_id)`);
  none('Reviews', 'Active cases belong to active exceptions; Resolved / Closed cases to resolved ones', `SELECT rc.id FROM "ReviewCase" rc JOIN "Exception" e ON e.id = rc.exception_id WHERE (rc.status IN ('Resolved', 'Closed')) <> (e.status = 'Resolved')`);
  none('Reviews', 'An exception is "In Review" exactly when it has an active case', `SELECT e.id FROM "Exception" e WHERE e.status <> 'Resolved' AND (e.status = 'In Review') <> EXISTS (SELECT 1 FROM "ReviewCase" rc WHERE rc.exception_id = e.id AND rc.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated'))`);
  none('Reviews', 'Every overdue periodic review already has its active case', `SELECT s.id FROM "ReviewSchedule" s WHERE s.status = 'Scheduled' AND s.next_review_date <= DATE '${ref}' AND NOT EXISTS (SELECT 1 FROM "ReviewCase" rc WHERE rc.review_schedule_id = s.id AND rc.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated'))`);
  none('Reviews', 'Case history starts with CREATED and ends in the case status', `SELECT rc.id FROM "ReviewCase" rc WHERE (SELECT action FROM "CaseHistory" h WHERE h.review_case_id = rc.id ORDER BY h.id LIMIT 1) <> 'CREATED' OR (SELECT new_status FROM "CaseHistory" h WHERE h.review_case_id = rc.id ORDER BY h.id DESC LIMIT 1) <> rc.status`);
  none('Reviews', 'Case history is in time order', `SELECT h.id FROM "CaseHistory" h WHERE EXISTS (SELECT 1 FROM "CaseHistory" p WHERE p.review_case_id = h.review_case_id AND p.id < h.id AND p.changed_at > h.changed_at)`);
  none('Reviews', 'Cases are not created before their exception was detected', `SELECT rc.id FROM "ReviewCase" rc JOIN "Exception" e ON e.id = rc.exception_id WHERE rc.created_at < e.detected_at`);
  none('Reviews', 'Escalated or approved cases name a compliance reviewer', `SELECT id FROM "ReviewCase" WHERE (status = 'Escalated' OR (requires_approval AND status IN ('Resolved', 'Closed'))) AND assigned_reviewer_id IS NULL`);
  none('Reviews', 'No active exception is duplicated', `SELECT dedupe_key FROM "Exception" WHERE status <> 'Resolved' GROUP BY 1 HAVING count(*) > 1`);
  none('Reviews', 'Exceptions are detected after the customer was onboarded', `SELECT e.id FROM "Exception" e JOIN "Customer" c ON c.id = e.customer_id WHERE e.detected_at < c.created_at OR e.detected_at > '${refEnd}'`);
  none('Reviews', 'Exception source records exist', `SELECT e.id FROM "Exception" e WHERE
      (e.source_entity_type = 'Document' AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d.id = e.source_entity_id AND d.customer_id = e.customer_id))
   OR (e.source_entity_type = 'KYCRequirement' AND NOT EXISTS (SELECT 1 FROM "KYCRequirement" q WHERE q.id = e.source_entity_id))
   OR (e.source_entity_type = 'BeneficialOwner' AND NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.id = e.source_entity_id AND b.customer_id = e.customer_id))
   OR (e.source_entity_type = 'Customer' AND e.source_entity_id <> e.customer_id)
   OR (e.source_entity_type = 'ReviewSchedule' AND NOT EXISTS (SELECT 1 FROM "ReviewSchedule" s WHERE s.id = e.source_entity_id AND s.customer_id = e.customer_id))`);

  // ---- alerts -----------------------------------------------------------------------------------------------------------------
  none('Alerts', 'No duplicate active alert for one condition', `SELECT dedupe_key FROM "Alert" WHERE status NOT IN ('Resolved', 'Dismissed') GROUP BY 1 HAVING count(*) > 1`);
  none('Alerts', 'Expiry thresholds are 90, 60, 30 or 7 only', `SELECT id FROM "Alert" WHERE alert_type = 'DOCUMENT_EXPIRY' AND (threshold IS NULL OR threshold NOT IN (90, 60, 30, 7))`);
  none('Alerts', 'One expiry alert per document and threshold', `SELECT related_entity_id, threshold FROM "Alert" WHERE alert_type = 'DOCUMENT_EXPIRY' GROUP BY 1, 2 HAVING count(*) > 1`);
  none('Alerts', 'The active expiry alert is the closest threshold the document has reached', `SELECT a.id FROM "Alert" a JOIN "Document" d ON d.id = a.related_entity_id WHERE a.alert_type = 'DOCUMENT_EXPIRY' AND a.status NOT IN ('Resolved', 'Dismissed')
      AND a.threshold <> (SELECT min(t) FROM unnest(ARRAY[90, 60, 30, 7]) t WHERE t >= (d.expiry_date - DATE '${ref}'))`);
  none('Alerts', 'Active expiry alerts exist only for valid documents expiring within 90 days', `SELECT a.id FROM "Alert" a JOIN "Document" d ON d.id = a.related_entity_id WHERE a.alert_type = 'DOCUMENT_EXPIRY' AND a.status NOT IN ('Resolved', 'Dismissed') AND (d.status <> 'Verified' OR d.expiry_date < DATE '${ref}' OR d.expiry_date > DATE '${ref}' + 90)`);
  none('Alerts', 'Alert source records exist', `SELECT a.id FROM "Alert" a WHERE
      (a.related_entity_type = 'Document' AND NOT EXISTS (SELECT 1 FROM "Document" d WHERE d.id = a.related_entity_id AND d.customer_id = a.customer_id))
   OR (a.related_entity_type = 'KYCRequirement' AND NOT EXISTS (SELECT 1 FROM "KYCRequirement" q WHERE q.id = a.related_entity_id))
   OR (a.related_entity_type = 'BeneficialOwner' AND NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.id = a.related_entity_id AND b.customer_id = a.customer_id))
   OR (a.related_entity_type = 'Customer' AND a.related_entity_id <> a.customer_id)
   OR (a.related_entity_type = 'ReviewSchedule' AND NOT EXISTS (SELECT 1 FROM "ReviewSchedule" s WHERE s.id = a.related_entity_id AND s.customer_id = a.customer_id))`);
  none('Alerts', 'Linked exception belongs to the same customer', `SELECT a.id FROM "Alert" a JOIN "Exception" e ON e.id = a.exception_id WHERE e.customer_id <> a.customer_id`);
  none('Alerts', 'Closed alerts are closed after they were created and not after the reference date', `SELECT id FROM "Alert" WHERE (status IN ('Resolved', 'Dismissed') AND (resolved_at < created_at OR resolved_at > '${refEnd}')) OR created_at > '${refEnd}'`);
  none('Alerts', 'Acknowledged alerts name who acknowledged them', `SELECT id FROM "Alert" WHERE status IN ('Acknowledged', 'In Progress') AND (acknowledged_by_id IS NULL OR acknowledged_at IS NULL)`);

  // ---- Phase 3 baseline: onboarding decisions and names on documents ----------------------------------------------
  orphan('OnboardingDecision', 'customer_id', 'Customer');
  orphan('OnboardingDecision', 'decided_by_id', 'Reviewer');
  none('Decisions', 'Every customer has a Pending Review entry from onboarding', `SELECT c.id FROM "Customer" c WHERE NOT EXISTS (SELECT 1 FROM "OnboardingDecision" d WHERE d.customer_id = c.id AND d.decision = 'Pending Review')`);
  none('Decisions', 'Decisions are dated between onboarding and the reference date', `SELECT d.id FROM "OnboardingDecision" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.decided_at < c.created_at OR d.decided_at > '${refEnd}'`);
  none('Decisions', 'Approvals and rejections are by active Reviewers or Admins', `SELECT d.id FROM "OnboardingDecision" d JOIN "Reviewer" r ON r.id = d.decided_by_id WHERE d.decision <> 'Pending Review' AND (r.role NOT IN ('Reviewer', 'Admin') OR r.is_active IS NOT TRUE)`);
  none('Decisions', 'A customer is approved at most once and never after being rejected', `SELECT customer_id FROM "OnboardingDecision" GROUP BY 1 HAVING count(*) FILTER (WHERE decision = 'Approved') > 1 OR (count(*) FILTER (WHERE decision = 'Approved') > 0 AND count(*) FILTER (WHERE decision = 'Rejected') > 0)`);
  none('Decisions', 'Every document records the name written on it', `SELECT id FROM "Document" WHERE name_on_document IS NULL OR btrim(name_on_document) = ''`);

  // ---- audit ---------------------------------------------------------------------------------------------------------------------
  none('Audit', 'Audit event references point to existing records', `SELECT a.id FROM "AuditEvent" a WHERE a.entity_id IS NOT NULL AND NOT (
      CASE a.entity_type
        WHEN 'Customer' THEN EXISTS (SELECT 1 FROM "Customer" x WHERE x.id = a.entity_id)
        WHEN 'RiskRating' THEN EXISTS (SELECT 1 FROM "RiskRating" x WHERE x.id = a.entity_id)
        WHEN 'Document' THEN EXISTS (SELECT 1 FROM "Document" x WHERE x.id = a.entity_id)
        WHEN 'KYCRequirement' THEN EXISTS (SELECT 1 FROM "KYCRequirement" x WHERE x.id = a.entity_id)
        WHEN 'BeneficialOwner' THEN EXISTS (SELECT 1 FROM "BeneficialOwner" x WHERE x.id = a.entity_id)
        WHEN 'OwnerScreening' THEN EXISTS (SELECT 1 FROM "OwnerScreening" x WHERE x.id = a.entity_id)
        WHEN 'OwnershipValidation' THEN EXISTS (SELECT 1 FROM "OwnershipValidation" x WHERE x.id = a.entity_id)
        WHEN 'ReviewCase' THEN EXISTS (SELECT 1 FROM "ReviewCase" x WHERE x.id = a.entity_id)
        WHEN 'ReviewSchedule' THEN EXISTS (SELECT 1 FROM "ReviewSchedule" x WHERE x.id = a.entity_id)
        WHEN 'Exception' THEN EXISTS (SELECT 1 FROM "Exception" x WHERE x.id = a.entity_id)
        WHEN 'Alert' THEN EXISTS (SELECT 1 FROM "Alert" x WHERE x.id = a.entity_id)
        WHEN 'OnboardingDecision' THEN EXISTS (SELECT 1 FROM "OnboardingDecision" x WHERE x.id = a.entity_id)
        ELSE false END)`);
  none('Audit', 'Audit event customers exist', `SELECT a.id FROM "AuditEvent" a LEFT JOIN "Customer" c ON c.id = a.customer_id WHERE a.customer_id IS NOT NULL AND c.id IS NULL`);
  none('Audit', 'Audit event references match the record business code', `SELECT a.id FROM "AuditEvent" a WHERE a.entity_ref IS NOT NULL AND a.entity_id IS NOT NULL AND NOT (
      CASE a.entity_type
        WHEN 'Customer' THEN EXISTS (SELECT 1 FROM "Customer" x WHERE x.id = a.entity_id AND x.customer_id = a.entity_ref)
        WHEN 'Document' THEN EXISTS (SELECT 1 FROM "Document" x WHERE x.id = a.entity_id AND x.business_id = a.entity_ref)
        WHEN 'ReviewCase' THEN EXISTS (SELECT 1 FROM "ReviewCase" x WHERE x.id = a.entity_id AND x.case_code = a.entity_ref)
        WHEN 'Exception' THEN EXISTS (SELECT 1 FROM "Exception" x WHERE x.id = a.entity_id AND x.exception_code = a.entity_ref)
        WHEN 'Alert' THEN EXISTS (SELECT 1 FROM "Alert" x WHERE x.id = a.entity_id AND x.alert_code = a.entity_ref)
        WHEN 'RiskRating' THEN EXISTS (SELECT 1 FROM "RiskRating" x WHERE x.id = a.entity_id AND x.assessment_code = a.entity_ref)
        WHEN 'KYCRequirement' THEN EXISTS (SELECT 1 FROM "KYCRequirement" x WHERE x.id = a.entity_id AND x.business_id = a.entity_ref)
        ELSE true END)`);
  none('Audit', 'Audit events are not dated after the reference date', `SELECT a.id FROM "AuditEvent" a WHERE a.created_at > '${refEnd}'`);
  none('Audit', 'Every customer and every case has its creation event', `SELECT c.id FROM "Customer" c WHERE NOT EXISTS (SELECT 1 FROM "AuditEvent" a WHERE a.entity_type = 'Customer' AND a.entity_id = c.id AND a.action_type = 'CUSTOMER_CREATED')
      UNION ALL SELECT rc.id FROM "ReviewCase" rc WHERE NOT EXISTS (SELECT 1 FROM "AuditEvent" a WHERE a.entity_type = 'ReviewCase' AND a.entity_id = rc.id AND a.action_type = 'CASE_CREATED')`);
  none('Audit', 'Audit events hold no PAN-like or Aadhaar-like text', `SELECT id FROM "AuditEvent" WHERE coalesce(new_values::text, '') || coalesce(previous_values::text, '') || coalesce(reason, '') ~ '[A-Z]{5}[0-9]{4}[A-Z]|[0-9]{4} ?[0-9]{4} ?[0-9]{4}'`);
  return C;
}

async function runValidation(prisma, cfg) {
  const results = [];
  for (const check of sqlChecks(cfg)) {
    const t0 = Date.now();
    let outcome;
    try {
      if (check.kind === 'count') {
        const [{ n }] = await prisma.$queryRawUnsafe(check.sql);
        outcome = { passed: n === check.expected, violations: n === check.expected ? 0 : Math.abs(n - check.expected), detail: `found ${n}, expected ${check.expected}`, examples: [] };
      } else {
        const [{ n }] = await prisma.$queryRawUnsafe(`SELECT count(*)::int AS n FROM (${check.sql}) v`);
        const examples = n > 0 ? await prisma.$queryRawUnsafe(`${check.sql} LIMIT ${EXAMPLES}`) : [];
        outcome = { passed: n === 0, violations: n, detail: n === 0 ? 'no violations' : `${n} violating row(s)`, examples: examples.map((row) => JSON.parse(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)))) };
      }
    } catch (err) {
      outcome = { passed: false, violations: null, detail: `the check could not run: ${err.message.split('\n').pop()}`, examples: [] };
    }
    results.push({ group: check.group, name: check.name, ...outcome, ms: Date.now() - t0 });
  }

  // The application's own data-quality checks (Scene 5), read-only.
  let application = null;
  if (!cfg.skipApplicationChecks) {
    try {
      const { evaluate } = require('../../server/src/services/dataQualityService');
      const { results: appResults } = await evaluate(prisma, cfg.referenceDate);
      application = appResults.map((x) => ({ code: x.code, title: x.title, outcome: x.outcome, issues: x.issueCount }));
    } catch (err) {
      application = [{ code: 'APP', title: 'Application data quality checks', outcome: 'Failed', issues: null, error: err.message }];
    }
  }
  const failed = results.filter((x) => !x.passed);
  const appFailed = (application || []).filter((x) => x.outcome === 'Failed');
  return {
    status: failed.length === 0 && appFailed.length === 0 ? 'PASSED' : 'FAILED',
    checks: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    application,
    applicationFailed: appFailed.length,
    applicationWarnings: (application || []).filter((x) => x.outcome === 'Warning').length,
  };
}

module.exports = { runValidation, sqlChecks };
