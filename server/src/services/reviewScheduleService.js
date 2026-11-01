/**
 * Periodic KYC review scheduling.
 *
 * Each customer has ONE current schedule (status Scheduled) with the date of the last review, the interval and the
 * next due date. The interval depends on the customer's CURRENT risk level (config/reviewRules.js). The intervals
 * are configurable illustrations, not legal requirements.
 *
 * Completing a review closes the current row (Completed) and starts the next cycle (Scheduled), so a customer keeps
 * their full schedule history. A change in risk level supersedes the current row with a new one that uses the new
 * interval from the same last-review date.
 *
 * Duplicate prevention: the database allows only one Scheduled row per customer, and only one active periodic case
 * per customer and cycle.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const audit = require('./auditService');
const { AppError, conflict, notFound, badRequest } = require('../utils/errors');
const { addMonths, toIso, todayIso, parseIso, daysBetween } = require('../utils/dates');
const { PERIODIC_REVIEW, ACTIVE_CASE_STATUSES } = require('../config/reviewRules');
const { findCustomer } = require('./kycService');

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
const intervalFor = (level) => PERIODIC_REVIEW.intervalMonths[level];

/** Calculates the next review date. */
const nextReviewFrom = (lastReviewDate, riskLevel) => addMonths(lastReviewDate, intervalFor(riskLevel));

/** Overdue / due soon / scheduled, relative to `asOf`. */
function scheduleState(status, nextReviewDate, asOf) {
  if (status !== 'Scheduled') return status;
  const days = daysBetween(asOf, toIso(nextReviewDate));
  if (days < 0) return 'Overdue';
  if (days <= PERIODIC_REVIEW.upcomingDays) return 'Due soon';
  return 'Scheduled';
}

function scheduleDto(r, asOf = todayIso()) {
  const next = toIso(r.nextReviewDate);
  return {
    id: r.id,
    customerId: r.customerCode,
    customerName: r.customerName,
    customerType: r.customerType,
    cycleNumber: r.cycleNumber,
    riskLevel: r.riskLevel,
    currentRiskLevel: r.currentRiskLevel ?? null,
    lastReviewDate: toIso(r.lastReviewDate),
    nextReviewDate: next,
    reviewIntervalMonths: r.reviewIntervalMonths,
    status: r.status,
    state: scheduleState(r.status, next, asOf),
    daysUntilDue: r.status === 'Scheduled' ? daysBetween(asOf, next) : null,
    completedAt: r.completedAt ?? null,
    completionNotes: r.completionNotes ?? null,
    activeCase: r.activeCaseId ? { id: Number(r.activeCaseId), caseCode: r.activeCaseCode, status: r.activeCaseStatus } : null,
    // The customer's risk level changed since this row was scheduled (it is reconciled the next time detection runs).
    riskLevelChanged: r.status === 'Scheduled' && r.currentRiskLevel != null && r.currentRiskLevel !== r.riskLevel,
  };
}

const SCHEDULE_SELECT = Prisma.sql`
  SELECT s.id, s.cycle_number AS "cycleNumber", s.risk_level AS "riskLevel", s.last_review_date AS "lastReviewDate",
         s.next_review_date AS "nextReviewDate", s.review_interval_months AS "reviewIntervalMonths", s.status,
         s.completed_at AS "completedAt", s.completion_notes AS "completionNotes",
         c.customer_id AS "customerCode", c.full_name AS "customerName", t.type_name AS "customerType",
         cur.risk_level AS "currentRiskLevel",
         ac.id AS "activeCaseId", ac.case_code AS "activeCaseCode", ac.status AS "activeCaseStatus"
  FROM "ReviewSchedule" s
  JOIN "Customer" c ON c.id = s.customer_id
  JOIN "CustomerType" t ON t.id = c.customer_type_id
  LEFT JOIN LATERAL (SELECT rr.risk_level FROM "RiskRating" rr WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1) cur ON true
  LEFT JOIN LATERAL (
    SELECT rc.id, rc.case_code, rc.status FROM "ReviewCase" rc
    WHERE rc.customer_id = s.customer_id AND rc.periodic_cycle = s.cycle_number AND rc.case_type = 'Periodic KYC Review'
      AND rc.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated')
    ORDER BY rc.id DESC LIMIT 1
  ) ac ON true`;

/** Lists schedules. mode: 'all' | 'overdue' (next date before today) | 'upcoming' (due within the next 30 days). */
async function listSchedules({ page, pageSize, search, status, riskLevel, customerType, customerId }, mode = 'all', asOf = todayIso()) {
  const conditions = [];
  if (mode === 'overdue') conditions.push(Prisma.sql`s.status = 'Scheduled' AND s.next_review_date < ${asOf}::date`);
  if (mode === 'upcoming') {
    const end = new Date(parseIso(asOf).getTime() + PERIODIC_REVIEW.upcomingDays * 86_400_000).toISOString().slice(0, 10);
    conditions.push(Prisma.sql`s.status = 'Scheduled' AND s.next_review_date >= ${asOf}::date AND s.next_review_date <= ${end}::date`);
  }
  if (status) conditions.push(Prisma.sql`s.status = ${status}`);
  if (riskLevel) conditions.push(Prisma.sql`s.risk_level = ${riskLevel}`);
  if (customerType) conditions.push(Prisma.sql`t.type_name = ${customerType}`);
  if (customerId) conditions.push(Prisma.sql`c.customer_id = ${customerId.toUpperCase()}`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(Prisma.sql`(c.customer_id ILIKE ${pattern} OR c.full_name ILIKE ${pattern})`);
  }
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  const order = mode === 'all' ? Prisma.sql`ORDER BY (s.status = 'Scheduled') DESC, s.next_review_date ASC, s.id DESC` : Prisma.sql`ORDER BY s.next_review_date ASC, s.id ASC`;

  const [rows, [{ total }]] = await Promise.all([
    prisma.$queryRaw`${SCHEDULE_SELECT} ${where} ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw`SELECT count(*) AS total FROM "ReviewSchedule" s JOIN "Customer" c ON c.id = s.customer_id JOIN "CustomerType" t ON t.id = c.customer_type_id ${where}`,
  ]);
  const totalItems = Number(total);
  return { items: rows.map((r) => scheduleDto(r, asOf)), pagination: { page, pageSize, totalItems, totalPages: Math.max(Math.ceil(totalItems / pageSize), 1) } };
}

async function getScheduleDto(id, asOf = todayIso()) {
  const [row] = await prisma.$queryRaw`${SCHEDULE_SELECT} WHERE s.id = ${id}`;
  if (!row) throw notFound(`Review schedule ${id} was not found`);
  return scheduleDto(row, asOf);
}

/** Creates the first (or a replacement) schedule for a customer. */
async function createSchedule(customerIdParam, { lastReviewDate } = {}) {
  const customer = await findCustomer(customerIdParam);
  if (!customer.riskLevel) throw badRequest('This customer has no risk rating yet, so the review interval cannot be chosen');
  const row = await prisma.customer.findUnique({ where: { id: customer.id }, select: { createdAt: true } });
  const last = lastReviewDate || toIso(row.createdAt); // the onboarding date counts as the first KYC review
  if (last > todayIso()) throw badRequest('Last review date cannot be in the future', { lastReviewDate: 'Last review date cannot be in the future' });

  const existing = await prisma.reviewSchedule.findFirst({ where: { customerId: customer.id, status: 'Scheduled' } });
  if (existing) {
    throw conflict('SCHEDULE_EXISTS', 'This customer already has a current review schedule. Complete the review to move to the next cycle.', { existingScheduleId: existing.id });
  }
  const latest = await prisma.reviewSchedule.findFirst({ where: { customerId: customer.id }, orderBy: { cycleNumber: 'desc' } });
  try {
    const created = await prisma.$transaction(async (tx) => {
      const row2 = await tx.reviewSchedule.create({
        data: {
          customerId: customer.id,
          cycleNumber: (latest?.cycleNumber ?? 0) + 1,
          riskLevel: customer.riskLevel,
          lastReviewDate: parseIso(last),
          reviewIntervalMonths: intervalFor(customer.riskLevel),
          nextReviewDate: parseIso(nextReviewFrom(last, customer.riskLevel)),
        },
      });
      await audit.record(tx, {
        actionType: 'REVIEW_SCHEDULE_CREATED', entityType: 'ReviewSchedule', entityId: row2.id, entityRef: `${customer.customerId} / cycle ${row2.cycleNumber}`, customerId: customer.id,
        newValues: { cycleNumber: row2.cycleNumber, riskLevel: row2.riskLevel, lastReviewDate: toIso(row2.lastReviewDate), nextReviewDate: toIso(row2.nextReviewDate), intervalMonths: row2.reviewIntervalMonths },
        reason: 'Periodic review scheduled',
      });
      return row2;
    });
    return getScheduleDto(created.id);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('SCHEDULE_EXISTS', 'This customer already has a current review schedule');
    throw err;
  }
}

/**
 * Makes sure every customer (or one customer) has a current schedule, and that the interval matches the CURRENT risk level.
 * Returns how many schedules were created / re-based.
 */
async function ensureSchedules(db = prisma, customerDbId = null) {
  const filter = customerDbId ? Prisma.sql`AND c.id = ${customerDbId}` : Prisma.empty;
  const customers = await db.$queryRaw`
    SELECT c.id, c.created_at AS "createdAt", r.risk_level AS "riskLevel",
           s.id AS "scheduleId", s.risk_level AS "scheduleRisk", s.cycle_number AS "cycleNumber", s.last_review_date AS "lastReviewDate",
           (SELECT coalesce(max(x.cycle_number), 0) FROM "ReviewSchedule" x WHERE x.customer_id = c.id) AS "maxCycle"
    FROM "Customer" c
    JOIN LATERAL (SELECT rr.risk_level FROM "RiskRating" rr WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1) r ON true
    LEFT JOIN "ReviewSchedule" s ON s.customer_id = c.id AND s.status = 'Scheduled'
    WHERE (s.id IS NULL OR s.risk_level <> r.risk_level) ${filter}`;

  let created = 0;
  let rebased = 0;
  for (const c of customers) {
    // One transaction per customer: the schedule change and its audit event are saved together (done by the system).
    // Two detections can reach the same customer at the same moment (for example two people clicking "Run detection", or two approvals):
    // the second one then hits the unique index on the schedule. That means the first one already did the work, so it is skipped, not an error.
    try {
      await audit.inTransaction(db, async (tx) => {
        if (c.scheduleId) {
          // Risk level changed: the old row becomes history and a new row uses the new interval from the same last review date.
          const last = toIso(c.lastReviewDate);
          await tx.reviewSchedule.update({ where: { id: c.scheduleId }, data: { status: 'Superseded' } });
          const row = await tx.reviewSchedule.create({
            data: { customerId: c.id, cycleNumber: c.cycleNumber, riskLevel: c.riskLevel, lastReviewDate: parseIso(last), reviewIntervalMonths: intervalFor(c.riskLevel), nextReviewDate: parseIso(nextReviewFrom(last, c.riskLevel)) },
          });
          await audit.record(tx, {
            actionType: 'REVIEW_SCHEDULE_REBASED', entityType: 'ReviewSchedule', entityId: row.id, entityRef: `cycle ${row.cycleNumber}`, customerId: c.id, actor: null,
            previousValues: { riskLevel: c.scheduleRisk }, newValues: { riskLevel: row.riskLevel, intervalMonths: row.reviewIntervalMonths, nextReviewDate: toIso(row.nextReviewDate) },
            reason: `Risk level changed from ${c.scheduleRisk} to ${c.riskLevel}: the review interval was re-based on the last review date`,
          });
          rebased += 1;
        } else {
          const last = toIso(c.createdAt);
          const row = await tx.reviewSchedule.create({
            data: { customerId: c.id, cycleNumber: Number(c.maxCycle) + 1, riskLevel: c.riskLevel, lastReviewDate: parseIso(last), reviewIntervalMonths: intervalFor(c.riskLevel), nextReviewDate: parseIso(nextReviewFrom(last, c.riskLevel)) },
          });
          await audit.record(tx, {
            actionType: 'REVIEW_SCHEDULE_CREATED', entityType: 'ReviewSchedule', entityId: row.id, entityRef: `cycle ${row.cycleNumber}`, customerId: c.id, actor: null,
            newValues: { cycleNumber: row.cycleNumber, riskLevel: row.riskLevel, lastReviewDate: toIso(row.lastReviewDate), nextReviewDate: toIso(row.nextReviewDate), intervalMonths: row.reviewIntervalMonths },
            reason: 'Periodic review scheduled automatically (onboarding date counts as the first review)',
          });
          created += 1;
        }
      });
    } catch (err) {
      const concurrent = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && typeof db.$transaction === 'function';
      if (!concurrent) throw err;
    }
  }
  return { created, rebased };
}

/**
 * Completes the current review: closes the row, starts the next cycle from the review date with the interval for the
 * CURRENT risk level, and resolves the periodic review case for this cycle (the completing reviewer is the approval).
 */
async function completeSchedule(id, actor, { reviewDate, notes }) {
  const date = reviewDate || todayIso();
  const out = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw`SELECT id, customer_id AS "customerId", status, cycle_number AS "cycleNumber", last_review_date AS "lastReviewDate" FROM "ReviewSchedule" WHERE id = ${id} FOR UPDATE`;
    if (rows.length === 0) throw notFound(`Review schedule ${id} was not found`);
    const current = rows[0];
    if (current.status !== 'Scheduled') throw conflict('SCHEDULE_NOT_ACTIVE', `This review schedule is already ${current.status}. Only the current schedule can be completed.`);
    if (date < toIso(current.lastReviewDate)) throw badRequest('Review date cannot be before the previous review', { reviewDate: `Review date cannot be before the previous review (${toIso(current.lastReviewDate)})` });

    const rating = await tx.riskRating.findFirst({ where: { customerId: current.customerId }, orderBy: [{ assessmentDate: 'desc' }, { id: 'desc' }] });
    const level = rating.riskLevel;

    await tx.reviewSchedule.update({ where: { id }, data: { status: 'Completed', completedAt: new Date(), completedById: actor.id, completionNotes: notes } });
    const next = await tx.reviewSchedule.create({
      data: {
        customerId: current.customerId,
        cycleNumber: current.cycleNumber + 1,
        riskLevel: level,
        lastReviewDate: parseIso(date),
        reviewIntervalMonths: intervalFor(level),
        nextReviewDate: parseIso(nextReviewFrom(date, level)),
      },
    });

    // The periodic case for this cycle is resolved by the completed review. Recorded as a status transition.
    const cases = await tx.reviewCase.findMany({ where: { customerId: current.customerId, caseType: 'Periodic KYC Review', periodicCycle: current.cycleNumber, status: { in: ACTIVE_CASE_STATUSES } } });
    const resolvedCases = [];
    for (const c of cases) {
      const resolutionNotes = `Periodic review completed on ${date}. ${notes}`;
      await tx.reviewCase.update({ where: { id: c.id }, data: { status: 'Resolved', resolutionNotes, resolvedAt: new Date(), proposalPending: false } });
      const history = { action: 'REVIEW_COMPLETED', previousStatus: c.status, newStatus: 'Resolved', changedById: actor.id, remarks: resolutionNotes };
      await tx.caseHistory.create({ data: { reviewCaseId: c.id, ...history } });
      await audit.recordCaseChange(tx, c.id, history, actor);
      resolvedCases.push(c.caseCode);
    }
    await audit.record(tx, {
      actionType: 'PERIODIC_REVIEW_COMPLETED', entityType: 'ReviewSchedule', entityId: id, entityRef: `cycle ${current.cycleNumber}`, customerId: current.customerId,
      previousValues: { cycleNumber: current.cycleNumber, lastReviewDate: toIso(current.lastReviewDate) },
      newValues: { reviewDate: date, nextCycleNumber: next.cycleNumber, nextReviewDate: toIso(next.nextReviewDate), intervalMonths: next.reviewIntervalMonths, casesResolved: resolvedCases.length },
      reason: notes, actor,
    });
    return { customerId: current.customerId, nextId: next.id, resolvedCases };
  });

  // The overdue / due-soon exceptions for the finished cycle clear on the next detection: run it now for this customer.
  await require('./exceptionService').syncCustomer(out.customerId, { createCases: false });
  const [completed, next] = await Promise.all([getScheduleDto(id), getScheduleDto(out.nextId)]);
  return { completed, next, resolvedCases: out.resolvedCases };
}

/** Schedules whose review date has arrived (today or earlier). */
async function dueSchedules(db = prisma, asOf = todayIso(), customerDbId = null) {
  return db.reviewSchedule.findMany({ where: { status: 'Scheduled', nextReviewDate: { lte: parseIso(asOf) }, ...(customerDbId ? { customerId: customerDbId } : {}) } });
}

module.exports = { intervalFor, nextReviewFrom, scheduleState, scheduleDto, listSchedules, getScheduleDto, createSchedule, ensureSchedules, completeSchedule, dueSchedules, AppError };
