/**
 * Analytics: every figure is calculated from the database on each request (SQL aggregates over the real tables, plus the
 * same KYC engine the rest of the system uses). Nothing is stored, estimated or hardcoded.
 *
 * Two kinds of numbers, labelled as such in the API and the UI:
 *   SNAPSHOT  the state right now (risk levels, KYC completeness, document statuses, open cases, ownership). These ignore the
 *             date filter, because "what is the risk level distribution of last week" is not a question the records can answer.
 *   PERIOD    activity inside the selected date range (customers onboarded, documents submitted, cases opened, alerts raised).
 *
 * Date filter: range = 7d | 30d | 90d | all, or from/to (YYYY-MM-DD) for a custom range. Dates are UTC calendar days.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { badRequest } = require('../utils/errors');
const { todayIso, addDays, parseIso, daysBetween } = require('../utils/dates');
const { EXPIRY_WARNING_DAYS } = require('../config/kycRules');
const { evaluateCustomerKyc } = require('./kycEngine');
const { loadRequirements } = require('./kycService');
const ownership = require('./ownershipService');
const { ACTIVE_CASE_STATUSES } = require('../config/reviewRules');
const { ACTIVE_ALERT_STATUSES, ALERT_TYPES } = require('../config/alertRules');

const RANGE_DAYS = { '7d': 7, '30d': 30, '90d': 90 };
const num = (v) => Number(v ?? 0);
const activeCases = Prisma.sql`('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated')`;

/**
 * Turns the query (range / from / to) into an inclusive day range plus UTC timestamps for SQL.
 * "Last 7 days" = today and the 6 days before it.
 */
function resolveRange({ range, from, to } = {}, today = todayIso()) {
  if (from || to) {
    if (!from || !to) throw badRequest('A custom range needs both a start and an end date', { [from ? 'to' : 'from']: 'Choose both dates' });
    if (from > to) throw badRequest('The start date must not be after the end date', { from: 'The start date must not be after the end date' });
    if (to > today) throw badRequest('The end date cannot be in the future', { to: 'The end date cannot be in the future' });
    return build('custom', from, to, 'Custom range');
  }
  const key = range || '30d';
  if (key === 'all') return { key, from: null, to: today, fromTs: null, toTs: `${addDays(today, 1)} 00:00:00`, days: null, label: 'All time' };
  if (!RANGE_DAYS[key]) throw badRequest('Range must be 7d, 30d, 90d or all', { range: 'Choose 7d, 30d, 90d or all, or send from and to' });
  return build(key, addDays(today, -(RANGE_DAYS[key] - 1)), today, `Last ${RANGE_DAYS[key]} days`);
}

function build(key, from, to, label) {
  return { key, from, to, fromTs: `${from} 00:00:00`, toTs: `${addDays(to, 1)} 00:00:00`, days: daysBetween(from, to) + 1, label };
}

/** SQL fragment: column falls inside the range. */
function inRange(column, r) {
  const parts = [Prisma.sql`${column} < ${r.toTs}::timestamp`];
  if (r.fromTs) parts.push(Prisma.sql`${column} >= ${r.fromTs}::timestamp`);
  return Prisma.join(parts, ' AND ');
}

const rangeDto = (r) => ({ key: r.key, from: r.from, to: r.to, label: r.label, days: r.days });

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------
async function monthlyOnboarding(r) {
  // Month buckets from the start of the range (at least six months back) up to the end of the range, empty months included.
  let startIso = r.from && r.days > 150 ? r.from : addDays(r.to, -180);
  if (r.key === 'all') {
    const [first] = await prisma.$queryRaw`SELECT min(created_at)::date::text AS d FROM "Customer"`;
    if (first.d && first.d < startIso) startIso = first.d;
  }
  const rows = await prisma.$queryRaw`
    WITH months AS (
      SELECT generate_series(date_trunc('month', ${startIso}::timestamp), date_trunc('month', ${r.to}::timestamp), interval '1 month') AS m
    )
    SELECT to_char(months.m, 'YYYY-MM') AS month,
           count(c.id)::int AS total,
           count(c.id) FILTER (WHERE t.type_name = 'Individual')::int AS individual,
           count(c.id) FILTER (WHERE t.type_name = 'Company')::int AS company
    FROM months
    LEFT JOIN "Customer" c ON date_trunc('month', c.created_at) = months.m AND c.created_at < ${r.toTs}::timestamp
    LEFT JOIN "CustomerType" t ON t.id = c.customer_type_id
    GROUP BY months.m ORDER BY months.m`;
  return rows.map((x) => ({ month: x.month, total: num(x.total), individual: num(x.individual), company: num(x.company) }));
}

/** One row per calendar day of the range (empty days included). Only for short ranges; longer ones use the monthly series. */
async function dailyOnboarding(r) {
  if (!r.from || !r.days || r.days > 45) return null;
  const rows = await prisma.$queryRaw`
    SELECT to_char(d.day, 'YYYY-MM-DD') AS date,
           count(c.id)::int AS total,
           count(c.id) FILTER (WHERE t.type_name = 'Individual')::int AS individual,
           count(c.id) FILTER (WHERE t.type_name = 'Company')::int AS company
    FROM generate_series(${r.from}::timestamp, ${r.to}::timestamp, interval '1 day') AS d(day)
    LEFT JOIN "Customer" c ON c.created_at >= d.day AND c.created_at < d.day + interval '1 day'
    LEFT JOIN "CustomerType" t ON t.id = c.customer_type_id
    GROUP BY d.day ORDER BY d.day`;
  return rows.map((x) => ({ date: x.date, total: num(x.total), individual: num(x.individual), company: num(x.company) }));
}

async function customerAnalytics(r) {
  const [row] = await prisma.$queryRaw`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE t.type_name = 'Individual')::int AS individual,
           count(*) FILTER (WHERE t.type_name = 'Company')::int AS company,
           count(*) FILTER (WHERE ${inRange(Prisma.sql`c.created_at`, r)})::int AS recent,
           count(*) FILTER (WHERE rr.risk_level = 'Low')::int AS low,
           count(*) FILTER (WHERE rr.risk_level = 'Medium')::int AS medium,
           count(*) FILTER (WHERE rr.risk_level = 'High')::int AS high,
           count(*) FILTER (WHERE rr.risk_level IS NULL)::int AS unrated
    FROM "Customer" c
    JOIN "CustomerType" t ON t.id = c.customer_type_id
    LEFT JOIN LATERAL (SELECT x.risk_level FROM "RiskRating" x WHERE x.customer_id = c.id ORDER BY x.assessment_date DESC, x.id DESC LIMIT 1) rr ON true`;
  return {
    period: rangeDto(r),
    totalCustomers: row.total,
    individualCustomers: row.individual,
    companyCustomers: row.company,
    recentlyOnboardedCustomers: row.recent, // PERIOD
    customersByRiskLevel: { Low: row.low, Medium: row.medium, High: row.high, ...(row.unrated ? { Unrated: row.unrated } : {}) }, // SNAPSHOT
    monthlyOnboarding: await monthlyOnboarding(r), // PERIOD
    dailyOnboarding: await dailyOnboarding(r), // PERIOD: null when the range is longer than 45 days
  };
}

// ---------------------------------------------------------------------------------------------
// KYC completeness (the Scene 2 engine over every customer)
// ---------------------------------------------------------------------------------------------
async function completenessAnalytics(asOf = todayIso()) {
  const [customers, requirements, documents] = await Promise.all([
    prisma.$queryRaw`
      SELECT c.id, t.type_name AS "customerType", rr.risk_level AS "riskLevel"
      FROM "Customer" c JOIN "CustomerType" t ON t.id = c.customer_type_id
      LEFT JOIN LATERAL (SELECT x.risk_level FROM "RiskRating" x WHERE x.customer_id = c.id ORDER BY x.assessment_date DESC, x.id DESC LIMIT 1) rr ON true`,
    loadRequirements(),
    prisma.document.findMany({ select: { id: true, customerId: true, documentType: true, status: true, expiryDate: true, submissionDate: true } }),
  ]);
  const byCustomer = new Map();
  for (const d of documents) byCustomer.set(d.customerId, [...(byCustomer.get(d.customerId) ?? []), d]);

  const distribution = { Complete: 0, 'Partially Complete': 0, 'Not Started': 0, 'No Requirements': 0 };
  const buckets = { '0%': 0, '1-49%': 0, '50-99%': 0, '100%': 0 };
  let sum = 0;
  let counted = 0;
  let noDocuments = 0;
  for (const c of customers) {
    const docs = byCustomer.get(c.id) ?? [];
    if (docs.length === 0) noDocuments += 1;
    if (!c.riskLevel) continue;
    const e = evaluateCustomerKyc({ customerType: c.customerType, riskLevel: c.riskLevel, requirements, documents: docs, asOf });
    distribution[e.status] += 1;
    if (e.percentage !== null) {
      sum += e.percentage;
      counted += 1;
      if (e.percentage === 0) buckets['0%'] += 1;
      else if (e.percentage < 50) buckets['1-49%'] += 1;
      else if (e.percentage < 100) buckets['50-99%'] += 1;
      else buckets['100%'] += 1;
    }
  }
  return {
    asOf,
    customersEvaluated: customers.length,
    fullyCompleteCustomers: distribution.Complete,
    partiallyCompleteCustomers: distribution['Partially Complete'],
    notStartedCustomers: distribution['Not Started'],
    customersWithNoKycDocuments: noDocuments,
    averageCompletenessPercentage: counted ? Math.round((sum / counted) * 10) / 10 : null,
    customersWithRequirements: counted,
    distribution,
    percentageBuckets: buckets,
  };
}

// ---------------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------------
async function documentAnalytics(r, today = todayIso()) {
  const soon = addDays(today, EXPIRY_WARNING_DAYS);
  const [row] = await prisma.$queryRaw`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status = 'Verified')::int AS verified,
           count(*) FILTER (WHERE status IN ('Pending', 'In Review'))::int AS pending,
           count(*) FILTER (WHERE status = 'Rejected')::int AS rejected,
           count(*) FILTER (WHERE status = 'Requires Resubmission')::int AS resubmission,
           count(*) FILTER (WHERE status = 'Pending')::int AS only_pending,
           count(*) FILTER (WHERE status = 'In Review')::int AS in_review,
           count(*) FILTER (WHERE expiry_date IS NOT NULL AND expiry_date < ${today}::date)::int AS expired,
           count(*) FILTER (WHERE expiry_date IS NOT NULL AND expiry_date >= ${today}::date AND expiry_date <= ${soon}::date)::int AS expiring,
           count(*) FILTER (WHERE ${inRange(Prisma.sql`created_at`, r)})::int AS submitted,
           count(*) FILTER (WHERE status = 'Verified' AND (expiry_date IS NULL OR expiry_date >= ${today}::date))::int AS h_valid,
           count(*) FILTER (WHERE status IN ('Pending', 'In Review') AND (expiry_date IS NULL OR expiry_date >= ${today}::date))::int AS h_waiting,
           count(*) FILTER (WHERE status IN ('Rejected', 'Requires Resubmission') AND (expiry_date IS NULL OR expiry_date >= ${today}::date))::int AS h_rejected
    FROM "Document"`;
  return {
    asOf: today,
    period: rangeDto(r),
    totalDocuments: row.total,
    verifiedDocuments: row.verified,
    pendingVerification: row.pending,
    rejectedDocuments: row.rejected,
    requiresResubmission: row.resubmission,
    expiredDocuments: row.expired,
    documentsExpiringWithin30Days: row.expiring,
    expiryWarningDays: EXPIRY_WARNING_DAYS,
    submittedInPeriod: row.submitted, // PERIOD
    // Every document in exactly one group (an expired document counts as expired whatever its review said), so the groups add up to the total.
    health: { verifiedAndValid: row.h_valid, waitingForCheck: row.h_waiting, rejectedOrNeedsNewCopy: row.h_rejected, expired: row.expired },
    statusDistribution: { Verified: row.verified, Pending: row.only_pending, 'In Review': row.in_review, Rejected: row.rejected, 'Requires Resubmission': row.resubmission },
  };
}

// ---------------------------------------------------------------------------------------------
// Risk
// ---------------------------------------------------------------------------------------------
async function riskAnalytics(r) {
  const [row] = await prisma.$queryRaw`
    WITH latest AS (
      SELECT c.id, rr.risk_level, rr.assessment_status, rr.risk_reasons
      FROM "Customer" c
      LEFT JOIN LATERAL (SELECT x.* FROM "RiskRating" x WHERE x.customer_id = c.id ORDER BY x.assessment_date DESC, x.id DESC LIMIT 1) rr ON true
    ),
    owner_flags AS (
      SELECT DISTINCT bo.customer_id, s.screening_type
      FROM "BeneficialOwner" bo
      JOIN LATERAL (SELECT x.* FROM "OwnerScreening" x WHERE x.beneficial_owner_id = bo.id AND x.screening_type = 'PEP' ORDER BY x.id DESC LIMIT 1) s ON s.screening_result = 'Potential Match'
      UNION
      SELECT DISTINCT bo.customer_id, s.screening_type
      FROM "BeneficialOwner" bo
      JOIN LATERAL (SELECT x.* FROM "OwnerScreening" x WHERE x.beneficial_owner_id = bo.id AND x.screening_type = 'Sanctions' ORDER BY x.id DESC LIMIT 1) s ON s.screening_result = 'Potential Match'
    )
    SELECT count(*) FILTER (WHERE l.risk_level = 'Low')::int AS low,
           count(*) FILTER (WHERE l.risk_level = 'Medium')::int AS medium,
           count(*) FILTER (WHERE l.risk_level = 'High')::int AS high,
           count(*) FILTER (WHERE l.assessment_status = 'Requires Manual Review')::int AS manual,
           count(*) FILTER (WHERE (l.risk_reasons->'screening'->'pep'->>'potentialMatch') = 'true'
                              OR EXISTS (SELECT 1 FROM owner_flags f WHERE f.customer_id = l.id AND f.screening_type = 'PEP'))::int AS pep,
           count(*) FILTER (WHERE (l.risk_reasons->'screening'->'sanctions'->>'potentialMatch') = 'true'
                              OR EXISTS (SELECT 1 FROM owner_flags f WHERE f.customer_id = l.id AND f.screening_type = 'Sanctions'))::int AS sanctions
    FROM latest l`;
  const manual = await prisma.$queryRaw`
    SELECT c.customer_id AS "customerId", c.full_name AS name, rr.risk_level AS level, rr.risk_score AS score, rr.assessment_code AS "assessmentId"
    FROM "Customer" c JOIN LATERAL (SELECT x.* FROM "RiskRating" x WHERE x.customer_id = c.id ORDER BY x.assessment_date DESC, x.id DESC LIMIT 1) rr ON true
    WHERE rr.assessment_status = 'Requires Manual Review'
    ORDER BY CASE rr.risk_level WHEN 'High' THEN 1 WHEN 'Medium' THEN 2 ELSE 3 END, rr.risk_score DESC, c.id LIMIT 6`;
  const [period] = await prisma.$queryRaw`SELECT count(*)::int AS assessments FROM "RiskRating" WHERE ${inRange(Prisma.sql`assessment_date`, r)}`;
  return {
    period: rangeDto(r),
    lowRiskCustomers: row.low,
    mediumRiskCustomers: row.medium,
    highRiskCustomers: row.high,
    customersRequiringManualReview: row.manual,
    potentialPepMatches: row.pep, // customers with at least one POTENTIAL match; none of these is confirmed
    potentialSanctionsMatches: row.sanctions,
    manualReviewCustomers: manual.map((m) => ({ customerId: m.customerId, name: m.name, riskLevel: m.level, riskScore: m.score, assessmentId: m.assessmentId })), // the first six, highest risk first
    assessmentsInPeriod: period.assessments, // PERIOD
    note: 'Potential matches come from simulated screening and are not confirmed matches.',
  };
}

// ---------------------------------------------------------------------------------------------
// Review cases
// ---------------------------------------------------------------------------------------------
async function reviewCaseAnalytics(r, today = todayIso()) {
  const [row] = await prisma.$queryRaw`
    SELECT count(*)::int AS total,
           count(*) FILTER (WHERE status IN ('Open', 'Assigned'))::int AS open,
           count(*) FILTER (WHERE status IN ('In Progress', 'Pending Customer'))::int AS in_progress,
           count(*) FILTER (WHERE status = 'Escalated')::int AS escalated,
           count(*) FILTER (WHERE status = 'Resolved')::int AS resolved,
           count(*) FILTER (WHERE status = 'Closed')::int AS closed,
           count(*) FILTER (WHERE status IN ${activeCases} AND due_date < ${today}::date)::int AS overdue,
           count(*) FILTER (WHERE ${inRange(Prisma.sql`created_at`, r)})::int AS created,
           count(*) FILTER (WHERE status = 'Open')::int AS s_open,
           count(*) FILTER (WHERE status = 'Assigned')::int AS s_assigned,
           count(*) FILTER (WHERE status = 'In Progress')::int AS s_progress,
           count(*) FILTER (WHERE status = 'Pending Customer')::int AS s_pending
    FROM "ReviewCase"`;
  return {
    asOf: today,
    period: rangeDto(r),
    totalReviewCases: row.total,
    openCases: row.open, // Open + Assigned: waiting to be worked (same as the Review Cases dashboard)
    inProgressCases: row.in_progress, // In Progress + Pending Customer
    escalatedCases: row.escalated,
    resolvedCases: row.resolved,
    closedCases: row.closed,
    overdueCases: row.overdue,
    casesOpenedInPeriod: row.created, // PERIOD
    statusDistribution: { Open: row.s_open, Assigned: row.s_assigned, 'In Progress': row.s_progress, 'Pending Customer': row.s_pending, Escalated: row.escalated, Resolved: row.resolved, Closed: row.closed },
  };
}

// ---------------------------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------------------------
async function ownershipAnalytics() {
  const d = await ownership.getRiskDashboard();
  const [row] = await prisma.$queryRaw`
    WITH b AS (${ownership.COMPANY_BASE})
    SELECT count(*) FILTER (WHERE (${ownership.STATUS_SQL}) IN ('NO_OWNERS', 'MISSING_PERCENTAGE'))::int AS missing,
           count(*) FILTER (WHERE (${ownership.STATUS_SQL}) = 'EXCEEDS_100')::int AS exceeds,
           count(*) FILTER (WHERE (${ownership.STATUS_SQL}) = 'BELOW_100')::int AS below,
           count(*) FILTER (WHERE (${ownership.STATUS_SQL}) = 'RECONCILED')::int AS ok,
           count(*) FILTER (WHERE (${ownership.STATUS_SQL}) = 'NO_OWNERS')::int AS none,
           count(*) FILTER (WHERE (${ownership.STATUS_SQL}) = 'MISSING_PERCENTAGE')::int AS missing_pct
    FROM b`;
  return {
    totalBusinessCustomers: d.totalBusinessCustomers,
    totalBeneficialOwners: d.totalBeneficialOwners,
    ownershipValidationIssues: d.ownershipIssues,
    companiesWithMissingOwnershipInformation: row.missing, // no owners recorded, or an owner without a percentage
    companiesWithoutOwners: d.companiesWithoutOwners,
    companiesExceeding100Percent: row.exceeds,
    companiesBelow100Percent: row.below,
    // Every company in exactly one group; RECONCILED = owners add up to exactly 100%.
    validationStatusDistribution: { RECONCILED: row.ok, BELOW_100: row.below, MISSING_PERCENTAGE: row.missing_pct, EXCEEDS_100: row.exceeds, NO_OWNERS: row.none },
  };
}

// ---------------------------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------------------------
async function alertAnalytics(r) {
  const rows = await prisma.$queryRaw`
    SELECT severity, status, alert_type AS "alertType", count(*)::int AS n
    FROM "Alert" WHERE ${inRange(Prisma.sql`created_at`, r)}
    GROUP BY severity, status, alert_type`;
  const [all] = await prisma.$queryRaw`
    SELECT count(*) FILTER (WHERE status IN ('New', 'Acknowledged', 'In Progress'))::int AS active,
           count(*) FILTER (WHERE status = 'New')::int AS new_alerts,
           count(*) FILTER (WHERE status IN ('New', 'Acknowledged', 'In Progress') AND severity IN ('High', 'Critical'))::int AS high_active
    FROM "Alert"`;
  const isActive = (s) => ACTIVE_ALERT_STATUSES.includes(s);
  const bySeverity = ['Critical', 'High', 'Medium', 'Low'].map((severity) => ({
    severity,
    active: rows.filter((x) => x.severity === severity && isActive(x.status)).reduce((n, x) => n + x.n, 0),
    closed: rows.filter((x) => x.severity === severity && !isActive(x.status)).reduce((n, x) => n + x.n, 0),
  }));
  const byType = Object.keys(ALERT_TYPES).map((t) => ({ alertType: t, label: ALERT_TYPES[t].label, count: rows.filter((x) => x.alertType === t).reduce((n, x) => n + x.n, 0) })).filter((x) => x.count > 0);
  return {
    period: rangeDto(r),
    alertsInPeriod: rows.reduce((n, x) => n + x.n, 0), // PERIOD
    activeAlerts: all.active, // SNAPSHOT
    newAlerts: all.new_alerts,
    highOrCriticalActive: all.high_active,
    bySeverity, // alerts raised in the period, split into still-active and closed
    byType,
  };
}

// ---------------------------------------------------------------------------------------------
// Overview = everything the Analytics & Reports page shows
// ---------------------------------------------------------------------------------------------
async function overview(query) {
  const r = resolveRange(query);
  const today = todayIso();
  const [customers, kyc, documents, risks, reviewCases, ownershipData, alerts] = await Promise.all([
    customerAnalytics(r), completenessAnalytics(today), documentAnalytics(r, today), riskAnalytics(r), reviewCaseAnalytics(r, today), ownershipAnalytics(), alertAnalytics(r),
  ]);
  return { generatedAt: new Date().toISOString(), period: rangeDto(r), customers, kyc, documents, risks, reviewCases, ownership: ownershipData, alerts };
}

module.exports = {
  resolveRange, overview,
  customers: (q) => customerAnalytics(resolveRange(q)).then(async (c) => ({ ...c, kycCompleteness: await completenessAnalytics() })),
  documents: (q) => documentAnalytics(resolveRange(q)),
  risks: (q) => riskAnalytics(resolveRange(q)),
  reviewCases: (q) => reviewCaseAnalytics(resolveRange(q)),
  ownership: () => ownershipAnalytics(),
  alerts: (q) => alertAnalytics(resolveRange(q)),
  completenessAnalytics, parseIso,
};
