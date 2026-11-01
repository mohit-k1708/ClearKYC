/**
 * Document expiry alert lead times (documented in documentation/expiry_configuration.md).
 *
 * A VERIFIED, still-valid document raises an expiry alert for the tightest lead time it has reached: with the default list
 * [90, 60, 30, 7], a document 45 days from expiry is in the 60-day window, one 20 days away is in the 30-day window, one
 * 5 days away is in the 7-day window. Each (document, expiry date, lead time) is alerted ONCE; moving to a closer window
 * closes the earlier alert (history is kept). An EXPIRED document is separate (it raises the "document expired" alert).
 *
 * These are the DEFAULTS. Reviewers and admins can save other lead times on the Expiry alert settings screen (services/settingsService.js):
 * detection uses the newest saved value and falls back to this file when nothing has been saved. `enabled: false` switches lead-time
 * alerts off.
 *
 * Note: the "Expiring Soon" state shown on screens and used by the document filters stays 30 days (config/kycRules.js).
 */
const EXPIRY_ALERT_CONFIG = {
  enabled: true,
  expiryAlertDays: [90, 60, 30, 7],
};

/** The tightest configured lead time a document `daysToExpiry` days from expiry has reached, or null when it has not reached any. */
function leadTimeFor(daysToExpiry, config = EXPIRY_ALERT_CONFIG) {
  if (!config.enabled || daysToExpiry === null || daysToExpiry < 0) return null;
  const sorted = [...config.expiryAlertDays].sort((a, b) => a - b);
  return sorted.find((d) => daysToExpiry <= d) ?? null;
}

const maxLeadTime = (config = EXPIRY_ALERT_CONFIG) => (config.enabled ? Math.max(...config.expiryAlertDays) : 0);

/** Limits of a configuration: how many lead times, and how far ahead (days). The database CHECK uses the same numbers. */
const LIMITS = { minCount: 1, maxCount: 8, maxDays: 3650 };

/**
 * Validates lead times typed by a person. Rules: 1 to 8 whole numbers, each above zero (and at most 3650), no duplicates, and listed
 * from largest to smallest. A list that breaks the order is rejected, never silently re-sorted, so what is saved is what the person saw.
 * @returns {{ ok: boolean, days: number[], problems: string[] }}
 */
function validateExpiryAlertDays(input) {
  if (!Array.isArray(input)) return { ok: false, days: [], problems: ['Give the lead times as a list of numbers, for example [90, 60, 30, 7].'] };
  const problems = [];
  if (input.length < LIMITS.minCount) problems.push('Add at least one lead time.');
  if (input.length > LIMITS.maxCount) problems.push(`Use at most ${LIMITS.maxCount} lead times.`);
  const days = [];
  input.forEach((raw, i) => {
    const n = typeof raw === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(raw) ? Number(raw) : raw;
    if (typeof n !== 'number' || !Number.isFinite(n)) problems.push(`Lead time ${i + 1} must be a number.`);
    else if (!Number.isInteger(n)) problems.push(`Lead time ${i + 1} (${n}) must be a whole number of days.`);
    else if (n <= 0) problems.push(`Lead time ${i + 1} (${n}) must be greater than zero.`);
    else if (n > LIMITS.maxDays) problems.push(`Lead time ${i + 1} (${n}) must be at most ${LIMITS.maxDays} days.`);
    else days.push(n);
  });
  if (days.length === input.length) {
    const seen = new Set();
    for (const d of days) {
      if (seen.has(d)) problems.push(`${d} appears more than once: each lead time must be different.`);
      seen.add(d);
    }
    for (let i = 1; i < days.length; i += 1) {
      if (days[i] > days[i - 1]) problems.push(`The lead times must go from largest to smallest: ${days[i]} comes after ${days[i - 1]}.`);
    }
  }
  const unique = [...new Set(problems)];
  return { ok: unique.length === 0, days: unique.length === 0 ? days : [], problems: unique };
}

module.exports = { EXPIRY_ALERT_CONFIG, LIMITS, leadTimeFor, maxLeadTime, validateExpiryAlertDays };
