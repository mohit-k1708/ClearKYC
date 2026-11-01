/**
 * Verification workflow: a reviewer records a decision on a document.
 *
 * Every decision is a NEW row in "Verification". Earlier rows are never changed (the database
 * blocks UPDATE and DELETE), so the full history is preserved. The newest row is the document's
 * current status, and a database trigger copies it to Document.status in the same transaction.
 *
 * This is a SIMULATED MANUAL REVIEW, not a government or identity-provider check.
 */
const prisma = require('../utils/prisma');
const { AppError, conflict, notFound } = require('../utils/errors');
const { todayIso, toIso } = require('../utils/dates');
const { effectiveStatus } = require('./kycEngine');
const { verificationDto } = require('./documentService');
const audit = require('./auditService');

// Verification decision -> audit action
const AUDIT_FOR_STATUS = {
  'In Review': 'VERIFICATION_STARTED',
  Verified: 'DOCUMENT_VERIFIED',
  Rejected: 'DOCUMENT_REJECTED',
  'Requires Resubmission': 'DOCUMENT_RESUBMISSION_REQUESTED',
  Pending: 'VERIFICATION_RESET',
};

async function listVerifications(documentId) {
  const doc = await prisma.document.findUnique({ where: { id: documentId }, select: { id: true, status: true } });
  if (!doc) throw notFound(`Document ${documentId} was not found`);
  const rows = await prisma.verification.findMany({ where: { documentId }, orderBy: { id: 'desc' }, include: { reviewer: true } });
  return { documentId, currentStatus: doc.status, items: rows.map(verificationDto) };
}

/**
 * @param {number} documentId
 * @param {{id:number}} reviewer  already authorised by requireReviewer
 * @param {{status:string, remarks?:string}} decision  already validated
 */
async function recordVerification(documentId, reviewer, decision, asOf = todayIso()) {
  const created = await prisma.$transaction(async (tx) => {
    // Lock the document so two reviewers cannot decide on the same version at the same moment.
    const rows = await tx.$queryRaw`SELECT id, status, expiry_date AS "expiryDate" FROM "Document" WHERE id = ${documentId} FOR UPDATE`;
    if (rows.length === 0) throw notFound(`Document ${documentId} was not found`);
    const doc = rows[0];

    if (doc.status === decision.status) {
      throw conflict('STATUS_UNCHANGED', `The document is already ${doc.status}`, { status: `The document is already ${doc.status}` });
    }
    // An expired document can be rejected or sent back, but it cannot be approved.
    if (decision.status === 'Verified' && effectiveStatus({ status: doc.status, expiryDate: doc.expiryDate }, asOf) === 'Expired') {
      throw new AppError(409, 'DOCUMENT_EXPIRED', `This document expired on ${toIso(doc.expiryDate)} and cannot be verified. Ask the customer to resubmit a current document.`, {
        status: 'An expired document cannot be verified',
      });
    }

    const verification = await tx.verification.create({
      data: { documentId, reviewerId: reviewer.id, status: decision.status, remarks: decision.remarks ?? null },
      include: { reviewer: true },
    });
    const document = await tx.document.findUnique({ where: { id: documentId }, select: { customerId: true, documentType: true, customer: { select: { customerCode: true } } } });
    await audit.record(tx, {
      actionType: AUDIT_FOR_STATUS[decision.status] ?? 'VERIFICATION_RESET', entityType: 'Document', entityId: documentId, entityRef: `${document.customer.customerCode} / ${document.documentType}`, customerId: document.customerId,
      previousValues: { status: doc.status }, newValues: { status: decision.status, verificationId: verification.id },
      reason: decision.remarks ?? null, actor: reviewer,
    });
    return verification;
  });
  return verificationDto(created);
}

module.exports = { listVerifications, recordVerification };
