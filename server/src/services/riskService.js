/**
 * Rule-based initial risk assessment (pure functions - no database access).
 *
 * Rules and thresholds live in config/riskRules.js and are PROTOTYPE ASSUMPTIONS,
 * not regulatory rules. Risk is assessed here independently of KYC completeness.
 *
 * Input  : a normalised profile { customerType, fullName, country, occupation?,
 *          businessActivity?, dateOfBirth?, dateOfIncorporation? }
 * Output : { score, level, method, reasons[], screening, requiresManualReview }
 *
 * Each reason is { factor, description, points, simulated }. `simulated: true` marks
 * results produced by the fictional screening lists (never real screening data).
 */
const { RISK_RULES, SIMULATED_WATCHLISTS } = require('../config/riskRules');
const { COUNTRIES } = require('../config/options');
const { ageInYears } = require('../utils/validation');

const normaliseName = (name) => String(name || '').toLowerCase().replace(/\s+/g, ' ').trim();

/** True when any keyword appears at the start of a word in the text, e.g. "jewel" matches "Jeweller". */
function matchesKeyword(text, keywords) {
  const lower = String(text || '').toLowerCase();
  return keywords.find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(lower));
}

/**
 * SIMULATED screening against the fictional lists in riskRules.js.
 * Returns what was checked and whether a *potential* match was found.
 * A potential match never rejects the customer; it only adds risk points and a review flag.
 */
function runSimulatedScreening(profile) {
  const name = normaliseName(profile.fullName);

  const pepNameHit = SIMULATED_WATCHLISTS.pep.includes(name);
  const pepOccupationHit =
    profile.customerType === 'Individual' && matchesKeyword(profile.occupation, RISK_RULES.pep.occupationKeywords);
  const sanctionsHit = SIMULATED_WATCHLISTS.sanctions.includes(name);

  return {
    simulated: true,
    note: 'Simulated screening against a fictional demo list. Not a real PEP or sanctions check.',
    pep: {
      potentialMatch: Boolean(pepNameHit || pepOccupationHit),
      basis: pepNameHit ? 'name on simulated PEP list' : pepOccupationHit ? `occupation keyword "${pepOccupationHit}"` : null,
    },
    sanctions: { potentialMatch: sanctionsHit, basis: sanctionsHit ? 'name on simulated sanctions list' : null },
  };
}

function levelForScore(score) {
  const { mediumFrom, highFrom } = RISK_RULES.thresholds;
  if (score >= highFrom) return 'High';
  if (score >= mediumFrom) return 'Medium';
  return 'Low';
}

/** `now` is injectable so tests and the data generator are deterministic. */
function assessRisk(profile, now = new Date()) {
  const reasons = [];
  const add = (factor, description, points, simulated = false) => reasons.push({ factor, description, points, simulated });

  // 1. Customer type
  const typePoints = RISK_RULES.customerType[profile.customerType] ?? 0;
  add('Customer type', `${profile.customerType} customer`, typePoints);

  // 2. Country exposure
  const countryName = COUNTRIES[profile.country] || profile.country;
  const { country: c } = RISK_RULES;
  if (c.high.codes.includes(profile.country)) {
    add('Country exposure', `${countryName} is on the prototype high-risk jurisdiction list`, c.high.points);
  } else if (c.elevated.codes.includes(profile.country)) {
    add('Country exposure', `${countryName} is on the prototype elevated-risk jurisdiction list`, c.elevated.points);
  } else if (profile.country === c.domestic) {
    add('Country exposure', `Domestic customer (${countryName})`, c.domesticPoints);
  } else {
    add('Country exposure', `Foreign country (${countryName}), standard exposure`, c.standardPoints);
  }

  // 3. Business activity (companies)
  if (profile.customerType === 'Company' && profile.businessActivity) {
    const points = RISK_RULES.businessActivity[profile.businessActivity] ?? RISK_RULES.businessActivity.Other;
    add('Business activity', `${profile.businessActivity}`, points);
  }

  // 4. Occupation indicators (individuals)
  if (profile.customerType === 'Individual' && profile.occupation) {
    const rule = RISK_RULES.occupationKeywords.find((r) => matchesKeyword(profile.occupation, r.keywords));
    if (rule) add('Occupation', `${rule.label} ("${profile.occupation}")`, rule.points);
  }

  // 5 & 6. Simulated PEP / sanctions screening
  const screening = runSimulatedScreening(profile);
  if (screening.pep.potentialMatch) {
    add('PEP indicator (simulated)', `Potential PEP: ${screening.pep.basis}. Requires enhanced due diligence, not rejection`, RISK_RULES.pep.points, true);
  }
  if (screening.sanctions.potentialMatch) {
    add('Sanctions screening (simulated)', `Potential match: ${screening.sanctions.basis}. Requires manual review, not automatic rejection`, RISK_RULES.sanctions.points, true);
  }

  // 7. Other documented indicators
  const { other } = RISK_RULES;
  if (profile.customerType === 'Individual' && profile.dateOfBirth) {
    const age = ageInYears(new Date(profile.dateOfBirth), now);
    if (age < other.youngAgeBelow) add('Other indicator', `Customer is under ${other.youngAgeBelow} (age ${age})`, other.youngAgePoints);
  }
  if (profile.customerType === 'Company' && profile.dateOfIncorporation) {
    const days = Math.floor((now - new Date(profile.dateOfIncorporation)) / 86_400_000);
    if (days <= other.newCompanyWithinDays) add('Other indicator', `Recently incorporated (${days} days ago)`, other.newCompanyPoints);
  }

  const rawScore = reasons.reduce((sum, r) => sum + r.points, 0);
  const score = Math.min(rawScore, RISK_RULES.maxScore);

  return {
    score,
    level: levelForScore(score),
    method: RISK_RULES.version,
    reasons,
    screening,
    requiresManualReview: screening.pep.potentialMatch || screening.sanctions.potentialMatch,
    thresholds: { ...RISK_RULES.thresholds },
  };
}

module.exports = { assessRisk, runSimulatedScreening, levelForScore };
