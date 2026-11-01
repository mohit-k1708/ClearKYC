/**
 * Scene 3 unit tests for the ownership and risk engine (no database needed).   npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/config/env');
const { validateOwnership, assessOwnerRisk, assessComplexity, assessOverallRisk, ownerLevel, pointsForScreening } = require('../src/services/ownershipEngine');
const { assessRisk } = require('../src/services/riskService');
const { OWNERSHIP_RULES } = require('../src/config/ownershipRules');

let nextId = 1;
const owner = (over = {}) => ({
  id: nextId++,
  fullName: `Owner ${nextId}`,
  dateOfBirth: '1980-01-01',
  countryOfResidence: 'IN',
  nationality: 'IN',
  ownershipPercentage: 50,
  ownershipType: 'Direct',
  controlType: 'Shareholding',
  pepStatus: 'No',
  ...over,
});
const screening = (result) => ({ result, remarks: 'x', screenedAt: new Date(), source: 'Manual entry (synthetic)' });
const company = (over = {}) => ({ customerType: 'Company', fullName: 'Demo Traders Pvt Ltd', country: 'IN', businessActivity: 'Retail', dateOfIncorporation: new Date('2015-01-01'), ...over });
const baseline = (profile = company(), now = new Date('2026-10-22')) => assessRisk(profile, now);

// ---- Ownership validation: the three examples from the brief -------------------------------------------------------
test('Company A: 60% + 50% = 110% is an invalid total', () => {
  const v = validateOwnership([owner({ ownershipPercentage: 60 }), owner({ ownershipPercentage: 50 })]);
  assert.equal(v.status, 'EXCEEDS_100');
  assert.equal(v.totalPercentage, 110);
  assert.match(v.message, /Invalid ownership total/);
});

test('Company B: 60% + 40% = 100% is reconciled', () => {
  const v = validateOwnership([owner({ ownershipPercentage: 60 }), owner({ ownershipPercentage: 40 })]);
  assert.equal(v.status, 'RECONCILED');
  assert.equal(v.totalPercentage, 100);
  assert.match(v.message, /reconciled/i);
  assert.equal(v.isReconciled, true);
});

test('Company C: 40% + 30% = 70% is incomplete, flagged for investigation, and NOT presented as wrongdoing', () => {
  const v = validateOwnership([owner({ ownershipPercentage: 40 }), owner({ ownershipPercentage: 30 })]);
  assert.equal(v.status, 'BELOW_100');
  assert.equal(v.totalPercentage, 70);
  assert.equal(v.unaccountedPercentage, 30);
  assert.match(v.message, /incomplete/i);
  assert.match(v.message, /not proof of wrongdoing/i);
  assert.match(v.message, /investigation or an explanation/i);
});

test('the specification example 50 + 30 + 20 = 100% is reconciled', () => {
  assert.equal(validateOwnership([50, 30, 20].map((p) => owner({ ownershipPercentage: p }))).status, 'RECONCILED');
});

test('no owners, missing percentages and decimal arithmetic are handled', () => {
  assert.equal(validateOwnership([]).status, 'NO_OWNERS');

  const missing = validateOwnership([owner({ ownershipPercentage: 60 }), owner({ ownershipPercentage: null, fullName: 'No Percentage Person' })]);
  assert.equal(missing.status, 'MISSING_PERCENTAGE');
  assert.equal(missing.missingPercentageCount, 1);
  assert.match(missing.message, /No Percentage Person/);

  // 33.33 + 33.33 + 33.34 must be exactly 100 (floating point would give 99.99999...)
  assert.equal(validateOwnership([33.33, 33.33, 33.34].map((p) => owner({ ownershipPercentage: p }))).status, 'RECONCILED');
  assert.equal(validateOwnership([0.1, 0.2, 99.7].map((p) => owner({ ownershipPercentage: p }))).status, 'RECONCILED');
});

test('exceeding 100% wins over a missing percentage', () => {
  const v = validateOwnership([owner({ ownershipPercentage: 70 }), owner({ ownershipPercentage: 40 }), owner({ ownershipPercentage: null })]);
  assert.equal(v.status, 'EXCEEDS_100');
});

test('possible duplicate owners are flagged, but the same name with different birth dates is two people', () => {
  const dup = validateOwnership([owner({ fullName: 'Asha  Rao', dateOfBirth: null, ownershipPercentage: 50 }), owner({ fullName: 'asha rao', dateOfBirth: '1980-02-02', ownershipPercentage: 50 })]);
  assert.ok(dup.issues.some((i) => i.code === 'POSSIBLE_DUPLICATE_OWNER'));
  assert.equal(dup.isReconciled, false);

  const same = validateOwnership([owner({ fullName: 'Asha Rao', dateOfBirth: '1980-02-02', ownershipPercentage: 50 }), owner({ fullName: 'Asha Rao', dateOfBirth: '1980-02-02', ownershipPercentage: 50 })]);
  assert.ok(same.issues.some((i) => i.code === 'POSSIBLE_DUPLICATE_OWNER'));

  const different = validateOwnership([owner({ fullName: 'Asha Rao', dateOfBirth: '1980-02-02', ownershipPercentage: 50 }), owner({ fullName: 'Asha Rao', dateOfBirth: '1991-09-09', ownershipPercentage: 50 })]);
  assert.ok(!different.issues.some((i) => i.code === 'POSSIBLE_DUPLICATE_OWNER'));
});

// ---- Owner risk: the example scoring model ---------------------------------------------------------------------------
test('owner points follow the configured model: PEP 3, high-risk country 2, potential sanctions 3, missing information 1', () => {
  const clean = assessOwnerRisk(owner(), { PEP: screening('No Match'), Sanctions: screening('No Match') });
  assert.equal(clean.points, 0);
  assert.equal(clean.level, 'Low');

  assert.equal(assessOwnerRisk(owner(), { PEP: screening('Confirmed'), Sanctions: screening('No Match') }).points, 3);
  assert.equal(assessOwnerRisk(owner({ countryOfResidence: 'IR' }), { PEP: screening('No Match'), Sanctions: screening('No Match') }).points, 2);
  assert.equal(assessOwnerRisk(owner(), { PEP: screening('No Match'), Sanctions: screening('Potential Match') }).points, 3);
  assert.equal(assessOwnerRisk(owner({ nationality: null }), { PEP: screening('No Match'), Sanctions: screening('No Match') }).points, 1);
});

test('owner risk bands: 0-2 Low, 3-5 Medium, 6 or more High', () => {
  for (const [points, level] of [[0, 'Low'], [2, 'Low'], [3, 'Medium'], [5, 'Medium'], [6, 'High'], [9, 'High']]) assert.equal(ownerLevel(points), level, `${points} points`);
  // 3 (confirmed PEP) + 2 (high-risk country) + 1 (missing nationality) = 6
  const high = assessOwnerRisk(owner({ countryOfResidence: 'IR', nationality: null }), { PEP: screening('Confirmed'), Sanctions: screening('No Match') });
  assert.equal(high.points, 6);
  assert.equal(high.level, 'High');
});

test('a POTENTIAL sanctions match needs investigation and is never described or scored as confirmed', () => {
  const potential = assessOwnerRisk(owner(), { PEP: screening('No Match'), Sanctions: screening('Potential Match') });
  const confirmed = assessOwnerRisk(owner(), { PEP: screening('No Match'), Sanctions: screening('Confirmed') });
  const sanctionsOf = (r) => r.indicators.find((i) => i.indicator === 'Sanctions screening');

  assert.equal(sanctionsOf(potential).outcome, 'Potential Match');
  assert.match(sanctionsOf(potential).detail, /NOT a confirmed match/);
  assert.ok(potential.reviewReasons.some((r) => r.code === 'SANCTIONS_POTENTIAL' && /not a confirmed match/i.test(r.message)));
  assert.ok(!potential.reviewReasons.some((r) => r.code === 'SANCTIONS_CONFIRMED'));

  assert.equal(sanctionsOf(confirmed).outcome, 'Confirmed');
  assert.ok(confirmed.reviewReasons.some((r) => r.code === 'SANCTIONS_CONFIRMED'));
  assert.ok(confirmed.points > potential.points, 'a confirmed match is scored higher than a potential one');
  assert.equal(pointsForScreening('Sanctions', 'Potential Match'), OWNERSHIP_RULES.ownerPoints.sanctionsPotential);
  assert.equal(pointsForScreening('Sanctions', 'Confirmed'), OWNERSHIP_RULES.ownerPoints.sanctionsConfirmed);
});

test('Confirmed, Potential Match, No Match and Not Screened are four distinct outcomes', () => {
  const outcome = (latest) => assessOwnerRisk(owner(), latest).screening;
  assert.deepEqual(outcome({}), { pep: 'Not Screened', sanctions: 'Not Screened' });
  assert.deepEqual(outcome({ PEP: screening('No Match'), Sanctions: screening('Potential Match') }), { pep: 'No Match', sanctions: 'Potential Match' });
  assert.deepEqual(outcome({ PEP: screening('Confirmed'), Sanctions: screening('Confirmed') }), { pep: 'Confirmed', sanctions: 'Confirmed' });
  // Not Screened adds no points and is not the same as No Match
  const notScreened = assessOwnerRisk(owner(), {});
  assert.equal(notScreened.indicators.find((i) => i.indicator === 'PEP status').outcome, 'Not Screened');
  assert.equal(notScreened.points, 0);
});

test('a possible or declared PEP is flagged for review, never rejected', () => {
  const potential = assessOwnerRisk(owner(), { PEP: screening('Potential Match') });
  assert.ok(potential.reviewReasons.some((r) => r.code === 'PEP_POTENTIAL' && /not an automatic rejection/i.test(r.message)));
  const declared = assessOwnerRisk(owner({ pepStatus: 'Yes' }), {});
  assert.ok(declared.reviewReasons.some((r) => r.code === 'PEP_DECLARED'));
  assert.equal(declared.points, OWNERSHIP_RULES.ownerPoints.pepDeclared);
  for (const r of [potential, declared]) assert.ok(!('rejected' in r) && !('autoReject' in r));
});

test('an unknown PEP status counts as missing information until screened', () => {
  const unknown = assessOwnerRisk(owner({ pepStatus: 'Unknown' }), {});
  assert.ok(unknown.missingFields.includes('PEP status'));
  assert.equal(unknown.points, 1);
  assert.equal(assessOwnerRisk(owner({ pepStatus: 'Unknown' }), { PEP: screening('No Match') }).missingFields.length, 0);
});

// ---- Complexity ----------------------------------------------------------------------------------------------------------
test('ownership complexity: indirect owner, five or more owners, three or more countries, other control', () => {
  assert.equal(assessComplexity([owner(), owner()]).isComplex, false);
  assert.equal(assessComplexity([owner({ ownershipType: 'Indirect' }), owner()]).isComplex, true);
  assert.equal(assessComplexity([1, 2, 3, 4, 5].map(() => owner())).isComplex, true);
  assert.equal(assessComplexity([owner({ countryOfResidence: 'IN' }), owner({ countryOfResidence: 'US' }), owner({ countryOfResidence: 'SG' })]).isComplex, true);
  assert.equal(assessComplexity([owner({ controlType: 'Other means of control' })]).isComplex, true);
  assert.equal(assessComplexity([owner({ ownershipType: 'Indirect' })]).points, OWNERSHIP_RULES.complexity.points);
});

// ---- Overall customer risk -------------------------------------------------------------------------------------------------
function overall({ owners, latest = {}, profile = company() }) {
  const ownerAssessments = owners.map((o, i) => assessOwnerRisk(o, latest[i] || {}));
  return assessOverallRisk({ customerType: 'Company', baseline: baseline(profile), ownerAssessments, validation: validateOwnership(owners), complexity: assessComplexity(owners) });
}
const clean = { PEP: screening('No Match'), Sanctions: screening('No Match') };

test('a Low company with clean, reconciled owners stays Low and Completed', () => {
  const r = overall({ owners: [owner({ ownershipPercentage: 60 }), owner({ ownershipPercentage: 40 })], latest: [clean, clean] });
  assert.equal(r.level, 'Low');
  assert.equal(r.status, 'Completed');
  assert.equal(r.overallResult, 'Low');
  assert.equal(r.components.ownership, 0);
  assert.equal(r.components.validation, 0);
  assert.equal(r.manualReviewReasons.length, 0);
});

test('the brief example: a Medium customer with a High-risk owner and an ownership structure needing investigation', () => {
  // Retail company in a foreign country + new company gives a Medium baseline.
  const profile = company({ country: 'AE', businessActivity: 'Construction', dateOfIncorporation: new Date('2026-06-01') });
  const base = baseline(profile);
  assert.equal(base.level, 'Medium');

  const owners = [owner({ ownershipPercentage: 70, countryOfResidence: 'IR', nationality: null }), owner({ ownershipPercentage: 20 })]; // 70 + 20 = 90: below 100
  const r = overall({ owners, latest: [{ PEP: screening('Confirmed'), Sanctions: screening('No Match') }, clean], profile });

  assert.equal(r.components.baseline, base.score);
  assert.ok(r.components.ownership > 0, 'the high-risk owner raises the score');
  assert.ok(r.components.validation > 0, 'the below-100% total raises the score');
  assert.equal(r.score, Math.min(100, base.score + r.components.ownership + r.components.complexity + r.components.validation));
  assert.equal(r.level, 'High');
  assert.equal(r.status, 'Requires Manual Review');
  assert.equal(r.overallResult, 'Requires Manual Review');
  assert.ok(r.manualReviewReasons.some((m) => m.code === 'OWNERSHIP_BELOW_100'));
  assert.ok(r.manualReviewReasons.some((m) => m.code === 'PEP_CONFIRMED'));
  assert.ok(r.reasons.every((x) => typeof x.points === 'number' && x.factor));
});

test('the risk score band and the manual-review flag are separate things', () => {
  // A Low-risk company with an unexplained 70% total: Low score, but needs review.
  const r = overall({ owners: [owner({ ownershipPercentage: 40 }), owner({ ownershipPercentage: 30 })], latest: [clean, clean] });
  assert.equal(r.level, 'Medium'); // 10 points for the validation issue lift it from the baseline
  assert.equal(r.requiresManualReview, true);
  assert.equal(r.overallResult, 'Requires Manual Review');
  assert.ok(['Low', 'Medium', 'High'].includes(r.level), 'level is always one of the three bands');
});

test('a potential sanctions match forces review and raises the score, but never rejects', () => {
  const r = overall({ owners: [owner({ ownershipPercentage: 100 })], latest: [{ PEP: screening('No Match'), Sanctions: screening('Potential Match') }] });
  assert.equal(r.status, 'Requires Manual Review');
  assert.ok(r.manualReviewReasons.some((m) => m.code === 'SANCTIONS_POTENTIAL' && /not a confirmed match/i.test(m.message)));
  assert.ok(r.components.ownership >= 5 * OWNERSHIP_RULES.ownerPoints.sanctionsPotential);
  assert.ok(!('rejected' in r));
});

test('only the highest-risk owner counts: many clean owners do not add risk and one risky owner is not diluted', () => {
  const clean5 = [1, 2, 3, 4].map(() => owner({ ownershipPercentage: 20, countryOfResidence: 'IN' }));
  const risky = owner({ ownershipPercentage: 20, countryOfResidence: 'IR' });
  const a = overall({ owners: [...clean5, risky], latest: [...clean5.map(() => clean), clean] });
  const b = overall({ owners: [risky], latest: [clean] });
  assert.equal(a.components.ownership, 5 * 2);
  assert.equal(b.components.ownership, 5 * 2);
});

test('the ownership uplift is capped and the total score never exceeds 100', () => {
  const r = overall({
    owners: [owner({ ownershipPercentage: 90, countryOfResidence: 'IR', nationality: null, ownershipType: 'Indirect' })],
    latest: [{ PEP: screening('Confirmed'), Sanctions: screening('Confirmed') }],
    profile: company({ country: 'KP', businessActivity: 'Casinos & Gaming', fullName: 'Blackwater Demo Holdings', dateOfIncorporation: new Date('2026-09-01') }),
  });
  assert.ok(r.components.ownership + r.components.complexity <= OWNERSHIP_RULES.overall.ownershipUpliftCap);
  assert.equal(r.score, 100);
  assert.equal(r.level, 'High');
});

test('complex ownership alone requires manual review', () => {
  const r = overall({ owners: [owner({ ownershipPercentage: 50, ownershipType: 'Indirect' }), owner({ ownershipPercentage: 50 })], latest: [clean, clean] });
  assert.equal(r.status, 'Requires Manual Review');
  assert.ok(r.manualReviewReasons.some((m) => m.code === 'OWNERSHIP_COMPLEX'));
  assert.ok(r.reasons.some((x) => x.factor === 'Ownership complexity' && x.points > 0));
});

test('a company with no beneficial owners is flagged for review with a validation uplift', () => {
  const r = overall({ owners: [] });
  assert.ok(r.manualReviewReasons.some((m) => m.code === 'OWNERSHIP_NO_OWNERS'));
  assert.equal(r.components.validation, OWNERSHIP_RULES.overall.validationUplift.NO_OWNERS);
});

test('an individual customer is assessed on the baseline only', () => {
  const profile = { customerType: 'Individual', fullName: 'Asha Demo', country: 'IN', occupation: 'Engineer', dateOfBirth: new Date('1990-01-01') };
  const base = assessRisk(profile, new Date('2026-10-22'));
  const r = assessOverallRisk({ customerType: 'Individual', baseline: base });
  assert.equal(r.score, base.score);
  assert.equal(r.level, base.level);
  assert.deepEqual([r.components.ownership, r.components.complexity, r.components.validation], [0, 0, 0]);
  assert.equal(r.status, 'Completed');
});

test('the calculation is deterministic and the rules are documented as prototype assumptions', () => {
  const input = { owners: [owner({ id: 900, ownershipPercentage: 55 }), owner({ id: 901, ownershipPercentage: 45 })], latest: [clean, clean] };
  assert.deepEqual(overall(input), overall(input));
  assert.equal(OWNERSHIP_RULES.version, 'RULES_V2_OWNERSHIP_PROTOTYPE');
  assert.equal(OWNERSHIP_RULES.ownerBands.mediumFrom, 3);
  assert.equal(OWNERSHIP_RULES.ownerBands.highFrom, 6);
});
