/**
 * Audit trail: writing and reading.
 *
 * WRITING (backend only). `record(db, event)` is called by the services INSIDE the same database transaction as the
 * business change (`db` is the transaction client), so either both are saved or neither is. There is no endpoint that
 * lets the frontend create, change or delete an audit event, and database triggers refuse UPDATE/DELETE/TRUNCATE.
 *
 * WHO. The acting person is, in order: the `actor` given in the event (null = the system), the person identified by
 * the current request (X-Reviewer-Id), or the system.
 *
 * WHAT IS STORED. `previousValues` / `newValues` are small summaries chosen by the caller. They are sanitised again here:
 * keys that can hold PAN, Aadhaar, document numbers, dates of birth, passwords or tokens are replaced by "[redacted]",
 * anything in free text that looks like a PAN or an Aadhaar number is masked, and long text is cut.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { currentContext, clientIp } = require('../utils/requestContext');
const { notFound } = require('../utils/errors');
const {
  ACTIVITY_FEED_ACTIONS, AUDIT_ACTIONS, SENSITIVE_KEYS, SENSITIVE_KEY_SUFFIXES, PAN_PATTERN, AADHAAR_PATTERN, MAX_TEXT_LENGTH,
} = require('../config/auditRules');

const REDACTED = '[redacted]';

// ---------------------------------------------------------------------------------------------
// Sanitising
// ---------------------------------------------------------------------------------------------
function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/[^a-z]/g, '');
  return SENSITIVE_KEYS.has(k) || SENSITIVE_KEY_SUFFIXES.some((s) => k.endsWith(s));
}

function maskText(text) {
  const masked = text
    .replace(PAN_PATTERN, (m) => `${'X'.repeat(m.length - 4)}${m.slice(-4)}`)
    .replace(AADHAAR_PATTERN, (m) => `XXXX XXXX ${m.replace(/\D/g, '').slice(-4)}`);
  return masked.length > MAX_TEXT_LENGTH ? `${masked.slice(0, MAX_TEXT_LENGTH)}…` : masked;
}

/** Deep, JSON-safe copy with sensitive keys redacted and sensitive-looking text masked. */
function sanitize(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > 4) return REDACTED;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Prisma.Decimal) return Number(value);
  if (typeof value === 'string') return maskText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, isSensitiveKey(k) ? REDACTED : sanitize(v, depth + 1)]));
  }
  return String(value);
}

/** Only the keys whose value really changed, as two small objects: { previous, next }. */
function changedFields(before, after, keys) {
  const previous = {};
  const next = {};
  for (const k of keys) {
    const a = before[k] instanceof Date ? before[k].toISOString().slice(0, 10) : before[k] ?? null;
    const b = after[k] instanceof Date ? after[k].toISOString().slice(0, 10) : after[k] ?? null;
    if (String(a) !== String(b)) {
      previous[k] = a;
      next[k] = b;
    }
  }
  return { previous, next };
}

// ---------------------------------------------------------------------------------------------
// Who acted
// ---------------------------------------------------------------------------------------------
async function personFromRequest(ctx) {
  if (!ctx) return null;
  if (ctx.req.reviewer) return ctx.req.reviewer;
  if (ctx.actor !== undefined) return ctx.actor;
  const raw = ctx.req.get?.('x-reviewer-id');
  ctx.actor = null;
  if (raw && /^\d{1,9}$/.test(raw)) {
    const person = await prisma.reviewer.findUnique({ where: { id: Number(raw) } });
    if (person?.isActive) ctx.actor = person;
  }
  return ctx.actor;
}

async function resolveActor(event, ctx) {
  if (Object.prototype.hasOwnProperty.call(event, 'actor')) return event.actor ?? null;
  return personFromRequest(ctx);
}

// ---------------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------------
/**
 * Writes one audit event using `db` (the transaction client of the business change, or the shared client).
 * @param {object} db
 * @param {object} event
 * @param {string} event.actionType     a key of AUDIT_ACTIONS
 * @param {string} event.entityType
 * @param {number} [event.entityId]
 * @param {string} [event.entityRef]    business reference such as CASE-000012
 * @param {number} [event.customerId]   database id of the customer affected
 * @param {object} [event.previousValues]
 * @param {object} [event.newValues]
 * @param {string} [event.reason]
 * @param {object|null} [event.actor]   a Reviewer-like { id, role }; null = the system; omitted = the current request's person
 */
async function record(db, event) {
  if (!AUDIT_ACTIONS[event.actionType]) throw new Error(`Unknown audit action type: ${event.actionType}`);
  const ctx = currentContext();
  const actor = await resolveActor(event, ctx);
  return db.auditEvent.create({
    data: {
      userId: actor?.id ?? null,
      userRole: actor?.role ?? 'System',
      actionType: event.actionType,
      entityType: event.entityType,
      entityId: event.entityId ?? null,
      entityRef: event.entityRef ?? null,
      customerId: event.customerId ?? null,
      previousValues: event.previousValues == null ? Prisma.DbNull : sanitize(event.previousValues),
      newValues: event.newValues == null ? Prisma.DbNull : sanitize(event.newValues),
      reason: event.reason ? maskText(String(event.reason)) : null,
      ipAddress: actor && ctx ? clientIp(ctx.req) : null,
    },
  });
}

/** Runs `fn` in a transaction. If `db` already is a transaction client, `fn` simply uses it. */
function inTransaction(db, fn, options) {
  return typeof db.$transaction === 'function' ? db.$transaction(fn, options) : fn(db);
}

// Case history entries (CaseHistory.action) -> audit action types.
const CASE_ACTION_MAP = {
  CREATED: 'CASE_CREATED',
  ASSIGNED_ANALYST: 'CASE_ASSIGNED',
  UNASSIGNED_ANALYST: 'CASE_ASSIGNED',
  ASSIGNED_REVIEWER: 'CASE_ASSIGNED',
  UNASSIGNED_REVIEWER: 'CASE_ASSIGNED',
  PRIORITY_CHANGED: 'CASE_PRIORITY_CHANGED',
  ESCALATED: 'CASE_ESCALATED',
  RESOLVED: 'CASE_RESOLVED',
  RESOLUTION_APPROVED: 'CASE_RESOLVED',
  REVIEW_COMPLETED: 'CASE_RESOLVED',
  CLOSED: 'CASE_CLOSED',
  REOPENED: 'CASE_REOPENED',
};

/**
 * Records the audit event for one CaseHistory entry. Called right after the history row is written, in the same
 * transaction. EXCEPTION_RESOLVED notes are not case changes and are not audited here (the exception has its own event).
 */
async function recordCaseChange(db, reviewCaseId, history, actor) {
  if (history.action === 'EXCEPTION_RESOLVED') return null;
  const row = await db.reviewCase.findUnique({ where: { id: reviewCaseId }, select: { id: true, caseCode: true, customerId: true, caseType: true, priority: true, assignedAnalystId: true, assignedReviewerId: true } });
  const actionType = CASE_ACTION_MAP[history.action] ?? 'CASE_STATUS_CHANGED';
  return record(db, {
    actionType,
    entityType: 'ReviewCase',
    entityId: row.id,
    entityRef: row.caseCode,
    customerId: row.customerId,
    previousValues: history.previousStatus ? { status: history.previousStatus } : null,
    newValues: { status: history.newStatus, workflowAction: history.action, caseType: row.caseType, priority: row.priority, assignedAnalystId: row.assignedAnalystId, assignedReviewerId: row.assignedReviewerId },
    reason: history.remarks ?? null,
    ...(actor === undefined ? {} : { actor }),
  });
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------
function auditDto(e) {
  const meta = AUDIT_ACTIONS[e.actionType] ?? { label: e.actionType, category: 'Other' };
  return {
    id: e.id,
    eventId: e.eventCode,
    user: e.user ? { id: e.user.id, name: e.user.name, role: e.userRole } : { id: null, name: 'System', role: 'System' },
    userRole: e.userRole,
    actionType: e.actionType,
    actionLabel: meta.label,
    category: meta.category,
    entityType: e.entityType,
    entityId: e.entityId,
    entityRef: e.entityRef,
    customerId: e.customerId,
    previousValues: e.previousValues,
    newValues: e.newValues,
    reason: e.reason,
    ipAddress: e.ipAddress,
    createdAt: e.createdAt,
  };
}

/** Builds the Prisma `where` for audit filters (also used by the CSV export). */
async function buildWhere({ search, actionType, category, entityType, entityId, userId, customerId, from, to }) {
  const where = {};
  if (actionType) where.actionType = actionType;
  else if (category) where.actionType = { in: Object.entries(AUDIT_ACTIONS).filter(([, v]) => v.category === category).map(([k]) => k) };
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (userId === 0) where.userId = null; // 0 = "System"
  else if (userId) where.userId = userId;
  if (customerId) {
    const customer = await prisma.customer.findUnique({ where: { customerCode: customerId }, select: { id: true } });
    where.customerId = customer?.id ?? -1; // unknown customer code: matches nothing
  }
  if (from || to) where.createdAt = { ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}), ...(to ? { lt: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + 86_400_000) } : {}) };
  if (search) {
    const q = search.trim();
    // A customer ID finds everything that happened to that customer, not only events whose reference contains it.
    const customers = await prisma.customer.findMany({ where: { customerCode: { contains: q, mode: 'insensitive' } }, select: { id: true }, take: 200 });
    where.OR = [
      { eventCode: { contains: q, mode: 'insensitive' } },
      { entityRef: { contains: q, mode: 'insensitive' } },
      { reason: { contains: q, mode: 'insensitive' } },
      ...(customers.length ? [{ customerId: { in: customers.map((c) => c.id) } }] : []),
    ];
  }
  return where;
}

const WITH_USER = { user: { select: { id: true, name: true, role: true } } };

async function customerCodes(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.customer.findMany({ where: { id: { in: unique } }, select: { id: true, customerCode: true } });
  return new Map(rows.map((r) => [r.id, r.customerCode]));
}

async function listAuditEvents(query) {
  const { page, pageSize } = query;
  const where = await buildWhere(query);
  const [total, rows] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({ where, orderBy: { id: 'desc' }, skip: (page - 1) * pageSize, take: pageSize, include: WITH_USER }),
  ]);
  const codes = await customerCodes(rows.map((r) => r.customerId));
  return {
    data: rows.map((r) => ({ ...auditDto(r), customerCode: codes.get(r.customerId) ?? null })),
    pagination: { page, pageSize, totalItems: total, totalPages: Math.max(Math.ceil(total / pageSize), 1) },
  };
}

async function getAuditEvent(idParam) {
  const where = /^AUD-\d+$/i.test(String(idParam)) ? { eventCode: String(idParam).toUpperCase() } : /^\d{1,9}$/.test(String(idParam)) ? { id: Number(idParam) } : null;
  if (!where) throw notFound(`Audit event ${idParam} was not found`);
  const row = await prisma.auditEvent.findUnique({ where, include: WITH_USER });
  if (!row) throw notFound(`Audit event ${idParam} was not found`);
  const codes = await customerCodes([row.customerId]);
  return { ...auditDto(row), customerCode: codes.get(row.customerId) ?? null };
}

/** The audit events of one entity, oldest first (used for "alert history"). */
async function entityHistory(entityType, entityId) {
  const rows = await prisma.auditEvent.findMany({ where: { entityType, entityId }, orderBy: { id: 'asc' }, include: WITH_USER });
  return rows.map(auditDto);
}

/**
 * The latest business activity, for the Overview. Deliberately limited: action, record reference, customer, who and when.
 * Previous/new values, reasons and IP addresses are NOT included (those stay in the restricted audit trail).
 */
async function recentActivity(limit = 8) {
  const rows = await prisma.auditEvent.findMany({
    where: { actionType: { in: ACTIVITY_FEED_ACTIONS } },
    orderBy: { id: 'desc' },
    take: limit,
    include: WITH_USER,
  });
  const codes = await customerCodes(rows.map((r) => r.customerId));
  return rows.map((e) => ({
    id: e.id,
    actionType: e.actionType,
    actionLabel: AUDIT_ACTIONS[e.actionType]?.label ?? e.actionType,
    category: AUDIT_ACTIONS[e.actionType]?.category ?? 'Other',
    entityType: e.entityType,
    entityId: e.entityId,
    entityRef: e.entityRef,
    customerCode: codes.get(e.customerId) ?? null,
    user: e.user ? { name: e.user.name, role: e.userRole } : { name: 'System', role: 'System' },
    createdAt: e.createdAt,
  }));
}

module.exports = { recentActivity, record, recordCaseChange, inTransaction, sanitize, maskText, isSensitiveKey, changedFields, listAuditEvents, getAuditEvent, entityHistory, buildWhere, auditDto, CASE_ACTION_MAP };
