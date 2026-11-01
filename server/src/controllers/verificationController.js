/**
 * HTTP layer for the verification workflow.
 */
const service = require('../services/verificationService');
const { parseId } = require('../services/requirementService');
const { verificationSchema } = require('../utils/kycValidation');
const { parse } = require('./requirementController');

// POST /api/documents/:documentId/verifications   (requires an authorised reviewer)
async function createVerification(req, res) {
  const decision = parse(verificationSchema, req.body);
  const verification = await service.recordVerification(parseId(req.params.documentId), req.reviewer, decision);
  res.status(201).json({ data: verification });
}

// GET /api/documents/:documentId/verifications   (full history, newest first)
async function listVerifications(req, res) {
  res.json({ data: await service.listVerifications(parseId(req.params.documentId)) });
}

module.exports = { createVerification, listVerifications };
