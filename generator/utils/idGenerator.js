/**
 * Deterministic business IDs. Nothing here is random: a code depends only on the entity's position in the generated sequence,
 * its parent's code and its year.
 *
 *   Customer        CUS-000001            Document   DOC-CUS-000001-001 (counter per customer)
 *   KYC requirement KYC-2026-000001       Review     REV-CUS-000001-2026 (-02, -03 for the customer's later cases in a year)
 *   Alert           ALT-2026-000001       (also the older codes: CASE-, ALT-, EXC-, RSK-, AUD-)
 */
const pad = (n, width) => String(n).padStart(width, '0');

const customerCode = (n) => `CUS-${pad(n, 6)}`;
const requirementCode = (year, n) => `KYC-${year}-${pad(n, 6)}`;
const documentCode = (customer, n) => `DOC-${customer}-${pad(n, 3)}`;
const reviewCode = (customer, year, n = 1) => `REV-${customer}-${year}${n > 1 ? `-${pad(n, 2)}` : ''}`;
const alertBusinessId = (year, n) => `ALT-${year}-${pad(n, 6)}`;
const alertLegacyCode = (n) => `ALT-${pad(n, 6)}`;
const caseCode = (n) => `CASE-${pad(n, 6)}`;
const exceptionCode = (n) => `EXC-${pad(n, 6)}`;
const riskCode = (n) => `RSK-${pad(n, 6)}`;
const auditCode = (n) => `AUD-${pad(n, 6)}`;

const FORMATS = {
  customer: /^CUS-\d{6,}$/,
  requirement: /^KYC-\d{4}-\d{6,}$/,
  document: /^DOC-CUS-\d{6,}-\d{3,}$/,
  review: /^REV-CUS-\d{6,}-\d{4}(-\d{2,})?$/,
  alert: /^ALT-\d{4}-\d{6,}$/,
};

/** Counters per (scope, period): the same numbering the database trigger uses, so generated and application-created IDs continue one series. */
class ScopedCounter {
  constructor() {
    this.values = new Map();
  }

  next(scope, period = 0) {
    const key = `${scope}\u0000${period}`;
    const value = (this.values.get(key) ?? 0) + 1;
    this.values.set(key, value);
    return value;
  }

  /** Rows for the IdCounter table, so the application carries on after the generated data. */
  rows() {
    return [...this.values.entries()].map(([key, lastValue]) => {
      const [scope, period] = key.split('\u0000');
      return { scope, period: Number(period), lastValue };
    });
  }
}

module.exports = { pad, customerCode, requirementCode, documentCode, reviewCode, alertBusinessId, alertLegacyCode, caseCode, exceptionCode, riskCode, auditCode, FORMATS, ScopedCounter };
