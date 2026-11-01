/**
 * Risk rules for the initial customer risk assessment.
 *
 * !! PROTOTYPE ASSUMPTIONS - NOT OFFICIAL REGULATORY RULES !!
 * Every point value, list and threshold below was chosen for this demo. They are NOT
 * taken from RBI, SEBI, FATF or any other regulator and must be replaced by the
 * institution's approved risk methodology before any real use.
 *
 * How scoring works (see services/riskService.js):
 *   score = sum of the points of all matching factors, capped at 100
 *   level = Low (< mediumFrom), Medium (>= mediumFrom), High (>= highFrom)
 *
 * Editing this file is the only change needed to adjust the rules.
 */

const RISK_RULES = {
  version: 'RULES_V1_PROTOTYPE',

  // Score thresholds (prototype assumption).
  thresholds: {
    mediumFrom: 30, // 0-29  -> Low
    highFrom: 60, //  30-59 -> Medium, 60+ -> High
  },
  maxScore: 100,

  // Factor 1: customer type. Companies carry more structural risk than individuals.
  customerType: { Individual: 5, Company: 15 },

  // Factor 2: country exposure of the customer's stated country.
  country: {
    domestic: 'IN', // 0 points
    domesticPoints: 0,
    standardPoints: 10, // any other country not listed below
    // ILLUSTRATIVE lists only - not an official jurisdiction rating.
    elevated: { codes: ['AF', 'NG', 'VE', 'YE', 'PK'], points: 25 },
    high: { codes: ['IR', 'KP', 'SY', 'MM'], points: 40 },
  },

  // Factor 3: business activity (companies only).
  businessActivity: {
    'Information Technology': 0,
    Manufacturing: 5,
    Retail: 5,
    Healthcare: 0,
    Education: 0,
    Agriculture: 0,
    Construction: 10,
    'Financial Services': 10,
    'Real Estate': 20,
    'Jewellery & Precious Metals': 20,
    'Import / Export Trading': 15,
    'Casinos & Gaming': 30,
    'Virtual Assets / Crypto': 30,
    'Money Services / Remittance': 30,
    'Non-profit / NGO': 15,
    Other: 5,
  },

  // Factor 4: occupation indicators (individuals only), matched on keywords.
  // Cash-intensive or high-value-goods occupations get a small uplift.
  occupationKeywords: [
    { keywords: ['jewel', 'bullion'], points: 15, label: 'High-value goods occupation' },
    { keywords: ['real estate', 'property broker'], points: 10, label: 'Real-estate occupation' },
    { keywords: ['self-employed', 'business owner', 'trader'], points: 5, label: 'Self-employed / business income' },
  ],

  // Factor 5: SIMULATED PEP screening.
  // A potential PEP is a reason for enhanced due diligence, NEVER for automatic rejection.
  pep: {
    // Occupation keywords that raise a *potential* PEP indicator.
    occupationKeywords: ['politician', 'minister', 'member of parliament', 'mla', 'mp', 'elected', 'government official', 'judge'],
    points: 30,
  },

  // Factor 6: SIMULATED sanctions-list screening against the fictional list below.
  // A potential match adds points and flags the case for manual review - it does NOT reject.
  sanctions: { points: 40 },

  // Factor 7: other documented indicators.
  other: {
    // Individuals under this age at registration are a (mild) indicator of limited financial history.
    youngAgeBelow: 21,
    youngAgePoints: 5,
    // Companies incorporated within this many days get a "new entity" uplift.
    newCompanyWithinDays: 365,
    newCompanyPoints: 10,
  },
};

/**
 * FICTIONAL watch-list used by the simulated screening. These names are invented for the
 * demo; matching them proves nothing about any real person or company.
 */
const SIMULATED_WATCHLISTS = {
  pep: ['rajiv malhotra demo', 'sunita verma demo'],
  sanctions: ['northstar trading demo llc', 'viktor demo petrov', 'blackwater demo holdings'],
};

module.exports = { RISK_RULES, SIMULATED_WATCHLISTS };
