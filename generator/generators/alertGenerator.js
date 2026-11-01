/**
 * Alerts (Task 12), derived from the same conditions as the exceptions.
 *
 *  - Active alerts: the application's alert engine is run on every customer's conditions at the reference date, so an active
 *    alert exists only while its condition exists, and there is never more than one active alert per condition.
 *  - Expiry alerts use the configured lead times (90 / 60 / 30 / 7 days, config/expiryRules.js): ONE alert per document per
 *    threshold. When a document moves to a closer threshold the earlier alert is resolved ("Condition cleared"), so only the
 *    closest threshold is active. The earlier ones are kept as history, dated by the day the document reached that threshold.
 *  - Closed alerts also exist for conditions that cleared in the past (a replaced expired document, a late periodic review).
 */
const { addDays } = require('../../server/src/utils/dates');
const { deriveAlerts } = require('../../server/src/services/alertEngine');
const { ALERT_TYPE_FOR_CONDITION, ALERT_TYPES } = require('../../server/src/config/alertRules');
const { EXPIRY_ALERT_CONFIG } = require('../../server/src/config/expiryRules');
const { alertLegacyCode, alertBusinessId } = require('../utils/idGenerator');

const HOUR = 3_600_000;
const MIN = 60_000;

function generateAlerts(cfg, rng, input) {
  const { contexts, conditionsByCustomer, activeByKey, exceptions, documents, customers, people, counters } = input;
  const r = rng.fork('alerts');
  const ref = cfg.referenceDate;
  const refEnd = Date.parse(`${ref}T23:59:59.000Z`);
  const cap = (ms) => Math.min(ms, refEnd);
  const dayStart = (iso) => Date.parse(`${iso}T00:00:00.000Z`);
  const docById = new Map(documents.map((d) => [d.id, d]));
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const thresholds = [...EXPIRY_ALERT_CONFIG.expiryAlertDays].sort((a, b) => b - a); // 90, 60, 30, 7
  const alerts = [];

  const verifiedAt = (doc) => doc.steps.filter((s) => s.status === 'Verified').pop().when.getTime();
  const crossing = (doc, th) => dayStart(addDays(doc.expiryIso, -th)) + 2 * HOUR + r.int(0, 120) * MIN;

  const base = (customerId, a) => ({
    customerId, alertType: a.alertType, title: a.title, description: a.description, severity: a.severity, relatedEntityType: a.relatedEntityType, relatedEntityId: a.relatedEntityId,
    exceptionId: null, dedupeKey: a.key, threshold: a.threshold ?? null, dueDate: a.dueDate ? new Date(`${a.dueDate}T00:00:00.000Z`) : null,
    acknowledgedById: null, acknowledgedAt: null, resolvedById: null, resolvedAt: null, resolutionType: null, resolutionNotes: null, suppressRegeneration: false,
  });
  const clearedNote = (ms) => `The underlying records no longer show this condition (checked ${new Date(ms).toISOString().slice(0, 10)}).`;

  // earlier lead-time alerts of one document, closed when the next threshold was reached (or the document expired)
  const leadHistory = (doc, customer, currentThreshold, endMs, currentCreatedMs) => {
    const verified = verifiedAt(doc);
    const verifiedDay = dayStart(new Date(verified).toISOString().slice(0, 10));
    const chain = thresholds.filter((th) => (currentThreshold === null || th > currentThreshold) && dayStart(addDays(doc.expiryIso, -th)) >= verifiedDay);
    const times = chain.map((th) => cap(Math.max(crossing(doc, th), verified + HOUR))); // the day the document reached that lead time
    return chain.map((th, i) => {
      const nextMs = i + 1 < chain.length ? times[i + 1] : currentCreatedMs ?? endMs;
      return { th, createdMs: times[i], resolvedMs: cap(Math.max(nextMs, times[i] + MIN)), days: th, key: `${keyBase(doc, customer)}|T${th}` };
    });
  };
  const keyBase = (doc, customer) => `${customer.id}|DOCUMENT_EXPIRING_SOON|Document|${doc.id}`;
  const label = ALERT_TYPES.DOCUMENT_EXPIRY.label.replace(/ Alert$/, '');

  const pushLeadHistory = (doc, customer, currentThreshold, endMs, currentCreatedMs) => {
    for (const h of leadHistory(doc, customer, currentThreshold, endMs, currentCreatedMs)) {
      alerts.push({
        ...base(customer.id, {
          alertType: 'DOCUMENT_EXPIRY', title: `${label} (${h.th}-day notice): ${customer.fullName}`.slice(0, 150),
          description: `${doc.documentType} expires on ${doc.expiryIso} (in ${h.days} days).`, severity: h.th <= 7 ? 'Medium' : 'Low', relatedEntityType: 'Document', relatedEntityId: doc.id,
          key: h.key, threshold: h.th, dueDate: doc.expiryIso,
        }),
        status: 'Resolved', createdAt: new Date(h.createdMs), updatedAt: new Date(h.resolvedMs), resolvedAt: new Date(h.resolvedMs), resolutionType: 'Condition cleared', resolutionNotes: clearedNote(h.resolvedMs),
        historical: true,
      });
    }
  };

  // ---- active alerts ---------------------------------------------------------------------------------------------------
  for (const c of customers) {
    const ctx = contexts.get(c.id);
    for (const a of deriveAlerts(ctx, conditionsByCustomer.get(c.id))) {
      const exception = activeByKey.get(a.conditionKey) ?? null;
      let createdMs;
      let doc = null;
      if (a.threshold) {
        doc = docById.get(a.relatedEntityId);
        createdMs = Math.max(verifiedAt(doc) + HOUR, crossing(doc, a.threshold));
      } else {
        createdMs = (exception ? exception.detectedAt.getTime() : c.onboardedAt.getTime()) + MIN;
      }
      createdMs = cap(Math.max(createdMs, c.onboardedAt.getTime() + MIN));
      const row = { ...base(c.id, a), exceptionId: exception ? exception.id : null, status: 'New', createdAt: new Date(createdMs), updatedAt: new Date(createdMs), historical: false };

      const roll = r.next();
      const room = refEnd - createdMs;
      if (room > 6 * HOUR && roll < cfg.ratios.alertAcknowledgedRate + cfg.ratios.alertInProgressRate) {
        const ackMs = cap(createdMs + r.int(60, 72 * 60) * MIN);
        row.status = roll < cfg.ratios.alertAcknowledgedRate ? 'Acknowledged' : 'In Progress';
        row.acknowledgedById = r.pick([...people.analysts, ...people.reviewers]);
        row.acknowledgedAt = new Date(ackMs);
        row.updatedAt = new Date(row.status === 'In Progress' ? cap(ackMs + r.int(30, 24 * 60) * MIN) : ackMs);
      }
      alerts.push(row);
      if (doc) pushLeadHistory(doc, c, a.threshold, createdMs, createdMs);
    }
  }

  // expired documents: the lead-time alerts they raised on the way, all closed when the document expired
  for (const doc of documents) {
    if (doc.outcome !== 'expired' || doc.isReplaced || doc.steps[doc.steps.length - 1].status !== 'Verified') continue;
    const c = customerById.get(doc.customerId);
    const expiredMs = cap(dayStart(addDays(doc.expiryIso, 1)) + 2 * HOUR);
    pushLeadHistory(doc, c, null, expiredMs, null);
  }

  // conditions that cleared in the past
  for (const e of exceptions) {
    if (!e.historical) continue;
    const alertType = ALERT_TYPE_FOR_CONDITION[e.exceptionType];
    if (!alertType) continue;
    const c = customerById.get(e.customerId);
    const typeLabel = ALERT_TYPES[alertType].label.replace(/ Alert$/, '');
    alerts.push({
      ...base(c.id, {
        alertType, title: `${typeLabel}: ${c.fullName}`.slice(0, 150), description: e.description, severity: e.severity, relatedEntityType: e.sourceEntityType, relatedEntityId: e.sourceEntityId, key: e.dedupeKey,
      }),
      exceptionId: e.id, status: 'Resolved', createdAt: new Date(e.detectedAt.getTime() + MIN), updatedAt: e.resolvedAt, resolvedAt: e.resolvedAt, resolutionType: 'Condition cleared', resolutionNotes: clearedNote(e.resolvedAt.getTime()),
      historical: true,
    });
  }

  // ---- numbering: by creation time ---------------------------------------------------------------------------------------
  alerts.sort((a, b) => a.createdAt - b.createdAt || a.customerId - b.customerId || a.dedupeKey.localeCompare(b.dedupeKey));
  alerts.forEach((a, i) => {
    a.id = i + 1;
    a.alertCode = alertLegacyCode(i + 1);
    const year = a.createdAt.getUTCFullYear();
    a.businessId = alertBusinessId(year, counters.next('ALT', year));
  });

  const byStatus = {};
  for (const a of alerts) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  const byThreshold = {};
  for (const a of alerts) if (a.threshold) byThreshold[a.threshold] = (byThreshold[a.threshold] || 0) + 1;
  return { alerts, stats: { alerts: alerts.length, byStatus, byThreshold, active: alerts.filter((a) => !['Resolved', 'Dismissed'].includes(a.status)).length } };
}

module.exports = { generateAlerts };
