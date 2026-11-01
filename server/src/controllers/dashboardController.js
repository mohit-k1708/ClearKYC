const dashboardService = require('../services/dashboardService');

// GET /api/dashboard/summary
async function getSummary(req, res) {
  res.json({ data: await dashboardService.getSummary() });
}

module.exports = { getSummary };
