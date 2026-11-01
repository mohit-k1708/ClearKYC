/**
 * Exception management: detection, listing, and resolution.
 *
 * DETECTION loads real records for each customer (documents + requirements from Scene 2, owners and the newest risk
 * assessment from Scene 3, and the periodic review schedule), asks the pure engine for the current CONDITIONS, then
 * reconciles them with the stored exceptions:
 *   - a condition with no ACTIVE exception creates one (the database also refuses a second active exception for the
 *     same condition, so running detection twice, or twice at once, never creates duplicates);
 *   - an active exception whose condition is gone is RESOLVED automatically, with the reason recorded;
 *   - a still-present condition keeps its exception (its severity and description are refreshed).
 * Resolved exceptions are history. If a condition returns, a NEW exception is created.
 *
 * Detection also creates the periodic review case when a review becomes due.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { AppError, conflict, notFound, badRequest } = require('../utils/errors');
const { todayIso, toIso } = require('../utils/dates');
const { EXCEPTION_TYPES, SEVERITY_RANK, ACTIVE_EXCEPTION_STATUSES, ACTIVE_CASE_STATUSES, SLA_DAYS } = require('../config/reviewRules');
const { evaluateCustomerKyc } = require('./kycEngine');
const { loadRequirements } = require('./kycService');
const { buildOwnerAnalysis } = require('./ownershipService');
const { detectConditions, reviewConditions } = require('./exceptionEngine');
const { ensureSchedules } = require('./reviewScheduleService');
const { requiresApproval } = require('./caseWorkflow');
const audit = require('./auditService');
const { syncAlerts } = require('./alertService');
const { getExpiryAlertConfig } = require('./settingsService');

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
const PREVIOUS = 'PREVIOUS_REVIEW_UNRESOLVED';
const GROUP_OF = Object.fromEntries(Object.entries(EXCEPTION_TYPES).map(([k, v]) => [k, v.group]));
const nowUtc = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

// ---------------------------------------------------------------------------------------------
// Loading the records detection needs
// ---------------------------------------------------------------------------------------------

/** Closed cases whose exception is still active and has no other active case: "closed without proper resolution". */
async function unresolvedClosedCases(db, customerDbId) {
  return db.$queryRaw`
    SELECT c.id AS "caseId", c.case_code AS "caseCode", e.exception_code AS "exceptionCode", e.exception_type AS "exceptionType", e.severity AS "exceptionSeverity"
    FROM "ReviewCase" c
    JOIN "Exception" e ON e.id = c.exception_id
    WHERE c.customer_id = ${customerDbId} AND c.status = 'Closed'
      AND e.status IN ('Open', 'In Review') AND e.exception_type <> ${PREVIOUS}
      AND NOT EXISTS (SELECT 1 FROM "ReviewCase" c2 WHERE c2.exception_id = e.id AND c2.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated'))
      AND c.id = (SELECT max(c3.id) FROM "ReviewCase" c3 WHERE c3.exception_id = e.id AND c3.status = 'Closed')`;
}

/** Builds one context per customer (all customers, or one). */
async function loadContexts(db, { customerDbId = null, asOf }) {
  const filter = customerDbId ? Prisma.sql`WHERE c.id = ${customerDbId}` : Prisma.empty;
  const where = customerDbId ? { customerId: customerDbId } : {};

  const expiryConfig = await getExpiryAlertConfig(db); // the SAVED lead times, read once per detection run
  const [customers, requirements, documents, ownerRows, schedules] = await Promise.all([
    db.$queryRaw`
      SELECT c.id, c.customer_id AS code, c.full_name AS name, t.type_name AS "customerType",
             r.id AS "ratingId", r.assessment_code AS "ratingCode", r.risk_level AS "riskLevel", r.risk_score AS "riskScore",
             r.assessment_status AS "ratingStatus", r.risk_reasons->'screening' AS screening
      FROM "Customer" c
      JOIN "CustomerType" t ON t.id = c.customer_type_id
      LEFT JOIN LATERAL (SELECT rr.* FROM "RiskRating" rr WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1) r ON true
      ${filter}
      ORDER BY c.id`,
    loadRequirements(),
    db.document.findMany({ where, select: { id: true, customerId: true, documentType: true, status: true, expiryDate: true, submissionDate: true } }),
    db.beneficialOwner.findMany({ where, orderBy: { id: 'asc' }, include: { screenings: { orderBy: { id: 'desc' } } } }),
    db.reviewSchedule.findMany({ where: { ...where, status: 'Scheduled' } }),
  ]);

  const group = (rows) => rows.reduce((m, r) => m.set(r.customerId, [...(m.get(r.customerId) || []), r]), new Map());
  const docsBy = group(documents);
  const ownersBy = group(ownerRows);
  const scheduleBy = new Map(schedules.map((s) => [s.customerId, s]));

  return customers.map((c) => {
    const customer = { id: c.id, code: c.code, name: c.name, customerType: c.customerType, riskLevel: c.riskLevel };
    return {
      customer,
      kyc: c.riskLevel ? evaluateCustomerKyc({ customerType: c.customerType, riskLevel: c.riskLevel, requirements, documents: docsBy.get(c.id) || [], asOf }) : null,
      ownership: c.customerType === 'Company' ? buildOwnerAnalysis(ownersBy.get(c.id) || []) : null,
      rating: c.ratingId ? { id: c.ratingId, code: c.ratingCode, riskLevel: c.riskLevel, riskScore: c.riskScore, status: c.ratingStatus, screening: c.screening } : null,
      schedule: scheduleBy.get(c.id) || null,
      expiryConfig,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Reconciling conditions with stored exceptions
// ---------------------------------------------------------------------------------------------

/** Exceptions with an active case are "In Review", the rest are "Open". */
async function refreshStatuses(db, customerDbId) {
  await db.$executeRaw`
    UPDATE "Exception" e
       SET status = CASE WHEN EXISTS (SELECT 1 FROM "ReviewCase" c WHERE c.exception_id = e.id AND c.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated'))
                         THEN 'In Review' ELSE 'Open' END,
           updated_at = ${nowUtc}
     WHERE e.customer_id = ${customerDbId} AND e.status IN ('Open', 'In Review')
       AND e.status <> CASE WHEN EXISTS (SELECT 1 FROM "ReviewCase" c WHERE c.exception_id = e.id AND c.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated'))
                            THEN 'In Review' ELSE 'Open' END`;
}

/** Records on every active linked case that its exception was resolved (the case itself keeps its status). */
async function noteLinkedCases(db, exception, remarks, changedById = null) {
  // Active cases, and Resolved ones (resolved by the analyst, waiting to be closed): both should show that the exception cleared.
  const cases = await db.reviewCase.findMany({ where: { exceptionId: exception.id, status: { in: [...ACTIVE_CASE_STATUSES, 'Resolved'] } } });
  for (const c of cases) {
    await db.caseHistory.create({ data: { reviewCaseId: c.id, action: 'EXCEPTION_RESOLVED', previousStatus: c.status, newStatus: c.status, changedById, remarks } });
  }
}

async function syncSubset(tx, customer, conditions, typeFilter, asOf) {
  const active = (await tx.exception.findMany({ where: { customerId: customer.id, status: { in: ACTIVE_EXCEPTION_STATUSES } } })).filter((e) => typeFilter(e.exceptionType));
  const have = new Map(active.map((e) => [e.dedupeKey, e]));
  const want = new Map(conditions.map((c) => [c.key, c]));
  const out = { created: 0, updated: 0, resolved: 0, unchanged: 0 };

  for (const [key, c] of want) {
    const existing = have.get(key);
    if (!existing) {
      // skipDuplicates = ON CONFLICT DO NOTHING: a simultaneous detection can never create a second active exception.
      const r = await tx.exception.createMany({
        data: [{ customerId: customer.id, exceptionType: c.type, description: c.description, severity: c.severity, sourceEntityType: c.sourceType, sourceEntityId: c.sourceId, dedupeKey: key }],
        skipDuplicates: true,
      });
      out.created += r.count;
      if (r.count > 0) {
        const created = await tx.exception.findFirst({ where: { dedupeKey: key, status: { in: ACTIVE_EXCEPTION_STATUSES } } });
        await audit.record(tx, {
          actionType: 'EXCEPTION_DETECTED', entityType: 'Exception', entityId: created.id, entityRef: created.exceptionCode, customerId: customer.id, actor: null,
          newValues: { exceptionType: c.type, severity: c.severity, sourceEntityType: c.sourceType, sourceEntityId: c.sourceId, status: 'Open' },
          reason: c.description,
        });
      }
    } else if (existing.severity !== c.severity || existing.description !== c.description) {
      await tx.exception.update({ where: { id: existing.id }, data: { severity: c.severity, description: c.description } });
      out.updated += 1;
    } else {
      out.unchanged += 1;
    }
  }

  for (const [key, e] of have) {
    if (want.has(key)) continue;
    await tx.exception.update({
      where: { id: e.id },
      data: { status: 'Resolved', resolvedAt: new Date(), resolutionType: 'Condition cleared', resolutionNotes: `The underlying records no longer show this condition (checked ${asOf}).` },
    });
    await audit.record(tx, {
      actionType: 'EXCEPTION_RESOLVED', entityType: 'Exception', entityId: e.id, entityRef: e.exceptionCode, customerId: customer.id, actor: null,
      previousValues: { status: e.status }, newValues: { status: 'Resolved', resolutionType: 'Condition cleared' },
      reason: `The underlying records no longer show this condition (checked ${asOf}).`,
    });
    await noteLinkedCases(tx, e, `Linked exception ${e.exceptionCode} was resolved automatically: its condition no longer exists.`);
    out.resolved += 1;
  }
  return out;
}

/** Creates the periodic review case when the review is due and no active case exists for this cycle. */
async function ensurePeriodicCase(tx, ctx, asOf) {
  const s = ctx.schedule;
  if (!s || toIso(s.nextReviewDate) > asOf) return 0;
  const exists = await tx.reviewCase.findFirst({ where: { customerId: ctx.customer.id, caseType: 'Periodic KYC Review', periodicCycle: s.cycleNumber, status: { in: ACTIVE_CASE_STATUSES } } });
  if (exists) return 0;

  const exception = await tx.exception.findFirst({
    where: { customerId: ctx.customer.id, status: { in: ACTIVE_EXCEPTION_STATUSES }, exceptionType: { in: ['PERIODIC_REVIEW_OVERDUE', 'PERIODIC_REVIEW_DUE_SOON'] }, sourceEntityId: s.id },
  });
  const priority = exception?.severity ?? (ctx.customer.riskLevel === 'High' ? 'High' : 'Medium');
  const created = await tx.reviewCase.create({
    data: {
      customerId: ctx.customer.id,
      exceptionId: exception?.id ?? null,
      reviewScheduleId: s.id,
      periodicCycle: s.cycleNumber,
      caseTitle: `Periodic KYC review (cycle ${s.cycleNumber})`,
      caseType: 'Periodic KYC Review',
      description: `The periodic KYC review for ${ctx.customer.name} was due on ${toIso(s.nextReviewDate)} (${s.reviewIntervalMonths}-month interval for ${s.riskLevel} risk). Created automatically when the review became due.`,
      priority,
      status: 'Open',
      dueDate: s.nextReviewDate,
      requiresApproval: requiresApproval({ caseType: 'Periodic KYC Review', priority, customerRiskLevel: ctx.customer.riskLevel }),
      createdById: null,
    },
  });
  const history = { action: 'CREATED', previousStatus: null, newStatus: 'Open', changedById: null, remarks: 'Created by the system: the periodic review became due.' };
  await tx.caseHistory.create({ data: { reviewCaseId: created.id, ...history } });
  await audit.recordCaseChange(tx, created.id, history, null);
  return 1;
}

async function syncOne(ctx, { asOf, createCases }) {
  return prisma.$transaction(
    async (tx) => {
      // One detection at a time per customer.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(4, ${ctx.customer.id}::int)`;

      const base = detectConditions({ ...ctx, unresolvedClosedCases: [], asOf });
      const r1 = await syncSubset(tx, ctx.customer, base.filter((c) => !c.alertOnly), (t) => t !== PREVIOUS, asOf);
      await refreshStatuses(tx, ctx.customer.id);
      // Scene 5: alerts come from the same conditions, in the same transaction.
      const alerts = await syncAlerts(tx, ctx, base, asOf);

      // "Closed without proper resolution" depends on the exception statuses just reconciled.
      const prevConds = reviewConditions(ctx.customer, null, await unresolvedClosedCases(tx, ctx.customer.id), asOf);
      const r2 = await syncSubset(tx, ctx.customer, prevConds, (t) => t === PREVIOUS, asOf);

      const casesCreated = createCases ? await ensurePeriodicCase(tx, ctx, asOf) : 0;
      await refreshStatuses(tx, ctx.customer.id);
      return {
        created: r1.created + r2.created, updated: r1.updated + r2.updated, resolved: r1.resolved + r2.resolved, unchanged: r1.unchanged + r2.unchanged, casesCreated,
        alertsCreated: alerts.created, alertsResolved: alerts.resolved,
      };
    },
    { timeout: 20000 }
  );
}

/**
 * Runs detection for all customers (or one). Safe to run any number of times.
 * @returns {Promise<object>} what was created, resolved and left unchanged
 */
async function detect({ customerDbId = null, asOf = todayIso(), createCases = true, onProgress = null } = {}) {
  const schedules = await ensureSchedules(prisma, customerDbId);
  const contexts = await loadContexts(prisma, { customerDbId, asOf });
  const totals = { created: 0, updated: 0, resolved: 0, unchanged: 0, casesCreated: 0, alertsCreated: 0, alertsResolved: 0 };
  if (onProgress) onProgress({ processed: 0, total: contexts.length });
  let processed = 0;
  for (const ctx of contexts) {
    const r = await syncOne(ctx, { asOf, createCases });
    for (const k of Object.keys(totals)) totals[k] += r[k];
    processed += 1;
    if (onProgress) onProgress({ processed, total: contexts.length }); // used by the background detection job (services/detectionJobService.js)
  }
  return { asOf, customersChecked: contexts.length, ...totals, schedulesCreated: schedules.created, schedulesRebased: schedules.rebased };
}

/** Detection for one customer (used after a case changes, or a review is completed). */
const syncCustomer = (customerDbId, opts = {}) => detect({ customerDbId, ...opts });

/** The conditions that exist right now for one customer (read only). */
async function currentConditions(customerDbId, asOf = todayIso()) {
  const [ctx] = await loadContexts(prisma, { customerDbId, asOf });
  if (!ctx) return [];
  return detectConditions({ ...ctx, unresolvedClosedCases: await unresolvedClosedCases(prisma, customerDbId), asOf });
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------
function exceptionDto(e) {
  const type = EXCEPTION_TYPES[e.exceptionType] || { label: e.exceptionType, group: 'Other' };
  return {
    id: e.id,
    exceptionId: e.exceptionCode,
    customerId: e.customerCode,
    customerName: e.customerName,
    customerType: e.customerType ?? null,
    exceptionType: e.exceptionType,
    typeLabel: type.label,
    group: type.group,
    description: e.description,
    severity: e.severity,
    detectionDate: e.detectedAt,
    status: e.status,
    sourceEntityType: e.sourceEntityType,
    sourceEntityId: e.sourceEntityId,
    // Convenience links to the underlying record
    relatedDocumentId: e.sourceEntityType === 'Document' ? e.sourceEntityId : null,
    relatedOwnerId: e.sourceEntityType === 'BeneficialOwner' ? e.sourceEntityId : null,
    relatedReviewId: ['ReviewSchedule', 'ReviewCase'].includes(e.sourceEntityType) ? e.sourceEntityId : null,
    resolvedAt: e.resolvedAt,
    resolutionType: e.resolutionType,
    resolutionNotes: e.resolutionNotes,
    resolvedBy: e.resolverName ? { name: e.resolverName } : null,
    activeCase: e.caseId ? { id: Number(e.caseId), caseCode: e.caseCode, status: e.caseStatus } : null,
  };
}

const EXCEPTION_SELECT = Prisma.sql`
  SELECT e.id, e.exception_code AS "exceptionCode", e.exception_type AS "exceptionType", e.description, e.severity, e.status,
         e.source_entity_type AS "sourceEntityType", e.source_entity_id AS "sourceEntityId", e.detected_at AS "detectedAt",
         e.resolved_at AS "resolvedAt", e.resolution_type AS "resolutionType", e.resolution_notes AS "resolutionNotes",
         c.customer_id AS "customerCode", c.full_name AS "customerName", t.type_name AS "customerType", rv.name AS "resolverName",
         ac.id AS "caseId", ac.case_code AS "caseCode", ac.status AS "caseStatus"
  FROM "Exception" e
  JOIN "Customer" c ON c.id = e.customer_id
  JOIN "CustomerType" t ON t.id = c.customer_type_id
  LEFT JOIN "Reviewer" rv ON rv.id = e.resolved_by_id
  LEFT JOIN LATERAL (
    SELECT rc.id, rc.case_code, rc.status FROM "ReviewCase" rc
    WHERE rc.exception_id = e.id AND rc.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated')
    ORDER BY rc.id DESC LIMIT 1
  ) ac ON true`;

const SEVERITY_ORDER = Prisma.sql`CASE e.severity WHEN 'Critical' THEN 4 WHEN 'High' THEN 3 WHEN 'Medium' THEN 2 ELSE 1 END`;

async function listExceptions({ page, pageSize, search, status, severity, type, group, customerId, withoutCase }) {
  const conditions = [];
  if (status === 'active') conditions.push(Prisma.sql`e.status IN ('Open', 'In Review')`);
  else if (status !== 'all') conditions.push(Prisma.sql`e.status = ${status}`);
  if (severity) conditions.push(Prisma.sql`e.severity = ${severity}`);
  if (type) conditions.push(Prisma.sql`e.exception_type = ${type}`);
  if (group) conditions.push(Prisma.sql`e.exception_type IN (${Prisma.join(Object.keys(EXCEPTION_TYPES).filter((k) => GROUP_OF[k] === group))})`);
  if (customerId) conditions.push(Prisma.sql`c.customer_id = ${customerId.toUpperCase()}`);
  if (withoutCase) conditions.push(Prisma.sql`ac.id IS NULL`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(Prisma.sql`(c.customer_id ILIKE ${pattern} OR c.full_name ILIKE ${pattern} OR e.exception_code ILIKE ${pattern} OR e.description ILIKE ${pattern})`);
  }
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const [rows, [{ total }], counts] = await Promise.all([
    prisma.$queryRaw`${EXCEPTION_SELECT} ${where} ORDER BY (e.status = 'Resolved') ASC, ${SEVERITY_ORDER} DESC, e.detected_at DESC, e.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw`SELECT count(*) AS total FROM "Exception" e JOIN "Customer" c ON c.id = e.customer_id LEFT JOIN LATERAL (SELECT rc.id FROM "ReviewCase" rc WHERE rc.exception_id = e.id AND rc.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated') LIMIT 1) ac ON true ${where}`,
    prisma.$queryRaw`SELECT exception_type AS type, severity, status, count(*)::int AS n FROM "Exception" GROUP BY 1, 2, 3`,
  ]);

  // Overview numbers for the whole system (not only this page of results).
  const summary = { active: 0, resolved: 0, bySeverity: { Low: 0, Medium: 0, High: 0, Critical: 0 }, byGroup: { Document: 0, Ownership: 0, Risk: 0, Review: 0 } };
  for (const c of counts) {
    if (c.status === 'Resolved') summary.resolved += c.n;
    else {
      summary.active += c.n;
      summary.bySeverity[c.severity] += c.n;
      summary.byGroup[GROUP_OF[c.type]] += c.n;
    }
  }
  const totalItems = Number(total);
  return { items: rows.map(exceptionDto), summary, pagination: { page, pageSize, totalItems, totalPages: Math.max(Math.ceil(totalItems / pageSize), 1) } };
}

async function findExceptionRow(idParam) {
  const where = /^EXC-\d+$/i.test(String(idParam)) ? { exceptionCode: String(idParam).toUpperCase() } : /^\d{1,9}$/.test(String(idParam)) ? { id: Number(idParam) } : null;
  if (!where) throw badRequest('Exception ID must look like EXC-000001');
  const row = await prisma.exception.findUnique({ where, include: { customer: { include: { customerType: true } } } });
  if (!row) throw notFound(`Exception ${idParam} was not found`);
  return row;
}

/** Describes the record an exception points at (so the page can show what it refers to). */
async function describeSource(e) {
  switch (e.sourceEntityType) {
    case 'Document': {
      const d = await prisma.document.findUnique({ where: { id: e.sourceEntityId }, select: { id: true, documentType: true, status: true, expiryDate: true } });
      return d ? { type: 'Document', id: d.id, label: `${d.documentType} (${d.status})`, path: `/documents/${d.id}` } : null;
    }
    case 'BeneficialOwner': {
      const o = await prisma.beneficialOwner.findUnique({ where: { id: e.sourceEntityId }, select: { id: true, fullName: true } });
      return o ? { type: 'Beneficial owner', id: o.id, label: o.fullName, path: `/ownership/owners/${o.id}` } : null;
    }
    case 'KYCRequirement': {
      const r = await prisma.kYCRequirement.findUnique({ where: { id: e.sourceEntityId }, select: { id: true, documentType: true } });
      return r ? { type: 'KYC requirement', id: r.id, label: r.documentType, path: `/kyc/${e.customer.customerCode}` } : null;
    }
    case 'ReviewSchedule':
      return { type: 'Review schedule', id: e.sourceEntityId, label: `Review schedule #${e.sourceEntityId}`, path: '/reviews' };
    case 'ReviewCase': {
      const c = await prisma.reviewCase.findUnique({ where: { id: e.sourceEntityId }, select: { id: true, caseCode: true } });
      return c ? { type: 'Review case', id: c.id, label: c.caseCode, path: `/cases/${c.id}` } : null;
    }
    default:
      return { type: 'Customer', id: e.customer.id, label: e.customer.fullName, path: `/customers/${e.customer.customerCode}` };
  }
}

async function getException(idParam) {
  const row = await findExceptionRow(idParam);
  const [listRow] = await prisma.$queryRaw`${EXCEPTION_SELECT} WHERE e.id = ${row.id}`;
  const cases = await prisma.reviewCase.findMany({ where: { exceptionId: row.id }, orderBy: { id: 'desc' }, select: { id: true, caseCode: true, status: true, priority: true, createdAt: true } });
  return { ...exceptionDto(listRow), source: await describeSource(row), cases };
}

/**
 * Records a resolution. Only possible when the underlying condition has actually cleared (otherwise detection would
 * simply raise it again). Analysts may resolve Low and Medium exceptions; High and Critical need a reviewer.
 */
async function resolveException(idParam, actor, resolutionNotes) {
  const row = await findExceptionRow(idParam);
  if (row.status === 'Resolved') throw conflict('ALREADY_RESOLVED', `Exception ${row.exceptionCode} is already resolved.`);
  if (['High', 'Critical'].includes(row.severity) && actor.role === 'Analyst') {
    throw new AppError(403, 'FORBIDDEN_ACTION', `${row.severity} exceptions can only be resolved by a compliance reviewer or an administrator.`);
  }
  const conditions = await currentConditions(row.customerId);
  if (conditions.some((c) => c.key === row.dedupeKey)) {
    throw conflict('CONDITION_PERSISTS', 'The underlying condition still exists, so this exception cannot be resolved yet. Fix the issue (or close the related case with an explanation), then try again.', {
      resolutionNotes: 'The condition is still present in the records.',
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.exception.update({ where: { id: row.id }, data: { status: 'Resolved', resolvedAt: new Date(), resolvedById: actor.id, resolutionType: 'Resolved manually', resolutionNotes } });
    await audit.record(tx, {
      actionType: 'EXCEPTION_RESOLVED', entityType: 'Exception', entityId: row.id, entityRef: row.exceptionCode, customerId: row.customerId, actor,
      previousValues: { status: row.status }, newValues: { status: 'Resolved', resolutionType: 'Resolved manually' }, reason: resolutionNotes,
    });
    await noteLinkedCases(tx, row, `Linked exception ${row.exceptionCode} was resolved by ${actor.name}: ${resolutionNotes}`, actor.id);
    await refreshStatuses(tx, row.customerId);
  });
  return getException(row.id);
}

module.exports = {
  detect,
  loadContexts,
  syncCustomer,
  currentConditions,
  listExceptions,
  getException,
  resolveException,
  refreshStatuses,
  exceptionDto,
  EXCEPTION_SELECT,
  SEVERITY_RANK,
  SLA_DAYS,
};
