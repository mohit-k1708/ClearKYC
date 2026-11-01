/**
 * Ownership and risk rule engine for Scene 3 (pure functions: no database, no clock).
 *
 * Three things are calculated here and kept SEPARATE from each other:
 *   1. Ownership validation  - is the ownership structure documented and reconciled?
 *   2. Owner risk            - how risky is each beneficial owner? (PEP, country, sanctions, missing info)
 *   3. Overall customer risk - the Scene 1 baseline + owner risk + structure + validation issues.
 * KYC completeness (Scene 2: are the required documents present and valid?) is a fourth, independent
 * measure and is never used as an input here.
 *
 * Safeguards built into the rules:
 *   - A POTENTIAL sanctions or PEP match is "needs investigation / review". It is never treated as confirmed.
 *   - Nothing here rejects a customer. The strongest outcome is "Requires Manual Review".
 *   - A total below 100% is not proof of wrongdoing: it is reported as information to investigate or explain.
 *   - Screening results are synthetic. No real sanctions or PEP database is consulted.
 */
const { OWNERSHIP_RULES, SCREENING_POINTS } = require('../config/ownershipRules');
const { RISK_RULES } = require('../config/riskRules');
const { COUNTRIES } = require('../config/options');
const { levelForScore } = require('./riskService');

const countryName = (code) => COUNTRIES[code] || code;
const bp = (pct) => Math.round(Number(pct) * 100); // basis points: avoids floating point errors when adding percentages
const fmtBp = (value) => `${(value / 100).toFixed(2).replace(/\.?0+$/, '')}%`;

const normaliseName = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------------------------
// 1. Ownership validation
// ---------------------------------------------------------------------------------------------

/** Owners that look like the same person: same normalised name and the same (or an unknown) date of birth. */
function findDuplicateGroups(owners) {
  const groups = new Map();
  for (const o of owners) {
    const key = normaliseName(o.fullName);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  const duplicates = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    // Same name but two different, known birth dates = two different people, not a duplicate.
    const clusters = [];
    for (const m of members) {
      const cluster = clusters.find((c) => c.some((x) => !x.dateOfBirth || !m.dateOfBirth || x.dateOfBirth === m.dateOfBirth));
      if (cluster) cluster.push(m);
      else clusters.push([m]);
    }
    clusters.filter((c) => c.length > 1).forEach((c) => duplicates.push(c));
  }
  return duplicates;
}

/**
 * Reconciles the owners' percentages.
 * Status: NO_OWNERS | EXCEEDS_100 | MISSING_PERCENTAGE | BELOW_100 | RECONCILED
 */
function validateOwnership(owners) {
  const withPct = owners.filter((o) => o.ownershipPercentage !== null && o.ownershipPercentage !== undefined);
  const missing = owners.filter((o) => o.ownershipPercentage === null || o.ownershipPercentage === undefined);
  const totalBp = withPct.reduce((sum, o) => sum + bp(o.ownershipPercentage), 0);
  const issues = [];

  let status;
  let message;
  if (owners.length === 0) {
    status = 'NO_OWNERS';
    message = 'No beneficial owners are recorded for this company. Add the individuals who ultimately own or control it, or record why none can be identified.';
  } else if (totalBp > 10000) {
    status = 'EXCEEDS_100';
    message = `Invalid ownership total: the owners add up to ${fmtBp(totalBp)}, which is more than 100%. Correct the percentages.`;
  } else if (missing.length > 0) {
    status = 'MISSING_PERCENTAGE';
    message = `${missing.length} owner${missing.length > 1 ? 's have' : ' has'} no ownership percentage (${missing.map((o) => o.fullName).join(', ')}), so the total cannot be reconciled. The percentages recorded so far add up to ${fmtBp(totalBp)}.`;
  } else if (totalBp < 10000) {
    status = 'BELOW_100';
    message = `Ownership information incomplete: the owners add up to ${fmtBp(totalBp)}, leaving ${fmtBp(10000 - totalBp)} unaccounted for. A total below 100% is not proof of wrongdoing, but it needs investigation or an explanation.`;
  } else {
    status = 'RECONCILED';
    message = 'Ownership reconciled: the owners add up to exactly 100%.';
  }

  if (missing.length > 0 && status !== 'MISSING_PERCENTAGE') {
    issues.push({ code: 'MISSING_PERCENTAGE', severity: 'warning', message: `${missing.length} owner(s) have no ownership percentage: ${missing.map((o) => o.fullName).join(', ')}.` });
  }
  for (const group of findDuplicateGroups(owners)) {
    issues.push({ code: 'POSSIBLE_DUPLICATE_OWNER', severity: 'warning', message: `Possible duplicate owner records: ${group.map((o) => `${o.fullName} (#${o.id})`).join(', ')}.` });
  }

  return {
    status,
    message,
    ownerCount: owners.length,
    totalPercentage: totalBp / 100,
    unaccountedPercentage: status === 'BELOW_100' ? (10000 - totalBp) / 100 : 0,
    missingPercentageCount: missing.length,
    issues,
    isReconciled: status === 'RECONCILED' && issues.length === 0,
  };
}

// ---------------------------------------------------------------------------------------------
// 2. Owner risk
// ---------------------------------------------------------------------------------------------

function ownerLevel(points) {
  const { mediumFrom, highFrom } = OWNERSHIP_RULES.ownerBands;
  if (points >= highFrom) return 'High';
  if (points >= mediumFrom) return 'Medium';
  return 'Low';
}

function missingFields(owner) {
  const missing = OWNERSHIP_RULES.mandatoryOwnerFields.filter((f) => owner[f] === null || owner[f] === undefined || owner[f] === '');
  const labels = { dateOfBirth: 'date of birth', countryOfResidence: 'country of residence', nationality: 'nationality', ownershipPercentage: 'ownership percentage' };
  const list = missing.map((f) => labels[f]);
  if (OWNERSHIP_RULES.unknownPepCountsAsMissing && owner.pepStatus === 'Unknown' && !(owner.screenings?.PEP)) list.push('PEP status');
  return list;
}

/**
 * Risk of one beneficial owner.
 * @param {object} owner      normalised owner
 * @param {{PEP?:object, Sanctions?:object}} latest  newest screening of each type (or undefined = Not Screened)
 */
function assessOwnerRisk(owner, latest = {}) {
  const P = OWNERSHIP_RULES.ownerPoints;
  const indicators = [];
  const reviewReasons = [];
  const name = owner.fullName;

  // PEP: screening outcome first, then the owner's own declaration.
  const pep = latest.PEP || null;
  let pepPoints = 0;
  let pepOutcome = pep ? pep.result : 'Not Screened';
  let pepDetail = pep ? `PEP screening: ${pep.result}.` : 'No PEP screening has been recorded yet.';
  if (pep?.result === 'Confirmed') {
    pepPoints = P.pepConfirmed;
    reviewReasons.push({ code: 'PEP_CONFIRMED', message: `${name} is a confirmed PEP. Enhanced due diligence is required. This is not an automatic rejection.` });
  } else if (pep?.result === 'Potential Match') {
    pepPoints = P.pepPotential;
    pepDetail = 'Possible PEP match. It must be reviewed and is not a confirmed PEP.';
    reviewReasons.push({ code: 'PEP_POTENTIAL', message: `Possible PEP match for ${name}: review is required. It is not a confirmed PEP and not an automatic rejection.` });
  } else if (owner.pepStatus === 'Yes') {
    pepPoints = P.pepDeclared;
    pepOutcome = pep ? 'No Match' : 'Not Screened';
    pepDetail = pep ? 'The owner declared PEP status but screening found no match. The conflict needs review.' : 'The owner declared PEP status. It has not been confirmed by screening.';
    reviewReasons.push({ code: 'PEP_DECLARED', message: `${name} declared PEP status: confirm it through screening (not an automatic rejection).` });
  }
  indicators.push({ indicator: 'PEP status', outcome: pepOutcome, points: pepPoints, detail: pepDetail, requiresReview: pepPoints > 0 });

  // Country exposure: the riskier of residence and nationality.
  let countryPoints = 0;
  let countryDetail = 'No elevated country exposure.';
  const { high, elevated } = RISK_RULES.country;
  for (const [label, code] of [['residence', owner.countryOfResidence], ['nationality', owner.nationality]]) {
    if (!code) continue;
    if (high.codes.includes(code) && P.countryHigh > countryPoints) {
      countryPoints = P.countryHigh;
      countryDetail = `${label} in ${countryName(code)} is on the prototype high-risk country list.`;
    } else if (elevated.codes.includes(code) && P.countryElevated > countryPoints) {
      countryPoints = P.countryElevated;
      countryDetail = `${label} in ${countryName(code)} is on the prototype elevated-risk country list.`;
    }
  }
  indicators.push({ indicator: 'Country exposure', outcome: countryPoints >= P.countryHigh ? 'High-risk country' : countryPoints > 0 ? 'Elevated-risk country' : 'No exposure', points: countryPoints, detail: countryDetail, requiresReview: false });

  // Sanctions: a potential match is an investigation trigger, never a confirmed match.
  const sanctions = latest.Sanctions || null;
  let sanctionsPoints = 0;
  let sanctionsDetail = sanctions ? `Sanctions screening: ${sanctions.result}.` : 'No sanctions screening has been recorded yet.';
  if (sanctions?.result === 'Potential Match') {
    sanctionsPoints = P.sanctionsPotential;
    sanctionsDetail = 'Potential sanctions match. It requires investigation and is NOT a confirmed match.';
    reviewReasons.push({ code: 'SANCTIONS_POTENTIAL', message: `Potential sanctions match for ${name}: investigation is required. It is not a confirmed match.` });
  } else if (sanctions?.result === 'Confirmed') {
    sanctionsPoints = P.sanctionsConfirmed;
    sanctionsDetail = 'Sanctions match confirmed after investigation. Escalate according to policy.';
    reviewReasons.push({ code: 'SANCTIONS_CONFIRMED', message: `A sanctions match is recorded as confirmed for ${name}. Escalate according to policy. The system does not reject customers automatically.` });
  }
  indicators.push({ indicator: 'Sanctions screening', outcome: sanctions ? sanctions.result : 'Not Screened', points: sanctionsPoints, detail: sanctionsDetail, requiresReview: sanctionsPoints > 0 });

  // Missing mandatory information (once per owner).
  const missing = missingFields({ ...owner, screenings: latest });
  const missingPoints = missing.length > 0 ? P.missingInformation : 0;
  indicators.push({
    indicator: 'Owner information',
    outcome: missing.length > 0 ? 'Incomplete' : 'Complete',
    points: missingPoints,
    detail: missing.length > 0 ? `Missing: ${missing.join(', ')}.` : 'All mandatory owner information is present.',
    requiresReview: false,
  });

  const points = indicators.reduce((s, i) => s + i.points, 0);
  return {
    ownerId: owner.id,
    name,
    points,
    level: ownerLevel(points),
    indicators,
    reviewReasons,
    missingFields: missing,
    screening: { pep: pep ? pep.result : 'Not Screened', sanctions: sanctions ? sanctions.result : 'Not Screened' },
  };
}

/** Points a new screening record is worth (calculated by the server, never taken from the client). */
function pointsForScreening(type, result) {
  return SCREENING_POINTS[type]?.[result] ?? 0;
}

// ---------------------------------------------------------------------------------------------
// Structure complexity
// ---------------------------------------------------------------------------------------------
function assessComplexity(owners) {
  const C = OWNERSHIP_RULES.complexity;
  const reasons = [];
  if (C.anyIndirectOwner) {
    const indirect = owners.filter((o) => o.ownershipType === 'Indirect');
    if (indirect.length) reasons.push(`${indirect.length} owner${indirect.length > 1 ? 's hold' : ' holds'} their stake indirectly (${indirect.map((o) => o.fullName).join(', ')})`);
  }
  if (owners.length >= C.ownerCountAtLeast) reasons.push(`${owners.length} beneficial owners (the threshold is ${C.ownerCountAtLeast})`);
  const countries = new Set(owners.map((o) => o.countryOfResidence).filter(Boolean));
  if (countries.size >= C.residenceCountriesAtLeast) reasons.push(`owners live in ${countries.size} different countries (the threshold is ${C.residenceCountriesAtLeast})`);
  const other = owners.filter((o) => o.controlType === C.otherControlType);
  if (other.length) reasons.push(`control is exercised by "${C.otherControlType.toLowerCase()}" (${other.map((o) => o.fullName).join(', ')})`);
  return { isComplex: reasons.length > 0, points: reasons.length > 0 ? C.points : 0, reasons };
}

// ---------------------------------------------------------------------------------------------
// 3. Overall customer risk
// ---------------------------------------------------------------------------------------------

/**
 * @param {object} input
 * @param {string} input.customerType      'Individual' | 'Company'
 * @param {object} input.baseline          result of Scene 1's assessRisk() on the customer profile
 * @param {object[]} input.ownerAssessments results of assessOwnerRisk() (companies only)
 * @param {object|null} input.validation   result of validateOwnership() (companies only)
 * @param {object|null} input.complexity   result of assessComplexity() (companies only)
 */
function assessOverallRisk({ customerType, baseline, ownerAssessments = [], validation = null, complexity = null }) {
  const O = OWNERSHIP_RULES.overall;
  const reasons = baseline.reasons.map((r) => ({ ...r, source: 'baseline' }));
  const manualReviewReasons = [];
  const components = { baseline: baseline.score, ownership: 0, complexity: 0, validation: 0, cap: 0 };

  if (baseline.requiresManualReview && OWNERSHIP_RULES.manualReview.onCustomerScreeningPotentialMatch) {
    manualReviewReasons.push({ code: 'CUSTOMER_SCREENING_POTENTIAL', message: 'The customer name produced a potential match in the simulated screening. It needs review and is not a confirmed match.' });
  }

  if (customerType === 'Company') {
    // Highest-risk owner (not the sum: many clean owners must not add risk, and one risky owner must not be diluted).
    const top = [...ownerAssessments].sort((a, b) => b.points - a.points)[0];
    const rawOwner = top ? top.points * O.scorePerOwnerPoint : 0;
    const rawComplex = complexity ? complexity.points * O.scorePerOwnerPoint : 0;
    components.ownership = Math.min(rawOwner, O.ownershipUpliftCap);
    components.complexity = Math.min(rawComplex, O.ownershipUpliftCap - components.ownership);

    if (top && top.points > 0) {
      reasons.push({
        factor: 'Beneficial owner risk',
        description: `Highest-risk owner is ${top.name}: ${top.points} owner risk point${top.points > 1 ? 's' : ''} (${top.level}). Each owner point adds ${O.scorePerOwnerPoint} to the customer score.`,
        points: components.ownership,
        simulated: false,
        source: 'ownership',
      });
    }
    if (complexity?.isComplex) {
      reasons.push({
        factor: 'Ownership complexity',
        description: `Complex ownership structure: ${complexity.reasons.join('; ')}.`,
        points: components.complexity,
        simulated: false,
        source: 'ownership',
      });
    }
    if (validation) {
      components.validation = O.validationUplift[validation.status] ?? 0;
      if (components.validation > 0) {
        reasons.push({ factor: 'Ownership validation', description: validation.message, points: components.validation, simulated: false, source: 'validation' });
      }
    }

    // Manual review triggers (a review is not a rejection).
    const M = OWNERSHIP_RULES.manualReview;
    for (const o of ownerAssessments) {
      for (const r of o.reviewReasons) {
        const isSanctions = r.code.startsWith('SANCTIONS');
        if ((isSanctions && M.onSanctionsPotentialOrConfirmed) || (!isSanctions && M.onPepPotentialConfirmedOrDeclared)) manualReviewReasons.push(r);
      }
    }
    if (validation && M.onOwnershipStatuses.includes(validation.status)) {
      manualReviewReasons.push({ code: `OWNERSHIP_${validation.status}`, message: `Ownership structure requires investigation: ${validation.message}` });
    }
    if (complexity?.isComplex && M.onComplexStructure) {
      manualReviewReasons.push({ code: 'OWNERSHIP_COMPLEX', message: `Complex ownership structure requires review: ${complexity.reasons.join('; ')}.` });
    }
  }

  let score = baseline.score + components.ownership + components.complexity + components.validation;
  if (score > O.maxScore) {
    components.cap = O.maxScore - score;
    reasons.push({ factor: 'Score cap', description: `The total is limited to ${O.maxScore}.`, points: components.cap, simulated: false, source: 'cap' });
    score = O.maxScore;
  }

  const level = levelForScore(score);
  const requiresManualReview = manualReviewReasons.length > 0;
  return {
    score,
    level,
    // The score band (level) and the review flag stay separate: a High customer is not a "review", and a Low one can need review.
    status: requiresManualReview ? 'Requires Manual Review' : 'Completed',
    overallResult: requiresManualReview ? 'Requires Manual Review' : level,
    requiresManualReview,
    reasons,
    manualReviewReasons,
    components,
    thresholds: { ...RISK_RULES.thresholds },
    method: OWNERSHIP_RULES.version,
  };
}

module.exports = {
  validateOwnership,
  findDuplicateGroups,
  assessOwnerRisk,
  assessComplexity,
  assessOverallRisk,
  pointsForScreening,
  ownerLevel,
  missingFields,
  normaliseName,
  bp,
};
