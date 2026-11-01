/**
 * Document records: create, list, read, edit metadata, and download the stored file.
 *
 * A new document always starts as "Pending" (a Pending Verification row is written in the same
 * transaction). It never becomes Verified by being uploaded; only a reviewer's decision does.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { encrypt, decrypt, blindIndex } = require('../utils/crypto');
const { maskDocumentNumber } = require('../utils/mask');
const { AppError, conflict, notFound, badRequest } = require('../utils/errors');
const { parseIso, toIso, todayIso, addDays } = require('../utils/dates');
const { saveFile, deleteFile, openFile } = require('../utils/fileStorage');
const { typeInfo, EXPIRY_WARNING_DAYS } = require('../config/kycRules');
const { expiryInfo, effectiveStatus, isRequirementCurrent } = require('./kycEngine');
const { findCustomer } = require('./kycService');
const { getKnownDocumentTypes, canonicalDocumentType, TYPE_IDS } = require('./requirementService');
const audit = require('./auditService');
const { nameCheck } = require('../utils/nameMatching');

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
const normaliseNumber = (value) => value.replace(/\s+/g, ' ').trim().toUpperCase();

// ---------------------------------------------------------------------------------------
// Response shaping. Document numbers are decrypted ONLY to be masked.
// ---------------------------------------------------------------------------------------
function baseDto(d, customer, asOf) {
  const { expiryState, daysToExpiry } = expiryInfo(d.expiryDate, asOf);
  return {
    id: d.id,
    customer,
    requirementId: d.requirementId,
    documentType: d.documentType,
    documentNumberMasked: d.documentNumber ? maskDocumentNumber(decrypt(d.documentNumber)) : null,
    issueDate: toIso(d.issueDate),
    expiryDate: toIso(d.expiryDate),
    submissionDate: toIso(d.submissionDate),
    notes: d.notes,
    nameOnDocument: d.nameOnDocument ?? null,
    nameCheck: nameCheck({ registeredName: customer?.name, nameOnDocument: d.nameOnDocument, isCompany: customer?.customerType === 'Company' }),
    // `status` is the latest verification decision. `effectiveStatus` becomes "Expired" once the
    // expiry date has passed, even if the status still says Verified.
    status: d.status,
    effectiveStatus: effectiveStatus({ status: d.status, expiryDate: d.expiryDate }, asOf),
    expiryState,
    daysToExpiry,
    hasFile: Boolean(d.fileReference),
    file: d.fileReference ? { name: d.originalFileName, mimeType: d.fileMimeType, sizeBytes: d.fileSizeBytes } : null,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

const customerSummary = (c) => ({ id: c.id, customerId: c.customerCode, name: c.fullName, customerType: c.customerType.typeName });

function verificationDto(v) {
  return {
    id: v.id,
    documentId: v.documentId,
    status: v.status,
    remarks: v.remarks,
    verificationDate: v.verificationDate,
    reviewer: v.reviewer ? { id: v.reviewer.id, name: v.reviewer.name, role: v.reviewer.role } : null, // null = recorded by the system
  };
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------
async function getDocument(id, asOf = todayIso()) {
  const doc = await prisma.document.findUnique({
    where: { id },
    include: {
      customer: { include: { customerType: true, riskRatings: { orderBy: [{ assessmentDate: 'desc' }, { id: 'desc' }], take: 1 } } },
      requirement: true,
      verifications: { orderBy: { id: 'desc' }, include: { reviewer: true } },
    },
  });
  if (!doc) throw notFound(`Document ${id} was not found`);
  const dto = baseDto(doc, { ...customerSummary(doc.customer), riskLevel: doc.customer.riskRatings[0]?.riskLevel ?? null }, asOf);
  const history = doc.verifications.map(verificationDto);
  return {
    ...dto,
    requirement: doc.requirement ? { id: doc.requirement.id, documentType: doc.requirement.documentType, isMandatory: doc.requirement.isMandatory } : null,
    currentVerification: history[0] ?? null, // newest record decides the status
    verifications: history, // full history, newest first
  };
}

/** Paginated list with search (customer ID/name, document type) and filters (verification status, expiry). */
async function listDocuments({ page, pageSize, search, status, expiry, documentType, customerId }, asOf = todayIso()) {
  const soonEnd = addDays(asOf, EXPIRY_WARNING_DAYS);
  const conditions = [];
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(Prisma.sql`(c.customer_id ILIKE ${pattern} OR c.full_name ILIKE ${pattern} OR d.document_type ILIKE ${pattern})`);
  }
  if (status) conditions.push(Prisma.sql`d.status = ${status}`);
  if (documentType) conditions.push(Prisma.sql`d.document_type = ${documentType}`);
  if (customerId) conditions.push(Prisma.sql`c.customer_id = ${customerId.toUpperCase()}`);
  if (expiry === 'Expired') conditions.push(Prisma.sql`d.expiry_date < ${asOf}::date`);
  if (expiry === 'Expiring Soon') conditions.push(Prisma.sql`d.expiry_date >= ${asOf}::date AND d.expiry_date <= ${soonEnd}::date`);
  if (expiry === 'Valid') conditions.push(Prisma.sql`d.expiry_date > ${soonEnd}::date`);
  if (expiry === 'No Expiry') conditions.push(Prisma.sql`d.expiry_date IS NULL`);
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const from = Prisma.sql`
    FROM "Document" d
    JOIN "Customer" c ON c.id = d.customer_id
    JOIN "CustomerType" t ON t.id = c.customer_type_id`;

  const [rows, [{ total }]] = await Promise.all([
    prisma.$queryRaw`
      SELECT d.id, d.requirement_id AS "requirementId", d.document_type AS "documentType", d.document_number AS "documentNumber",
             d.issue_date AS "issueDate", d.expiry_date AS "expiryDate", d.submission_date AS "submissionDate", d.notes,
             d.status, d.name_on_document AS "nameOnDocument", d.file_reference AS "fileReference", d.original_file_name AS "originalFileName",
             d.file_mime_type AS "fileMimeType", d.file_size_bytes AS "fileSizeBytes", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
             c.id AS "cId", c.customer_id AS "cCode", c.full_name AS "cName", t.type_name AS "cType"
      ${from} ${where}
      ORDER BY d.submission_date DESC, d.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw`SELECT COUNT(*) AS total ${from} ${where}`,
  ]);

  const totalItems = Number(total);
  return {
    items: rows.map((r) => baseDto(r, { id: r.cId, customerId: r.cCode, name: r.cName, customerType: r.cType }, asOf)),
    pagination: { page, pageSize, totalItems, totalPages: Math.max(Math.ceil(totalItems / pageSize), 1) },
  };
}

/** Every document of one customer (newest first). */
async function listCustomerDocuments(customerIdParam, asOf = todayIso()) {
  const customer = await findCustomer(customerIdParam);
  const docs = await prisma.document.findMany({
    where: { customerId: customer.id },
    orderBy: [{ submissionDate: 'desc' }, { id: 'desc' }],
  });
  const summary = { id: customer.id, customerId: customer.customerId, name: customer.name, customerType: customer.customerType };
  return { customer: { ...summary, riskLevel: customer.riskLevel }, items: docs.map((d) => baseDto(d, summary, asOf)) };
}

// ---------------------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------------------
async function assertKnownType(documentType) {
  const canonical = await canonicalDocumentType(documentType);
  const known = await getKnownDocumentTypes();
  if (!known.includes(canonical)) {
    throw badRequest('Unknown document type', { documentType: `Choose one of the listed document types (${known.join(', ')})` });
  }
  return canonical;
}

function assertNumberRule(documentType, hasNumber) {
  if (typeInfo(documentType)?.requiresNumber && !hasNumber) {
    throw badRequest('Document number is required for this document type', { documentNumber: `A document number is required for ${documentType}` });
  }
}

/** The requirement a document counts against: customer's type + current risk level + document type, in effect on `onDate`. */
async function findRequirementId(customer, documentType, onDate) {
  const rows = await prisma.kYCRequirement.findMany({
    where: { customerTypeId: TYPE_IDS[customer.customerType], riskLevel: customer.riskLevel ?? undefined, documentType, isActive: true },
  });
  const current = rows.filter((r) => isRequirementCurrent(r, onDate));
  return (current.find((r) => r.isMandatory) || current[0])?.id ?? null;
}

function duplicateDocumentError() {
  return conflict('DUPLICATE_DOCUMENT', 'This document has already been submitted for the customer', {
    documentNumber: 'A document with the same type, number, issue date and submission date already exists for this customer',
  });
}

const fileColumns = (file, reference) => ({
  fileReference: reference,
  originalFileName: file.originalName,
  fileMimeType: file.mime,
  fileSizeBytes: file.size,
});

/**
 * When the name printed on a document does not match the customer's registered name, writes an audit event (in the business
 * transaction). Nothing is rejected or blocked: the document stays as it is and a person reviews the difference. Called on create,
 * and on update only when the printed name changed, so an unchanged mismatch is not logged again and again.
 */
async function recordNameMismatch(tx, { documentId, customer, documentType, printedName, previousName }) {
  if (!printedName) return null;
  const check = nameCheck({ registeredName: customer.name, nameOnDocument: printedName, isCompany: customer.customerType === 'Company' });
  if (check.status !== 'Mismatch') return null;
  return audit.record(tx, {
    actionType: 'DOCUMENT_NAME_MISMATCH_FLAGGED', entityType: 'Document', entityId: documentId, entityRef: `${customer.customerId} / ${documentType}`, customerId: customer.id,
    previousValues: previousName ? { nameOnDocument: previousName } : null,
    newValues: { nameOnDocument: printedName, registeredName: customer.name, similarity: check.similarity },
    reason: 'The name on the document differs from the registered name; flagged for a reviewer (not rejected automatically)',
  });
}

async function createDocument(data, file) {
  // 1. The customer must exist. (The database foreign key enforces this too.)
  let customer;
  try {
    customer = await findCustomer(data.customerId);
  } catch (err) {
    if (err instanceof AppError && err.status === 404) {
      throw new AppError(404, 'CUSTOMER_NOT_FOUND', `Customer ${data.customerId} does not exist`, { customerId: `Customer ${data.customerId} does not exist` });
    }
    throw err;
  }

  const documentType = await assertKnownType(data.documentType);
  assertNumberRule(documentType, Boolean(data.documentNumber));
  const requirementId = await findRequirementId(customer, documentType, data.submissionDate);

  const number = data.documentNumber ? normaliseNumber(data.documentNumber) : null;
  const numberHash = number ? blindIndex(`DOC:${documentType}`, number) : null;
  const printedName = data.nameOnDocument || null;

  // Friendly pre-check; the UNIQUE index is the real guard against simultaneous duplicates.
  if (numberHash) {
    const existing = await prisma.document.findFirst({
      where: { customerId: customer.id, documentType, documentNumberHash: numberHash, issueDate: parseIso(data.issueDate), submissionDate: parseIso(data.submissionDate) },
      select: { id: true },
    });
    if (existing) throw duplicateDocumentError();
  }

  // 2. Save the file first (outside the database), then the rows in ONE transaction.
  const reference = file ? await saveFile(file.buffer, file.ext) : null;
  try {
    const created = await prisma.$transaction(async (tx) => {
      const doc = await tx.document.create({
        data: {
          customerId: customer.id,
          requirementId,
          documentType,
          documentNumber: number ? encrypt(number) : null,
          documentNumberHash: numberHash,
          issueDate: parseIso(data.issueDate),
          expiryDate: data.expiryDate ? parseIso(data.expiryDate) : null,
          submissionDate: parseIso(data.submissionDate),
          notes: data.notes ?? null,
          nameOnDocument: printedName,
          ...(file ? fileColumns(file, reference) : {}),
        },
      });
      // The system opens the verification history with a Pending record (no reviewer yet).
      await tx.verification.create({ data: { documentId: doc.id, status: 'Pending', remarks: 'Submitted, awaiting review' } });
      await audit.record(tx, {
        actionType: 'DOCUMENT_SUBMITTED', entityType: 'Document', entityId: doc.id, entityRef: `${customer.customerId} / ${documentType}`, customerId: customer.id,
        newValues: { documentType, issueDate: data.issueDate, expiryDate: data.expiryDate ?? null, submissionDate: data.submissionDate, status: 'Pending', hasNumber: Boolean(number), hasFile: Boolean(file) },
        reason: 'Document submitted for verification',
      });
      await recordNameMismatch(tx, { documentId: doc.id, customer, documentType, printedName, previousName: null });
      return doc;
    });
    return getDocument(created.id);
  } catch (err) {
    if (reference) await deleteFile(reference);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw duplicateDocumentError();
    throw err;
  }
}

const MATERIAL_LABELS = { documentType: 'document type', documentNumber: 'document number', issueDate: 'issue date', expiryDate: 'expiry date', submissionDate: 'submission date', nameOnDocument: 'name on document', file: 'file' };

/**
 * Edits metadata. If an already-reviewed document changes in a way that could affect the review
 * (type, number, dates, file), a new Pending verification is recorded in the same transaction so a
 * stale "Verified" can never describe different content. Notes-only edits keep the status.
 */
async function updateDocument(id, data, file) {
  const existing = await prisma.document.findUnique({ where: { id }, include: { customer: { include: { customerType: true, riskRatings: { orderBy: [{ assessmentDate: 'desc' }, { id: 'desc' }], take: 1 } } } } });
  if (!existing) throw notFound(`Document ${id} was not found`);

  const documentType = await assertKnownType(data.documentType);
  const newNumber = data.documentNumber ? normaliseNumber(data.documentNumber) : null;
  const numberHash = newNumber ? blindIndex(`DOC:${documentType}`, newNumber) : existing.documentNumberHash; // blank = keep the stored number
  // A hash is scoped to the document type, so changing the type with a kept number would need a new number.
  if (!newNumber && existing.documentNumberHash && documentType !== existing.documentType) {
    throw badRequest('Enter the document number again for the new document type', { documentNumber: 'Re-enter the document number because the document type changed' });
  }
  assertNumberRule(documentType, Boolean(newNumber || existing.documentNumber));

  // absent = keep the stored name, blank = clear it, text = replace it
  const printedName = data.nameOnDocument === undefined ? existing.nameOnDocument : data.nameOnDocument || null;
  const nameChanged = printedName !== existing.nameOnDocument;

  const changed = [];
  if (documentType !== existing.documentType) changed.push('documentType');
  if (newNumber && numberHash !== existing.documentNumberHash) changed.push('documentNumber');
  if (data.issueDate !== toIso(existing.issueDate)) changed.push('issueDate');
  if ((data.expiryDate ?? null) !== toIso(existing.expiryDate)) changed.push('expiryDate');
  if (data.submissionDate !== toIso(existing.submissionDate)) changed.push('submissionDate');
  if (nameChanged) changed.push('nameOnDocument');
  if (file) changed.push('file');

  const customer = { customerType: existing.customer.customerType.typeName, riskLevel: existing.customer.riskRatings[0]?.riskLevel };
  const requirementId = await findRequirementId(customer, documentType, data.submissionDate);
  const newReference = file ? await saveFile(file.buffer, file.ext) : null;

  try {
    await prisma.$transaction(async (tx) => {
      // Lock the row so a reviewer's decision cannot slip in between reading the status and resetting it.
      const [{ status }] = await tx.$queryRaw`SELECT status FROM "Document" WHERE id = ${id} FOR UPDATE`;
      await tx.document.update({
        where: { id },
        data: {
          requirementId,
          documentType,
          ...(newNumber ? { documentNumber: encrypt(newNumber), documentNumberHash: numberHash } : {}),
          issueDate: parseIso(data.issueDate),
          expiryDate: data.expiryDate ? parseIso(data.expiryDate) : null,
          submissionDate: parseIso(data.submissionDate),
          notes: data.notes ?? null,
          nameOnDocument: printedName,
          ...(file ? fileColumns(file, newReference) : {}),
        },
      });
      if (changed.length > 0 && status !== 'Pending') {
        await tx.verification.create({
          data: {
            documentId: id,
            status: 'Pending',
            remarks: `Re-verification required: ${changed.map((c) => MATERIAL_LABELS[c]).join(', ')} changed after the previous decision (${status})`,
          },
        });
      }
      // Previous/new values hold only the fields that changed. The document number itself is never stored: only THAT it changed.
      const diff = audit.changedFields(
        { documentType: existing.documentType, issueDate: existing.issueDate, expiryDate: existing.expiryDate, submissionDate: existing.submissionDate, notes: existing.notes },
        { documentType, issueDate: data.issueDate, expiryDate: data.expiryDate ?? null, submissionDate: data.submissionDate, notes: data.notes ?? null },
        ['documentType', 'issueDate', 'expiryDate', 'submissionDate', 'notes']
      );
      if (nameChanged) { diff.previous.nameOnDocument = existing.nameOnDocument; diff.next.nameOnDocument = printedName; }
      if (changed.includes('documentNumber')) { diff.previous.documentNumber = 'changed'; diff.next.documentNumber = 'changed'; }
      if (file) { diff.previous.file = existing.originalFileName ? 'replaced' : 'none'; diff.next.file = 'new file'; }
      if (changed.length > 0 && status !== 'Pending') diff.next.statusResetTo = 'Pending';
      await audit.record(tx, {
        actionType: 'DOCUMENT_UPDATED', entityType: 'Document', entityId: id, entityRef: `${existing.customer.customerCode} / ${documentType}`, customerId: existing.customerId,
        previousValues: { ...diff.previous, status }, newValues: diff.next,
        reason: changed.length > 0 && status !== 'Pending' ? 'Document details changed; the earlier verification no longer applies' : 'Document details updated',
      });
      if (nameChanged) {
        const owner = { id: existing.customerId, customerId: existing.customer.customerCode, name: existing.customer.fullName, customerType: existing.customer.customerType.typeName };
        await recordNameMismatch(tx, { documentId: id, customer: owner, documentType, printedName, previousName: existing.nameOnDocument });
      }
    });
  } catch (err) {
    if (newReference) await deleteFile(newReference);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw duplicateDocumentError();
    throw err;
  }
  if (newReference && existing.fileReference) await deleteFile(existing.fileReference);
  return getDocument(id);
}

/** Streams the stored file. Returns null parts when the document has no file. */
async function getDocumentFile(id) {
  const doc = await prisma.document.findUnique({ where: { id }, select: { fileReference: true, originalFileName: true, fileMimeType: true } });
  if (!doc) throw notFound(`Document ${id} was not found`);
  if (!doc.fileReference) throw notFound('This document has no uploaded file');
  const stream = openFile(doc.fileReference);
  if (!stream) throw notFound('The stored file is missing');
  return { stream, fileName: doc.originalFileName, mimeType: doc.fileMimeType };
}

module.exports = { getDocument, listDocuments, listCustomerDocuments, createDocument, updateDocument, getDocumentFile, verificationDto };
