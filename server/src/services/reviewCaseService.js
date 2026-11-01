/**
 * Review cases: creation, listing, details, assignment, the status workflow, notes and history.
 *
 * Every change is a transaction that locks the case row, applies the change, and writes a CaseHistory row. History and
 * notes are insert-only. Cases are never deleted. The workflow rules live in caseWorkflow.js and are re-checked here
 * for every request: the frontend only uses them to decide which buttons to show.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { AppError, conflict, notFound, badRequest } = require('../utils/errors');
const { todayIso, addDays, parseIso, toIso } = require('../utils/dates');
const { SLA_DAYS, CASE_STATUSES, ACTIVE_CASE_STATUSES, MIN_NOTE_LENGTH, ROLE_LABELS, EXCEPTION_TYPES, caseTypeForException } = require('../config/reviewRules');
const workflow = require('./caseWorkflow');
const { findCustomer, getCompleteness } = require('./kycService');
const exceptionService = require('./exceptionService');
const audit = require('./auditService');
const { assessmentDto } = require('./riskAssessmentService');
const { buildOwnerAnalysis } = require('./ownershipService');

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
const PRIORITY_RANK = { Low: 1, Medium: 2, High: 3, Critical: 4 };
const MIN_REMARKS = 5;

const personDto = (p) => (p ? { id: p.id, name: p.name, role: p.role, roleLabel: ROLE_LABELS[p.role] ?? p.role } : null);

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------
async function resolveCaseId(idParam) {
  if (/^CASE-\d+$/i.test(String(idParam))) {
    const row = await prisma.reviewCase.findUnique({ where: { caseCode: String(idParam).toUpperCase() }, select: { id: true } });
    if (!row) throw notFound(`Review case ${idParam} was not found`);
    return row.id;
  }
  if (/^\d{1,9}$/.test(String(idParam))) {
    const row = await prisma.reviewCase.findUnique({ where: { id: Number(idParam) }, select: { id: true } });
    if (!row) throw notFound(`Review case ${idParam} was not found`);
    return row.id;
  }
  throw badRequest('Case ID must look like CASE-000001');
}

/** An active person with one of the allowed roles, or a clear field error. */
async function loadAssignee(db, id, roles, field, label) {
  const person = await db.reviewer.findUnique({ where: { id } });
  if (!person || !person.isActive) throw badRequest(`${label} was not found`, { [field]: `${label} does not exist or is not active` });
  if (!roles.includes(person.role)) throw badRequest(`${label} has the wrong role`, { [field]: `${person.name} is a ${ROLE_LABELS[person.role]}. Choose a ${roles.map((r) => ROLE_LABELS[r]).join(' or ')}.` });
  return person;
}
const ANALYST_ROLES = ['Analyst', 'Admin'];
const REVIEWER_ROLES = ['Reviewer', 'Admin'];

// Writes the CaseHistory row and, in the same transaction, the audit event for it.
async function addHistory(tx, reviewCaseId, h) {
  const row = await tx.caseHistory.create({ data: { reviewCaseId, ...h } });
  const who = h.changedById == null ? null : await tx.reviewer.findUnique({ where: { id: h.changedById } });
  await audit.recordCaseChange(tx, reviewCaseId, h, who);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------------------------
async function createCase(body, actor) {
  let exception = null;
  if (body.exceptionId) {
    exception = await prisma.exception.findUnique({ where: { id: body.exceptionId } });
    if (!exception) throw new AppError(404, 'NOT_FOUND', `Exception ${body.exceptionId} was not found`, { exceptionId: 'This exception does not exist' });
    if (exception.status === 'Resolved') throw conflict('EXCEPTION_RESOLVED', `Exception ${exception.exceptionCode} is already resolved, so a case cannot be created for it.`);
    const active = await prisma.reviewCase.findFirst({ where: { exceptionId: exception.id, status: { in: ACTIVE_CASE_STATUSES } } });
    if (active) throw conflict('CASE_EXISTS', `Exception ${exception.exceptionCode} already has an active case (${active.caseCode}).`, { existingCaseId: active.id, existingCaseCode: active.caseCode });
  }

  const customer = exception
    ? await findCustomer(exception.customerId)
    : await findCustomer(body.customerId).catch((err) => {
        if (err instanceof AppError && err.status === 404) throw new AppError(404, 'CUSTOMER_NOT_FOUND', `Customer ${body.customerId} does not exist`, { customerId: `Customer ${body.customerId} does not exist` });
        throw err;
      });
  if (exception && body.customerId && body.customerId !== customer.customerId) throw badRequest('The customer does not match the exception', { customerId: 'This exception belongs to a different customer' });

  // Defaults come from the exception when there is one.
  const typeInfo = exception ? EXCEPTION_TYPES[exception.exceptionType] : null;
  const caseType = body.caseType ?? caseTypeForException(exception?.exceptionType);
  const priority = body.priority ?? exception?.severity ?? 'Medium';
  const caseTitle = (body.caseTitle ?? `${typeInfo?.label ?? caseType}: ${customer.name}`).slice(0, 150);
  const description = body.description ?? exception?.description ?? null;
  const dueDate = body.dueDate ?? addDays(todayIso(), SLA_DAYS[priority]);

  // Periodic reviews: the case belongs to a schedule cycle, and there can be only one active case per cycle.
  let schedule = null;
  const scheduleId = body.reviewScheduleId ?? (exception?.sourceEntityType === 'ReviewSchedule' ? exception.sourceEntityId : null);
  if (scheduleId) {
    schedule = await prisma.reviewSchedule.findUnique({ where: { id: scheduleId } });
    if (!schedule || schedule.customerId !== customer.id) throw badRequest('The review schedule does not belong to this customer', { reviewScheduleId: 'Unknown review schedule for this customer' });
    if (schedule.status !== 'Scheduled') throw conflict('SCHEDULE_NOT_ACTIVE', 'That review schedule is not the current one.');
  }
  if (caseType === 'Periodic KYC Review' && schedule) {
    const dup = await prisma.reviewCase.findFirst({ where: { customerId: customer.id, caseType, periodicCycle: schedule.cycleNumber, status: { in: ACTIVE_CASE_STATUSES } } });
    if (dup) throw conflict('PERIODIC_CASE_EXISTS', `A periodic review case (${dup.caseCode}) is already open for this customer and review cycle.`, { existingCaseId: dup.id, existingCaseCode: dup.caseCode });
  }

  // Assignment at creation follows the same rules as assigning later.
  const analystId = body.assignedAnalystId ?? null;
  const reviewerId = body.assignedReviewerId ?? null;
  if (analystId) {
    if (actor.role === 'Analyst' && analystId !== actor.id) throw new AppError(403, 'FORBIDDEN_ACTION', 'Operations analysts can only assign a case to themselves.');
    await loadAssignee(prisma, analystId, ANALYST_ROLES, 'assignedAnalystId', 'Analyst');
  }
  if (reviewerId) {
    if (actor.role === 'Analyst') throw new AppError(403, 'FORBIDDEN_ACTION', 'Only a compliance reviewer or an administrator can assign a compliance reviewer.');
    await loadAssignee(prisma, reviewerId, REVIEWER_ROLES, 'assignedReviewerId', 'Reviewer');
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const row = await tx.reviewCase.create({
        data: {
          customerId: customer.id,
          exceptionId: exception?.id ?? null,
          reviewScheduleId: schedule?.id ?? null,
          periodicCycle: schedule?.cycleNumber ?? null,
          caseTitle,
          caseType,
          description,
          priority,
          assignedAnalystId: analystId,
          assignedReviewerId: reviewerId,
          status: analystId ? 'Assigned' : 'Open',
          dueDate: parseIso(dueDate),
          requiresApproval: workflow.requiresApproval({ caseType, priority, customerRiskLevel: customer.riskLevel }),
          createdById: actor.id,
        },
      });
      await addHistory(tx, row.id, { action: 'CREATED', previousStatus: null, newStatus: 'Open', changedById: actor.id, remarks: exception ? `Created from exception ${exception.exceptionCode}` : 'Created manually' });
      if (analystId) await addHistory(tx, row.id, { action: 'ASSIGNED_ANALYST', previousStatus: 'Open', newStatus: 'Assigned', changedById: actor.id, remarks: 'Assigned when the case was created' });
      await exceptionService.refreshStatuses(tx, customer.id); // the exception is now "In Review"
      return row;
    });
    return getCase(created.id, actor);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw conflict('PERIODIC_CASE_EXISTS', 'A periodic review case is already open for this customer and review cycle.');
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------------------------
const CASE_SELECT = Prisma.sql`
  SELECT rc.id, rc.case_code AS "caseCode", rc.case_title AS "caseTitle", rc.case_type AS "caseType", rc.priority, rc.status,
         rc.due_date AS "dueDate", rc.created_at AS "createdAt", rc.requires_approval AS "requiresApproval", rc.proposal_pending AS "proposalPending",
         c.customer_id AS "customerCode", c.full_name AS "customerName",
         a.id AS "analystId", a.name AS "analystName", a.role AS "analystRole",
         rv.id AS "reviewerId", rv.name AS "reviewerName", rv.role AS "reviewerRole",
         e.exception_code AS "exceptionCode", e.exception_type AS "exceptionType"
  FROM "ReviewCase" rc
  JOIN "Customer" c ON c.id = rc.customer_id
  LEFT JOIN "Reviewer" a ON a.id = rc.assigned_analyst_id
  LEFT JOIN "Reviewer" rv ON rv.id = rc.assigned_reviewer_id
  LEFT JOIN "Exception" e ON e.id = rc.exception_id`;

function listDto(r, asOf) {
  const active = ACTIVE_CASE_STATUSES.includes(r.status);
  const due = toIso(r.dueDate);
  const overdue = active && due < asOf;
  return {
    id: r.id,
    caseId: r.caseCode,
    customerId: r.customerCode,
    customerName: r.customerName,
    caseTitle: r.caseTitle,
    caseType: r.caseType,
    priority: r.priority,
    status: r.status,
    dueDate: due,
    isOverdue: overdue,
    daysOverdue: overdue ? Math.round((parseIso(asOf) - parseIso(due)) / 86_400_000) : 0,
    createdAt: r.createdAt,
    requiresApproval: r.requiresApproval,
    proposalPending: r.proposalPending,
    assignedAnalyst: r.analystId ? { id: r.analystId, name: r.analystName, role: r.analystRole } : null,
    assignedReviewer: r.reviewerId ? { id: r.reviewerId, name: r.reviewerName, role: r.reviewerRole } : null,
    exception: r.exceptionCode ? { exceptionId: r.exceptionCode, exceptionType: r.exceptionType, typeLabel: EXCEPTION_TYPES[r.exceptionType]?.label ?? r.exceptionType } : null,
  };
}

function statusFilter(raw) {
  if (!raw) return null;
  if (raw === 'active') return ACTIVE_CASE_STATUSES;
  if (raw === 'closed') return ['Resolved', 'Closed'];
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = list.filter((s) => !CASE_STATUSES.includes(s));
  if (bad.length) throw badRequest('Invalid query parameters', { status: `Status must be one of: ${CASE_STATUSES.join(', ')}, active or closed` });
  return list;
}

async function listCases({ page, pageSize, search, status, priority, caseType, customerId, assignedAnalystId, assignedReviewerId, unassigned, overdue }, asOf = todayIso()) {
  const conditions = [];
  const statuses = statusFilter(status);
  if (statuses) conditions.push(Prisma.sql`rc.status IN (${Prisma.join(statuses)})`);
  if (priority) conditions.push(Prisma.sql`rc.priority IN (${Prisma.join(priority.split(',').map((p) => p.trim()))})`);
  if (caseType) conditions.push(Prisma.sql`rc.case_type = ${caseType}`);
  if (customerId) conditions.push(Prisma.sql`c.customer_id = ${customerId.toUpperCase()}`);
  if (assignedAnalystId) conditions.push(Prisma.sql`rc.assigned_analyst_id = ${assignedAnalystId}`);
  if (assignedReviewerId) conditions.push(Prisma.sql`rc.assigned_reviewer_id = ${assignedReviewerId}`);
  if (unassigned) conditions.push(Prisma.sql`rc.assigned_analyst_id IS NULL AND rc.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated')`);
  if (overdue) conditions.push(Prisma.sql`rc.due_date < ${asOf}::date AND rc.status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated')`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(Prisma.sql`(rc.case_code ILIKE ${pattern} OR rc.case_title ILIKE ${pattern} OR c.customer_id ILIKE ${pattern} OR c.full_name ILIKE ${pattern})`);
  }
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
  const order = Prisma.sql`ORDER BY (rc.status IN ('Resolved', 'Closed')) ASC, CASE rc.priority WHEN 'Critical' THEN 4 WHEN 'High' THEN 3 WHEN 'Medium' THEN 2 ELSE 1 END DESC, rc.due_date ASC, rc.id DESC`;

  const [rows, [{ total }]] = await Promise.all([
    prisma.$queryRaw`${CASE_SELECT} ${where} ${order} LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw`SELECT count(*) AS total FROM "ReviewCase" rc JOIN "Customer" c ON c.id = rc.customer_id ${where}`,
  ]);
  const totalItems = Number(total);
  return { items: rows.map((r) => listDto(r, asOf)), pagination: { page, pageSize, totalItems, totalPages: Math.max(Math.ceil(totalItems / pageSize), 1) } };
}

// ---------------------------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------------------------
/** Customer information, risk summary, KYC completeness, ownership and documents for the case details page. */
async function customerContext(customerDbId) {
  const row = await prisma.customer.findUnique({
    where: { id: customerDbId },
    include: { customerType: true, riskRatings: { orderBy: [{ assessmentDate: 'desc' }, { id: 'desc' }], take: 1, include: { assessedBy: true } } },
  });
  const customer = { id: row.id, customerId: row.customerCode, name: row.fullName, customerType: row.customerType.typeName, country: row.country, registrationStatus: row.registrationStatus, email: row.email, phone: row.phone };
  const latest = row.riskRatings[0];
  const risk = latest ? assessmentDto(latest, row) : null;

  let kyc = null;
  try {
    const k = await getCompleteness(row.customerCode);
    kyc = { percentage: k.percentage, status: k.status, totals: k.totals };
  } catch {
    kyc = null;
  }

  let ownership = null;
  if (customer.customerType === 'Company') {
    const owners = await prisma.beneficialOwner.findMany({ where: { customerId: row.id }, orderBy: { id: 'asc' }, include: { screenings: { orderBy: { id: 'desc' } } } });
    const analysis = buildOwnerAnalysis(owners);
    ownership = {
      status: analysis.validation.status,
      message: analysis.validation.message,
      totalPercentage: analysis.validation.totalPercentage,
      ownerCount: analysis.validation.ownerCount,
      owners: analysis.entries.map((e) => ({ id: e.row.id, fullName: e.row.fullName, ownershipPercentage: e.owner.ownershipPercentage, riskLevel: e.risk.level, screening: e.risk.screening })),
    };
  }

  const docs = await prisma.document.findMany({ where: { customerId: row.id }, orderBy: [{ submissionDate: 'desc' }, { id: 'desc' }], select: { id: true, documentType: true, status: true, expiryDate: true, submissionDate: true } });
  const documents = docs.map((d) => ({ id: d.id, documentType: d.documentType, status: d.status, expiryDate: toIso(d.expiryDate), submissionDate: toIso(d.submissionDate) }));
  return { customer, risk, kyc, ownership, documents };
}

async function getCase(idParam, actor = null) {
  const id = await resolveCaseId(idParam);
  const row = await prisma.reviewCase.findUnique({
    where: { id },
    include: {
      assignedAnalyst: true,
      assignedReviewer: true,
      createdBy: true,
      proposedBy: true,
      history: { orderBy: { id: 'desc' }, include: { changedBy: true } },
      notes: { orderBy: { id: 'desc' }, include: { author: true } },
      reviewSchedule: true,
    },
  });
  const context = await customerContext(row.customerId);
  // Related exceptions: this customer's active ones, plus the one this case was created from (even if resolved since).
  const related = await exceptionService.listExceptions({ page: 1, pageSize: 50, status: 'all', customerId: context.customer.customerId });
  const customerExceptions = related.items.filter((e) => ['Open', 'In Review'].includes(e.status) || e.id === row.exceptionId);

  const today = todayIso();
  const due = toIso(row.dueDate);
  const active = ACTIVE_CASE_STATUSES.includes(row.status);
  const timeline = [
    ...row.history.map((h) => ({ kind: 'history', id: `h${h.id}`, at: h.changedAt, action: h.action, previousStatus: h.previousStatus, newStatus: h.newStatus, remarks: h.remarks, by: personDto(h.changedBy) ?? { id: null, name: 'System', role: 'System', roleLabel: 'System' } })),
    ...row.notes.map((n) => ({ kind: 'note', id: `n${n.id}`, at: n.createdAt, note: n.note, by: personDto(n.author) })),
  ].sort((a, b) => new Date(b.at) - new Date(a.at) || String(b.id).localeCompare(String(a.id)));

  const rights = actor ? workflow.assignmentRights(row, actor) : { analyst: 'none', reviewer: false, priorityMax: null };
  return {
    id: row.id,
    caseId: row.caseCode,
    caseTitle: row.caseTitle,
    caseType: row.caseType,
    description: row.description,
    priority: row.priority,
    status: row.status,
    dueDate: due,
    isOverdue: active && due < today,
    daysOverdue: active && due < today ? Math.round((parseIso(today) - parseIso(due)) / 86_400_000) : 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    resolvedAt: row.resolvedAt,
    closedAt: row.closedAt,
    requiresApproval: row.requiresApproval,
    proposalPending: row.proposalPending,
    resolutionNotes: row.resolutionNotes,
    assignedAnalyst: personDto(row.assignedAnalyst),
    assignedReviewer: personDto(row.assignedReviewer),
    createdBy: personDto(row.createdBy) ?? { id: null, name: 'System', role: 'System', roleLabel: 'System' },
    proposedBy: personDto(row.proposedBy),
    periodicReview: row.reviewSchedule ? { scheduleId: row.reviewSchedule.id, cycle: row.periodicCycle, nextReviewDate: toIso(row.reviewSchedule.nextReviewDate), status: row.reviewSchedule.status } : null,
    exceptionId: row.exceptionId,
    ...context,
    exceptions: customerExceptions.map((e) => ({ ...e, isLinked: e.id === row.exceptionId })),
    timeline,
    // What the person asking may do (decided by the backend)
    allowedActions: workflow.allowedActions({ ...row, assignedAnalystId: row.assignedAnalystId, assignedReviewerId: row.assignedReviewerId }, actor),
    permissions: { assignAnalyst: rights.analyst, assignReviewer: rights.reviewer, priorityMax: rights.priorityMax, addNote: workflow.canAddNote(row, actor) },
  };
}

async function getHistory(idParam) {
  const id = await resolveCaseId(idParam);
  const [c, rows] = await Promise.all([
    prisma.reviewCase.findUnique({ where: { id }, select: { caseCode: true, status: true } }),
    prisma.caseHistory.findMany({ where: { reviewCaseId: id }, orderBy: { id: 'desc' }, include: { changedBy: true } }),
  ]);
  return {
    caseId: c.caseCode,
    currentStatus: c.status,
    items: rows.map((h) => ({ id: h.id, action: h.action, previousStatus: h.previousStatus, newStatus: h.newStatus, remarks: h.remarks, changedAt: h.changedAt, changedBy: personDto(h.changedBy) ?? { id: null, name: 'System', role: 'System', roleLabel: 'System' } })),
  };
}

// ---------------------------------------------------------------------------------------------
// Assignment, priority
// ---------------------------------------------------------------------------------------------
async function assignCase(idParam, body, actor) {
  const id = await resolveCaseId(idParam);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ReviewCase" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.reviewCase.findUnique({ where: { id }, include: { customer: true } });
    if (row.status === 'Closed') throw conflict('CASE_CLOSED', 'A closed case cannot be changed. Reopen it first.');
    const rights = workflow.assignmentRights(row, actor);
    const data = {};
    const history = [];
    let status = row.status;

    if (body.assignedAnalystId !== undefined) {
      const target = body.assignedAnalystId;
      if (rights.analyst === 'none') throw new AppError(403, 'FORBIDDEN_ACTION', 'You cannot change the assigned analyst of this case.');
      if (rights.analyst === 'self' && target !== null && target !== actor.id) throw new AppError(403, 'FORBIDDEN_ACTION', 'Operations analysts can only assign a case to themselves.');
      if (rights.analyst === 'self' && target === null && row.assignedAnalystId !== actor.id) throw new AppError(403, 'FORBIDDEN_ACTION', 'You can only release a case that is assigned to you.');
      if (target !== row.assignedAnalystId) {
        const person = target ? await loadAssignee(tx, target, ANALYST_ROLES, 'assignedAnalystId', 'Analyst') : null;
        data.assignedAnalystId = target;
        if (status === 'Open' && target) status = 'Assigned';
        if (status === 'Assigned' && !target) status = 'Open';
        history.push({ action: target ? 'ASSIGNED_ANALYST' : 'UNASSIGNED_ANALYST', previousStatus: row.status, newStatus: status, remarks: target ? `Assigned to ${person.name}${body.remarks ? `: ${body.remarks}` : ''}` : `Analyst removed${body.remarks ? `: ${body.remarks}` : ''}` });
      }
    }

    if (body.assignedReviewerId !== undefined) {
      const target = body.assignedReviewerId;
      if (!rights.reviewer) throw new AppError(403, 'FORBIDDEN_ACTION', 'Only a compliance reviewer or an administrator can assign a compliance reviewer.');
      if (target !== row.assignedReviewerId) {
        const person = target ? await loadAssignee(tx, target, REVIEWER_ROLES, 'assignedReviewerId', 'Reviewer') : null;
        data.assignedReviewerId = target;
        history.push({ action: target ? 'ASSIGNED_REVIEWER' : 'UNASSIGNED_REVIEWER', previousStatus: status, newStatus: status, remarks: target ? `Compliance reviewer: ${person.name}${body.remarks ? `. ${body.remarks}` : ''}` : 'Compliance reviewer removed' });
      }
    }

    if (body.priority !== undefined && body.priority !== row.priority) {
      if (!rights.priorityMax) throw new AppError(403, 'FORBIDDEN_ACTION', 'You cannot change the priority of this case.');
      if (PRIORITY_RANK[body.priority] > PRIORITY_RANK[rights.priorityMax]) throw new AppError(403, 'FORBIDDEN_ACTION', `Only a compliance reviewer or an administrator can set the priority to ${body.priority}.`);
      data.priority = body.priority;
      const customer = await findCustomer(row.customer.customerCode);
      data.requiresApproval = row.proposalPending || workflow.requiresApproval({ caseType: row.caseType, priority: body.priority, customerRiskLevel: customer.riskLevel });
      history.push({ action: 'PRIORITY_CHANGED', previousStatus: status, newStatus: status, remarks: `Priority changed from ${row.priority} to ${body.priority}${body.remarks ? `: ${body.remarks}` : ''}` });
    }

    if (history.length === 0) throw badRequest('Nothing to change', { assignedAnalystId: 'The case already has these assignments and priority' });
    await tx.reviewCase.update({ where: { id }, data: { ...data, status } });
    for (const h of history) await addHistory(tx, id, { ...h, changedById: actor.id });
  });
  return getCase(id, actor);
}

// ---------------------------------------------------------------------------------------------
// Status workflow
// ---------------------------------------------------------------------------------------------
const HISTORY_ACTION = {
  start: 'STARTED',
  request_customer: 'CUSTOMER_INFO_REQUESTED',
  customer_responded: 'CUSTOMER_RESPONDED',
  escalate: 'ESCALATED',
  submit_for_review: 'SUBMITTED_FOR_REVIEW',
  approve: 'RESOLUTION_APPROVED',
  reject: 'RESOLUTION_REJECTED',
  return_to_analyst: 'RETURNED_TO_ANALYST',
  resolve: 'RESOLVED',
  close: 'CLOSED',
  reopen: 'REOPENED',
};
// Actions after which exceptions are re-checked against the records (the issue may now be fixed, or not).
const FULL_SYNC_ACTIONS = ['resolve', 'approve', 'close', 'reopen'];

async function transitionCase(idParam, body, actor) {
  const id = await resolveCaseId(idParam);
  const out = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "ReviewCase" WHERE id = ${id} FOR UPDATE`;
    const row = await tx.reviewCase.findUnique({ where: { id } });

    let action = body.action;
    if (!action) {
      action = workflow.actionForStatus(row.status, body.status);
      if (!action) throw badRequest('Choose an action', { action: `More than one action leads to "${body.status}" from ${row.status}. Send an "action" instead of a "status".` });
    }
    const def = workflow.ACTIONS[action];
    if (!def.from.includes(row.status)) {
      throw conflict('INVALID_TRANSITION', `"${def.label}" is not possible while the case is ${row.status}.`, { action: `Not allowed from ${row.status}` });
    }
    const verdict = workflow.check(action, row, actor);
    if (!verdict.ok) throw new AppError(403, 'FORBIDDEN_ACTION', verdict.reason);

    // Required explanations
    const details = {};
    const { remarks, resolutionNotes } = body;
    if (def.needs.includes('remarks') && (!remarks || remarks.length < MIN_REMARKS)) details.remarks = `Explain why (at least ${MIN_REMARKS} characters)`;
    if (def.needs.includes('resolutionNotes') && (!resolutionNotes || resolutionNotes.length < MIN_NOTE_LENGTH)) details.resolutionNotes = `Resolution notes are required (at least ${MIN_NOTE_LENGTH} characters)`;
    if (action === 'close' && row.status !== 'Resolved' && (!resolutionNotes || resolutionNotes.length < MIN_NOTE_LENGTH)) {
      details.resolutionNotes = `A case cannot be closed without resolution notes (at least ${MIN_NOTE_LENGTH} characters)`;
    }
    if (action === 'close' && row.status === 'Resolved' && !(row.resolutionNotes || '').trim()) details.resolutionNotes = 'A case cannot be closed without resolution notes';

    let reviewerId = row.assignedReviewerId;
    if (def.needs.includes('reviewer')) {
      reviewerId = body.reviewerId ?? row.assignedReviewerId;
      if (!reviewerId) details.reviewerId = 'Choose the compliance reviewer who should review this case';
      else {
        const reviewer = await loadAssignee(tx, reviewerId, REVIEWER_ROLES, 'reviewerId', 'Reviewer');
        if (action === 'submit_for_review' && reviewer.id === actor.id) details.reviewerId = 'Choose a different compliance reviewer: you cannot review your own proposal';
      }
    }
    if (Object.keys(details).length) throw badRequest('Please complete the highlighted fields', details);

    const now = new Date();
    const data = {};
    let newStatus = workflow.targetStatus(action, row);
    const extraHistory = [];

    switch (action) {
      case 'start':
        if (row.assignedAnalystId == null) {
          data.assignedAnalystId = actor.id;
          extraHistory.push({ action: 'ASSIGNED_ANALYST', previousStatus: row.status, newStatus: 'Assigned', remarks: `${actor.name} took the case` });
        }
        break;
      case 'escalate':
        data.assignedReviewerId = reviewerId;
        data.proposalPending = false;
        break;
      case 'submit_for_review':
        data.assignedReviewerId = reviewerId;
        data.resolutionNotes = resolutionNotes;
        data.proposalPending = true;
        data.proposedById = actor.id;
        break;
      case 'approve':
        data.resolvedAt = now;
        data.proposalPending = false;
        if (row.assignedReviewerId == null) data.assignedReviewerId = actor.id;
        break;
      case 'reject':
        data.proposalPending = false;
        data.proposedById = null;
        break;
      case 'resolve':
        data.resolutionNotes = resolutionNotes;
        data.resolvedAt = now;
        data.proposalPending = false;
        if (row.status === 'Escalated' && row.assignedReviewerId == null && ['Reviewer', 'Admin'].includes(actor.role)) data.assignedReviewerId = actor.id;
        break;
      case 'close':
        data.closedAt = now;
        data.proposalPending = false;
        if (row.status !== 'Resolved') data.resolutionNotes = resolutionNotes;
        break;
      case 'reopen':
        data.resolvedAt = null;
        data.closedAt = null;
        data.proposalPending = false;
        break;
      default:
        break;
    }

    await tx.reviewCase.update({ where: { id }, data: { ...data, status: newStatus } });
    for (const h of extraHistory) await addHistory(tx, id, { ...h, changedById: actor.id });
    const historyRemarks = remarks || resolutionNotes || null;
    await addHistory(tx, id, { action: HISTORY_ACTION[action], previousStatus: extraHistory.length ? 'Assigned' : row.status, newStatus, changedById: actor.id, remarks: historyRemarks });
    return { customerId: row.customerId, action };
  });

  if (FULL_SYNC_ACTIONS.includes(out.action)) await exceptionService.syncCustomer(out.customerId, { createCases: false });
  else await exceptionService.refreshStatuses(prisma, out.customerId);
  return getCase(id, actor);
}

// ---------------------------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------------------------
async function addNote(idParam, { note }, actor) {
  const id = await resolveCaseId(idParam);
  const row = await prisma.reviewCase.findUnique({ where: { id } });
  if (row.status === 'Closed') throw conflict('CASE_CLOSED', 'Notes cannot be added to a closed case. Reopen it first.');
  if (!workflow.canAddNote(row, actor)) throw new AppError(403, 'FORBIDDEN_ACTION', 'Only the assigned analyst, the assigned compliance reviewer or an administrator can add notes to this case.');
  await prisma.$transaction(async (tx) => {
    await tx.caseNote.create({ data: { reviewCaseId: id, authorId: actor.id, note } });
    // The note text stays in CaseNote (it can contain investigation detail); the audit event records only that a note was added.
    await audit.record(tx, { actionType: 'CASE_NOTE_ADDED', entityType: 'ReviewCase', entityId: id, entityRef: row.caseCode, customerId: row.customerId, newValues: { noteLength: note.length, status: row.status }, actor });
  });
  return getCase(id, actor);
}

module.exports = { createCase, listCases, getCase, getHistory, assignCase, transitionCase, addNote, resolveCaseId, personDto };
