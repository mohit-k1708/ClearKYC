/**
 * Alert engine (pure functions: no database, no clock).
 *
 * Alerts are NOT invented. They are derived from the CONDITIONS the exception engine already found in real records, so
 * an alert exists only while (or because) the underlying issue exists, and it carries the same dedupe key:
 * "customer | type | source type | source id". The service creates one active alert per key and resolves the alert when
 * the key is no longer detected.
 *
 * Wording safeguard: a potential PEP / sanctions match is described as "potential" and "needs investigation", exactly as
 * the condition describes it. It is never confirmed here and never dismissed automatically.
 */
const { ALERT_TYPES, ALERT_TYPE_FOR_CONDITION } = require('../config/alertRules');
const { EXCEPTION_TYPES } = require('../config/reviewRules');
const { toIso } = require('../utils/dates');

/** Due date of the alert: the document's expiry date, or the periodic review date. Other alerts have none. */
function dueDateFor(condition, ctx) {
  if (condition.sourceType === 'Document' && ctx.kyc) {
    const docs = [...ctx.kyc.requirements.map((r) => r.document), ...ctx.kyc.extraDocuments].filter(Boolean);
    const doc = docs.find((d) => d.id === condition.sourceId);
    return doc?.expiryDate ?? null;
  }
  if (condition.sourceType === 'ReviewSchedule' && ctx.schedule && ctx.schedule.id === condition.sourceId) return toIso(ctx.schedule.nextReviewDate);
  return null;
}

/**
 * @param {object} ctx         one customer's context from exceptionService.loadContexts
 * @param {object[]} conditions the conditions detected for that customer
 * @returns {object[]} alerts that should exist, keyed by the condition key
 */
function deriveAlerts(ctx, conditions) {
  const out = [];
  for (const c of conditions) {
    const alertType = ALERT_TYPE_FOR_CONDITION[c.type];
    if (!alertType) continue; // not every exception raises an alert
    const label = ALERT_TYPES[alertType].label.replace(/ Alert$/, '');
    out.push({
      key: c.threshold ? `${c.key}|T${c.threshold}` : c.key, // expiry alerts: one per lead time
      conditionKey: c.key, // the exception's key (without the lead time)
      threshold: c.threshold ?? null,
      alertType,
      title: `${label}${c.threshold ? ` (${c.threshold}-day notice)` : ''}: ${ctx.customer.name}`.slice(0, 150),
      description: c.description,
      severity: c.severity,
      relatedEntityType: c.sourceType,
      relatedEntityId: c.sourceId,
      dueDate: dueDateFor(c, ctx),
      conditionType: c.type,
      conditionLabel: EXCEPTION_TYPES[c.type]?.label ?? c.type,
    });
  }
  return out;
}

module.exports = { deriveAlerts, dueDateFor };
