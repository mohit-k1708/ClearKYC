/**
 * KYC requirement management: which documents each customer type + risk level must provide.
 * Rules are data (rows in "KYCRequirement"), so analysts can change them without a code change.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const audit = require('./auditService');
const { conflict, notFound, badRequest } = require('../utils/errors');
const { DOCUMENT_TYPES, RISK_LEVELS } = require('../config/kycRules');
const { toIso, parseIso, todayIso } = require('../utils/dates');
const { isRequirementCurrent } = require('./kycEngine');

const TYPE_IDS = { Individual: 1, Company: 2 }; // fixed by the Scene 1 migration

function requirementDto(r, asOf = todayIso()) {
  return {
    id: r.id,
    customerType: r.customerType.typeName,
    riskLevel: r.riskLevel,
    documentType: r.documentType,
    isMandatory: r.isMandatory,
    effectiveFrom: toIso(r.effectiveFrom),
    effectiveTo: toIso(r.effectiveTo),
    isActive: r.isActive,
    // Active AND inside its date window today: only these rules affect KYC completeness.
    inEffect: isRequirementCurrent(r, asOf),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** Built-in document types plus any custom type that appears in a requirement. */
async function getKnownDocumentTypes() {
  const rows = await prisma.kYCRequirement.findMany({ distinct: ['documentType'], select: { documentType: true } });
  const names = new Set(DOCUMENT_TYPES.map((t) => t.name));
  rows.forEach((r) => names.add(r.documentType));
  return [...names].sort((a, b) => a.localeCompare(b));
}

/** Matches "pan" to the canonical "PAN" so the same document type is never spelled two ways. */
async function canonicalDocumentType(input) {
  const known = await getKnownDocumentTypes();
  return known.find((k) => k.toLowerCase() === input.toLowerCase()) || input;
}

async function listRequirements({ customerType, riskLevel, isActive, search }) {
  const where = {};
  if (customerType) where.customerTypeId = TYPE_IDS[customerType];
  if (riskLevel) where.riskLevel = riskLevel;
  if (isActive !== undefined) where.isActive = isActive;
  if (search) where.documentType = { contains: search, mode: 'insensitive' };

  const rows = await prisma.kYCRequirement.findMany({ where, include: { customerType: true } });
  const asOf = todayIso();
  return rows
    .sort(
      (a, b) =>
        a.customerTypeId - b.customerTypeId ||
        RISK_LEVELS.indexOf(a.riskLevel) - RISK_LEVELS.indexOf(b.riskLevel) ||
        a.documentType.localeCompare(b.documentType)
    )
    .map((r) => requirementDto(r, asOf));
}

async function getRequirementRow(id) {
  const row = await prisma.kYCRequirement.findUnique({ where: { id }, include: { customerType: true } });
  if (!row) throw notFound(`KYC requirement ${id} was not found`);
  return row;
}

const rangesOverlap = (aFrom, aTo, bFrom, bTo) => aFrom <= (bTo || '9999-12-31') && bFrom <= (aTo || '9999-12-31');

/**
 * Two ACTIVE rules for the same customer type + risk level + document type must not cover the
 * same dates, otherwise it would be unclear which one applies.
 */
async function assertNoOverlap({ customerTypeId, riskLevel, documentType, effectiveFrom, effectiveTo, isActive }, ignoreId) {
  if (!isActive) return;
  const others = await prisma.kYCRequirement.findMany({
    where: { customerTypeId, riskLevel, documentType, isActive: true, ...(ignoreId ? { id: { not: ignoreId } } : {}) },
  });
  const clash = others.find((o) => rangesOverlap(effectiveFrom, effectiveTo, toIso(o.effectiveFrom), toIso(o.effectiveTo)));
  if (clash) {
    throw conflict('REQUIREMENT_OVERLAP', 'An active requirement for this customer type, risk level and document already covers these dates', {
      documentType: 'Overlaps an existing active requirement (id ' + clash.id + '). Change the dates or deactivate the other one.',
      existingRequirementId: clash.id,
    });
  }
}

function toRow(data) {
  return {
    customerTypeId: TYPE_IDS[data.customerType],
    riskLevel: data.riskLevel,
    isMandatory: data.isMandatory,
    effectiveFrom: parseIso(data.effectiveFrom),
    effectiveTo: data.effectiveTo ? parseIso(data.effectiveTo) : null,
    isActive: data.isActive,
  };
}

function mapUniqueError(err) {
  if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
    return conflict('DUPLICATE_REQUIREMENT', 'This requirement already exists for the same effective-from date', {
      effectiveFrom: 'A requirement with this customer type, risk level, document and start date already exists',
    });
  }
  return err;
}

async function createRequirement(data) {
  const documentType = await canonicalDocumentType(data.documentType);
  const row = { ...toRow(data), documentType };
  await assertNoOverlap({ ...row, effectiveFrom: toIso(row.effectiveFrom), effectiveTo: toIso(row.effectiveTo) });
  try {
    const created = await prisma.$transaction(async (tx) => {
      const made = await tx.kYCRequirement.create({ data: row, include: { customerType: true } });
      await audit.record(tx, {
        actionType: 'REQUIREMENT_CREATED', entityType: 'KYCRequirement', entityId: made.id, entityRef: `${made.customerType.typeName} / ${made.riskLevel} / ${made.documentType}`,
        newValues: { customerType: made.customerType.typeName, riskLevel: made.riskLevel, documentType: made.documentType, isMandatory: made.isMandatory, isActive: made.isActive, effectiveFrom: toIso(made.effectiveFrom), effectiveTo: toIso(made.effectiveTo) },
        reason: 'KYC requirement created',
      });
      return made;
    });
    return requirementDto(created);
  } catch (err) {
    throw mapUniqueError(err);
  }
}

async function updateRequirement(id, data) {
  await getRequirementRow(id);
  const documentType = await canonicalDocumentType(data.documentType);
  const row = { ...toRow(data), documentType };
  await assertNoOverlap({ ...row, effectiveFrom: toIso(row.effectiveFrom), effectiveTo: toIso(row.effectiveTo) }, id);
  try {
    const before = await prisma.kYCRequirement.findUnique({ where: { id } });
    const updated = await prisma.$transaction(async (tx) => {
      const made = await tx.kYCRequirement.update({ where: { id }, data: row, include: { customerType: true } });
      const diff = audit.changedFields(before, made, ['riskLevel', 'documentType', 'isMandatory', 'isActive', 'effectiveFrom', 'effectiveTo']);
      await audit.record(tx, {
        actionType: 'REQUIREMENT_UPDATED', entityType: 'KYCRequirement', entityId: id, entityRef: `${made.customerType.typeName} / ${made.riskLevel} / ${made.documentType}`,
        previousValues: diff.previous, newValues: diff.next, reason: 'KYC requirement edited',
      });
      return made;
    });
    return requirementDto(updated);
  } catch (err) {
    throw mapUniqueError(err);
  }
}

async function setRequirementActive(id, isActive) {
  const existing = await getRequirementRow(id);
  if (isActive) {
    await assertNoOverlap(
      {
        customerTypeId: existing.customerTypeId,
        riskLevel: existing.riskLevel,
        documentType: existing.documentType,
        effectiveFrom: toIso(existing.effectiveFrom),
        effectiveTo: toIso(existing.effectiveTo),
        isActive: true,
      },
      id
    );
  }
  const updated = await prisma.$transaction(async (tx) => {
    const made = await tx.kYCRequirement.update({ where: { id }, data: { isActive }, include: { customerType: true } });
    await audit.record(tx, {
      actionType: 'REQUIREMENT_STATUS_CHANGED', entityType: 'KYCRequirement', entityId: id, entityRef: `${made.customerType.typeName} / ${made.riskLevel} / ${made.documentType}`,
      previousValues: { isActive: existing.isActive }, newValues: { isActive }, reason: isActive ? 'KYC requirement activated' : 'KYC requirement deactivated',
    });
    return made;
  });
  return requirementDto(updated);
}

function parseId(raw) {
  if (!/^\d{1,9}$/.test(String(raw))) throw badRequest('Id must be a whole number');
  return Number(raw);
}

module.exports = {
  listRequirements,
  createRequirement,
  updateRequirement,
  setRequirementActive,
  getKnownDocumentTypes,
  canonicalDocumentType,
  parseId,
  TYPE_IDS,
};
