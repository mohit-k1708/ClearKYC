/**
 * Scene 5 pure-logic tests (no database): audit sanitising, CSV safety, alert derivation, alert permissions, analytics date ranges
 * and the data quality rules. Run with `npm test`.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitize, maskText, isSensitiveKey, changedFields, CASE_ACTION_MAP } = require('../src/services/auditService');
const { AUDIT_ACTIONS } = require('../src/config/auditRules');
const { toCsv, formatCell, BOM } = require('../src/utils/csv');
const { deriveAlerts } = require('../src/services/alertEngine');
const alertRules = require('../src/config/alertRules');
const { resolveRange } = require('../src/services/analyticsService');
const { resolveBlocker, dismissBlocker, allowedActions } = require('../src/services/alertService');
const checks = require('../src/services/dataQualityChecks');
const { EXCEPTION_TYPES } = require('../src/config/reviewRules');

// ---- audit sanitising ----------------------------------------------------------------------------------------------
test('audit: sensitive keys are redacted at any depth, other values are kept', () => {
  const out = sanitize({ riskLevel: 'High', panNumber: 'ABCDE1234F', nested: { aadhaarNumber: '123456789012', ok: 1 }, list: [{ password: 'x' }], documentNumber: 'SYN-PAN-123456', dateOfBirth: '1990-01-01', apiToken: 't' });
  assert.equal(out.riskLevel, 'High');
  assert.equal(out.panNumber, '[redacted]');
  assert.equal(out.nested.aadhaarNumber, '[redacted]');
  assert.equal(out.nested.ok, 1);
  assert.equal(out.list[0].password, '[redacted]');
  assert.equal(out.documentNumber, '[redacted]');
  assert.equal(out.dateOfBirth, '[redacted]');
  assert.equal(out.apiToken, '[redacted]');
  assert.ok(!isSensitiveKey('company') && !isSensitiveKey('companyName') && isSensitiveKey('PAN_NUMBER'));
});

test('audit: PAN and Aadhaar numbers hidden inside free text are masked, long text is cut', () => {
  assert.equal(maskText('Checked ABCDE1234F today'), 'Checked XXXXXX234F today');
  assert.equal(maskText('Aadhaar 1234 5678 9012 given'), 'Aadhaar XXXX XXXX 9012 given');
  assert.equal(maskText('a'.repeat(900)).length, 501);
  assert.ok(!JSON.stringify(sanitize({ remarks: 'PAN is ABCDE1234F' })).includes('ABCDE1234F'));
});

test('audit: only changed fields are reported, dates compare as calendar dates', () => {
  const diff = changedFields({ a: 1, b: new Date('2026-01-02T00:00:00Z'), c: null }, { a: 2, b: '2026-01-02', c: null }, ['a', 'b', 'c']);
  assert.deepEqual(diff, { previous: { a: 1 }, next: { a: 2 } });
});

test('audit: every case history action maps to a listed audit action, and every listed action has a label and category', () => {
  for (const type of Object.values(CASE_ACTION_MAP)) assert.ok(AUDIT_ACTIONS[type], type);
  for (const [code, a] of Object.entries(AUDIT_ACTIONS)) assert.ok(a.label && a.category, code);
  // the actions the specification asks for
  for (const code of ['CUSTOMER_CREATED', 'RISK_CLASSIFICATION_CHANGED', 'DOCUMENT_SUBMITTED', 'DOCUMENT_UPDATED', 'VERIFICATION_STARTED', 'DOCUMENT_VERIFIED', 'DOCUMENT_REJECTED', 'DOCUMENT_RESUBMISSION_REQUESTED', 'OWNER_ADDED', 'OWNERSHIP_PERCENTAGE_CHANGED', 'OWNERSHIP_VALIDATED', 'SCREENING_RECORDED', 'RISK_ASSESSMENT_CREATED', 'CASE_CREATED', 'CASE_ASSIGNED', 'CASE_STATUS_CHANGED', 'CASE_ESCALATED', 'CASE_RESOLVED', 'CASE_CLOSED', 'CASE_REOPENED', 'EXCEPTION_DETECTED', 'ALERT_GENERATED', 'ALERT_ACKNOWLEDGED', 'ALERT_RESOLVED']) {
    assert.ok(AUDIT_ACTIONS[code], code);
  }
});

// ---- CSV ---------------------------------------------------------------------------------------------------------------------
test('csv: UTF-8 byte-order mark, quoting, CRLF, and formula protection', () => {
  const csv = toCsv(['Name', 'Note'], [['Zoë "Z" Khan', 'line1\nline2'], ['=SUM(A1)', '+91 98'], [-5, null]]);
  assert.ok(csv.startsWith(BOM));
  const body = csv.slice(1);
  assert.ok(body.includes('"Zoë ""Z"" Khan"'));
  assert.ok(body.includes('"line1\nline2"'));
  assert.ok(body.includes("'=SUM(A1)"));
  assert.ok(body.includes("'+91 98"));
  assert.ok(body.includes('\r\n-5,'));
  assert.equal(formatCell(-5), '-5'); // a real negative number is not a formula
  assert.equal(formatCell(null), '');
  assert.equal(formatCell(new Date('2026-10-22T10:00:00Z')), '2026-10-22T10:00:00.000Z');
  assert.equal(formatCell({ a: 1 }), '"{""a"":1}"');
});

// ---- alerts --------------------------------------------------------------------------------------------------------------------
const cond = (type, severity, sourceType, sourceId) => ({ key: `1|${type}|${sourceType}|${sourceId}`, type, severity, description: `desc ${type}`, sourceType, sourceId });
const ctx = {
  customer: { id: 1, name: 'Test Co' },
  kyc: { requirements: [{ document: { id: 7, expiryDate: '2026-11-05' } }], extraDocuments: [] },
  schedule: { id: 3, nextReviewDate: new Date('2026-12-01T00:00:00Z') },
};

test('alerts: every alert type comes from a known exception condition, and each condition raises at most one alert type', () => {
  const seen = new Set();
  for (const [type, def] of Object.entries(alertRules.ALERT_TYPES)) {
    assert.ok(def.label.endsWith('Alert'), type);
    for (const c of def.conditions) {
      assert.ok(EXCEPTION_TYPES[c], `${type} -> ${c}`);
      assert.ok(!seen.has(c), `condition ${c} used twice`);
      seen.add(c);
    }
  }
  assert.equal(Object.keys(alertRules.ALERT_TYPES).length, 10);
});

test('alerts: derived from conditions with the same dedupe key, source link, severity and due date', () => {
  const alerts = deriveAlerts(ctx, [
    cond('DOCUMENT_EXPIRING_SOON', 'Low', 'Document', 7),
    cond('PERIODIC_REVIEW_OVERDUE', 'High', 'ReviewSchedule', 3),
    cond('POTENTIAL_SANCTIONS_MATCH', 'Critical', 'BeneficialOwner', 9),
    cond('DOCUMENT_REJECTED', 'Medium', 'Document', 8), // raises an exception but no alert
  ]);
  assert.equal(alerts.length, 3);
  const [expiry, review, sanctions] = alerts;
  assert.equal(expiry.alertType, 'DOCUMENT_EXPIRY');
  assert.equal(expiry.dueDate, '2026-11-05');
  assert.equal(expiry.key, '1|DOCUMENT_EXPIRING_SOON|Document|7');
  assert.equal(review.dueDate, '2026-12-01');
  assert.equal(review.relatedEntityType, 'ReviewSchedule');
  assert.equal(sanctions.severity, 'Critical');
  assert.match(sanctions.title, /Potential Sanctions Match: Test Co/);
  assert.ok(!/confirmed match/i.test(sanctions.description.replace(/not a confirmed/i, '')));
});

test('alerts: workflow rules - final states, dismissal limits, who may close important alerts', () => {
  assert.deepEqual(alertRules.ALERT_TRANSITIONS.Resolved, []);
  assert.deepEqual(alertRules.ALERT_TRANSITIONS.Dismissed, []);
  const analyst = { role: 'Analyst' };
  const reviewer = { role: 'Reviewer' };
  const sanctions = { alertType: 'POTENTIAL_SANCTIONS_MATCH', severity: 'Critical', status: 'New' };
  const expiry = { alertType: 'DOCUMENT_EXPIRY', severity: 'Low', status: 'New' };
  const high = { alertType: 'HIGH_RISK_CUSTOMER', severity: 'High', status: 'New' };

  assert.ok(dismissBlocker(sanctions, reviewer), 'a potential sanctions match can never be dismissed, even by a reviewer');
  assert.ok(resolveBlocker(sanctions, analyst), 'an analyst cannot close a potential match');
  assert.equal(resolveBlocker(sanctions, reviewer), null);
  assert.ok(dismissBlocker(expiry, analyst), 'analysts cannot dismiss');
  assert.equal(dismissBlocker(expiry, reviewer), null);
  assert.ok(resolveBlocker(high, analyst));
  assert.equal(resolveBlocker(expiry, analyst), null);

  assert.deepEqual(allowedActions(expiry, analyst), ['acknowledge', 'in_progress', 'resolve']);
  assert.deepEqual(allowedActions({ ...expiry, status: 'Acknowledged' }, reviewer), ['in_progress', 'resolve', 'dismiss']);
  assert.deepEqual(allowedActions({ ...expiry, status: 'Resolved' }, reviewer), []);
  assert.deepEqual(allowedActions(expiry, null), []);
});

// ---- analytics date ranges ------------------------------------------------------------------------------------------------
test('analytics: preset ranges include today and the days before it; custom ranges are validated', () => {
  const r7 = resolveRange({ range: '7d' }, '2026-10-30');
  assert.equal(r7.from, '2026-10-24');
  assert.equal(r7.to, '2026-10-30');
  assert.equal(r7.days, 7);
  assert.equal(r7.toTs, '2026-10-31 00:00:00'); // exclusive upper bound = start of tomorrow
  assert.equal(resolveRange({}, '2026-10-30').key, '30d');
  assert.equal(resolveRange({ range: '90d' }, '2026-10-30').from, '2026-08-02');
  assert.equal(resolveRange({ range: 'all' }, '2026-10-30').from, null);
  const custom = resolveRange({ from: '2026-10-01', to: '2026-10-10' }, '2026-10-30');
  assert.equal(custom.days, 10);
  assert.throws(() => resolveRange({ from: '2026-10-10', to: '2026-10-01' }, '2026-10-30'), /start date/);
  assert.throws(() => resolveRange({ from: '2026-10-01' }, '2026-10-30'), /both/);
  assert.throws(() => resolveRange({ from: '2026-10-01', to: '2026-12-01' }, '2026-10-30'), /future/);
  assert.throws(() => resolveRange({ range: '5d' }, '2026-10-30'), /Range/);
});

// ---- data quality rules ----------------------------------------------------------------------------------------------------
test('data quality: risk rows follow the configured scoring rules', () => {
  const ok = { riskScore: 40, riskLevel: 'Medium', reasons: [{ points: 15 }, { points: 25 }] };
  assert.deepEqual(checks.validateRiskRow(ok), []);
  assert.deepEqual(checks.validateRiskRow({ riskScore: 100, riskLevel: 'High', reasons: [{ points: 70 }, { points: 60 }] }), []); // capped at 100
  assert.equal(checks.validateRiskRow({ ...ok, riskLevel: 'High' })[0].code, 'LEVEL_SCORE');
  assert.equal(checks.validateRiskRow({ ...ok, riskScore: 140, riskLevel: 'High' }).some((p) => p.code === 'SCORE_RANGE'), true);
  assert.equal(checks.validateRiskRow({ ...ok, riskScore: 45 }).some((p) => p.code === 'SCORE_REASONS'), true);
  assert.equal(checks.validateRiskRow({ riskScore: 29, riskLevel: 'Low', reasons: null }).length, 0);
  assert.equal(checks.validateRiskRow({ riskScore: 30, riskLevel: 'Low', reasons: null })[0].code, 'LEVEL_SCORE'); // 30 is the Medium threshold
});

const h = (id, action, previousStatus, newStatus) => ({ id, action, previousStatus, newStatus });
test('data quality: case history must start with creation, be continuous, follow the workflow and end in the current status', () => {
  const good = [h(1, 'CREATED', null, 'Open'), h(2, 'ASSIGNED_ANALYST', 'Open', 'Assigned'), h(3, 'STARTED', 'Assigned', 'In Progress'), h(4, 'RESOLVED', 'In Progress', 'Resolved'), h(5, 'CLOSED', 'Resolved', 'Closed'), h(6, 'REOPENED', 'Closed', 'In Progress')];
  assert.deepEqual(checks.validateCaseHistory(good, 'In Progress'), []);
  assert.equal(checks.validateCaseHistory(good, 'Closed').length, 1); // history ends in a different status
  assert.equal(checks.validateCaseHistory([h(1, 'CREATED', null, 'Open'), h(2, 'CLOSED', 'Open', 'Closed')], 'Closed').length, 0); // close is allowed from Open
  const skipped = [h(1, 'CREATED', null, 'Open'), h(2, 'RESOLVED', 'Resolved', 'Closed')];
  assert.ok(checks.validateCaseHistory(skipped, 'Closed').some((p) => /starts from/.test(p.message)));
  const illegal = [h(1, 'CREATED', null, 'Open'), h(2, 'STARTED', 'Open', 'In Progress'), h(3, 'REOPENED', 'In Progress', 'Open'), h(4, 'X', 'Open', 'Pending Customer')];
  assert.ok(checks.validateCaseHistory(illegal, 'Pending Customer').some((p) => /does not allow/.test(p.message)));
  assert.equal(checks.validateCaseHistory([], 'Open').length, 1);
  assert.ok(checks.validateCaseHistory([h(1, 'STARTED', 'Open', 'In Progress')], 'In Progress')[0].message.includes('does not start'));
});

test('data quality: periodic review dates must be consistent', () => {
  const base = { lastReviewDate: '2026-01-31', nextReviewDate: '2027-01-31', reviewIntervalMonths: 12, riskLevel: 'High', status: 'Scheduled', asOf: '2026-10-30' };
  assert.deepEqual(checks.validateScheduleRow(base), []);
  assert.equal(checks.validateScheduleRow({ ...base, nextReviewDate: '2027-02-15' })[0].severity, 'Error');
  assert.equal(checks.validateScheduleRow({ ...base, nextReviewDate: '2026-01-31' })[0].severity, 'Error'); // not after the last review
  assert.equal(checks.validateScheduleRow({ ...base, reviewIntervalMonths: 24, nextReviewDate: '2028-01-31' })[0].severity, 'Warning'); // High risk uses 12 months
  assert.ok(checks.validateScheduleRow({ ...base, lastReviewDate: '2026-11-15', nextReviewDate: '2027-11-15' }).some((p) => /future/.test(p.message)));
  assert.equal(checks.validateScheduleRow({ ...base, status: 'Completed', lastReviewDate: '2026-11-15', nextReviewDate: '2027-11-15' }).length, 0);
});

test('data quality: completeness figures must agree with the requirement states', () => {
  const result = {
    percentage: 50,
    totals: { mandatory: 2, verified: 1, missing: 1, pendingVerification: 0, rejected: 0, requiresResubmission: 0, expired: 0, expiringSoon: 0 },
    requirements: [
      { documentType: 'PAN', isMandatory: true, state: 'Verified', submittedCount: 1, document: { status: 'Verified', expiryState: 'Valid' } },
      { documentType: 'Photograph', isMandatory: true, state: 'Missing', submittedCount: 0, document: null },
    ],
  };
  assert.deepEqual(checks.validateCompleteness(result), []);
  assert.ok(checks.validateCompleteness({ ...result, percentage: 75 })[0].includes('expected 50'));
  assert.ok(checks.validateCompleteness({ ...result, totals: { ...result.totals, missing: 0 } }).length > 0);
  const lying = { ...result, requirements: [{ ...result.requirements[0], document: { status: 'Pending', expiryState: 'Valid' } }, result.requirements[1]] };
  assert.ok(checks.validateCompleteness(lying).some((p) => /without a current verified document/.test(p)));
});

test('data quality: the check catalogue covers every rule the specification names, with unique codes', () => {
  const codes = checks.CHECKS.map((c) => c.code);
  assert.equal(new Set(codes).size, codes.length);
  for (const code of ['PK_CUSTOMER_CODE', 'FK_DOCUMENT_CUSTOMER', 'FK_VERIFICATION_DOCUMENT', 'FK_CASE_CUSTOMER', 'DOC_ISSUE_AFTER_SUBMISSION', 'DOC_EXPIRY_BEFORE_ISSUE', 'DOC_INVALID_STATUS',
    'OWN_PERCENTAGE_RANGE', 'OWN_TOTAL_OVER_100', 'OWN_MISSING_OWNERS', 'RISK_RULES_FOLLOWED', 'RISK_HISTORY_PRESERVED', 'CASE_CLOSED_WITHOUT_NOTES', 'CASE_STATUS_TRANSITIONS',
    'CASE_OVERDUE_IDENTIFIED', 'KYC_COMPLETENESS_CONSISTENT', 'ALERT_ACTIVE_VALID', 'PERIODIC_REVIEW_DATES']) {
    assert.ok(codes.includes(code), code);
  }
  for (const c of checks.CHECKS) {
    assert.ok(checks.CATEGORIES.includes(c.category), c.code);
    assert.ok(['Error', 'Warning'].includes(c.severity), c.code);
    assert.equal(typeof c.run, 'function');
  }
});
