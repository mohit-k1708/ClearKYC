/**
 * Scene 3 rules: beneficial-owner risk, ownership complexity, the overall customer risk model and
 * the synthetic screening lists.
 *
 * !! PROTOTYPE ASSUMPTIONS - NOT REGULATORY STANDARDS !!
 * Every point value, band and trigger below was chosen for this demo. They are not taken from any
 * regulator and must be replaced by the institution's approved methodology before real use.
 * Nothing here connects to a real sanctions or PEP database. Screening outcomes are synthetic.
 *
 * Editing this file is the only change needed to adjust the rules.
 */
const { RISK_RULES } = require('./riskRules');

const OWNERSHIP_RULES = {
  version: 'RULES_V2_OWNERSHIP_PROTOTYPE',

  // ---- Owner-level risk points ---------------------------------------------------------------
  ownerPoints: {
    pepConfirmed: 3, // a confirmed, relevant PEP
    pepPotential: 2, // possible PEP match: must be reviewed, never auto-rejected
    pepDeclared: 2, // owner declared "Yes" but it is not confirmed by screening
    countryHigh: 2, // residence or nationality on the prototype high-risk list
    countryElevated: 1, // ... on the prototype elevated-risk list
    sanctionsPotential: 3, // POTENTIAL match: needs investigation, is NOT a confirmed match
    sanctionsConfirmed: 6, // confirmed after investigation: escalate (still no automatic rejection)
    missingInformation: 1, // any mandatory owner field missing (counted once per owner)
  },
  // Owner score bands: 0-2 Low, 3-5 Medium, 6+ High
  ownerBands: { mediumFrom: 3, highFrom: 6 },
  // Fields that must be present for an owner record to be complete.
  mandatoryOwnerFields: ['dateOfBirth', 'countryOfResidence', 'nationality', 'ownershipPercentage'],
  unknownPepCountsAsMissing: true, // a PEP status of "Unknown" is missing information

  // ---- Ownership structure complexity ---------------------------------------------------------
  complexity: {
    points: 2, // added to the customer's ownership risk when the structure is complex
    anyIndirectOwner: true, // at least one Indirect owner
    ownerCountAtLeast: 5, // five or more beneficial owners
    residenceCountriesAtLeast: 3, // owners resident in three or more different countries
    otherControlType: 'Other means of control', // control exercised other than by ownership/voting/board/management
  },

  // ---- Overall customer risk -------------------------------------------------------------------
  // overall score = baseline (Scene 1 rules, 0-100) + ownership uplift + validation uplift, capped at 100.
  // Level bands are the Scene 1 thresholds (see riskRules.js): Low < 30, Medium < 60, High >= 60.
  overall: {
    scorePerOwnerPoint: 5, // each owner-risk point adds this many score points...
    ownershipUpliftCap: 40, // ...up to this cap (highest-risk owner + structure complexity)
    validationUplift: { RECONCILED: 0, EXCEEDS_100: 15, BELOW_100: 10, MISSING_PERCENTAGE: 10, NO_OWNERS: 10 },
    maxScore: RISK_RULES.maxScore,
    thresholds: RISK_RULES.thresholds,
  },

  // ---- What forces "Requires Manual Review" ------------------------------------------------------
  // A review flag is NOT a rejection. The customer stays registered; people investigate.
  manualReview: {
    onSanctionsPotentialOrConfirmed: true,
    onPepPotentialConfirmedOrDeclared: true,
    onOwnershipStatuses: ['EXCEEDS_100', 'BELOW_100', 'MISSING_PERCENTAGE', 'NO_OWNERS'],
    onComplexStructure: true,
    onCustomerScreeningPotentialMatch: true, // Scene 1 simulated screening of the customer name
  },
};

// ---- Screening ----------------------------------------------------------------------------------
const SCREENING_TYPES = ['PEP', 'Sanctions'];
const SCREENING_RESULTS = ['Confirmed', 'Potential Match', 'No Match']; // "Not Screened" = no record yet
const SCREENING_POINTS = {
  PEP: { Confirmed: OWNERSHIP_RULES.ownerPoints.pepConfirmed, 'Potential Match': OWNERSHIP_RULES.ownerPoints.pepPotential, 'No Match': 0 },
  Sanctions: { Confirmed: OWNERSHIP_RULES.ownerPoints.sanctionsConfirmed, 'Potential Match': OWNERSHIP_RULES.ownerPoints.sanctionsPotential, 'No Match': 0 },
};

/**
 * FICTIONAL lists for the "simulated list match" button. Matching a name here proves nothing about
 * any real person. The names are invented for the demo.
 */
const SIMULATED_OWNER_WATCHLISTS = {
  PEP: ['anil kapoor demo', 'farida rahman demo', 'meera joshi demo'],
  Sanctions: ['viktor demo petrov', 'darius demo volkov', 'nadia demo karimova'],
};

const OWNERSHIP_TYPES = ['Direct', 'Indirect'];
const PEP_STATUSES = ['Yes', 'No', 'Unknown'];
const CONTROL_TYPES = ['Shareholding', 'Voting rights', 'Right to appoint or remove directors', 'Senior managing official', 'Other means of control'];

const VALIDATION_STATUSES = ['RECONCILED', 'EXCEEDS_100', 'BELOW_100', 'NO_OWNERS', 'MISSING_PERCENTAGE'];
const ASSESSMENT_STATUSES = ['Completed', 'Requires Manual Review'];

module.exports = {
  OWNERSHIP_RULES,
  SCREENING_TYPES,
  SCREENING_RESULTS,
  SCREENING_POINTS,
  SIMULATED_OWNER_WATCHLISTS,
  OWNERSHIP_TYPES,
  PEP_STATUSES,
  CONTROL_TYPES,
  VALIDATION_STATUSES,
  ASSESSMENT_STATUSES,
};
