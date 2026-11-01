/**
 * Scene 2 routes (mounted under /api by routes/index.js).
 * Static paths such as /kyc-requirements/document-types are declared before paths with :id.
 */
const express = require('express');
const requirements = require('../controllers/requirementController');
const documents = require('../controllers/documentController');
const verifications = require('../controllers/verificationController');
const kyc = require('../controllers/kycController');
const asyncHandler = require('../middleware/asyncHandler');
const requireReviewer = require('../middleware/requireReviewer');
const { uploadOptionalFile } = require('../middleware/upload');

const router = express.Router();

// KYC requirements
router.get('/kyc-requirements', asyncHandler(requirements.listRequirements));
router.get('/kyc-requirements/document-types', asyncHandler(requirements.listDocumentTypes));
router.post('/kyc-requirements', asyncHandler(requirements.createRequirement));
router.put('/kyc-requirements/:id', asyncHandler(requirements.updateRequirement));
router.patch('/kyc-requirements/:id/status', asyncHandler(requirements.setStatus));

// Documents
router.get('/documents', asyncHandler(documents.listDocuments));
router.post('/documents', uploadOptionalFile, asyncHandler(documents.createDocument));
router.get('/documents/:id', asyncHandler(documents.getDocument));
router.put('/documents/:id', uploadOptionalFile, asyncHandler(documents.updateDocument));
router.get('/documents/:id/file', asyncHandler(documents.downloadFile));
router.get('/customers/:customerId/documents', asyncHandler(documents.listCustomerDocuments));

// Verification workflow
router.post('/documents/:documentId/verifications', requireReviewer, asyncHandler(verifications.createVerification));
router.get('/documents/:documentId/verifications', asyncHandler(verifications.listVerifications));

// Completeness and exceptions
router.get('/customers/:customerId/kyc-completeness', asyncHandler(kyc.getCompleteness));
router.get('/kyc/exceptions', asyncHandler(kyc.listExceptions));

// People who can act in the workflow
router.get('/reviewers', asyncHandler(kyc.listReviewers));

module.exports = router;
