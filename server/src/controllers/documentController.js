/**
 * HTTP layer for documents. Create/update accept multipart/form-data (with an optional "file")
 * or plain JSON.
 */
const service = require('../services/documentService');
const { parseId } = require('../services/requirementService');
const { documentCreateSchema, documentUpdateSchema, documentQuerySchema } = require('../utils/kycValidation');
const { parse } = require('./requirementController');

// GET /api/documents?page=&pageSize=&search=&status=&expiry=&documentType=&customerId=
async function listDocuments(req, res) {
  const query = parse(documentQuerySchema, req.query, 'Invalid query parameters');
  const result = await service.listDocuments(query);
  res.json({ data: result.items, pagination: result.pagination });
}

// POST /api/documents
async function createDocument(req, res) {
  const data = parse(documentCreateSchema, req.body);
  res.status(201).json({ data: await service.createDocument(data, req.uploadedFile) });
}

// GET /api/documents/:id
async function getDocument(req, res) {
  res.json({ data: await service.getDocument(parseId(req.params.id)) });
}

// PUT /api/documents/:id
async function updateDocument(req, res) {
  const data = parse(documentUpdateSchema, req.body);
  res.json({ data: await service.updateDocument(parseId(req.params.id), data, req.uploadedFile) });
}

// GET /api/customers/:customerId/documents
async function listCustomerDocuments(req, res) {
  res.json({ data: await service.listCustomerDocuments(req.params.customerId) });
}

// GET /api/documents/:id/file   (the stored file, always delivered as a download)
async function downloadFile(req, res) {
  const { stream, fileName, mimeType } = await service.getDocumentFile(parseId(req.params.id));
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(fileName));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

module.exports = { listDocuments, createDocument, getDocument, updateDocument, listCustomerDocuments, downloadFile };
