const service = require('../services/onboardingDecisionService');

async function getDecisions(req, res) {
  res.json({ data: await service.getDecisions(req.params.customerId) });
}

// body: { decision, reason, followUpAction?, waivers?: [{ exceptionId, reason }] } (see services/onboardingDecisionService.js)
async function createDecision(req, res) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  res.status(201).json({ data: await service.recordDecision(req.params.customerId, body, req.reviewer) });
}

module.exports = { getDecisions, createDecision };
