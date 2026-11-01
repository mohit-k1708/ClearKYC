/**
 * Alerts: generation (as part of detection), listing, and the manual workflow.
 *
 * GENERATION. `syncAlerts` runs inside the per-customer detection transaction (see exceptionService.syncOne), right after the
 * exceptions are reconciled, with the same conditions:
 *   - a condition with no ACTIVE alert raises one (the database also refuses a second active alert for the same condition);
 *   - an active alert whose condition is gone is RESOLVED automatically, with the reason recorded ("Condition cleared");
 *   - a still-present condition keeps its alert (severity and description are refreshed).
 * A person can close an alert while its condition still exists; detection then does not raise it again until the condition
 * has cleared at least once (`suppressRegeneration`).
 *
 * WORKFLOW. New -> Acknowledged -> In Progress -> Resolved, or Dismissed. Resolved and Dismissed are final. Every change
 * writes an audit event in the same transaction: the audit events of an alert ARE its history.
 *
 * Safeguards: potential PEP / sanctions alerts can never be dismissed and are closed only by a compliance reviewer or
 * administrator, with remarks. Critical alerts cannot be dismissed. Nothing closes an important alert automatically
 * except the records themselves no longer showing the condition.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { AppError, conflict, notFound, badRequest } = require('../utils/errors');
const { parseIso, toIso } = require('../utils/dates');
const audit = require('./auditService');
const { deriveAlerts } = require('./alertEngine');
const {
  ALERT_TYPES, ACTIVE_ALERT_STATUSES, CLOSED_ALERT_STATUSES, ALERT_TRANSITIONS, INVESTIGATION_ALERT_TYPES,
  UNDISMISSABLE_SEVERITIES, DISMISS_ROLES, SENIOR_ROLES, MIN_REMARKS_LENGTH,
} = require('../config/alertRules');
const { ROLE_LABELS } = require('../config/reviewRules');

const SEVERITY_RANK = { Low: 1, Medium: 2, High: 3, Critical: 4 };

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------
async function auditAlert(tx, alert, actionType, { previous, next, reason, actor } = {}) {
  return audit.record(tx, {
    actionType, entityType: 'Alert', entityId: alert.id, entityRef: alert.alertCode, customerId: alert.customerId,
    previousValues: previous ?? null, newValues: next ?? null, reason: reason ?? null, ...(actor === undefined ? { actor: null } : { actor }),
  });
}

/**
 * Reconciles the alerts of ONE customer with the conditions just detected.
 * @param {object} tx         transaction client (the detection transaction)
 * @param {object} ctx        the customer's context (exceptionService.loadContexts)
 * @param {object[]} conditions the base conditions detected now
 * @param {string} asOf       YYYY-MM-DD
 */
async function syncAlerts(tx, ctx, conditions, asOf) {
  const customerId = ctx.customer.id;
  const wanted = new Map(deriveAlerts(ctx, conditions).map((a) => [a.key, a]));
  const active = await tx.alert.findMany({ where: { customerId, status: { in: ACTIVE_ALERT_STATUSES } } });
  const have = new Map(active.map((a) => [a.dedupeKey, a]));
  const out = { created: 0, updated: 0, resolved: 0, unchanged: 0 };

  for (const [key, a] of wanted) {
    const existing = have.get(key);
    if (existing) {
      if (existing.severity !== a.severity || existing.description !== a.description) {
        await tx.alert.update({ where: { id: existing.id }, data: { severity: a.severity, description: a.description } });
        out.updated += 1;
      } else {
        out.unchanged += 1;
      }
      continue;
    }
    // A person closed an alert for this exact condition and it has not cleared since: do not nag again.
    const held = await tx.alert.findFirst({ where: { dedupeKey: key, suppressRegeneration: true }, select: { id: true } });
    if (held) { out.unchanged += 1; continue; }

    const exception = await tx.exception.findFirst({ where: { dedupeKey: a.conditionKey ?? key, status: { not: 'Resolved' } }, select: { id: true } });
    // skipDuplicates = ON CONFLICT DO NOTHING: two simultaneous detections can never create a second active alert.
    const r = await tx.alert.createMany({
      data: [{
        customerId, alertType: a.alertType, title: a.title, description: a.description, severity: a.severity,
        relatedEntityType: a.relatedEntityType, relatedEntityId: a.relatedEntityId, exceptionId: exception?.id ?? null,
        dedupeKey: key, threshold: a.threshold ?? null, dueDate: a.dueDate ? parseIso(a.dueDate) : null,
      }],
      skipDuplicates: true,
    });
    if (r.count > 0) {
      const created = await tx.alert.findFirst({ where: { dedupeKey: key, status: { in: ACTIVE_ALERT_STATUSES } } });
      await auditAlert(tx, created, 'ALERT_GENERATED', {
        next: { alertType: created.alertType, severity: created.severity, status: 'New', relatedEntityType: created.relatedEntityType, relatedEntityId: created.relatedEntityId },
        reason: created.description,
      });
      out.created += r.count;
    }
  }

  for (const [key, alert] of have) {
    if (wanted.has(key)) continue;
    const notes = `The underlying records no longer show this condition (checked ${asOf}).`;
    await tx.alert.update({ where: { id: alert.id }, data: { status: 'Resolved', resolvedAt: new Date(), resolutionType: 'Condition cleared', resolutionNotes: notes } });
    await auditAlert(tx, alert, 'ALERT_RESOLVED', { previous: { status: alert.status }, next: { status: 'Resolved', resolutionType: 'Condition cleared' }, reason: notes });
    out.resolved += 1;
  }

  // A condition that has cleared may be raised again if it returns.
  await tx.alert.updateMany({ where: { customerId, suppressRegeneration: true, dedupeKey: { notIn: [...wanted.keys()] } }, data: { suppressRegeneration: false } });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------
const personDto = (p) => (p ? { id: p.id, name: p.name, role: p.role, roleLabel: ROLE_LABELS[p.role] ?? p.role } : null);

function alertDto(a, customer) {
  const type = ALERT_TYPES[a.alertType] ?? { label: a.alertType };
  const active = ACTIVE_ALERT_STATUSES.includes(a.status);
  return {
    id: a.id,
    alertId: a.alertCode,
    customerId: customer.customerCode,
    customerName: customer.fullName,
    alertType: a.alertType,
    alertTypeLabel: type.label,
    threshold: a.threshold ?? null,
    title: a.title,
    description: a.description,
    severity: a.severity,
    relatedEntityType: a.relatedEntityType,
    relatedEntityId: a.relatedEntityId,
    exceptionId: a.exceptionId,
    createdAt: a.createdAt,
    dueDate: toIso(a.dueDate),
    status: a.status,
    isActive: active,
    investigationRequired: INVESTIGATION_ALERT_TYPES.includes(a.alertType),
    acknowledgedBy: personDto(a.acknowledgedBy),
    acknowledgedAt: a.acknowledgedAt,
    resolvedBy: personDto(a.resolvedBy),
    resolvedAt: a.resolvedAt,
    resolutionType: a.resolutionType,
    resolutionNotes: a.resolutionNotes,
    updatedAt: a.updatedAt,
  };
}

const INCLUDE = { customer: { select: { customerCode: true, fullName: true } }, acknowledgedBy: true, resolvedBy: true };

function statusFilter(raw) {
  if (!raw || raw === 'all') return null;
  if (raw === 'active') return ACTIVE_ALERT_STATUSES;
  if (raw === 'closed') return CLOSED_ALERT_STATUSES;
  return raw.split(',').map((s) => s.trim());
}

/** Shared by the list endpoint and the CSV export. */
function buildAlertWhere({ search, status, severity, alertType, customerId, from, to }) {
  const and = [];
  const statuses = statusFilter(status);
  if (statuses) and.push({ status: { in: statuses } });
  if (severity) and.push({ severity: { in: severity.split(',') } });
  if (alertType) and.push({ alertType });
  if (customerId) and.push({ customer: { customerCode: customerId } });
  if (from) and.push({ createdAt: { gte: new Date(`${from}T00:00:00.000Z`) } });
  if (to) and.push({ createdAt: { lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000) } });
  if (search) {
    and.push({
      OR: [
        { alertCode: { contains: search, mode: 'insensitive' } },
        { title: { contains: search, mode: 'insensitive' } },
        { customer: { customerCode: { contains: search, mode: 'insensitive' } } },
        { customer: { fullName: { contains: search, mode: 'insensitive' } } },
      ],
    });
  }
  return and.length ? { AND: and } : {};
}

async function listAlerts(query) {
  const { page, pageSize } = query;
  const where = buildAlertWhere(query);
  const [total, ids] = await Promise.all([
    prisma.alert.count({ where }),
    // Active alerts first, then by severity, then newest.
    prisma.alert.findMany({ where, select: { id: true, severity: true, status: true, createdAt: true } }),
  ]);
  const sorted = ids.sort((a, b) => {
    const act = Number(ACTIVE_ALERT_STATUSES.includes(b.status)) - Number(ACTIVE_ALERT_STATUSES.includes(a.status));
    return act || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.createdAt - a.createdAt || b.id - a.id;
  });
  const pageIds = sorted.slice((page - 1) * pageSize, page * pageSize).map((r) => r.id);
  const rows = await prisma.alert.findMany({ where: { id: { in: pageIds } }, include: INCLUDE });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const bySeverity = { Low: 0, Medium: 0, High: 0, Critical: 0 };
  const byStatus = {};
  ids.forEach((r) => { bySeverity[r.severity] += 1; byStatus[r.status] = (byStatus[r.status] ?? 0) + 1; });
  return {
    data: pageIds.map((id) => alertDto(byId.get(id), byId.get(id).customer)),
    summary: { total, bySeverity, byStatus },
    pagination: { page, pageSize, totalItems: total, totalPages: Math.max(Math.ceil(total / pageSize), 1) },
  };
}

async function findAlertRow(db, idParam) {
  const where = /^ALT-\d+$/i.test(String(idParam)) ? { alertCode: String(idParam).toUpperCase() } : /^\d{1,9}$/.test(String(idParam)) ? { id: Number(idParam) } : null;
  if (!where) throw notFound(`Alert ${idParam} was not found`);
  const row = await db.alert.findUnique({ where, include: INCLUDE });
  if (!row) throw notFound(`Alert ${idParam} was not found`);
  return row;
}

// ---------------------------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------------------------
const isSenior = (actor) => SENIOR_ROLES.includes(actor.role);

/** Why `actor` cannot resolve this alert, or null. */
function resolveBlocker(alert, actor) {
  if (INVESTIGATION_ALERT_TYPES.includes(alert.alertType) && !isSenior(actor)) {
    return 'A potential PEP or sanctions match must be investigated by a compliance reviewer or an administrator.';
  }
  if (['High', 'Critical'].includes(alert.severity) && !isSenior(actor)) {
    return `${alert.severity} alerts can only be resolved by a compliance reviewer or an administrator.`;
  }
  return null;
}

/** Why `actor` cannot dismiss this alert, or null. */
function dismissBlocker(alert, actor) {
  if (INVESTIGATION_ALERT_TYPES.includes(alert.alertType)) return 'A potential PEP or sanctions match cannot be dismissed. Investigate it and resolve it with your findings.';
  if (UNDISMISSABLE_SEVERITIES.includes(alert.severity)) return `${alert.severity} alerts cannot be dismissed. Resolve them with remarks.`;
  if (!DISMISS_ROLES.includes(actor.role)) return 'Only a compliance reviewer or an administrator can dismiss an alert.';
  return null;
}

/** The actions the given person may take now. The frontend shows only these; the service re-checks every request. */
function allowedActions(alert, actor) {
  if (!actor || !ACTIVE_ALERT_STATUSES.includes(alert.status)) return [];
  const out = [];
  if (alert.status === 'New') out.push('acknowledge');
  if (['New', 'Acknowledged'].includes(alert.status)) out.push('in_progress');
  if (!resolveBlocker(alert, actor)) out.push('resolve');
  if (!dismissBlocker(alert, actor)) out.push('dismiss');
  return out;
}

async function getAlert(idParam, actor = null) {
  const row = await findAlertRow(prisma, idParam);
  const history = await audit.entityHistory('Alert', row.id);
  return {
    ...alertDto(row, row.customer),
    allowedActions: allowedActions(row, actor),
    history: history.map((h) => ({ id: h.id, eventId: h.eventId, action: h.actionLabel, actionType: h.actionType, user: h.user, previousValues: h.previousValues, newValues: h.newValues, reason: h.reason, createdAt: h.createdAt })),
  };
}

// ---------------------------------------------------------------------------------------------
// Workflow
// ---------------------------------------------------------------------------------------------
function requireRemarks(remarks, label = 'Remarks') {
  if (!remarks || remarks.trim().length < MIN_REMARKS_LENGTH) {
    throw badRequest(`${label} are required`, { [label === 'Remarks' ? 'remarks' : 'resolutionNotes']: `${label} are required (at least ${MIN_REMARKS_LENGTH} characters)` });
  }
}

/** Locks the alert and runs `change(tx, locked)` in one transaction. */
async function withLockedAlert(idParam, change) {
  const found = await findAlertRow(prisma, idParam);
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Alert" WHERE id = ${found.id} FOR UPDATE`;
    const alert = await tx.alert.findUnique({ where: { id: found.id } });
    if (CLOSED_ALERT_STATUSES.includes(alert.status)) {
      throw conflict('ALERT_CLOSED', `Alert ${alert.alertCode} is already ${alert.status.toLowerCase()} and can no longer be changed. If the problem returns, a new alert is raised.`);
    }
    await change(tx, alert);
  });
  return found.id;
}

async function acknowledgeAlert(idParam, actor, { remarks } = {}) {
  const id = await withLockedAlert(idParam, async (tx, alert) => {
    if (alert.status !== 'New') throw conflict('INVALID_TRANSITION', `Alert ${alert.alertCode} is already ${alert.status}; only a new alert can be acknowledged.`);
    await tx.alert.update({ where: { id: alert.id }, data: { status: 'Acknowledged', acknowledgedById: actor.id, acknowledgedAt: new Date() } });
    await auditAlert(tx, alert, 'ALERT_ACKNOWLEDGED', { previous: { status: 'New' }, next: { status: 'Acknowledged' }, reason: remarks ?? null, actor });
  });
  return getAlert(id, actor);
}

async function changeAlertStatus(idParam, actor, { status, remarks }) {
  if (status === 'Resolved') throw badRequest('Use the resolve action to resolve an alert', { status: 'Resolve the alert with remarks using the resolve action' });
  if (status === 'New') throw badRequest('An alert cannot go back to New', { status: 'An alert cannot go back to New' });
  const id = await withLockedAlert(idParam, async (tx, alert) => {
    if (!ALERT_TRANSITIONS[alert.status].includes(status)) {
      throw conflict('INVALID_TRANSITION', `An alert that is ${alert.status} cannot move to ${status}.`, { status: `Not allowed from ${alert.status}` });
    }
    const data = { status };
    // Starting work on a New alert counts as acknowledging it.
    if (alert.status === 'New' && status === 'In Progress') Object.assign(data, { acknowledgedById: actor.id, acknowledgedAt: new Date() });

    if (status === 'Dismissed') {
      const blocker = dismissBlocker(alert, actor);
      if (blocker) throw new AppError(403, 'FORBIDDEN_ACTION', blocker);
      requireRemarks(remarks, 'Remarks');
      Object.assign(data, { resolvedById: actor.id, resolvedAt: new Date(), resolutionType: 'Dismissed manually', resolutionNotes: remarks.trim(), suppressRegeneration: true });
    }
    await tx.alert.update({ where: { id: alert.id }, data });
    await auditAlert(tx, alert, status === 'Dismissed' ? 'ALERT_DISMISSED' : status === 'Acknowledged' ? 'ALERT_ACKNOWLEDGED' : 'ALERT_STATUS_CHANGED', {
      previous: { status: alert.status }, next: { status }, reason: remarks ?? null, actor,
    });
  });
  return getAlert(id, actor);
}

async function resolveAlert(idParam, actor, { resolutionNotes }) {
  const found = await findAlertRow(prisma, idParam);
  const blocker = resolveBlocker(found, actor);
  if (blocker) throw new AppError(403, 'FORBIDDEN_ACTION', blocker);
  requireRemarks(resolutionNotes, 'Resolution notes');
  // Is the condition still in the records? Then detection must not raise this alert again straight away.
  const stillPresent = (await require('./exceptionService').currentConditions(found.customerId)).some((c) => c.key === found.dedupeKey);

  const id = await withLockedAlert(idParam, async (tx, alert) => {
    await tx.alert.update({
      where: { id: alert.id },
      data: { status: 'Resolved', resolvedById: actor.id, resolvedAt: new Date(), resolutionType: 'Resolved manually', resolutionNotes: resolutionNotes.trim(), suppressRegeneration: stillPresent },
    });
    await auditAlert(tx, alert, 'ALERT_RESOLVED', {
      previous: { status: alert.status }, next: { status: 'Resolved', resolutionType: 'Resolved manually', conditionStillPresent: stillPresent }, reason: resolutionNotes.trim(), actor,
    });
  });
  return getAlert(id, actor);
}

/** Counts used by the sidebar badge and the Overview cards (calculated from the records every time). */
async function getAlertSummary() {
  const rows = await prisma.alert.groupBy({ by: ['status', 'severity'], _count: { _all: true } });
  const active = rows.filter((r) => ACTIVE_ALERT_STATUSES.includes(r.status));
  const sum = (list) => list.reduce((n, r) => n + r._count._all, 0);
  return {
    totalAlerts: sum(rows),
    activeAlerts: sum(active),
    newAlerts: sum(rows.filter((r) => r.status === 'New')),
    criticalActive: sum(active.filter((r) => r.severity === 'Critical')),
    highActive: sum(active.filter((r) => r.severity === 'High')),
  };
}

module.exports = {
  syncAlerts, listAlerts, getAlert, acknowledgeAlert, changeAlertStatus, resolveAlert, getAlertSummary,
  allowedActions, resolveBlocker, dismissBlocker, buildAlertWhere, alertDto, INCLUDE, Prisma,
};
