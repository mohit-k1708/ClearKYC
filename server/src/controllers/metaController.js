/**
 * Static reference data and the documented risk rules, so the frontend never hard-codes them.
 */
const { COUNTRIES, BUSINESS_ACTIVITIES, OCCUPATIONS } = require('../config/options');
const { RISK_RULES } = require('../config/riskRules');

function getMeta(req, res) {
  res.json({
    data: {
      countries: Object.entries(COUNTRIES).map(([code, name]) => ({ code, name })),
      businessActivities: BUSINESS_ACTIVITIES,
      occupations: OCCUPATIONS,
      riskModel: {
        version: RISK_RULES.version,
        thresholds: RISK_RULES.thresholds,
        disclaimer:
          'Prototype assumptions for demonstration only. These are not official regulatory rules. Screening results are simulated.',
      },
    },
  });
}

module.exports = { getMeta };
