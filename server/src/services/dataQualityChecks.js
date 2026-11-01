/**
 * Data quality checks. Every check only READS the database: nothing is corrected silently. A check returns a list of
 * violations (the failed records, with a recommended fix); no violations = Passed.
 *
 *   Error    a rule is broken      -> the check is "Failed"
 *   Warning  worth attention       -> the check is "Warning"
 *
 * Several rules are also enforced by database constraints (foreign keys, CHECK constraints, triggers), so on a healthy database
 * those checks pass. They still run: they catch data loaded by bypassing the application, restored backups, or a constraint
 * that was dropped. The pure helpers at the bottom (validateRiskRow, validateCaseHistory, validateScheduleRow, ...) are unit-tested.
 */
const { Prisma } = require('@prisma/client');
const { VERIFICATION_STATUSES } = require('../config/kycRules');
const { RISK_RULES } = require('../config/riskRules');
const { PERIODIC_REVIEW } = require('../config/reviewRules');
const { ACTIONS } = require('./caseWorkflow');
const { levelForScore } = require('./riskService');
const { evaluateCustomerKyc, completenessFrom } = require('./kycEngine');
const { loadRequirements } = require('./kycService');
const { detectConditions } = require('./exceptionEngine');
const { addMonths, toIso, daysBetween } = require('../utils/dates');
const { nameCheck } = require('../utils/nameMatching');

const CATEGORIES = ['Primary Keys', 'Foreign Keys', 'Documents', 'Ownership', 'Risk', 'Review Cases', 'Data Consistency'];

const v = (entityType, entityId, entityRef, customerId, description, recommendedFix) => ({ entityType, entityId: entityId ?? null, entityRef: entityRef ?? null, customerId: customerId ?? null, description, recommendedFix });

// ---------------------------------------------------------------------------------------------
// Pure rules (unit-tested)
// ---------------------------------------------------------------------------------------------

/** Problems with one risk rating row: score range, score vs reasons, level vs configured thresholds. */
function validateRiskRow({ riskScore, riskLevel, reasons }) {
  const problems = [];
  if (!Number.isInteger(riskScore) || riskScore < 0 || riskScore > RISK_RULES.maxScore) problems.push({ code: 'SCORE_RANGE', message: `Score ${riskScore} is outside 0-${RISK_RULES.maxScore}` });
  if (Array.isArray(reasons) && reasons.length > 0) {
    const sum = Math.min(RISK_RULES.maxScore, reasons.reduce((n, r) => n + (Number(r.points) || 0), 0));
    if (sum !== riskScore) problems.push({ code: 'SCORE_REASONS', message: `Score ${riskScore} does not equal the points of its reasons (${sum})` });
  }
  if (Number.isInteger(riskScore) && levelForScore(riskScore) !== riskLevel) problems.push({ code: 'LEVEL_SCORE', message: `Level ${riskLevel} does not match score ${riskScore} (expected ${levelForScore(riskScore)})` });
  return problems;
}

// Pairs (from -> to) the case workflow can produce. A history row with no status change (assignment, priority, notes) is always fine.
const ALLOWED_TRANSITIONS = (() => {
  const pairs = new Set();
  for (const a of Object.values(ACTIONS)) {
    const targets = a.to ? [a.to] : ['In Progress', 'Open', 'Assigned']; // reopen goes back to work
    for (const from of a.from) for (const to of targets) pairs.add(`${from}>${to}`);
  }
  pairs.add('Open>Assigned'); // assigning an analyst
  pairs.add('Assigned>Open'); // releasing the case
  for (const from of ['Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated']) pairs.add(`${from}>Resolved`); // a completed periodic review
  return pairs;
})();

/**
 * Replays one case's history (oldest first). Returns problems: the first row must create the case, each row must start from
 * the status the previous row ended in, every status change must be an allowed workflow transition, and the case must end in
 * the status of its last history row.
 */
function validateCaseHistory(rows, currentStatus) {
  const problems = [];
  if (rows.length === 0) return [{ message: 'The case has no history at all' }];
  if (rows[0].previousStatus !== null || rows[0].action !== 'CREATED') problems.push({ message: 'The history does not start with the creation of the case' });
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (cur.previousStatus !== prev.newStatus) problems.push({ message: `History entry ${cur.id} (${cur.action}) starts from ${cur.previousStatus}, but the case was ${prev.newStatus}` });
    if (cur.previousStatus !== cur.newStatus && !ALLOWED_TRANSITIONS.has(`${cur.previousStatus}>${cur.newStatus}`)) problems.push({ message: `History entry ${cur.id} (${cur.action}) moved the case ${cur.previousStatus} -> ${cur.newStatus}, which the workflow does not allow` });
  }
  const last = rows[rows.length - 1];
  if (last.newStatus !== currentStatus) problems.push({ message: `The case is ${currentStatus}, but its history ends in ${last.newStatus}` });
  return problems;
}

/** Problems with one review schedule row. */
function validateScheduleRow({ lastReviewDate, nextReviewDate, reviewIntervalMonths, riskLevel, status, asOf }) {
  const problems = [];
  const last = toIso(lastReviewDate);
  const next = toIso(nextReviewDate);
  if (next <= last) problems.push({ severity: 'Error', message: `The next review (${next}) is not after the last review (${last})` });
  else if (addMonths(last, reviewIntervalMonths) !== next) problems.push({ severity: 'Error', message: `The next review (${next}) is not ${reviewIntervalMonths} months after the last review (${last})` });
  if (PERIODIC_REVIEW.intervalMonths[riskLevel] !== reviewIntervalMonths) problems.push({ severity: 'Warning', message: `The interval is ${reviewIntervalMonths} months, but ${riskLevel} risk uses ${PERIODIC_REVIEW.intervalMonths[riskLevel]} months` });
  if (status === 'Scheduled' && last > asOf) problems.push({ severity: 'Error', message: `The last review date (${last}) is in the future` });
  return problems;
}

/** Problems with the KYC completeness figures of one customer (evaluated by the engine from the records). */
function validateCompleteness(result) {
  const problems = [];
  const t = result.totals;
  const buckets = t.verified + t.missing + t.pendingVerification + t.rejected + t.requiresResubmission + t.expired;
  if (buckets !== t.mandatory) problems.push(`The requirement states add up to ${buckets}, but there are ${t.mandatory} mandatory requirements`);
  const expected = completenessFrom(t);
  if (expected.percentage !== result.percentage) problems.push(`Completeness is ${result.percentage}%, expected ${expected.percentage}%`);
  const verifiedRows = result.requirements.filter((r) => r.isMandatory && r.state === 'Verified').length;
  if (verifiedRows !== t.verified) problems.push(`${verifiedRows} requirements are verified, but the total says ${t.verified}`);
  for (const r of result.requirements) {
    if (r.state === 'Verified' && (!r.document || r.document.status !== 'Verified' || r.document.expiryState === 'Expired')) problems.push(`"${r.documentType}" counts as verified without a current verified document`);
    if (r.state === 'Missing' && r.submittedCount > 0) problems.push(`"${r.documentType}" is missing although ${r.submittedCount} document(s) were submitted`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Check definitions
// ---------------------------------------------------------------------------------------------
const duplicateCheck = (code, table, column, entityType, label) => ({
  code, category: 'Primary Keys', severity: 'Error', title: `No duplicate ${label}`,
  async run({ db }) {
    const rows = await db.$queryRaw(Prisma.sql`SELECT ${Prisma.raw(`"${column}"`)} AS ref, min(id)::int AS id, count(*)::int AS n FROM ${Prisma.raw(`"${table}"`)} GROUP BY 1 HAVING count(*) > 1`);
    return rows.map((r) => v(entityType, r.id, r.ref, null, `${label} ${r.ref} is used by ${r.n} records`, `Keep one record and correct the others so every ${label} is unique.`));
  },
});

const orphanCheck = (code, title, entityType, sql, fix) => ({
  code, category: 'Foreign Keys', severity: 'Error', title,
  async run({ db }) {
    const rows = await db.$queryRaw(sql);
    return rows.map((r) => v(entityType, r.id, r.ref, r.customerId, `${entityType} ${r.ref ?? r.id} points to a ${r.missing} that does not exist`, fix));
  },
});

const CHECKS = [
  // ---- Primary keys
  duplicateCheck('PK_CUSTOMER_CODE', 'Customer', 'customer_id', 'Customer', 'Customer ID'),
  duplicateCheck('PK_RISK_ASSESSMENT_CODE', 'RiskRating', 'assessment_code', 'RiskRating', 'risk assessment ID'),
  duplicateCheck('PK_CASE_CODE', 'ReviewCase', 'case_code', 'ReviewCase', 'review case ID'),
  duplicateCheck('PK_EXCEPTION_CODE', 'Exception', 'exception_code', 'Exception', 'exception ID'),
  duplicateCheck('PK_ALERT_CODE', 'Alert', 'alert_code', 'Alert', 'alert ID'),
  duplicateCheck('PK_AUDIT_EVENT_CODE', 'AuditEvent', 'event_code', 'AuditEvent', 'audit event ID'),
  {
    code: 'PK_DOCUMENT_DUPLICATE', category: 'Primary Keys', severity: 'Error', title: 'No duplicate document submissions',
    async run({ db }) {
      const rows = await db.$queryRaw`
        SELECT min(d.id)::int AS id, c.customer_id AS ref, d.customer_id AS "customerId", d.document_type AS type, count(*)::int AS n
        FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id
        WHERE d.document_number_hash IS NOT NULL
        GROUP BY c.customer_id, d.customer_id, d.document_type, d.document_number_hash, d.issue_date, d.submission_date HAVING count(*) > 1`;
      return rows.map((r) => v('Document', r.id, `${r.ref} / ${r.type}`, r.customerId, `The same ${r.type} (same number, issue and submission date) is recorded ${r.n} times for ${r.ref}`, 'Keep one document record and remove the duplicate submission through a corrected resubmission.'));
    },
  },
  {
    code: 'PK_OWNER_DUPLICATE', category: 'Primary Keys', severity: 'Error', title: 'No duplicate beneficial owners',
    async run({ db }) {
      const rows = await db.$queryRaw`
        SELECT min(b.id)::int AS id, c.customer_id AS ref, b.customer_id AS "customerId", count(*)::int AS n
        FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id
        WHERE b.identity_hash IS NOT NULL GROUP BY c.customer_id, b.customer_id, b.identity_hash HAVING count(*) > 1`;
      return rows.map((r) => v('BeneficialOwner', r.id, r.ref, r.customerId, `The same person is recorded ${r.n} times as an owner of ${r.ref}`, 'Open the ownership page and keep one record per person.'));
    },
  },

  // ---- Foreign keys
  orphanCheck('FK_DOCUMENT_CUSTOMER', 'Documents belong to existing customers', 'Document',
    Prisma.sql`SELECT d.id, d.id::text AS ref, d.customer_id AS "customerId", 'customer' AS missing FROM "Document" d LEFT JOIN "Customer" c ON c.id = d.customer_id WHERE c.id IS NULL`,
    'Restore the customer or remove the document through the document workflow.'),
  orphanCheck('FK_VERIFICATION_DOCUMENT', 'Verification records belong to existing documents', 'Verification',
    Prisma.sql`SELECT x.id, x.id::text AS ref, NULL::int AS "customerId", 'document' AS missing FROM "Verification" x LEFT JOIN "Document" d ON d.id = x.document_id WHERE d.id IS NULL`,
    'Restore the document; verification history must not be deleted.'),
  orphanCheck('FK_CASE_CUSTOMER', 'Review cases belong to existing customers', 'ReviewCase',
    Prisma.sql`SELECT rc.id, rc.case_code AS ref, rc.customer_id AS "customerId", 'customer' AS missing FROM "ReviewCase" rc LEFT JOIN "Customer" c ON c.id = rc.customer_id WHERE c.id IS NULL`,
    'Restore the customer; cases are never deleted.'),
  orphanCheck('FK_ALERT_CUSTOMER', 'Alerts belong to existing customers', 'Alert',
    Prisma.sql`SELECT a.id, a.alert_code AS ref, a.customer_id AS "customerId", 'customer' AS missing FROM "Alert" a LEFT JOIN "Customer" c ON c.id = a.customer_id WHERE c.id IS NULL`,
    'Restore the customer; alerts are kept as history.'),
  {
    code: 'FK_OWNER_COMPANY', category: 'Foreign Keys', severity: 'Error', title: 'Beneficial owners belong to existing company customers',
    async run({ db }) {
      const rows = await db.$queryRaw`
        SELECT b.id, b.customer_id AS "customerId", c.customer_id AS ref, t.type_name AS type
        FROM "BeneficialOwner" b LEFT JOIN "Customer" c ON c.id = b.customer_id LEFT JOIN "CustomerType" t ON t.id = c.customer_type_id
        WHERE c.id IS NULL OR t.type_name <> 'Company'`;
      return rows.map((r) => v('BeneficialOwner', r.id, r.ref ?? `owner #${r.id}`, r.customerId, r.ref ? `Owner #${r.id} is attached to ${r.ref}, which is an ${r.type}, not a company` : `Owner #${r.id} belongs to a customer that does not exist`, 'Move the owner to the correct company customer through the ownership page.'));
    },
  },
  {
    code: 'FK_CASE_LINKS', category: 'Foreign Keys', severity: 'Error', title: 'Cases link to existing exceptions and review schedules',
    async run({ db }) {
      const rows = await db.$queryRaw`
        SELECT rc.id, rc.case_code AS ref, rc.customer_id AS "customerId",
               (rc.exception_id IS NOT NULL AND e.id IS NULL) AS "badException", (rc.review_schedule_id IS NOT NULL AND s.id IS NULL) AS "badSchedule"
        FROM "ReviewCase" rc LEFT JOIN "Exception" e ON e.id = rc.exception_id LEFT JOIN "ReviewSchedule" s ON s.id = rc.review_schedule_id
        WHERE (rc.exception_id IS NOT NULL AND e.id IS NULL) OR (rc.review_schedule_id IS NOT NULL AND s.id IS NULL)`;
      return rows.map((r) => v('ReviewCase', r.id, r.ref, r.customerId, `Case ${r.ref} links to ${r.badException ? 'an exception' : 'a review schedule'} that does not exist`, 'Reopen the case and note the missing link in a case note.'));
    },
  },

  // ---- Documents
  {
    code: 'DOC_ISSUE_AFTER_SUBMISSION', category: 'Documents', severity: 'Error', title: 'Issue date is not after the submission date',
    async run({ db }) {
      const rows = await db.$queryRaw`SELECT d.id, d.customer_id AS "customerId", c.customer_id AS ref, d.document_type AS type, d.issue_date AS issue, d.submission_date AS sub FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.issue_date > d.submission_date`;
      return rows.map((r) => v('Document', r.id, `${r.ref} / ${r.type}`, r.customerId, `${r.type} was issued on ${toIso(r.issue)}, after it was submitted on ${toIso(r.sub)}`, 'Edit the document and correct the issue or submission date.'));
    },
  },
  {
    code: 'DOC_EXPIRY_BEFORE_ISSUE', category: 'Documents', severity: 'Error', title: 'Expiry date is not before the issue date',
    async run({ db }) {
      const rows = await db.$queryRaw`SELECT d.id, d.customer_id AS "customerId", c.customer_id AS ref, d.document_type AS type, d.issue_date AS issue, d.expiry_date AS expiry FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.expiry_date IS NOT NULL AND d.expiry_date < d.issue_date`;
      return rows.map((r) => v('Document', r.id, `${r.ref} / ${r.type}`, r.customerId, `${r.type} expires on ${toIso(r.expiry)}, before its issue date ${toIso(r.issue)}`, 'Edit the document and correct the expiry or issue date.'));
    },
  },
  {
    code: 'DOC_INVALID_STATUS', category: 'Documents', severity: 'Error', title: 'Documents have a valid status',
    async run({ db }) {
      const rows = await db.$queryRaw(Prisma.sql`SELECT d.id, d.customer_id AS "customerId", c.customer_id AS ref, d.document_type AS type, d.status FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.status NOT IN (${Prisma.join(VERIFICATION_STATUSES)})`);
      return rows.map((r) => v('Document', r.id, `${r.ref} / ${r.type}`, r.customerId, `${r.type} has the status "${r.status}", which is not one of: ${VERIFICATION_STATUSES.join(', ')}`, 'Record a new verification decision so the status is set by the verification workflow.'));
    },
  },
  {
    code: 'DOC_NAME_MATCHES_CUSTOMER', category: 'Documents', severity: 'Warning', title: 'Name on the document matches the registered name',
    async run({ db }) {
      const rows = await db.$queryRaw`
        SELECT d.id, d.customer_id AS "customerId", c.customer_id AS ref, d.document_type AS type, d.name_on_document AS printed, c.full_name AS registered, t.type_name AS "customerType"
        FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id JOIN "CustomerType" t ON t.id = c.customer_type_id
        WHERE d.name_on_document IS NOT NULL AND btrim(d.name_on_document) <> ''`;
      return rows
        .filter((r) => nameCheck({ registeredName: r.registered, nameOnDocument: r.printed, isCompany: r.customerType === 'Company' }).status === 'Mismatch')
        .map((r) => v('Document', r.id, `${r.ref} / ${r.type}`, r.customerId, `The name on the ${r.type} ("${r.printed}") differs from the registered name ("${r.registered}")`, 'Check the document with the customer. If the difference is genuine (for example a changed name), note it in the verification remarks; if it was a typing error, correct the name on the document record.'));
    },
  },
  {
    code: 'DOC_STATUS_MATCHES_VERIFICATION', category: 'Documents', severity: 'Error', title: 'Document status matches its latest verification',
    async run({ db }) {
      const rows = await db.$queryRaw`
        SELECT d.id, d.customer_id AS "customerId", c.customer_id AS ref, d.document_type AS type, d.status, lv.status AS latest
        FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id
        LEFT JOIN LATERAL (SELECT x.status FROM "Verification" x WHERE x.document_id = d.id ORDER BY x.id DESC LIMIT 1) lv ON true
        WHERE lv.status IS DISTINCT FROM d.status`;
      return rows.map((r) => v('Document', r.id, `${r.ref} / ${r.type}`, r.customerId, r.latest ? `${r.type} is ${r.status}, but its latest verification says ${r.latest}` : `${r.type} has no verification history`, 'Record a new verification decision for the document.'));
    },
  },

  // ---- Ownership
  {
    code: 'OWN_PERCENTAGE_RANGE', category: 'Ownership', severity: 'Error', title: 'Ownership percentage is between 0 and 100',
    async run({ db }) {
      const rows = await db.$queryRaw`SELECT b.id, b.customer_id AS "customerId", c.customer_id AS ref, b.ownership_percentage::float8 AS pct FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE b.ownership_percentage < 0 OR b.ownership_percentage > 100`;
      return rows.map((r) => v('BeneficialOwner', r.id, `${r.ref} / owner #${r.id}`, r.customerId, `Owner #${r.id} of ${r.ref} holds ${r.pct}%, outside 0-100%`, 'Edit the owner and enter a percentage between 0 and 100.'));
    },
  },
  {
    code: 'OWN_TOTAL_OVER_100', category: 'Ownership', severity: 'Error', title: 'Total ownership does not exceed 100%',
    async run({ db }) {
      const rows = await db.$queryRaw`SELECT c.id AS "customerId", c.customer_id AS ref, sum(b.ownership_percentage)::float8 AS total FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id GROUP BY c.id, c.customer_id HAVING sum(b.ownership_percentage) > 100`;
      return rows.map((r) => v('Customer', r.customerId, r.ref, r.customerId, `The owners of ${r.ref} hold ${r.total}% in total`, 'Review the owners on the ownership page and correct the percentages.'));
    },
  },
  {
    code: 'OWN_MISSING_OWNERS', category: 'Ownership', severity: 'Warning', title: 'Companies have beneficial owners recorded',
    async run({ db }) {
      const rows = await db.$queryRaw`SELECT c.id AS "customerId", c.customer_id AS ref FROM "Customer" c JOIN "CustomerType" t ON t.id = c.customer_type_id AND t.type_name = 'Company' WHERE NOT EXISTS (SELECT 1 FROM "BeneficialOwner" b WHERE b.customer_id = c.id)`;
      return rows.map((r) => v('Customer', r.customerId, r.ref, r.customerId, `${r.ref} is a company with no beneficial owners recorded`, 'Add the beneficial owners on the ownership page.'));
    },
  },
  {
    code: 'OWN_MISSING_PERCENTAGE', category: 'Ownership', severity: 'Warning', title: 'Beneficial owners have an ownership percentage',
    async run({ db }) {
      const rows = await db.$queryRaw`SELECT b.id, b.customer_id AS "customerId", c.customer_id AS ref FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id WHERE b.ownership_percentage IS NULL`;
      return rows.map((r) => v('BeneficialOwner', r.id, `${r.ref} / owner #${r.id}`, r.customerId, `Owner #${r.id} of ${r.ref} has no ownership percentage`, 'Edit the owner and enter the percentage.'));
    },
  },

  // ---- Risk
  {
    code: 'RISK_RULES_FOLLOWED', category: 'Risk', severity: 'Error', title: 'Risk scores and levels follow the configured rules',
    async run({ db }) {
      const rows = await db.$queryRaw`SELECT r.id, r.customer_id AS "customerId", r.assessment_code AS ref, r.risk_score AS score, r.risk_level AS level, r.risk_reasons->'reasons' AS reasons FROM "RiskRating" r`;
      return rows.flatMap((r) => validateRiskRow({ riskScore: r.score, riskLevel: r.level, reasons: r.reasons }).map((p) => v('RiskRating', r.id, r.ref, r.customerId, `Risk assessment ${r.ref}: ${p.message}`, 'Record a new risk assessment so the score and level are recalculated from the configured rules. The old assessment stays as history.')));
    },
  },
  {
    code: 'RISK_HISTORY_PRESERVED', category: 'Risk', severity: 'Error', title: 'Risk assessment history is complete and in order',
    async run({ db }) {
      const noRating = await db.$queryRaw`SELECT c.id AS "customerId", c.customer_id AS ref FROM "Customer" c WHERE NOT EXISTS (SELECT 1 FROM "RiskRating" r WHERE r.customer_id = c.id)`;
      const chain = await db.$queryRaw`
        SELECT * FROM (
          SELECT r.id, r.customer_id AS "customerId", r.assessment_code AS ref, r.previous_risk_level AS previous,
                 lag(r.risk_level) OVER (PARTITION BY r.customer_id ORDER BY r.assessment_date, r.id) AS expected
          FROM "RiskRating" r) x
        WHERE x.previous IS DISTINCT FROM x.expected`;
      return [
        ...noRating.map((r) => v('Customer', r.customerId, r.ref, r.customerId, `${r.ref} has no risk assessment`, 'Run a risk assessment for the customer.')),
        ...chain.map((r) => v('RiskRating', r.id, r.ref, r.customerId, `Assessment ${r.ref} records the previous level as ${r.previous ?? 'none'}, but the earlier assessment says ${r.expected ?? 'none'}`, 'Do not edit history. Record a new assessment and note the discrepancy.')),
      ];
    },
  },

  // ---- Review cases
  {
    code: 'CASE_CLOSED_WITHOUT_NOTES', category: 'Review Cases', severity: 'Error', title: 'Resolved and closed cases have resolution notes',
    async run({ db }) {
      const rows = await db.$queryRaw`SELECT id, case_code AS ref, customer_id AS "customerId", status FROM "ReviewCase" WHERE status IN ('Resolved', 'Closed') AND length(btrim(coalesce(resolution_notes, ''))) = 0`;
      return rows.map((r) => v('ReviewCase', r.id, r.ref, r.customerId, `Case ${r.ref} is ${r.status} without resolution notes`, 'Reopen the case and resolve it again with resolution notes.'));
    },
  },
  {
    code: 'CASE_STATUS_TRANSITIONS', category: 'Review Cases', severity: 'Error', title: 'Case status changes follow the workflow',
    async run({ db }) {
      const cases = await db.$queryRaw`SELECT id, case_code AS ref, customer_id AS "customerId", status FROM "ReviewCase"`;
      const history = await db.$queryRaw`SELECT id, review_case_id AS "caseId", action, previous_status AS "previousStatus", new_status AS "newStatus" FROM "CaseHistory" ORDER BY review_case_id, id`;
      const byCase = new Map();
      for (const h of history) byCase.set(h.caseId, [...(byCase.get(h.caseId) ?? []), h]);
      return cases.flatMap((c) => validateCaseHistory(byCase.get(c.id) ?? [], c.status).map((p) => v('ReviewCase', c.id, c.ref, c.customerId, `Case ${c.ref}: ${p.message}`, 'Do not edit case history. Reopen the case or add a case note that explains the discrepancy.')));
    },
  },
  {
    code: 'CASE_TIMESTAMPS_CONSISTENT', category: 'Review Cases', severity: 'Error', title: 'Case dates match the case status',
    async run({ db }) {
      const rows = await db.$queryRaw`
        SELECT id, case_code AS ref, customer_id AS "customerId", status FROM "ReviewCase"
        WHERE (status = 'Resolved' AND resolved_at IS NULL) OR (status = 'Closed' AND closed_at IS NULL)
           OR (status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated') AND (closed_at IS NOT NULL OR resolved_at IS NOT NULL))`;
      return rows.map((r) => v('ReviewCase', r.id, r.ref, r.customerId, `Case ${r.ref} is ${r.status} but its resolved/closed dates do not match`, 'Reopen and resolve the case again so the dates are recorded.'));
    },
  },
  {
    code: 'CASE_OVERDUE_IDENTIFIED', category: 'Review Cases', severity: 'Warning', title: 'No active case is past its due date',
    async run({ db, asOf }) {
      const rows = await db.$queryRaw`SELECT id, case_code AS ref, customer_id AS "customerId", due_date AS due, status FROM "ReviewCase" WHERE status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated') AND due_date < ${asOf}::date`;
      return rows.map((r) => v('ReviewCase', r.id, r.ref, r.customerId, `Case ${r.ref} (${r.status}) was due on ${toIso(r.due)} and is ${daysBetween(toIso(r.due), asOf)} day(s) overdue`, 'Work or escalate the case, or agree a new priority with the compliance reviewer.'));
    },
  },

  // ---- Data consistency
  {
    code: 'KYC_COMPLETENESS_CONSISTENT', category: 'Data Consistency', severity: 'Error', title: 'KYC completeness matches documents and requirements',
    async run({ db, asOf }) {
      const [customers, requirements, documents] = await Promise.all([
        db.$queryRaw`
          SELECT c.id, c.customer_id AS ref, t.type_name AS "customerType", rr.risk_level AS "riskLevel"
          FROM "Customer" c JOIN "CustomerType" t ON t.id = c.customer_type_id
          LEFT JOIN LATERAL (SELECT x.risk_level FROM "RiskRating" x WHERE x.customer_id = c.id ORDER BY x.assessment_date DESC, x.id DESC LIMIT 1) rr ON true`,
        loadRequirements(),
        db.document.findMany({ select: { id: true, customerId: true, documentType: true, status: true, expiryDate: true, submissionDate: true } }),
      ]);
      const docs = new Map();
      for (const d of documents) docs.set(d.customerId, [...(docs.get(d.customerId) ?? []), d]);
      const out = [];
      for (const c of customers) {
        if (!c.riskLevel) continue;
        const result = evaluateCustomerKyc({ customerType: c.customerType, riskLevel: c.riskLevel, requirements, documents: docs.get(c.id) ?? [], asOf });
        for (const p of validateCompleteness(result)) out.push(v('Customer', c.id, c.ref, c.id, `${c.ref}: ${p}`, 'Review the customer KYC page; correct the documents or requirements so the figures agree.'));
      }
      return out;
    },
  },
  {
    code: 'KYC_REQUIREMENTS_DEFINED', category: 'Data Consistency', severity: 'Warning', title: 'Every customer has KYC requirements to be measured against',
    async run({ db, asOf }) {
      const [customers, requirements] = await Promise.all([
        db.$queryRaw`
          SELECT c.id, c.customer_id AS ref, t.type_name AS "customerType", rr.risk_level AS "riskLevel"
          FROM "Customer" c JOIN "CustomerType" t ON t.id = c.customer_type_id
          LEFT JOIN LATERAL (SELECT x.risk_level FROM "RiskRating" x WHERE x.customer_id = c.id ORDER BY x.assessment_date DESC, x.id DESC LIMIT 1) rr ON true`,
        loadRequirements(),
      ]);
      return customers.filter((c) => c.riskLevel && evaluateCustomerKyc({ customerType: c.customerType, riskLevel: c.riskLevel, requirements, documents: [], asOf }).totals.mandatory === 0)
        .map((c) => v('Customer', c.id, c.ref, c.id, `${c.ref} (${c.customerType}, ${c.riskLevel} risk) has no mandatory KYC requirement, so completeness cannot be measured`, 'Add or activate a KYC requirement for this customer type and risk level.'));
    },
  },
  {
    code: 'ALERT_ACTIVE_VALID', category: 'Data Consistency', severity: 'Error', title: 'Active alerts reference a valid, current issue',
    async run({ db, asOf, getContexts }) {
      const { deriveAlerts } = require('./alertEngine');
      const active = await db.$queryRaw`SELECT a.id, a.alert_code AS ref, a.customer_id AS "customerId", a.dedupe_key AS key, a.related_entity_type AS "relatedType", a.related_entity_id AS "relatedId" FROM "Alert" a WHERE a.status IN ('New', 'Acknowledged', 'In Progress')`;
      const live = new Set();
      for (const ctx of await getContexts()) for (const a of deriveAlerts(ctx, detectConditions({ ...ctx, unresolvedClosedCases: [], asOf }))) live.add(a.key);
      const out = [];
      for (const a of active) {
        if (!live.has(a.key)) out.push(v('Alert', a.id, a.ref, a.customerId, `Alert ${a.ref} is active, but the records no longer show the issue it describes`, 'Run detection (Alerts page, "Refresh alerts") so the alert is resolved automatically.'));
      }
      const table = { Document: 'Document', BeneficialOwner: 'BeneficialOwner', ReviewSchedule: 'ReviewSchedule', Customer: 'Customer', ReviewCase: 'ReviewCase' };
      for (const a of active) {
        if (!a.relatedId || !table[a.relatedType]) continue;
        const found = await db.$queryRaw(Prisma.sql`SELECT 1 FROM ${Prisma.raw(`"${table[a.relatedType]}"`)} WHERE id = ${a.relatedId}`);
        if (found.length === 0) out.push(v('Alert', a.id, a.ref, a.customerId, `Alert ${a.ref} refers to ${a.relatedType} #${a.relatedId}, which does not exist`, 'Restore the source record, or resolve the alert with remarks.'));
      }
      return out;
    },
  },
  {
    code: 'ALERT_NO_DUPLICATE_ACTIVE', category: 'Data Consistency', severity: 'Error', title: 'No duplicate active alerts for the same issue',
    async run({ db }) {
      const rows = await db.$queryRaw`SELECT min(id)::int AS id, min(alert_code) AS ref, min(customer_id)::int AS "customerId", count(*)::int AS n FROM "Alert" WHERE status IN ('New', 'Acknowledged', 'In Progress') GROUP BY dedupe_key HAVING count(*) > 1`;
      return rows.map((r) => v('Alert', r.id, r.ref, r.customerId, `${r.n} active alerts describe the same issue (starting with ${r.ref})`, 'Resolve the duplicates with remarks; keep one active alert per issue.'));
    },
  },
  {
    code: 'PERIODIC_REVIEW_DATES', category: 'Data Consistency', severity: 'Error', title: 'Periodic review dates are logically consistent',
    async run({ db, asOf }) {
      const rows = await db.$queryRaw`SELECT s.id, s.customer_id AS "customerId", c.customer_id AS ref, s.cycle_number AS cycle, s.last_review_date AS last, s.next_review_date AS next, s.review_interval_months AS months, s.risk_level AS level, s.status FROM "ReviewSchedule" s JOIN "Customer" c ON c.id = s.customer_id`;
      const out = rows.flatMap((r) => validateScheduleRow({ lastReviewDate: r.last, nextReviewDate: r.next, reviewIntervalMonths: r.months, riskLevel: r.level, status: r.status, asOf }).map((p) => ({ p, r })));
      const noCurrent = await db.$queryRaw`SELECT c.id AS "customerId", c.customer_id AS ref FROM "Customer" c WHERE NOT EXISTS (SELECT 1 FROM "ReviewSchedule" s WHERE s.customer_id = c.id AND s.status = 'Scheduled')`;
      return [
        ...out.map(({ p, r }) => ({ ...v('ReviewSchedule', r.id, `${r.ref} / cycle ${r.cycle}`, r.customerId, `${r.ref} cycle ${r.cycle}: ${p.message}`, 'Complete or re-create the periodic review schedule from the Periodic Reviews page.'), severity: p.severity })),
        ...noCurrent.map((r) => ({ ...v('Customer', r.customerId, r.ref, r.customerId, `${r.ref} has no current periodic review schedule`, 'Run detection to create the schedule, or create it on the Periodic Reviews page.'), severity: 'Warning' })),
      ];
    },
  },
];

module.exports = { CHECKS, CATEGORIES, validateRiskRow, validateCaseHistory, validateScheduleRow, validateCompleteness, ALLOWED_TRANSITIONS };
