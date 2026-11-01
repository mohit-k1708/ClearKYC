/**
 * System settings. Currently one: the document-expiry alert lead times (days before expiry at which an alert is raised).
 *
 * Storage: the insert-only table "SystemSetting". The NEWEST row of a key is its current value; every change is a new row with who
 * changed it, when and why, so the history is never overwritten. When nothing has been saved the defaults in config/expiryRules.js
 * apply. Detection reads the value at the start of every run (exceptionService.loadContexts), so a saved change takes effect the next
 * time detection runs, with no restart.
 */
const prisma = require('../utils/prisma');
const { badRequest } = require('../utils/errors');
const { EXPIRY_ALERT_CONFIG, LIMITS, validateExpiryAlertDays } = require('../config/expiryRules');
const audit = require('./auditService');

const KEY = 'expiry_alert_days';

/** The configuration detection must use now: { enabled, expiryAlertDays }. `db` may be a transaction client. */
async function getExpiryAlertConfig(db = prisma) {
  const row = await db.systemSetting.findFirst({ where: { key: KEY }, orderBy: { id: 'desc' } });
  const check = row ? validateExpiryAlertDays(row.value) : { ok: false };
  // the database validates what it stores; the fallback only protects against a value edited by hand
  return { enabled: EXPIRY_ALERT_CONFIG.enabled, expiryAlertDays: check.ok ? check.days : [...EXPIRY_ALERT_CONFIG.expiryAlertDays] };
}

const person = (r) => (r ? { id: r.id, name: r.name, role: r.role } : null);

/** The screen's data: the lead times in use, where they come from, the defaults, the limits and the change history (newest first). */
async function getExpirySettings({ historyLimit = 20 } = {}) {
  const rows = await prisma.systemSetting.findMany({ where: { key: KEY }, orderBy: { id: 'desc' }, take: historyLimit, include: { changedBy: true } });
  const current = rows[0] ?? null;
  const config = await getExpiryAlertConfig();
  return {
    enabled: config.enabled,
    expiryAlertDays: config.expiryAlertDays,
    source: current ? 'saved' : 'default',
    defaults: [...EXPIRY_ALERT_CONFIG.expiryAlertDays],
    limits: { ...LIMITS },
    rules: ['1 to 8 lead times', 'each a whole number of days above zero', 'no duplicates', 'listed from largest to smallest'],
    updatedAt: current?.createdAt ?? null,
    updatedBy: person(current?.changedBy),
    reason: current?.reason ?? null,
    history: rows.map((r) => ({ id: r.id, expiryAlertDays: r.value, changedBy: person(r.changedBy), reason: r.reason, changedAt: r.createdAt })),
    appliesNextDetectionRun: true,
  };
}

/**
 * Saves new lead times. Validated here and again by the database. An unchanged list is refused rather than saved again.
 * @param {number[]} input
 * @param {{ id: number, role: string }} actor   the Reviewer / Admin making the change (checked by requireReviewer)
 * @param {string} [reason]
 */
async function updateExpiryAlertDays(input, actor, reason) {
  const check = validateExpiryAlertDays(input);
  if (!check.ok) throw badRequest('The lead times are not valid', { expiryAlertDays: check.problems.join(' ') });
  const note = typeof reason === 'string' ? reason.trim() : '';
  if (note.length > 500) throw badRequest('The reason is too long', { reason: 'Use at most 500 characters.' });

  await prisma.$transaction(async (tx) => {
    const previous = await getExpiryAlertConfig(tx);
    if (JSON.stringify(previous.expiryAlertDays) === JSON.stringify(check.days)) {
      throw badRequest('Nothing to change: these are already the lead times in use', { expiryAlertDays: 'These lead times are already in use.' });
    }
    const row = await tx.systemSetting.create({ data: { key: KEY, value: check.days, changedById: actor.id, reason: note || null } });
    await audit.record(tx, {
      actionType: 'SETTING_CHANGED',
      entityType: 'Setting',
      entityId: row.id,
      entityRef: KEY,
      previousValues: { expiryAlertDays: previous.expiryAlertDays },
      newValues: { expiryAlertDays: check.days },
      reason: note || 'Document-expiry alert lead times changed',
      actor,
    });
  });
  return getExpirySettings();
}

module.exports = { KEY, getExpiryAlertConfig, getExpirySettings, updateExpiryAlertDays };
