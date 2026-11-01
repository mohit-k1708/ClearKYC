/**
 * Reports & exports. Every export is built from the database at the moment it is requested, filtered BEFORE it is
 * written, with fixed column names, and delivered as UTF-8 (CSV with a byte-order mark; JSON; SQL).
 *
 * Safeguards
 *   - Identifiers are masked: PAN XXXXXX234F, Aadhaar XXXX XXXX 9012, document numbers keep the last four characters, and
 *     e-mail and phone are masked. Encrypted columns, key hashes, dates of birth and passwords are never exported.
 *   - Sensitive exports (customers, risk, ownership, audit trail, seed data, schema) are limited to compliance reviewers and
 *     administrators. The other reports are available to every active user.
 *   - Every export is recorded in the audit trail (who, which report, which filters, how many rows) before it is returned.
 *   - Row limit: EXPORT_MAX_ROWS. Larger result sets are refused with a request to narrow the filters.
 */
const prisma = require('../utils/prisma');
const { AppError, badRequest } = require('../utils/errors');
const { decrypt } = require('../utils/crypto');
const { maskPan, maskAadhaar, maskDocumentNumber } = require('../utils/mask');
const { toCsv } = require('../utils/csv');
const { toIso, todayIso, daysBetween } = require('../utils/dates');
const audit = require('./auditService');
const alerts = require('./alertService');
const { loadRequirements } = require('./kycService');
const { evaluateCustomerKyc, expiryInfo } = require('./kycEngine');
const { ACTIVE_CASE_STATUSES } = require('../config/reviewRules');

const EXPORT_MAX_ROWS = 20000;
const SEED = 20261022;
const SENSITIVE_ROLES = ['Reviewer', 'Admin'];
const ALL_ROLES = ['Analyst', 'Reviewer', 'Admin'];


const maskEmail = (e) => (e ? e.replace(/^(.).*(@.*)$/, '$1***$2') : null);
const maskPhone = (p) => (p ? `${'X'.repeat(Math.max(p.length - 4, 0))}${p.slice(-4)}` : null);
const safeDecrypt = (value, mask) => {
  if (!value) return null;
  try { return mask(decrypt(value)); } catch { return '[unreadable]'; }
};
const dateRange = (column, { from, to }) => {
  if (!from && !to) return {};
  return { [column]: { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000) } : {}) } };
};

function checkSize(count) {
  if (count > EXPORT_MAX_ROWS) throw new AppError(413, 'EXPORT_TOO_LARGE', `This export has ${count} rows; the limit is ${EXPORT_MAX_ROWS}. Narrow it with the filters or a date range.`);
}

async function latestRatings() {
  const rows = await prisma.$queryRaw`
    SELECT DISTINCT ON (customer_id) customer_id AS "customerId", risk_level AS level, risk_score AS score, assessment_status AS status
    FROM "RiskRating" ORDER BY customer_id, assessment_date DESC, id DESC`;
  return new Map(rows.map((r) => [r.customerId, r]));
}

// ---------------------------------------------------------------------------------------------
// Dataset builders: each returns { columns, rows }
// ---------------------------------------------------------------------------------------------
async function customersDataset(q) {
  const where = {
    ...(q.customerType ? { customerType: { typeName: q.customerType } } : {}),
    ...dateRange('createdAt', q),
    ...(q.search ? { OR: [{ customerCode: { contains: q.search, mode: 'insensitive' } }, { fullName: { contains: q.search, mode: 'insensitive' } }] } : {}),
  };
  const [customers, ratings] = await Promise.all([prisma.customer.findMany({ where, include: { customerType: true }, orderBy: { id: 'asc' } }), latestRatings()]);
  const rows = customers
    .map((c) => ({ c, r: ratings.get(c.id) }))
    .filter(({ r }) => !q.riskLevel || r?.level === q.riskLevel);
  checkSize(rows.length);
  return {
    columns: ['Customer ID', 'Customer Type', 'Full Name', 'Email (masked)', 'Phone (masked)', 'Country', 'PAN (masked)', 'Aadhaar (masked)', 'Registration Status', 'Risk Level', 'Risk Score', 'Created At'],
    rows: rows.map(({ c, r }) => [c.customerCode, c.customerType.typeName, c.fullName, maskEmail(c.email), maskPhone(c.phone), c.country, safeDecrypt(c.panNumber, maskPan), safeDecrypt(c.aadhaarNumber, maskAadhaar), c.registrationStatus, r?.level ?? '', r?.score ?? '', c.createdAt]),
  };
}

async function documentsDataset(q) {
  const asOf = todayIso();
  const where = {
    ...(q.status ? { status: q.status } : {}),
    ...(q.documentType ? { documentType: q.documentType } : {}),
    ...(q.customerId ? { customer: { customerCode: q.customerId } } : {}),
    ...(q.from || q.to ? { submissionDate: { ...(q.from ? { gte: new Date(`${q.from}T00:00:00.000Z`) } : {}), ...(q.to ? { lte: new Date(`${q.to}T00:00:00.000Z`) } : {}) } } : {}),
  };
  const docs = await prisma.document.findMany({ where, include: { customer: { select: { customerCode: true } } }, orderBy: { id: 'asc' } });
  const rows = docs.filter((d) => !q.expiry || expiryInfo(d.expiryDate, asOf).expiryState === q.expiry);
  checkSize(rows.length);
  return {
    columns: ['Document ID', 'Customer ID', 'Document Type', 'Document Number (masked)', 'Issue Date', 'Expiry Date', 'Submission Date', 'Verification Status', 'Expiry State', 'File Attached', 'Created At'],
    rows: rows.map((d) => [d.id, d.customer.customerCode, d.documentType, safeDecrypt(d.documentNumber, maskDocumentNumber), toIso(d.issueDate), toIso(d.expiryDate), toIso(d.submissionDate), d.status, expiryInfo(d.expiryDate, asOf).expiryState, d.fileReference ? 'Yes' : 'No', d.createdAt]),
  };
}

async function completenessDataset(q) {
  const asOf = todayIso();
  const [customers, requirements, documents, ratings] = await Promise.all([
    prisma.customer.findMany({ where: { ...(q.customerType ? { customerType: { typeName: q.customerType } } : {}), ...dateRange('createdAt', q) }, include: { customerType: true }, orderBy: { id: 'asc' } }),
    loadRequirements(),
    prisma.document.findMany({ select: { id: true, customerId: true, documentType: true, status: true, expiryDate: true, submissionDate: true } }),
    latestRatings(),
  ]);
  const byCustomer = new Map();
  for (const d of documents) byCustomer.set(d.customerId, [...(byCustomer.get(d.customerId) ?? []), d]);
  const rows = [];
  for (const c of customers) {
    const level = ratings.get(c.id)?.level;
    if (!level || (q.riskLevel && level !== q.riskLevel)) continue;
    const e = evaluateCustomerKyc({ customerType: c.customerType.typeName, riskLevel: level, requirements, documents: byCustomer.get(c.id) ?? [], asOf });
    if (q.completeness && e.status !== q.completeness) continue;
    const t = e.totals;
    rows.push([c.customerCode, c.customerType.typeName, level, t.mandatory, t.verified, t.missing, t.pendingVerification, t.rejected, t.requiresResubmission, t.expired, t.expiringSoon, e.percentage ?? '', e.status, asOf]);
  }
  checkSize(rows.length);
  return { columns: ['Customer ID', 'Customer Type', 'Risk Level', 'Mandatory Requirements', 'Verified', 'Missing', 'Pending Verification', 'Rejected', 'Requires Resubmission', 'Expired', 'Expiring Within 30 Days', 'Completeness %', 'Completeness Status', 'As Of'], rows };
}

async function risksDataset(q) {
  const where = {
    ...(q.riskLevel ? { riskLevel: q.riskLevel } : {}),
    ...(q.assessmentStatus ? { assessmentStatus: q.assessmentStatus } : {}),
    ...(q.customerId ? { customer: { customerCode: q.customerId } } : {}),
    ...dateRange('assessmentDate', q),
  };
  const list = await prisma.riskRating.findMany({ where, include: { customer: { select: { customerCode: true } }, assessedBy: { select: { name: true } } }, orderBy: { id: 'asc' } });
  checkSize(list.length);
  return {
    columns: ['Assessment ID', 'Customer ID', 'Risk Score', 'Risk Level', 'Previous Risk Level', 'Assessment Status', 'Method', 'Assessed By', 'Assessment Date'],
    rows: list.map((r) => [r.assessmentCode, r.customer.customerCode, r.riskScore, r.riskLevel, r.previousRiskLevel ?? '', r.assessmentStatus, r.assessmentMethod, r.assessedBy?.name ?? 'System', r.assessmentDate]),
  };
}

async function ownershipDataset(q) {
  const owners = await prisma.beneficialOwner.findMany({
    where: { ...(q.customerId ? { customer: { customerCode: q.customerId } } : {}), ...dateRange('createdAt', q) },
    include: { customer: { select: { customerCode: true, fullName: true } }, screenings: { orderBy: { id: 'desc' } } },
    orderBy: { id: 'asc' },
  });
  const validations = await prisma.$queryRaw`
    SELECT c.customer_id AS code,
           CASE WHEN o.n = 0 THEN 'NO_OWNERS' WHEN o.total > 100 THEN 'EXCEEDS_100' WHEN o.missing > 0 THEN 'MISSING_PERCENTAGE' WHEN o.total < 100 THEN 'BELOW_100' ELSE 'RECONCILED' END AS status,
           o.total::float8 AS total
    FROM "Customer" c JOIN LATERAL (SELECT count(*)::int AS n, coalesce(sum(ownership_percentage), 0) AS total, count(*) FILTER (WHERE ownership_percentage IS NULL)::int AS missing FROM "BeneficialOwner" b WHERE b.customer_id = c.id) o ON true`;
  const status = new Map(validations.map((v) => [v.code, v]));
  const latest = (o, type) => o.screenings.find((s) => s.screeningType === type)?.screeningResult ?? 'Not Screened';
  const rows = owners.filter((o) => !q.screening || latest(o, 'PEP') === q.screening || latest(o, 'Sanctions') === q.screening);
  checkSize(rows.length);
  return {
    columns: ['Company Customer ID', 'Company Name', 'Owner ID', 'Owner Name', 'Ownership %', 'Ownership Type', 'Control Type', 'Declared PEP Status', 'Country of Residence', 'Nationality', 'Latest PEP Screening', 'Latest Sanctions Screening', 'Company Total Ownership %', 'Company Ownership Validation'],
    rows: rows.map((o) => [o.customer.customerCode, o.customer.fullName, o.id, o.fullName, o.ownershipPercentage === null ? '' : Number(o.ownershipPercentage), o.ownershipType, o.controlType, o.pepStatus, o.countryOfResidence ?? '', o.nationality ?? '', latest(o, 'PEP'), latest(o, 'Sanctions'), status.get(o.customer.customerCode)?.total ?? '', status.get(o.customer.customerCode)?.status ?? '']),
  };
}

async function reviewCasesDataset(q) {
  const asOf = todayIso();
  const where = {
    ...(q.status ? { status: q.status === 'active' ? { in: ACTIVE_CASE_STATUSES } : q.status } : {}),
    ...(q.priority ? { priority: q.priority } : {}),
    ...(q.caseType ? { caseType: q.caseType } : {}),
    ...(q.customerId ? { customer: { customerCode: q.customerId } } : {}),
    ...dateRange('createdAt', q),
  };
  const list = await prisma.reviewCase.findMany({ where, include: { customer: { select: { customerCode: true } }, assignedAnalyst: { select: { name: true } }, assignedReviewer: { select: { name: true } } }, orderBy: { id: 'asc' } });
  checkSize(list.length);
  return {
    columns: ['Case ID', 'Customer ID', 'Case Title', 'Case Type', 'Priority', 'Status', 'Assigned Analyst', 'Assigned Reviewer', 'Due Date', 'Overdue', 'Requires Approval', 'Created At', 'Resolved At', 'Closed At'],
    rows: list.map((c) => [c.caseCode, c.customer.customerCode, c.caseTitle, c.caseType, c.priority, c.status, c.assignedAnalyst?.name ?? '', c.assignedReviewer?.name ?? '', toIso(c.dueDate), ACTIVE_CASE_STATUSES.includes(c.status) && daysBetween(asOf, toIso(c.dueDate)) < 0 ? 'Yes' : 'No', c.requiresApproval ? 'Yes' : 'No', c.createdAt, c.resolvedAt ?? '', c.closedAt ?? '']),
  };
}

async function alertsDataset(q) {
  const list = await prisma.alert.findMany({ where: alerts.buildAlertWhere(q), include: alerts.INCLUDE, orderBy: { id: 'asc' } });
  checkSize(list.length);
  return {
    columns: ['Alert ID', 'Customer ID', 'Alert Type', 'Title', 'Severity', 'Status', 'Related Entity Type', 'Related Entity ID', 'Created At', 'Due Date', 'Acknowledged By', 'Acknowledged At', 'Resolved By', 'Resolved At', 'Resolution Type', 'Resolution Notes'],
    rows: list.map((a) => [a.alertCode, a.customer.customerCode, a.alertType, a.title, a.severity, a.status, a.relatedEntityType, a.relatedEntityId ?? '', a.createdAt, toIso(a.dueDate) ?? '', a.acknowledgedBy?.name ?? '', a.acknowledgedAt ?? '', a.resolvedBy?.name ?? (a.resolutionType === 'Condition cleared' ? 'System' : ''), a.resolvedAt ?? '', a.resolutionType ?? '', a.resolutionNotes ?? '']),
  };
}

async function auditDataset(q) {
  const where = await audit.buildWhere(q);
  const count = await prisma.auditEvent.count({ where });
  checkSize(count);
  const list = await prisma.auditEvent.findMany({ where, include: { user: { select: { name: true } } }, orderBy: { id: 'asc' } });
  const codes = new Map((await prisma.customer.findMany({ where: { id: { in: [...new Set(list.map((e) => e.customerId).filter(Boolean))] } }, select: { id: true, customerCode: true } })).map((c) => [c.id, c.customerCode]));
  return {
    columns: ['Audit Event ID', 'User', 'User Role', 'Action Type', 'Entity Type', 'Entity ID', 'Entity Reference', 'Customer ID', 'Previous Values', 'New Values', 'Reason', 'IP Address', 'Timestamp'],
    rows: list.map((e) => [e.eventCode, e.user?.name ?? 'System', e.userRole, e.actionType, e.entityType, e.entityId ?? '', e.entityRef ?? '', codes.get(e.customerId) ?? '', e.previousValues ?? '', e.newValues ?? '', e.reason ?? '', e.ipAddress ?? '', e.createdAt]),
  };
}

// ---------------------------------------------------------------------------------------------
// Seed data (JSON) and schema (SQL)
// ---------------------------------------------------------------------------------------------
/** Synthetic records of every table, with identifiers masked and secrets left out, so a demo database can be recreated or inspected. */
async function seedData() {
  const asDate = (d) => toIso(d);
  const [types, reviewers, customers, requirements, documents, verifications, ratings, owners, screenings, validations, exceptions, cases, history, notes, schedules, alertRows] = await Promise.all([
    prisma.customerType.findMany({ orderBy: { id: 'asc' } }),
    prisma.reviewer.findMany({ orderBy: { id: 'asc' } }),
    prisma.customer.findMany({ include: { customerType: true }, orderBy: { id: 'asc' } }),
    prisma.kYCRequirement.findMany({ include: { customerType: true }, orderBy: { id: 'asc' } }),
    prisma.document.findMany({ include: { customer: { select: { customerCode: true } } }, orderBy: { id: 'asc' } }),
    prisma.verification.findMany({ orderBy: { id: 'asc' } }),
    prisma.riskRating.findMany({ include: { customer: { select: { customerCode: true } } }, orderBy: { id: 'asc' } }),
    prisma.beneficialOwner.findMany({ include: { customer: { select: { customerCode: true } } }, orderBy: { id: 'asc' } }),
    prisma.ownerScreening.findMany({ orderBy: { id: 'asc' } }),
    prisma.ownershipValidation.findMany({ include: { customer: { select: { customerCode: true } } }, orderBy: { id: 'asc' } }),
    prisma.exception.findMany({ include: { customer: { select: { customerCode: true } } }, orderBy: { id: 'asc' } }),
    prisma.reviewCase.findMany({ include: { customer: { select: { customerCode: true } } }, orderBy: { id: 'asc' } }),
    prisma.caseHistory.findMany({ orderBy: { id: 'asc' } }),
    prisma.caseNote.findMany({ orderBy: { id: 'asc' } }),
    prisma.reviewSchedule.findMany({ include: { customer: { select: { customerCode: true } } }, orderBy: { id: 'asc' } }),
    prisma.alert.findMany({ include: { customer: { select: { customerCode: true } } }, orderBy: { id: 'asc' } }),
  ]);
  const data = {
    customerTypes: types.map((t) => ({ id: t.id, typeName: t.typeName })),
    reviewers: reviewers.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role, isActive: r.isActive })),
    customers: customers.map((c) => ({ id: c.id, customerId: c.customerCode, customerType: c.customerType.typeName, fullName: c.fullName, email: maskEmail(c.email), phone: maskPhone(c.phone), country: c.country, panMasked: safeDecrypt(c.panNumber, maskPan), aadhaarMasked: safeDecrypt(c.aadhaarNumber, maskAadhaar), occupation: c.occupation, businessActivity: c.businessActivity, dateOfIncorporation: asDate(c.dateOfIncorporation), registrationStatus: c.registrationStatus, createdAt: c.createdAt })),
    kycRequirements: requirements.map((r) => ({ id: r.id, customerType: r.customerType.typeName, riskLevel: r.riskLevel, documentType: r.documentType, isMandatory: r.isMandatory, effectiveFrom: asDate(r.effectiveFrom), effectiveTo: asDate(r.effectiveTo), isActive: r.isActive })),
    documents: documents.map((d) => ({ id: d.id, customerId: d.customer.customerCode, documentType: d.documentType, documentNumberMasked: safeDecrypt(d.documentNumber, maskDocumentNumber), issueDate: asDate(d.issueDate), expiryDate: asDate(d.expiryDate), submissionDate: asDate(d.submissionDate), status: d.status, hasFile: Boolean(d.fileReference) })),
    verifications: verifications.map((v) => ({ id: v.id, documentId: v.documentId, reviewerId: v.reviewerId, status: v.status, remarks: v.remarks, verificationDate: v.verificationDate })),
    riskRatings: ratings.map((r) => ({ id: r.id, assessmentId: r.assessmentCode, customerId: r.customer.customerCode, riskScore: r.riskScore, riskLevel: r.riskLevel, previousRiskLevel: r.previousRiskLevel, assessmentStatus: r.assessmentStatus, method: r.assessmentMethod, assessedById: r.assessedById, assessmentDate: r.assessmentDate })),
    beneficialOwners: owners.map((o) => ({ id: o.id, customerId: o.customer.customerCode, fullName: o.fullName, ownershipPercentage: o.ownershipPercentage === null ? null : Number(o.ownershipPercentage), ownershipType: o.ownershipType, controlType: o.controlType, pepStatus: o.pepStatus, countryOfResidence: o.countryOfResidence, nationality: o.nationality })),
    ownerScreenings: screenings.map((s) => ({ id: s.id, beneficialOwnerId: s.beneficialOwnerId, screeningType: s.screeningType, screeningResult: s.screeningResult, source: s.source, screenedAt: s.screenedAt })),
    ownershipValidations: validations.map((v) => ({ id: v.id, customerId: v.customer.customerCode, validationStatus: v.validationStatus, totalOwnershipPercentage: Number(v.totalOwnershipPercentage), ownerCount: v.ownerCount, checkedAt: v.checkedAt })),
    exceptions: exceptions.map((e) => ({ id: e.id, exceptionId: e.exceptionCode, customerId: e.customer.customerCode, exceptionType: e.exceptionType, severity: e.severity, status: e.status, sourceEntityType: e.sourceEntityType, sourceEntityId: e.sourceEntityId, detectedAt: e.detectedAt, resolvedAt: e.resolvedAt })),
    reviewCases: cases.map((c) => ({ id: c.id, caseId: c.caseCode, customerId: c.customer.customerCode, exceptionId: c.exceptionId, caseType: c.caseType, caseTitle: c.caseTitle, priority: c.priority, status: c.status, dueDate: asDate(c.dueDate), assignedAnalystId: c.assignedAnalystId, assignedReviewerId: c.assignedReviewerId, createdAt: c.createdAt })),
    caseHistory: history.map((h) => ({ id: h.id, reviewCaseId: h.reviewCaseId, action: h.action, previousStatus: h.previousStatus, newStatus: h.newStatus, changedById: h.changedById, changedAt: h.changedAt })),
    caseNotes: notes.map((n) => ({ id: n.id, reviewCaseId: n.reviewCaseId, authorId: n.authorId, note: n.note, createdAt: n.createdAt })),
    reviewSchedules: schedules.map((s) => ({ id: s.id, customerId: s.customer.customerCode, cycleNumber: s.cycleNumber, riskLevel: s.riskLevel, lastReviewDate: asDate(s.lastReviewDate), nextReviewDate: asDate(s.nextReviewDate), intervalMonths: s.reviewIntervalMonths, status: s.status })),
    alerts: alertRows.map((a) => ({ id: a.id, alertId: a.alertCode, customerId: a.customer.customerCode, alertType: a.alertType, severity: a.severity, status: a.status, relatedEntityType: a.relatedEntityType, relatedEntityId: a.relatedEntityId, createdAt: a.createdAt })),
  };
  return {
    meta: {
      application: 'ClearKYC', kind: 'Synthetic seed data export', generatedAt: new Date().toISOString(), seed: SEED,
      note: 'All records are synthetic. PAN, Aadhaar, document numbers, e-mail and phone are masked; encrypted columns, key hashes and dates of birth are not exported. Regenerate the data with the scripts listed in docs/SCENE5.md.',
      rowCounts: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v.length])),
    },
    data,
  };
}

/** The live database structure as SQL (sequences, functions, tables with constraints, indexes, triggers). No data. */
async function schemaSql() {
  const q = (name) => `"${name}"`;
  const [sequences, functions, columns, constraints, indexes, triggers] = await Promise.all([
    prisma.$queryRaw`SELECT sequencename AS name, start_value::text AS start, increment_by::text AS inc FROM pg_sequences WHERE schemaname = 'public' ORDER BY 1`,
    prisma.$queryRaw`SELECT pg_get_functiondef(p.oid) AS def, p.proname AS name FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' ORDER BY 2`,
    prisma.$queryRaw`
      SELECT c.relname AS tbl, a.attname AS col, format_type(a.atttypid, a.atttypmod) AS typ, a.attnotnull AS nn, pg_get_expr(d.adbin, d.adrelid) AS def
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations' ORDER BY c.relname, a.attnum`,
    prisma.$queryRaw`SELECT conrelid::regclass::text AS tbl, conname AS name, contype AS type, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE connamespace = 'public'::regnamespace AND conrelid::regclass::text <> '_prisma_migrations' ORDER BY conrelid::regclass::text, contype, conname`,
    prisma.$queryRaw`SELECT i.indexname AS name, i.indexdef AS def FROM pg_indexes i WHERE i.schemaname = 'public' AND i.tablename <> '_prisma_migrations' AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conname = i.indexname AND k.connamespace = 'public'::regnamespace) ORDER BY i.tablename, i.indexname`,
    prisma.$queryRaw`SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid::regclass::text NOT LIKE '%_prisma_migrations%' AND t.tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace) ORDER BY t.tgrelid::regclass::text, t.tgname`,
  ]);
  const tables = [...new Set(columns.map((c) => c.tbl))];
  const out = [
    '-- ClearKYC database schema (PostgreSQL)',
    `-- Generated ${new Date().toISOString()} from the live database. Structure only: no data.`,
    '-- Apply to an empty database, then load data with the generate scripts. Normally use `npm run db:migrate` instead.',
    '',
    '-- Sequences',
    ...sequences.map((s) => `CREATE SEQUENCE ${q(s.name)} START WITH ${s.start} INCREMENT BY ${s.inc};`),
    '',
    '-- Functions',
    ...functions.filter((f) => !f.name.startsWith('pg_')).map((f) => `${f.def.trim()};\n`),
    '-- Tables',
  ];
  for (const t of tables) {
    const lines = columns.filter((c) => c.tbl === t).map((c) => `  ${q(c.col)} ${c.typ}${c.nn ? ' NOT NULL' : ''}${c.def ? ` DEFAULT ${c.def}` : ''}`);
    const own = constraints.filter((k) => k.tbl.replace(/"/g, '') === t && k.type !== 'f').map((k) => `  CONSTRAINT ${q(k.name)} ${k.def}`);
    out.push(`CREATE TABLE ${q(t)} (\n${[...lines, ...own].join(',\n')}\n);`, '');
  }
  out.push('-- Foreign keys', ...constraints.filter((k) => k.type === 'f').map((k) => `ALTER TABLE ${q(k.tbl.replace(/"/g, ''))} ADD CONSTRAINT ${q(k.name)} ${k.def};`), '');
  out.push('-- Indexes', ...indexes.map((i) => `${i.def};`), '');
  out.push('-- Triggers', ...triggers.map((t) => `${t.def};`), '');
  return out.join('\n');
}

// ---------------------------------------------------------------------------------------------
// Catalogue + delivery
// ---------------------------------------------------------------------------------------------
const EXPORTS = {
  customers: { label: 'Customer Data', format: 'csv', roles: SENSITIVE_ROLES, sensitive: true, filters: ['customerType', 'riskLevel', 'search', 'from', 'to'], build: customersDataset },
  documents: { label: 'Document Register', format: 'csv', roles: ALL_ROLES, sensitive: false, filters: ['status', 'documentType', 'expiry', 'customerId', 'from', 'to'], build: documentsDataset },
  completeness: { label: 'KYC Completeness Report', format: 'csv', roles: ALL_ROLES, sensitive: false, filters: ['customerType', 'riskLevel', 'completeness', 'from', 'to'], build: completenessDataset },
  risks: { label: 'Risk Assessment Report', format: 'csv', roles: SENSITIVE_ROLES, sensitive: true, filters: ['riskLevel', 'assessmentStatus', 'customerId', 'from', 'to'], build: risksDataset },
  ownership: { label: 'Beneficial Ownership Report', format: 'csv', roles: SENSITIVE_ROLES, sensitive: true, filters: ['customerId', 'screening', 'from', 'to'], build: ownershipDataset },
  'review-cases': { label: 'Review Case Report', format: 'csv', roles: ALL_ROLES, sensitive: false, filters: ['status', 'priority', 'caseType', 'customerId', 'from', 'to'], build: reviewCasesDataset },
  alerts: { label: 'Alert Report', format: 'csv', roles: ALL_ROLES, sensitive: false, filters: ['status', 'severity', 'alertType', 'customerId', 'from', 'to'], build: alertsDataset },
  'audit-events': { label: 'Audit Trail', format: 'csv', roles: SENSITIVE_ROLES, sensitive: true, filters: ['actionType', 'category', 'entityType', 'customerId', 'from', 'to'], build: auditDataset },
  'seed-data': { label: 'Database Seed Data', format: 'json', roles: SENSITIVE_ROLES, sensitive: true, filters: [] },
  schema: { label: 'Database Schema', format: 'sql', roles: SENSITIVE_ROLES, sensitive: true, filters: [] },
};

function catalog(actor) {
  return Object.entries(EXPORTS).map(([key, e]) => ({
    key, label: e.label, format: e.format, sensitive: e.sensitive, allowedRoles: e.roles, filters: e.filters,
    allowed: Boolean(actor && e.roles.includes(actor.role)),
  }));
}

/**
 * Builds one export for `actor`. Throws 403 when the role may not export it. Records the export in the audit trail.
 * @returns {Promise<{filename:string, contentType:string, body:string, rows:number}>}
 */
async function generateExport(key, query, actor) {
  const def = EXPORTS[key];
  if (!def) throw badRequest(`Unknown export "${key}"`);
  if (!def.roles.includes(actor.role)) {
    throw new AppError(403, 'EXPORT_NOT_ALLOWED', `${def.label} contains sensitive information and can only be exported by a compliance reviewer or an administrator.`);
  }
  let body;
  let rows;
  let contentType;
  if (def.format === 'csv') {
    const dataset = await def.build(query);
    body = toCsv(dataset.columns, dataset.rows);
    rows = dataset.rows.length;
    contentType = 'text/csv; charset=utf-8';
  } else if (def.format === 'json') {
    const seed = await seedData();
    body = JSON.stringify(seed, null, 2);
    rows = Object.values(seed.meta.rowCounts).reduce((n, c) => n + c, 0);
    contentType = 'application/json; charset=utf-8';
  } else {
    body = await schemaSql();
    rows = body.split('\n').length;
    contentType = 'application/sql; charset=utf-8';
  }
  const filters = Object.fromEntries(Object.entries(query).filter(([k, v]) => v !== undefined && v !== '' && !['page', 'pageSize'].includes(k)));
  // Recorded BEFORE the file is returned: an export that cannot be audited is not delivered.
  await audit.record(prisma, {
    actionType: 'EXPORT_GENERATED', entityType: 'Export', entityRef: def.label,
    newValues: { report: key, format: def.format, rows, filters }, reason: `${def.label} exported (${rows} ${def.format === 'csv' ? 'rows' : 'items'})`, actor,
  });
  const ext = { csv: 'csv', json: 'json', sql: 'sql' }[def.format];
  return { filename: `clearkyc-${key}-${todayIso()}.${ext}`, contentType, body, rows };
}

module.exports = { generateExport, catalog, seedData, schemaSql, EXPORTS, EXPORT_MAX_ROWS, maskEmail, maskPhone };
