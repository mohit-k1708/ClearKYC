/**
 * Beneficial ownership: owners of company customers, ownership validation, and the overview lists.
 *
 * A beneficial owner is an INDIVIDUAL who ultimately owns or controls a COMPANY. Owners can never be
 * attached to an individual customer (checked here and by a database trigger).
 * Date of birth is personal data: it is encrypted in the database and only returned on the owner's own
 * detail endpoint. Lists show the birth year only.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { encrypt, decrypt, blindIndex } = require('../utils/crypto');
const { AppError, conflict, notFound, badRequest } = require('../utils/errors');
const { parseIso, toIso } = require('../utils/dates');
const { COUNTRIES } = require('../config/options');
const { validateOwnership, assessOwnerRisk, assessComplexity, normaliseName } = require('./ownershipEngine');
const audit = require('./auditService');

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
const SCREENING_TYPES = ['PEP', 'Sanctions'];

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

/** Finds a customer by CUS-000001 or numeric id. 404 if missing. */
async function findCustomerRow(db, idParam) {
  let where;
  if (/^CUS-\d+$/i.test(String(idParam))) where = { customerCode: String(idParam).toUpperCase() };
  else if (/^\d{1,9}$/.test(String(idParam))) where = { id: Number(idParam) };
  else throw badRequest('Customer ID must look like CUS-000001');
  const customer = await db.customer.findUnique({ where, include: { customerType: true } });
  if (!customer) throw notFound(`Customer ${idParam} was not found`);
  return customer;
}

/** Same, but the customer must be a COMPANY (beneficial ownership does not apply to individuals). */
async function findCompany(db, idParam) {
  const customer = await findCustomerRow(db, idParam);
  if (customer.customerType.typeName !== 'Company') {
    throw new AppError(400, 'NOT_A_COMPANY', 'Beneficial owners can only be recorded for company customers. This customer is an individual.', {
      customerId: 'Choose a company customer. Individuals do not have beneficial owners.',
    });
  }
  return customer;
}

const customerSummary = (c) => ({ id: c.id, customerId: c.customerCode, name: c.fullName, customerType: c.customerType.typeName });

// ---------------------------------------------------------------------------------------------
// Loading owners together with their latest screenings and calculated risk
// ---------------------------------------------------------------------------------------------

const decryptDob = (row) => (row.dateOfBirth ? decrypt(row.dateOfBirth) : null);

function toEngineOwner(row) {
  return {
    id: row.id,
    fullName: row.fullName,
    dateOfBirth: decryptDob(row),
    countryOfResidence: row.countryOfResidence,
    nationality: row.nationality,
    ownershipPercentage: row.ownershipPercentage === null ? null : Number(row.ownershipPercentage),
    ownershipType: row.ownershipType,
    controlType: row.controlType,
    pepStatus: row.pepStatus,
  };
}

/** Newest screening of each type. `screenings` must be sorted newest first. */
function latestByType(screenings) {
  const latest = {};
  for (const s of screenings) {
    if (SCREENING_TYPES.includes(s.screeningType) && !latest[s.screeningType]) {
      latest[s.screeningType] = { result: s.screeningResult, remarks: s.remarks, screenedAt: s.screenedAt, source: s.source };
    }
  }
  return latest;
}

/**
 * Everything the rules need about one company's owners: the owners, each owner's risk, the ownership
 * validation result and the structure complexity. `db` can be the Prisma client or a transaction.
 */
async function loadOwnerAnalysis(db, customerDbId) {
  const rows = await db.beneficialOwner.findMany({
    where: { customerId: customerDbId },
    orderBy: { id: 'asc' },
    include: { screenings: { orderBy: { id: 'desc' } } },
  });
  return buildOwnerAnalysis(rows);
}

/** The same analysis from owner rows that are already loaded (each with its screenings, newest first). */
function buildOwnerAnalysis(rows) {
  const entries = rows.map((row) => {
    const owner = toEngineOwner(row);
    const latest = latestByType(row.screenings);
    return { row, owner, latest, risk: assessOwnerRisk(owner, latest) };
  });
  const owners = entries.map((e) => e.owner);
  return { entries, validation: validateOwnership(owners), complexity: assessComplexity(owners) };
}

// ---------------------------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------------------------
function personDto(p) {
  return p ? { id: p.id, name: p.name, role: p.role } : null;
}

function screeningDto(s) {
  return {
    id: s.id,
    beneficialOwnerId: s.beneficialOwnerId,
    screeningType: s.screeningType,
    screeningResult: s.screeningResult,
    riskPoints: s.riskPoints,
    remarks: s.remarks,
    source: s.source,
    screenedAt: s.screenedAt,
    screenedBy: personDto(s.screenedBy),
  };
}

function ownerDto(entry, { detail = false } = {}) {
  const { row, owner, risk } = entry;
  const dto = {
    id: row.id,
    customerDbId: row.customerId,
    fullName: row.fullName,
    // Lists show the birth year only; the full date is returned by the owner's own detail endpoint.
    birthYear: owner.dateOfBirth ? Number(owner.dateOfBirth.slice(0, 4)) : null,
    countryOfResidence: row.countryOfResidence,
    countryOfResidenceName: row.countryOfResidence ? COUNTRIES[row.countryOfResidence] || row.countryOfResidence : null,
    nationality: row.nationality,
    nationalityName: row.nationality ? COUNTRIES[row.nationality] || row.nationality : null,
    ownershipPercentage: owner.ownershipPercentage,
    ownershipType: row.ownershipType,
    controlType: row.controlType,
    pepStatus: row.pepStatus,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    risk: { points: risk.points, level: risk.level, screening: risk.screening, missingFields: risk.missingFields, requiresReview: risk.reviewReasons.length > 0 },
  };
  if (detail) {
    dto.dateOfBirth = owner.dateOfBirth;
    dto.risk = { ...dto.risk, indicators: risk.indicators, reviewReasons: risk.reviewReasons };
  }
  return dto;
}

// ---------------------------------------------------------------------------------------------
// Owners
// ---------------------------------------------------------------------------------------------
async function listOwners(idParam) {
  const company = await findCompany(prisma, idParam);
  const analysis = await loadOwnerAnalysis(prisma, company.id);
  const lastRecorded = await prisma.ownershipValidation.findFirst({ where: { customerId: company.id }, orderBy: { id: 'desc' }, include: { checkedBy: true } });
  const levels = analysis.entries.map((e) => e.risk.level);
  return {
    customer: customerSummary(company),
    owners: analysis.entries.map((e) => ownerDto(e)),
    validation: { ...analysis.validation, lastRecorded: lastRecorded ? validationRecordDto(lastRecorded) : null },
    complexity: analysis.complexity,
    highestOwnerRisk: levels.includes('High') ? 'High' : levels.includes('Medium') ? 'Medium' : levels.length ? 'Low' : null,
  };
}

async function getOwner(id) {
  const row = await prisma.beneficialOwner.findUnique({ where: { id }, include: { screenings: { orderBy: { id: 'desc' }, include: { screenedBy: true } }, customer: { include: { customerType: true } } } });
  if (!row) throw notFound(`Beneficial owner ${id} was not found`);
  const owner = toEngineOwner(row);
  const latest = latestByType(row.screenings);
  const entry = { row, owner, latest, risk: assessOwnerRisk(owner, latest) };
  return { ...ownerDto(entry, { detail: true }), customer: customerSummary(row.customer), screenings: row.screenings.map(screeningDto) };
}

/** Same person if the normalised names match and the dates of birth match or either is unknown. */
async function assertNotDuplicate(customerDbId, candidate, ignoreId) {
  const existing = await prisma.beneficialOwner.findMany({ where: { customerId: customerDbId, ...(ignoreId ? { id: { not: ignoreId } } : {}) } });
  const name = normaliseName(candidate.fullName);
  const clash = existing.find((o) => {
    if (normaliseName(o.fullName) !== name) return false;
    const dob = decryptDob(o);
    return !dob || !candidate.dateOfBirth || dob === candidate.dateOfBirth;
  });
  if (clash) throw duplicateOwnerError(clash.id);
}

function duplicateOwnerError(existingId) {
  return conflict('DUPLICATE_OWNER', 'This owner is already recorded for the company', {
    fullName: `An owner with this name${existingId ? ` (owner #${existingId})` : ''} is already recorded for this company. Edit that record instead.`,
    existingOwnerId: existingId,
  });
}

function toRow(data) {
  const dob = data.dateOfBirth || null;
  return {
    fullName: data.fullName,
    dateOfBirth: dob ? encrypt(dob) : null,
    identityHash: dob ? blindIndex('OWNER', `${normaliseName(data.fullName)}|${dob}`) : null,
    countryOfResidence: data.countryOfResidence ?? null,
    nationality: data.nationality ?? null,
    ownershipPercentage: data.ownershipPercentage ?? null,
    ownershipType: data.ownershipType,
    controlType: data.controlType,
    pepStatus: data.pepStatus ?? 'Unknown',
    notes: data.notes ?? null,
  };
}

async function createOwner(idParam, data, actor) {
  const company = await findCompany(prisma, idParam);
  await assertNotDuplicate(company.id, data);
  try {
    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.beneficialOwner.create({ data: { ...toRow(data), customerId: company.id, createdById: actor.id, updatedById: actor.id } });
      // The owner's name, date of birth and notes are personal data and are not copied into the audit trail.
      await audit.record(tx, {
        actionType: 'OWNER_ADDED', entityType: 'BeneficialOwner', entityId: created.id, entityRef: `${company.customerCode} / owner #${created.id}`, customerId: company.id,
        newValues: { ownershipPercentage: data.ownershipPercentage ?? null, ownershipType: data.ownershipType, controlType: data.controlType, pepStatus: data.pepStatus ?? 'Unknown' },
        reason: 'Beneficial owner recorded', actor,
      });
      return created;
    });
    return getOwner(row.id);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw duplicateOwnerError();
    throw err;
  }
}

/** PUT replaces the editable fields. A blank optional field becomes "missing" again. */
async function updateOwner(id, data, actor) {
  const existing = await prisma.beneficialOwner.findUnique({ where: { id } });
  if (!existing) throw notFound(`Beneficial owner ${id} was not found`);
  await assertNotDuplicate(existing.customerId, data, id);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.beneficialOwner.update({ where: { id }, data: { ...toRow(data), updatedById: actor.id } });
      const base = { entityType: 'BeneficialOwner', entityId: id, entityRef: `owner #${id}`, customerId: existing.customerId, actor };
      const before = { ownershipPercentage: existing.ownershipPercentage == null ? null : Number(existing.ownershipPercentage), ownershipType: existing.ownershipType, controlType: existing.controlType, pepStatus: existing.pepStatus, countryOfResidence: existing.countryOfResidence, nationality: existing.nationality };
      const after = { ownershipPercentage: data.ownershipPercentage ?? null, ownershipType: data.ownershipType, controlType: data.controlType, pepStatus: data.pepStatus ?? 'Unknown', countryOfResidence: data.countryOfResidence ?? null, nationality: data.nationality ?? null };
      const diff = audit.changedFields(before, after, Object.keys(before));
      if ('ownershipPercentage' in diff.previous) {
        await audit.record(tx, { ...base, actionType: 'OWNERSHIP_PERCENTAGE_CHANGED', previousValues: { ownershipPercentage: diff.previous.ownershipPercentage }, newValues: { ownershipPercentage: diff.next.ownershipPercentage }, reason: 'Ownership percentage edited' });
        delete diff.previous.ownershipPercentage;
        delete diff.next.ownershipPercentage;
      }
      // Name and notes: only THAT they changed is recorded, never the values.
      const flags = {};
      if (existing.fullName !== data.fullName) flags.fullName = 'changed';
      if ((existing.notes ?? null) !== (data.notes ?? null)) flags.notes = 'changed';
      if (Object.keys(diff.previous).length > 0 || Object.keys(flags).length > 0) {
        await audit.record(tx, { ...base, actionType: 'OWNER_UPDATED', previousValues: { ...diff.previous, ...flags }, newValues: { ...diff.next, ...flags }, reason: 'Beneficial owner details edited' });
      }
    });
    return getOwner(id);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') throw duplicateOwnerError();
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// Ownership validation (live calculation + recorded history)
// ---------------------------------------------------------------------------------------------
function validationRecordDto(r) {
  return {
    id: r.id,
    totalOwnershipPercentage: Number(r.totalOwnershipPercentage),
    ownerCount: r.ownerCount,
    validationStatus: r.validationStatus,
    validationMessage: r.validationMessage,
    checkedAt: r.checkedAt,
    checkedBy: personDto(r.checkedBy),
  };
}

/** Live result calculated now, plus the last recorded checks. */
async function getOwnershipValidation(idParam) {
  const company = await findCompany(prisma, idParam);
  const [analysis, history] = await Promise.all([
    loadOwnerAnalysis(prisma, company.id),
    prisma.ownershipValidation.findMany({ where: { customerId: company.id }, orderBy: { id: 'desc' }, take: 20, include: { checkedBy: true } }),
  ]);
  const recorded = history.map(validationRecordDto);
  return {
    customer: customerSummary(company),
    current: analysis.validation,
    complexity: analysis.complexity,
    latestRecorded: recorded[0] ?? null,
    // True when owners changed since the last recorded check (or nothing was recorded yet).
    recordedCheckOutdated: !recorded[0] || recorded[0].validationStatus !== analysis.validation.status || recorded[0].totalOwnershipPercentage !== analysis.validation.totalPercentage || recorded[0].ownerCount !== analysis.validation.ownerCount,
    history: recorded,
  };
}

/** Records the current result as a new, permanent check. */
async function recordOwnershipValidation(idParam, actor) {
  const company = await findCompany(prisma, idParam);
  const { validation } = await loadOwnerAnalysis(prisma, company.id);
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.ownershipValidation.create({
      data: {
        customerId: company.id,
        totalOwnershipPercentage: validation.totalPercentage,
        ownerCount: validation.ownerCount,
        validationStatus: validation.status,
        validationMessage: validation.message,
        checkedById: actor?.id ?? null,
      },
      include: { checkedBy: true },
    });
    await audit.record(tx, {
      actionType: 'OWNERSHIP_VALIDATED', entityType: 'OwnershipValidation', entityId: created.id, entityRef: company.customerCode, customerId: company.id,
      newValues: { validationStatus: validation.status, totalOwnershipPercentage: validation.totalPercentage, ownerCount: validation.ownerCount },
      reason: validation.message, ...(actor ? { actor } : {}),
    });
    return created;
  });
  return { ...validationRecordDto(row), issues: validation.issues };
}

// ---------------------------------------------------------------------------------------------
// Overview (Ownership Management page) and dashboard counts
// ---------------------------------------------------------------------------------------------
const STATUS_SQL = Prisma.sql`CASE
  WHEN b.owner_count = 0 THEN 'NO_OWNERS'
  WHEN b.total_pct > 100 THEN 'EXCEEDS_100'
  WHEN b.missing_count > 0 THEN 'MISSING_PERCENTAGE'
  WHEN b.total_pct < 100 THEN 'BELOW_100'
  ELSE 'RECONCILED' END`;

const COMPANY_BASE = Prisma.sql`
  SELECT c.id, c.customer_id AS code, c.full_name AS name,
         o.owner_count, o.total_pct, o.missing_count,
         r.risk_level AS "riskLevel", r.assessment_status AS "assessmentStatus", r.assessment_code AS "assessmentCode"
  FROM "Customer" c
  JOIN "CustomerType" t ON t.id = c.customer_type_id AND t.type_name = 'Company'
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS owner_count, coalesce(sum(ownership_percentage), 0)::float8 AS total_pct,
           count(*) FILTER (WHERE ownership_percentage IS NULL)::int AS missing_count
    FROM "BeneficialOwner" bo WHERE bo.customer_id = c.id
  ) o ON true
  LEFT JOIN LATERAL (
    SELECT rr.risk_level, rr.assessment_status, rr.assessment_code FROM "RiskRating" rr
    WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1
  ) r ON true`;

/** Paginated list of company customers with their ownership status. Search matches company name/ID or an owner's name. */
async function listOwnershipOverview({ page, pageSize, search, status }) {
  const conditions = [];
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(Prisma.sql`(b.name ILIKE ${pattern} OR b.code ILIKE ${pattern} OR EXISTS (SELECT 1 FROM "BeneficialOwner" x WHERE x.customer_id = b.id AND x.full_name ILIKE ${pattern}))`);
  }
  if (status) conditions.push(Prisma.sql`(${STATUS_SQL}) = ${status}`);
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const [rows, [{ total }]] = await Promise.all([
    prisma.$queryRaw`
      WITH b AS (${COMPANY_BASE})
      SELECT b.id, b.code AS "customerId", b.name, b.owner_count AS "ownerCount", b.total_pct AS "totalPercentage", b.missing_count AS "missingCount",
             b."riskLevel", b."assessmentStatus", b."assessmentCode", (${STATUS_SQL}) AS "validationStatus"
      FROM b ${where}
      ORDER BY b.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw`WITH b AS (${COMPANY_BASE}) SELECT count(*) AS total FROM b ${where}`,
  ]);
  const totalItems = Number(total);
  return {
    items: rows.map((r) => ({ ...r, id: Number(r.id) })),
    pagination: { page, pageSize, totalItems, totalPages: Math.max(Math.ceil(totalItems / pageSize), 1) },
  };
}

/** Counts for the dashboard cards. */
async function getRiskDashboard() {
  const [row] = await prisma.$queryRaw`
    WITH b AS (${COMPANY_BASE})
    SELECT
      (SELECT count(*) FROM b) AS businesses,
      (SELECT count(*) FROM "BeneficialOwner") AS owners,
      (SELECT count(*) FROM b WHERE (${STATUS_SQL}) <> 'RECONCILED') AS issues,
      (SELECT count(*) FROM b WHERE (${STATUS_SQL}) = 'NO_OWNERS') AS no_owners`;
  const [risk] = await prisma.$queryRaw`
    SELECT
      count(*) FILTER (WHERE r.risk_level = 'High') AS high,
      count(*) FILTER (WHERE r.assessment_status = 'Requires Manual Review') AS review
    FROM "Customer" c
    LEFT JOIN LATERAL (
      SELECT rr.risk_level, rr.assessment_status FROM "RiskRating" rr
      WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1
    ) r ON true`;
  return {
    totalBusinessCustomers: Number(row.businesses),
    totalBeneficialOwners: Number(row.owners),
    ownershipIssues: Number(row.issues),
    companiesWithoutOwners: Number(row.no_owners),
    highRiskCustomers: Number(risk.high),
    customersRequiringManualReview: Number(risk.review),
  };
}

module.exports = {
  findCustomerRow,
  findCompany,
  customerSummary,
  loadOwnerAnalysis,
  buildOwnerAnalysis,
  toEngineOwner,
  latestByType,
  listOwners,
  getOwner,
  createOwner,
  updateOwner,
  getOwnershipValidation,
  recordOwnershipValidation,
  listOwnershipOverview,
  getRiskDashboard,
  COMPANY_BASE,
  STATUS_SQL,
  screeningDto,
  personDto,
  toIso,
  parseIso,
};
