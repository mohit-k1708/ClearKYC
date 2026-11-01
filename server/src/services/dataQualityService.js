/**
 * Data Quality & Validation: runs the checks, stores the result and lets users inspect it.
 *
 * Running validation only READS business data. It writes a ValidationRun, its ValidationIssues and one audit event, and it
 * marks issues from earlier runs as "Resolved" when the newest run no longer finds them. Nothing else is modified:
 * problems are fixed by people through the relevant workflow (the issue says which record and what to do).
 */
const prisma = require('../utils/prisma');
const { notFound, badRequest } = require('../utils/errors');
const { todayIso, parseIso } = require('../utils/dates');
const audit = require('./auditService');
const { CHECKS, CATEGORIES } = require('./dataQualityChecks');

const MAX_ISSUES_PER_CHECK = 500; // keeps one broken table from producing an unreadable report; the count still shows the truth

const fingerprint = (checkCode, i) => `${checkCode}|${i.entityType}|${i.entityId ?? i.entityRef ?? '-'}|${i.description.slice(0, 60)}`;

/** Runs every check once and returns { results, issues }. Pure reading. */
async function evaluate(db, asOf, checks = CHECKS) {
  let contexts = null;
  const getContexts = async () => {
    if (!contexts) contexts = await require('./exceptionService').loadContexts(db, { asOf });
    return contexts;
  };
  const results = [];
  const issues = [];
  for (const check of checks) {
    let violations;
    let crashed = false;
    try {
      violations = await check.run({ db, asOf, getContexts });
    } catch (err) {
      // A check that cannot run is reported as failed, never silently skipped.
      crashed = true;
      violations = [{ entityType: 'System', entityId: null, entityRef: check.code, customerId: null, description: `The check could not be completed (${err.name}${err.code ? ` ${err.code}` : ''})`, recommendedFix: 'Contact the administrator; the check could not read the data.' }];
    }
    const severities = violations.map((x) => x.severity ?? check.severity);
    const outcome = crashed || severities.includes('Error') ? 'Failed' : violations.length > 0 ? 'Warning' : 'Passed';
    results.push({ code: check.code, category: check.category, title: check.title, outcome, issueCount: violations.length, severity: check.severity });
    for (const x of violations.slice(0, MAX_ISSUES_PER_CHECK)) {
      issues.push({ checkCode: check.code, category: check.category, severity: crashed ? 'Error' : x.severity ?? check.severity, ...x, fingerprint: fingerprint(check.code, x) });
    }
  }
  return { results, issues };
}

const summarize = (results) => ({
  totalChecks: results.length,
  passedChecks: results.filter((r) => r.outcome === 'Passed').length,
  failedChecks: results.filter((r) => r.outcome === 'Failed').length,
  warningCount: results.filter((r) => r.outcome === 'Warning').length,
});

/**
 * Runs all checks and records the run. `asOf` defaults to today; the dev seed passes a fixed date.
 * @param {{id:number, role:string}|null} actor
 */
async function runValidation(actor, asOf = todayIso()) {
  const startedAt = new Date();
  let evaluated;
  try {
    evaluated = await evaluate(prisma, asOf);
  } catch (err) {
    await prisma.validationRun.create({ data: { startedAt, completedAt: new Date(), asOf: parseIso(asOf), status: 'Failed', createdById: actor?.id ?? null } });
    throw err;
  }
  const { results, issues } = evaluated;
  const counts = summarize(results);

  const run = await prisma.$transaction(async (tx) => {
    const created = await tx.validationRun.create({
      data: { startedAt, completedAt: new Date(), asOf: parseIso(asOf), status: 'Completed', results, createdById: actor?.id ?? null, ...counts },
    });
    if (issues.length) {
      await tx.validationIssue.createMany({
        data: issues.map((i) => ({
          validationRunId: created.id, checkCode: i.checkCode, category: i.category, entityType: i.entityType, entityId: i.entityId, entityRef: i.entityRef, customerId: i.customerId,
          issueType: i.checkCode, severity: i.severity, description: i.description, recommendedFix: i.recommendedFix, fingerprint: i.fingerprint,
        })),
      });
    }
    // Issues of earlier runs that this run no longer finds are fixed.
    await tx.validationIssue.updateMany({
      where: { status: 'Open', validationRunId: { not: created.id }, fingerprint: { notIn: issues.map((i) => i.fingerprint) } },
      data: { status: 'Resolved', resolvedAt: new Date() },
    });
    await audit.record(tx, {
      actionType: 'DATA_VALIDATION_RUN', entityType: 'ValidationRun', entityId: created.id, entityRef: `Validation run #${created.id}`,
      newValues: { ...counts, asOf, issues: issues.length }, reason: 'Data quality checks run', ...(actor ? { actor } : {}),
    });
    return created;
  });
  return getRun(run.id);
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------
const runDto = (r, extra = {}) => ({
  id: r.id,
  runId: `VAL-${String(r.id).padStart(6, '0')}`,
  startedAt: r.startedAt,
  completedAt: r.completedAt,
  validationRunDate: r.startedAt,
  asOf: r.asOf.toISOString().slice(0, 10),
  status: r.status,
  totalChecks: r.totalChecks,
  passedChecks: r.passedChecks,
  failedChecks: r.failedChecks,
  warnings: r.warningCount,
  createdBy: r.createdBy ? { id: r.createdBy.id, name: r.createdBy.name, role: r.createdBy.role } : null,
  ...extra,
});

async function listRuns({ page, pageSize }) {
  const [total, rows] = await Promise.all([
    prisma.validationRun.count(),
    prisma.validationRun.findMany({ orderBy: { id: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: { createdBy: true } }),
  ]);
  return { data: rows.map((r) => runDto(r)), pagination: { page, pageSize, totalItems: total, totalPages: Math.max(Math.ceil(total / pageSize), 1) } };
}

async function getRun(idParam) {
  if (!/^\d{1,9}$/.test(String(idParam))) throw notFound(`Validation run ${idParam} was not found`);
  const run = await prisma.validationRun.findUnique({ where: { id: Number(idParam) }, include: { createdBy: true } });
  if (!run) throw notFound(`Validation run ${idParam} was not found`);
  const failed = await prisma.validationIssue.findMany({ where: { validationRunId: run.id, severity: 'Error' }, select: { entityType: true, entityId: true, entityRef: true }, take: 200 });
  return runDto(run, {
    results: run.results,
    // The IDs of the records that failed (errors), for quick reference. The full list, with fixes, is GET /data-validation/issues.
    failedRecordIds: [...new Set(failed.map((f) => f.entityRef ?? `${f.entityType} #${f.entityId}`))],
    categories: CATEGORIES.map((c) => ({ category: c, checks: run.results.filter((x) => x.category === c) })),
  });
}

async function latestRunId() {
  const run = await prisma.validationRun.findFirst({ where: { status: 'Completed' }, orderBy: { id: 'desc' }, select: { id: true } });
  return run?.id ?? null;
}

async function listIssues({ page, pageSize, runId, severity, category, checkCode, status, entityType, search }) {
  const run = runId ?? (await latestRunId());
  if (run === null) return { data: [], runId: null, summary: { Error: 0, Warning: 0 }, pagination: { page, pageSize, totalItems: 0, totalPages: 1 } };
  const where = {
    validationRunId: run,
    ...(severity ? { severity } : {}),
    ...(category ? { category } : {}),
    ...(checkCode ? { checkCode } : {}),
    ...(status ? { status } : {}),
    ...(entityType ? { entityType } : {}),
    ...(search ? { OR: [{ entityRef: { contains: search, mode: 'insensitive' } }, { description: { contains: search, mode: 'insensitive' } }] } : {}),
  };
  const [total, rows, grouped] = await Promise.all([
    prisma.validationIssue.count({ where }),
    prisma.validationIssue.findMany({ where, orderBy: [{ severity: 'asc' }, { id: 'asc' }], skip: (page - 1) * pageSize, take: pageSize }),
    prisma.validationIssue.groupBy({ by: ['severity'], where: { validationRunId: run }, _count: { _all: true } }),
  ]);
  const codes = await customerCodeMap(rows.map((r) => r.customerId));
  return {
    runId: run,
    summary: { Error: grouped.find((g) => g.severity === 'Error')?._count._all ?? 0, Warning: grouped.find((g) => g.severity === 'Warning')?._count._all ?? 0 },
    data: rows.map((i) => ({
      id: i.id, validationRunId: i.validationRunId, checkCode: i.checkCode, category: i.category, entityType: i.entityType, entityId: i.entityId, entityRef: i.entityRef,
      customerId: codes.get(i.customerId) ?? null, issueType: i.issueType, severity: i.severity, description: i.description, recommendedFix: i.recommendedFix,
      status: i.status, resolvedAt: i.resolvedAt, createdAt: i.createdAt,
    })),
    pagination: { page, pageSize, totalItems: total, totalPages: Math.max(Math.ceil(total / pageSize), 1) },
  };
}

async function customerCodeMap(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return new Map();
  const rows = await prisma.customer.findMany({ where: { id: { in: unique } }, select: { id: true, customerCode: true } });
  return new Map(rows.map((r) => [r.id, r.customerCode]));
}

function assertValidRun(idParam) {
  if (idParam !== undefined && !Number.isInteger(idParam)) throw badRequest('runId must be a whole number');
}

module.exports = { runValidation, listRuns, getRun, listIssues, evaluate, summarize, assertValidRun };
