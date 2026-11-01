/**
 * Independent anomaly detection engine.
 *
 * It reads the OPERATIONAL records of one database (documents, verifications, owners, cases, decisions ...) with plain SQL and
 * applies business rules. It never reads any answer key, never looks at how the data was generated and
 * does not use the generator or the application's own detection services: it is a second, separate implementation.
 */
const { ISSUE_TYPES, ORDER } = require('./config/detectionRules');
const { buildDetections } = require('./detectionResults');

const rules = {
  EXPIRED_DOCUMENT_MARKED_VALID: require('./rules/expiredDocumentRule'),
  APPROVED_WITH_MISSING_EVIDENCE: require('./rules/missingEvidenceRule'),
  OWNERSHIP_OVER_100: require('./rules/ownershipRule'),
  CLOSED_WITHOUT_RESOLUTION: require('./rules/closedCaseRule'),
  DOCUMENT_REUSED_ACROSS_CUSTOMERS: require('./rules/duplicateDocumentRule'),
  DOCUMENT_NAME_MISMATCH: require('./rules/nameMismatchRule'),
};

/**
 * @param {import('pg').Client} db     a connected client
 * @param {object} options
 * @param {string} options.referenceDate  YYYY-MM-DD, the "as of" day for every date comparison
 * @param {string[]} [options.only]      run only these issue types
 */
async function runDetection(db, { referenceDate, only = null, nameMatching } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate || '')) throw new Error('referenceDate (YYYY-MM-DD) is required');
  const perRule = [];
  const raw = [];
  for (const issueType of ORDER) {
    if (only && !only.includes(issueType)) continue;
    const t0 = Date.now();
    const { findings, notes } = await rules[issueType].run(db, { referenceDate, nameMatching });
    perRule.push({ issueType, rule: ISSUE_TYPES[issueType].rule, findings: findings.length, ms: Date.now() - t0, notes });
    for (const f of findings) raw.push({ issueType, ...f });
  }
  return { detections: buildDetections(raw, referenceDate), perRule };
}

module.exports = { runDetection };
