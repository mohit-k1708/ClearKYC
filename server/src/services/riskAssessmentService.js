/**
 * Overall customer risk: calculating it, recording it, and reading its history.
 *
 * Every assessment is a NEW "RiskRating" row (RSK-000001, RSK-000002 ...). Old rows are never changed
 * (the database blocks UPDATE and DELETE), so you can always see how and why a risk level changed.
 *
 * Kept separate on purpose:
 *   - Customer risk        what this service calculates
 *   - Ownership validation is the ownership structure reconciled? (an INPUT to risk, reported separately)
 *   - KYC completeness     Scene 2: are the required documents present and valid? It is reported next to
 *                          risk in the summary, but is never an input to the risk score.
 *
 * The baseline is Scene 1's rule engine re-run on the customer's profile (not the previous rating), so
 * repeated assessments never compound each other.
 */
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { AppError, conflict, notFound, badRequest } = require('../utils/errors');
const { assessRisk } = require('./riskService');
const { assessOverallRisk } = require('./ownershipEngine');
const { OWNERSHIP_RULES } = require('../config/ownershipRules');
const { toIso } = require('../utils/dates');
const ownership = require('./ownershipService');
const { getCompleteness } = require('./kycService');
const audit = require('./auditService');

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
const LATEST_ORDER = [{ assessmentDate: 'desc' }, { id: 'desc' }];

// ---------------------------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------------------------

/**
 * Pure calculation from already-loaded data (also used by the seed script).
 * @param {object} customer  Customer row with customerType
 * @param {object|null} analysis  result of ownership.loadOwnerAnalysis() for companies, else null
 */
function buildAssessment(customer, analysis, now = new Date()) {
  const customerType = customer.customerType.typeName;
  const baseline = assessRisk(
    {
      customerType,
      fullName: customer.fullName,
      country: customer.country,
      occupation: customer.occupation,
      businessActivity: customer.businessActivity,
      dateOfBirth: customer.dateOfBirth,
      dateOfIncorporation: customer.dateOfIncorporation,
    },
    now
  );

  const isCompany = customerType === 'Company' && analysis;
  const overall = assessOverallRisk({
    customerType,
    baseline,
    ownerAssessments: isCompany ? analysis.entries.map((e) => e.risk) : [],
    validation: isCompany ? analysis.validation : null,
    complexity: isCompany ? analysis.complexity : null,
  });

  const ownerBreakdown = isCompany
    ? analysis.entries.map((e) => ({
        ownerId: e.row.id,
        name: e.row.fullName,
        ownershipPercentage: e.owner.ownershipPercentage,
        points: e.risk.points,
        level: e.risk.level,
        screening: e.risk.screening,
        indicators: e.risk.indicators.filter((i) => i.points > 0 || i.outcome !== 'No exposure').map((i) => ({ indicator: i.indicator, outcome: i.outcome, points: i.points })),
      }))
    : [];

  // Same inputs => same fingerprint. Lets the API refuse to record an assessment that changes nothing.
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify({ s: overall.score, l: overall.level, st: overall.status, r: overall.reasons.map((r) => [r.factor, r.points]), m: overall.manualReviewReasons.map((m) => m.code), o: ownerBreakdown.map((o) => [o.ownerId, o.points, o.ownershipPercentage, o.screening.pep, o.screening.sanctions]) }))
    .digest('hex')
    .slice(0, 16);

  return {
    ...overall,
    baseline: { score: baseline.score, level: baseline.level, method: baseline.method },
    screening: baseline.screening, // the Scene 1 simulated screening of the customer's own name
    ownerBreakdown,
    ownershipValidation: isCompany ? { status: analysis.validation.status, totalPercentage: analysis.validation.totalPercentage, ownerCount: analysis.validation.ownerCount, message: analysis.validation.message } : null,
    complexity: isCompany ? { isComplex: analysis.complexity.isComplex, reasons: analysis.complexity.reasons } : null,
    fingerprint,
  };
}

/** The JSON stored in RiskRating.risk_reasons. It keeps the shape Scene 1's profile page reads (reasons, screening, thresholds). */
function toStoredReasons(a, note) {
  return {
    reasons: a.reasons,
    screening: a.screening,
    requiresManualReview: a.requiresManualReview,
    thresholds: a.thresholds,
    // Scene 3 additions
    manualReviewReasons: a.manualReviewReasons,
    components: a.components,
    baseline: a.baseline,
    ownerBreakdown: a.ownerBreakdown,
    ownershipValidation: a.ownershipValidation,
    complexity: a.complexity,
    fingerprint: a.fingerprint,
    ...(note ? { assessorNote: note } : {}),
  };
}

async function loadCustomerForAssessment(db, idParam) {
  const customer = await ownership.findCustomerRow(db, idParam);
  const analysis = customer.customerType.typeName === 'Company' ? await ownership.loadOwnerAnalysis(db, customer.id) : null;
  return { customer, analysis };
}

// ---------------------------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------------------------
function assessmentDto(r, customer) {
  const stored = r.riskReasons || {};
  const status = r.assessmentStatus;
  return {
    id: r.id,
    assessmentId: r.assessmentCode,
    customerId: customer.customerCode ?? customer.customerId,
    customerName: customer.fullName ?? customer.name,
    customerType: customer.customerType?.typeName ?? customer.customerType,
    previousRiskLevel: r.previousRiskLevel,
    riskLevel: r.riskLevel,
    riskScore: r.riskScore,
    status, // Completed | Requires Manual Review
    overallResult: status === 'Requires Manual Review' ? 'Requires Manual Review' : r.riskLevel,
    levelChanged: r.previousRiskLevel ? r.previousRiskLevel !== r.riskLevel : null,
    assessmentDate: r.assessmentDate,
    assessedBy: r.assessedBy ? { id: r.assessedBy.id, name: r.assessedBy.name, role: r.assessedBy.role } : { id: null, name: 'System (onboarding)', role: 'System' },
    method: r.assessmentMethod,
    reasons: stored.reasons ?? [],
    manualReviewReasons: stored.manualReviewReasons ?? [],
    components: stored.components ?? null,
    baseline: stored.baseline ?? null,
    ownerBreakdown: stored.ownerBreakdown ?? [],
    ownershipValidation: stored.ownershipValidation ?? null,
    complexity: stored.complexity ?? null,
    screening: stored.screening ?? null,
    assessorNote: stored.assessorNote ?? null,
    isOwnershipAware: Boolean(stored.fingerprint),
  };
}

/** What a new assessment would produce right now (not recorded). */
function previewDto(a) {
  return {
    riskScore: a.score,
    riskLevel: a.level,
    status: a.status,
    overallResult: a.overallResult,
    reasons: a.reasons,
    manualReviewReasons: a.manualReviewReasons,
    components: a.components,
    baseline: a.baseline,
    ownerBreakdown: a.ownerBreakdown,
    ownershipValidation: a.ownershipValidation,
    complexity: a.complexity,
    method: a.method,
    fingerprint: a.fingerprint,
  };
}

// ---------------------------------------------------------------------------------------------
// Recording a new assessment (one transaction)
// ---------------------------------------------------------------------------------------------
async function createAssessment(idParam, actor, { force = false, remarks } = {}) {
  const result = await prisma.$transaction(async (tx) => {
    const customerRow = await ownership.findCustomerRow(tx, idParam);
    // Serialise assessments of the same customer so "previous level" is always the real previous level.
    await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${customerRow.id} FOR UPDATE`;

    const { customer, analysis } = await loadCustomerForAssessment(tx, customerRow.id);
    const assessment = buildAssessment(customer, analysis);

    const previous = await tx.riskRating.findFirst({ where: { customerId: customer.id }, orderBy: LATEST_ORDER });
    if (!force && previous?.riskReasons?.fingerprint === assessment.fingerprint) {
      throw conflict('NO_CHANGE', `Nothing has changed since ${previous.assessmentCode}, so a new assessment was not recorded.`, {
        existingAssessmentId: previous.assessmentCode,
      });
    }

    const created = await tx.riskRating.create({
      data: {
        customerId: customer.id,
        riskScore: assessment.score,
        riskLevel: assessment.level,
        riskReasons: toStoredReasons(assessment, remarks),
        assessmentMethod: assessment.method,
        previousRiskLevel: previous?.riskLevel ?? null,
        assessedById: actor.id,
        assessmentStatus: assessment.status,
      },
      include: { assessedBy: true },
    });
    await audit.record(tx, {
      actionType: 'RISK_ASSESSMENT_CREATED', entityType: 'RiskRating', entityId: created.id, entityRef: created.assessmentCode, customerId: customer.id,
      previousValues: previous ? { riskScore: previous.riskScore, riskLevel: previous.riskLevel, assessmentStatus: previous.assessmentStatus } : null,
      newValues: { riskScore: created.riskScore, riskLevel: created.riskLevel, assessmentStatus: created.assessmentStatus },
      reason: remarks ?? 'Risk assessment recorded', actor,
    });
    if (previous && previous.riskLevel !== created.riskLevel) {
      await audit.record(tx, {
        actionType: 'RISK_CLASSIFICATION_CHANGED', entityType: 'Customer', entityId: customer.id, entityRef: customerRow.customerCode, customerId: customer.id,
        previousValues: { riskLevel: previous.riskLevel }, newValues: { riskLevel: created.riskLevel, riskScore: created.riskScore, assessment: created.assessmentCode },
        reason: remarks ?? `Risk level moved from ${previous.riskLevel} to ${created.riskLevel} after assessment ${created.assessmentCode}`, actor,
      });
    }
    return { created, customer };
  });
  return assessmentDto(result.created, result.customer);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------
async function listCustomerAssessments(idParam) {
  const customer = await ownership.findCustomerRow(prisma, idParam);
  const rows = await prisma.riskRating.findMany({ where: { customerId: customer.id }, orderBy: LATEST_ORDER, include: { assessedBy: true } });
  return { customer: ownership.customerSummary(customer), items: rows.map((r) => assessmentDto(r, customer)) };
}

async function getAssessment(idParam) {
  const where = /^RSK-\d+$/i.test(String(idParam)) ? { assessmentCode: String(idParam).toUpperCase() } : /^\d{1,9}$/.test(String(idParam)) ? { id: Number(idParam) } : null;
  if (!where) throw badRequest('Assessment ID must look like RSK-000001');
  const row = await prisma.riskRating.findUnique({ where, include: { assessedBy: true, customer: { include: { customerType: true } } } });
  if (!row) throw notFound(`Risk assessment ${idParam} was not found`);
  return assessmentDto(row, row.customer);
}

/** Paginated history of all assessments, newest first. */
async function listAssessments({ page, pageSize, search, riskLevel, status, customerType, customerId, from, to }) {
  const conditions = [];
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(Prisma.sql`(c.customer_id ILIKE ${pattern} OR c.full_name ILIKE ${pattern} OR rr.assessment_code ILIKE ${pattern})`);
  }
  if (riskLevel) conditions.push(Prisma.sql`rr.risk_level = ${riskLevel}`);
  if (status) conditions.push(Prisma.sql`rr.assessment_status = ${status}`);
  if (customerType) conditions.push(Prisma.sql`t.type_name = ${customerType}`);
  if (customerId) conditions.push(Prisma.sql`c.customer_id = ${customerId.toUpperCase()}`);
  if (from) conditions.push(Prisma.sql`rr.assessment_date >= ${from}::date`);
  if (to) conditions.push(Prisma.sql`rr.assessment_date < (${to}::date + 1)`);
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const from_ = Prisma.sql`
    FROM "RiskRating" rr
    JOIN "Customer" c ON c.id = rr.customer_id
    JOIN "CustomerType" t ON t.id = c.customer_type_id
    LEFT JOIN "Reviewer" a ON a.id = rr.assessed_by_id`;

  const [rows, [{ total }]] = await Promise.all([
    prisma.$queryRaw`
      SELECT rr.id, rr.assessment_code AS "assessmentCode", c.customer_id AS "customerCode", c.full_name AS "customerName", t.type_name AS "customerType",
             rr.previous_risk_level AS "previousRiskLevel", rr.risk_level AS "riskLevel", rr.risk_score AS "riskScore", rr.assessment_status AS "assessmentStatus",
             rr.assessment_date AS "assessmentDate", rr.assessment_method AS "assessmentMethod", rr.risk_reasons AS "riskReasons",
             a.id AS "aId", a.name AS "aName", a.role AS "aRole"
      ${from_} ${where}
      ORDER BY rr.assessment_date DESC, rr.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw`SELECT COUNT(*) AS total ${from_} ${where}`,
  ]);

  const totalItems = Number(total);
  return {
    items: rows.map((r) =>
      assessmentDto(
        { ...r, riskReasons: r.riskReasons, assessmentStatus: r.assessmentStatus, assessedBy: r.aId ? { id: r.aId, name: r.aName, role: r.aRole } : null },
        { customerCode: r.customerCode, fullName: r.customerName, customerType: { typeName: r.customerType } }
      )
    ),
    pagination: { page, pageSize, totalItems, totalPages: Math.max(Math.ceil(totalItems / pageSize), 1) },
  };
}

/**
 * Customer Risk Summary. Three DIFFERENT questions, answered separately:
 *   customerRisk         what is the customer's risk? (current recorded assessment + what a new one would give)
 *   ownershipValidation  is the ownership structure reconciled?
 *   kycCompleteness      are the required documents present and valid? (Scene 2, never an input to risk)
 */
async function getRiskSummary(idParam) {
  const { customer, analysis } = await loadCustomerForAssessment(prisma, idParam);
  const [latest, history, count] = await Promise.all([
    prisma.riskRating.findFirst({ where: { customerId: customer.id }, orderBy: LATEST_ORDER, include: { assessedBy: true } }),
    prisma.riskRating.findMany({ where: { customerId: customer.id }, orderBy: LATEST_ORDER, take: 6, include: { assessedBy: true } }),
    prisma.riskRating.count({ where: { customerId: customer.id } }),
  ]);
  const preview = buildAssessment(customer, analysis);
  const current = latest ? assessmentDto(latest, customer) : null;

  let kyc = null;
  try {
    const k = await getCompleteness(customer.customerCode);
    kyc = { percentage: k.percentage, status: k.status, totals: k.totals };
  } catch {
    kyc = null; // requirements cannot be selected without a risk level; shown as unavailable
  }

  const reassessmentRecommended = !current?.isOwnershipAware
    ? Boolean(current) && (current.riskScore !== preview.score || current.riskLevel !== preview.level || current.status !== preview.status)
    : latest.riskReasons.fingerprint !== preview.fingerprint;

  return {
    customer: ownership.customerSummary(customer),
    customerRisk: {
      current,
      wouldBe: previewDto(preview),
      reassessmentRecommended,
      assessmentCount: count,
      rules: { version: OWNERSHIP_RULES.version, disclaimer: 'Prototype assumptions, not regulatory standards. Screening outcomes are synthetic.' },
    },
    ownershipValidation: analysis
      ? {
          applicable: true,
          ...analysis.validation,
          complexity: analysis.complexity,
          owners: analysis.entries.map((e) => ({ id: e.row.id, fullName: e.row.fullName, ownershipPercentage: e.owner.ownershipPercentage, riskLevel: e.risk.level, riskPoints: e.risk.points, screening: e.risk.screening })),
        }
      : { applicable: false, message: 'Beneficial ownership applies to company customers only.' },
    kycCompleteness: kyc,
    separation: 'KYC completeness, customer risk and ownership validation are three separate measures. A customer can be 100% KYC complete and still High risk, or Low risk with incomplete documents.',
    history: history.map((r) => assessmentDto(r, customer)),
  };
}

module.exports = { buildAssessment, toStoredReasons, createAssessment, listCustomerAssessments, getAssessment, listAssessments, getRiskSummary, assessmentDto, AppError, toIso };
