/**
 * Date-only helpers. Document and requirement dates are calendar dates (YYYY-MM-DD),
 * compared as UTC dates so the result does not depend on the server's time zone.
 */
const MS_PER_DAY = 86_400_000;

/** Today as YYYY-MM-DD (UTC). */
const todayIso = (now = new Date()) => now.toISOString().slice(0, 10);

/** Accepts a Date or "YYYY-MM-DD..." string and returns "YYYY-MM-DD" (or null). */
function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

/** "YYYY-MM-DD" -> Date at UTC midnight, or null if not a real calendar date. */
function parseIso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return date;
}

/** Whole days from `fromIso` to `toIsoDate` (positive when the second date is later). */
function daysBetween(fromIso, toIsoDate) {
  return Math.round((parseIso(toIsoDate) - parseIso(fromIso)) / MS_PER_DAY);
}

function addDays(iso, days) {
  return new Date(parseIso(iso).getTime() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** Adds calendar months, keeping the day where possible (31 Jan + 1 month = 28/29 Feb). */
function addMonths(iso, months) {
  const d = parseIso(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

module.exports = { todayIso, toIso, parseIso, daysBetween, addDays, addMonths };
