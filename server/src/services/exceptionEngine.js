/**
 * Exception detection engine (pure functions: no database, no clock - `asOf` is passed in).
 *
 * It turns REAL records (the outcome of Scene 2's document evaluation, Scene 3's ownership and risk analysis,
 * and the periodic review schedule) into a list of CONDITIONS. Nothing here is random: a condition exists only
 * when the underlying records show it.
 *
 * Each condition has a stable dedupe KEY (customer | type | source type | source id). The service uses the key to
 *   - create an exception only when no ACTIVE exception with that key exists (no duplicates),
 *   - resolve an active exception whose key is no longer detected (the condition cleared).
 *
 * Safeguards: a POTENTIAL sanctions or PEP match is described as "needs investigation" and never as confirmed.
 */
const { EXCEPTION_TYPES, SEVERITY_RULES, PERIODIC_REVIEW } = require('../config/reviewRules');
const { daysBetween, toIso } = require('../utils/dates');
const { EXPIRY_ALERT_CONFIG, leadTimeFor } = require('../config/expiryRules');

const keyOf = (customerId, type, sourceType, sourceId) => `${customerId}|${type}|${sourceType}|${sourceId ?? '-'}`;

/** Raises a severity by one step when the customer is High risk. */
const bump = (severity, customerRisk) => {
  if (customerRisk !== 'High') return severity;
  return { Low: 'Medium', Medium: 'High', High: 'High', Critical: 'Critical' }[severity];
};

function make(customer, type, severity, description, sourceType, sourceId) {
  return { key: keyOf(customer.id, type, sourceType, sourceId), type, severity, description, sourceType, sourceId: sourceId ?? null };
}

/** Document-related conditions from Scene 2's evaluation result. */
function documentConditions(customer, kyc, config = EXPIRY_ALERT_CONFIG) {
  const out = [];
  if (!kyc) return out;
  const requirementIdByType = Object.fromEntries(kyc.requirements.map((r) => [r.documentType, r.requirementId]));

  for (const e of kyc.exceptions) {
    const doc = e.document;
    const t = e.documentType;
    switch (e.type) {
      case 'MISSING_DOCUMENT':
        out.push(make(customer, 'MANDATORY_DOCUMENT_MISSING', bump('Medium', customer.riskLevel), `Mandatory document "${t}" has not been submitted.`, 'KYCRequirement', requirementIdByType[t]));
        break;
      case 'EXPIRED': {
        const days = Math.abs(doc.daysToExpiry);
        const wasVerified = doc.status === 'Verified' ? ', although a reviewer had verified it' : '';
        out.push(make(customer, 'DOCUMENT_EXPIRED', e.isMandatory ? 'High' : 'Medium', `${t} expired on ${doc.expiryDate} (${days} day${days === 1 ? '' : 's'} ago)${wasVerified}. It no longer counts as valid.`, 'Document', doc.id));
        break;
      }
      case 'EXPIRING_SOON': {
        const severity = doc.daysToExpiry <= SEVERITY_RULES.expiringSoonDaysToMedium ? 'Medium' : 'Low';
        out.push({ ...make(customer, 'DOCUMENT_EXPIRING_SOON', severity, `${t} expires on ${doc.expiryDate} (in ${doc.daysToExpiry} day${doc.daysToExpiry === 1 ? '' : 's'}).`, 'Document', doc.id), threshold: leadTimeFor(doc.daysToExpiry, config) });
        break;
      }
      case 'REJECTED':
        out.push(make(customer, 'DOCUMENT_REJECTED', e.isMandatory ? bump('Medium', customer.riskLevel) : 'Low', `${t} was rejected by a reviewer and has not been replaced.`, 'Document', doc.id));
        break;
      case 'PENDING_VERIFICATION': {
        const waiting = Math.max(0, daysBetween(doc.submissionDate, kyc.asOf));
        const severity = waiting > SEVERITY_RULES.awaitingVerificationDaysToMedium ? 'Medium' : 'Low';
        out.push(make(customer, 'DOCUMENT_AWAITING_VERIFICATION', severity, `${t} was submitted on ${doc.submissionDate} and has been waiting for verification for ${waiting} day${waiting === 1 ? '' : 's'}.`, 'Document', doc.id));
        break;
      }
      case 'REQUIRES_RESUBMISSION':
        if (e.isMandatory) {
          out.push(make(customer, 'DOCUMENT_REQUIRES_RESUBMISSION', bump('Medium', customer.riskLevel), `Mandatory document "${t}" must be resubmitted: a reviewer asked for a new copy.`, 'Document', doc.id));
        }
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Expiry lead-time conditions BEYOND the 30-day "expiring soon" window (for example 31-90 days with the default [90, 60, 30, 7]).
 * They only raise an ALERT (alertOnly): no exception is created, so the Exceptions list does not fill up months before expiry.
 * Same key as the document's exception, so the alert and the exception stay linked once the document is inside 30 days.
 */
function expiryLeadConditions(customer, kyc, config = EXPIRY_ALERT_CONFIG) {
  const out = [];
  if (!kyc || !config.enabled) return out;
  const docs = [...kyc.requirements.map((r) => r.document), ...kyc.extraDocuments].filter(Boolean);
  const seen = new Set();
  for (const doc of docs) {
    if (seen.has(doc.id) || doc.effectiveStatus !== 'Verified' || doc.expiryState === 'Expired' || doc.daysToExpiry === null) continue;
    seen.add(doc.id);
    if (doc.expiryState === 'Expiring Soon') continue; // already covered by the exception condition (30 days or less)
    const threshold = leadTimeFor(doc.daysToExpiry, config);
    if (threshold === null) continue;
    out.push({
      ...make(customer, 'DOCUMENT_EXPIRING_SOON', 'Low', `${doc.documentType} expires on ${doc.expiryDate} (in ${doc.daysToExpiry} days).`, 'Document', doc.id),
      threshold,
      alertOnly: true,
    });
  }
  return out;
}

/** Ownership-related conditions (company customers only). */
function ownershipConditions(customer, ownership) {
  const out = [];
  if (!ownership || customer.customerType !== 'Company') return out;
  const { validation, complexity } = ownership;

  if (validation.status === 'NO_OWNERS') {
    out.push(make(customer, 'OWNERSHIP_NO_OWNERS', bump('Medium', customer.riskLevel), 'The company has no beneficial owners recorded.', 'Customer', customer.id));
  } else if (validation.status === 'EXCEEDS_100') {
    out.push(make(customer, 'OWNERSHIP_EXCEEDS_100', 'High', `${validation.message}`, 'Customer', customer.id));
  } else if (validation.status === 'BELOW_100' || validation.status === 'MISSING_PERCENTAGE') {
    out.push(make(customer, 'OWNERSHIP_INCOMPLETE', 'Medium', `${validation.message}`, 'Customer', customer.id));
  }

  const parts = [];
  if (complexity.isComplex) parts.push(`complex structure (${complexity.reasons.join('; ')})`);
  const duplicates = validation.issues.filter((i) => i.code === 'POSSIBLE_DUPLICATE_OWNER');
  duplicates.forEach((d) => parts.push(d.message.replace(/\.$/, '')));
  if (parts.length > 0) {
    out.push(make(customer, 'OWNERSHIP_REQUIRES_INVESTIGATION', 'Medium', `Ownership structure needs investigation: ${parts.join('; ')}.`, 'Customer', customer.id));
  }
  return out;
}

/** Risk-related conditions from the newest risk assessment and the owner screenings. */
function riskConditions(customer, rating, ownership) {
  const out = [];
  if (rating) {
    if (rating.riskLevel === 'High') {
      out.push(make(customer, 'HIGH_RISK_CUSTOMER', 'High', `The customer is rated High risk (score ${rating.riskScore}, ${rating.code}).`, 'Customer', customer.id));
    }
    if (rating.status === 'Requires Manual Review') {
      out.push(make(customer, 'RISK_MANUAL_REVIEW_REQUIRED', 'High', `Risk assessment ${rating.code} requires manual review. A review is not a rejection.`, 'Customer', customer.id));
    }
    if (rating.screening?.pep?.potentialMatch) {
      out.push(make(customer, 'POTENTIAL_PEP_MATCH', 'High', 'The customer name produced a potential PEP match in the simulated screening. It needs review and is not confirmed.', 'Customer', customer.id));
    }
    if (rating.screening?.sanctions?.potentialMatch) {
      out.push(make(customer, 'POTENTIAL_SANCTIONS_MATCH', 'Critical', 'The customer name produced a potential sanctions match in the simulated screening. It must be investigated and is not a confirmed match.', 'Customer', customer.id));
    }
  }

  for (const o of ownership?.entries ?? []) {
    const pep = o.latest?.PEP?.result;
    const sanctions = o.latest?.Sanctions?.result;
    if (pep === 'Potential Match') {
      out.push(make(customer, 'POTENTIAL_PEP_MATCH', 'High', `Beneficial owner ${o.row.fullName} has a potential PEP match. It needs review and is not a confirmed PEP.`, 'BeneficialOwner', o.row.id));
    }
    if (sanctions === 'Potential Match') {
      out.push(make(customer, 'POTENTIAL_SANCTIONS_MATCH', 'Critical', `Beneficial owner ${o.row.fullName} has a potential sanctions match. It must be investigated and is NOT a confirmed match.`, 'BeneficialOwner', o.row.id));
    }
    if (sanctions === 'Confirmed') {
      out.push(make(customer, 'CONFIRMED_SANCTIONS_MATCH', 'Critical', `A sanctions match is recorded as confirmed for beneficial owner ${o.row.fullName}. Escalate according to policy. The customer is not rejected automatically.`, 'BeneficialOwner', o.row.id));
    }
  }
  return out;
}

/** Review-related conditions: periodic review overdue / approaching, and earlier reviews closed without resolution. */
function reviewConditions(customer, schedule, unresolvedClosedCases, asOf) {
  const out = [];
  if (schedule) {
    const next = toIso(schedule.nextReviewDate);
    const days = daysBetween(asOf, next);
    if (days < 0) {
      const overdue = Math.abs(days);
      const severity = overdue > SEVERITY_RULES.periodicOverdueDaysToCritical ? 'Critical' : overdue > SEVERITY_RULES.periodicOverdueDaysToHigh ? 'High' : 'Medium';
      out.push(make(customer, 'PERIODIC_REVIEW_OVERDUE', severity, `The periodic KYC review was due on ${next} and is ${overdue} day${overdue === 1 ? '' : 's'} overdue.`, 'ReviewSchedule', schedule.id));
    } else if (days <= PERIODIC_REVIEW.upcomingDays) {
      out.push(make(customer, 'PERIODIC_REVIEW_DUE_SOON', 'Low', `The periodic KYC review is due on ${next} (in ${days} day${days === 1 ? '' : 's'}).`, 'ReviewSchedule', schedule.id));
    }
  }
  for (const c of unresolvedClosedCases) {
    const severity = ['High', 'Critical'].includes(c.exceptionSeverity) ? 'High' : 'Medium';
    out.push(make(customer, 'PREVIOUS_REVIEW_UNRESOLVED', severity, `Case ${c.caseCode} was closed, but its exception ${c.exceptionCode} (${EXCEPTION_TYPES[c.exceptionType]?.label ?? c.exceptionType}) is still active and no new case is open.`, 'ReviewCase', c.caseId));
  }
  return out;
}

/**
 * All conditions for one customer.
 * @param {object} input see the file header of exceptionService.js for how the pieces are loaded
 */
function detectConditions({ customer, kyc, ownership, rating, schedule, unresolvedClosedCases = [], asOf, expiryConfig = EXPIRY_ALERT_CONFIG }) {
  return [
    ...documentConditions(customer, kyc, expiryConfig),
    ...expiryLeadConditions(customer, kyc, expiryConfig),
    ...ownershipConditions(customer, ownership),
    ...riskConditions(customer, rating, ownership),
    ...reviewConditions(customer, schedule, unresolvedClosedCases, asOf),
  ];
}

module.exports = { detectConditions, expiryLeadConditions, keyOf, documentConditions, ownershipConditions, riskConditions, reviewConditions };
