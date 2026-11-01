const service = require('../services/settingsService');

async function getExpiryAlerts(req, res) {
  res.json({ data: await service.getExpirySettings() });
}

async function updateExpiryAlerts(req, res) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  res.json({ data: await service.updateExpiryAlertDays(body.expiryAlertDays, req.reviewer, body.reason) });
}

module.exports = { getExpiryAlerts, updateExpiryAlerts };
