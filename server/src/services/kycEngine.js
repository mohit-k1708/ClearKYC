/**
 * KYC rule engine (pure functions - no database, no clock: `asOf` is always passed in).
 *
 * Every important business decision about documents is made here, on the server:
 *   - is a document expired / expiring soon / valid?
 *   - is a requirement Verified, Pending, Rejected, Missing ...?
 *   - what is the customer's KYC completeness percentage?
 *
 * Key rules
 *   1. Uploading or submitting a document does NOT make it valid. Only a Verified decision does.
 *   2. A document whose expiry date is before `asOf` is Expired, even if its verification says
 *      Verified. It never counts as a currently valid verified requirement.
 *   3. A document expiring on `asOf` itself is still valid (expired means expiryDate < asOf).
 *   4. For each document type the customer's BEST document decides the state of that requirement
 *      (Verified > Pending/In Review > Requires Resubmission > Rejected > Expired > Missing).
 *      Older rejected/expired copies that were replaced by a better one are history, not exceptions.
 *   5. completeness % = verified mandatory requirements / total mandatory requirements x 100.
 *
 * Verification here is a SIMULATED MANUAL REVIEW. It is not a government or identity-provider check.
 */
const { EXPIRY_WARNING_DAYS } = require('../config/kycRules');
const { toIso, daysBetween } = require('../utils/dates');

const EXPIRY = { NONE: 'No Expiry', VALID: 'Valid', SOON: 'Expiring Soon', EXPIRED: 'Expired' };

// Requirement-level states
const STATE = {
  VERIFIED: 'Verified',
  PENDING: 'Pending Verification',
  RESUBMIT: 'Requires Resubmission',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  MISSING: 'Missing',
};

// Exception types reported by GET /api/kyc/exceptions
const EXCEPTION = {
  MISSING: 'MISSING_DOCUMENT',
  PENDING: 'PENDING_VERIFICATION',
  REJECTED: 'REJECTED',
  RESUBMIT: 'REQUIRES_RESUBMISSION',
  EXPIRED: 'EXPIRED',
  EXPIRING: 'EXPIRING_SOON',
};
const EXCEPTION_ORDER = [EXCEPTION.MISSING, EXCEPTION.EXPIRED, EXCEPTION.REJECTED, EXCEPTION.RESUBMIT, EXCEPTION.PENDING, EXCEPTION.EXPIRING];

/** Expiry state of a document on `asOf` (YYYY-MM-DD). */
function expiryInfo(expiryDate, asOf, warningDays = EXPIRY_WARNING_DAYS) {
  const expiry = toIso(expiryDate);
  if (!expiry) return { expiryState: EXPIRY.NONE, daysToExpiry: null };
  const daysToExpiry = daysBetween(asOf, expiry);
  if (daysToExpiry < 0) return { expiryState: EXPIRY.EXPIRED, daysToExpiry };
  if (daysToExpiry <= warningDays) return { expiryState: EXPIRY.SOON, daysToExpiry };
  return { expiryState: EXPIRY.VALID, daysToExpiry };
}

/** Verification status, overridden by "Expired" once the expiry date has passed. */
function effectiveStatus(doc, asOf) {
  return expiryInfo(doc.expiryDate, asOf).expiryState === EXPIRY.EXPIRED ? 'Expired' : doc.status;
}

/** True only for a document that is Verified AND not past its expiry date. */
function isCurrentlyValid(doc, asOf) {
  return doc.status === 'Verified' && effectiveStatus(doc, asOf) === 'Verified';
}

const RANK = { Verified: 0, Pending: 1, 'In Review': 1, 'Requires Resubmission': 2, Rejected: 3, Expired: 4 };
const STATE_FOR_EFFECTIVE = {
  Verified: STATE.VERIFIED,
  Pending: STATE.PENDING,
  'In Review': STATE.PENDING,
  'Requires Resubmission': STATE.RESUBMIT,
  Rejected: STATE.REJECTED,
  Expired: STATE.EXPIRED,
};

/** The best document of one type: lowest rank, then newest submission, then highest id. */
function pickPrimary(docs, asOf) {
  return [...docs].sort((a, b) => {
    const byRank = RANK[effectiveStatus(a, asOf)] - RANK[effectiveStatus(b, asOf)];
    if (byRank !== 0) return byRank;
    const bySubmission = String(toIso(b.submissionDate)).localeCompare(String(toIso(a.submissionDate)));
    return bySubmission !== 0 ? bySubmission : b.id - a.id;
  })[0];
}

/** A requirement applies when it is active and `asOf` is inside its effective window. */
function isRequirementCurrent(req, asOf) {
  if (!req.isActive) return false;
  const from = toIso(req.effectiveFrom);
  const to = toIso(req.effectiveTo);
  return from <= asOf && (!to || to >= asOf);
}

function docSummary(doc, asOf) {
  const { expiryState, daysToExpiry } = expiryInfo(doc.expiryDate, asOf);
  return {
    id: doc.id,
    documentType: doc.documentType,
    status: doc.status,
    effectiveStatus: effectiveStatus(doc, asOf),
    submissionDate: toIso(doc.submissionDate),
    expiryDate: toIso(doc.expiryDate),
    expiryState,
    daysToExpiry,
  };
}

/**
 * Evaluates one customer.
 * @param {object}   input
 * @param {string}   input.customerType  'Individual' | 'Company'
 * @param {string}   input.riskLevel     current risk level from Scene 1
 * @param {object[]} input.requirements  ALL requirement rows ({ customerType, riskLevel, documentType, isMandatory, isActive, effectiveFrom, effectiveTo, id })
 * @param {object[]} input.documents     this customer's documents ({ id, documentType, status, expiryDate, submissionDate })
 * @param {string}   input.asOf          YYYY-MM-DD
 */
function evaluateCustomerKyc({ customerType, riskLevel, requirements, documents, asOf }) {
  // Requirements for this customer type + risk level, current today. One entry per document type
  // (if rules overlap, a mandatory entry wins).
  const byType = new Map();
  for (const req of requirements) {
    if (req.customerType !== customerType || req.riskLevel !== riskLevel || !isRequirementCurrent(req, asOf)) continue;
    const existing = byType.get(req.documentType);
    if (!existing || (!existing.isMandatory && req.isMandatory)) byType.set(req.documentType, req);
  }

  const docsByType = new Map();
  for (const doc of documents) {
    if (!docsByType.has(doc.documentType)) docsByType.set(doc.documentType, []);
    docsByType.get(doc.documentType).push(doc);
  }

  const exceptions = [];
  const requirementRows = [];

  for (const req of byType.values()) {
    const docs = docsByType.get(req.documentType) || [];
    const primary = docs.length ? pickPrimary(docs, asOf) : null;
    const state = primary ? STATE_FOR_EFFECTIVE[effectiveStatus(primary, asOf)] : STATE.MISSING;
    const summary = primary ? docSummary(primary, asOf) : null;
    const expiringSoon = state === STATE.VERIFIED && summary.expiryState === EXPIRY.SOON;

    requirementRows.push({
      requirementId: req.id,
      documentType: req.documentType,
      isMandatory: req.isMandatory,
      state,
      expiringSoon,
      submittedCount: docs.length,
      document: summary,
    });

    const exception = exceptionFor(state, expiringSoon, req.isMandatory);
    if (exception) {
      exceptions.push({ type: exception, documentType: req.documentType, isMandatory: req.isMandatory, document: summary });
    }
  }

  // Submitted documents whose type is not a current requirement (extra evidence).
  const extraDocuments = [];
  for (const [type, docs] of docsByType) {
    if (byType.has(type)) continue;
    const primary = pickPrimary(docs, asOf);
    const summary = docSummary(primary, asOf);
    extraDocuments.push(summary);
    const state = STATE_FOR_EFFECTIVE[summary.effectiveStatus];
    const exception = exceptionFor(state, state === STATE.VERIFIED && summary.expiryState === EXPIRY.SOON, false);
    if (exception) exceptions.push({ type: exception, documentType: type, isMandatory: false, document: summary });
  }

  // Counters count MANDATORY requirements only; each one falls in exactly one bucket.
  const mandatory = requirementRows.filter((r) => r.isMandatory);
  const count = (state) => mandatory.filter((r) => r.state === state).length;
  const totals = {
    mandatory: mandatory.length,
    verified: count(STATE.VERIFIED),
    missing: count(STATE.MISSING),
    pendingVerification: count(STATE.PENDING),
    rejected: count(STATE.REJECTED),
    requiresResubmission: count(STATE.RESUBMIT),
    expired: count(STATE.EXPIRED),
    expiringSoon: mandatory.filter((r) => r.expiringSoon).length, // subset of `verified`
  };

  const { percentage, status } = completenessFrom(totals);

  exceptions.sort((a, b) => EXCEPTION_ORDER.indexOf(a.type) - EXCEPTION_ORDER.indexOf(b.type) || a.documentType.localeCompare(b.documentType));

  return { asOf, customerType, riskLevel, percentage, status, totals, requirements: requirementRows, extraDocuments, exceptions };
}

function exceptionFor(state, expiringSoon, isMandatory) {
  switch (state) {
    case STATE.MISSING:
      return isMandatory ? EXCEPTION.MISSING : null; // a missing OPTIONAL document is not an exception
    case STATE.PENDING:
      return EXCEPTION.PENDING;
    case STATE.REJECTED:
      return EXCEPTION.REJECTED;
    case STATE.RESUBMIT:
      return EXCEPTION.RESUBMIT;
    case STATE.EXPIRED:
      return EXCEPTION.EXPIRED;
    case STATE.VERIFIED:
      return expiringSoon ? EXCEPTION.EXPIRING : null;
    default:
      return null;
  }
}

/** Completeness % = verified mandatory / total mandatory x 100 (one decimal). */
function completenessFrom(totals) {
  if (totals.mandatory === 0) return { percentage: null, status: 'No Requirements' };
  const percentage = Math.round((totals.verified / totals.mandatory) * 1000) / 10;
  let status = 'Partially Complete';
  if (percentage === 100) status = 'Complete';
  else if (percentage === 0) status = 'Not Started';
  return { percentage, status };
}

module.exports = {
  EXPIRY,
  STATE,
  EXCEPTION,
  EXCEPTION_ORDER,
  expiryInfo,
  effectiveStatus,
  isCurrentlyValid,
  isRequirementCurrent,
  pickPrimary,
  docSummary,
  evaluateCustomerKyc,
  completenessFrom,
};
