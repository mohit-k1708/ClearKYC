/**
 * Customer business logic: registration, listing and profile lookup.
 * Controllers stay thin and call these functions.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { encrypt, decrypt, blindIndex } = require('../utils/crypto');
const { maskPan, maskAadhaar } = require('../utils/mask');
const { conflict, notFound, badRequest, AppError } = require('../utils/errors');
const { assessRisk } = require('./riskService');
const { COUNTRIES } = require('../config/options');
const audit = require('./auditService');

const TYPE_IDS = { Individual: 1, Company: 2 }; // fixed by the migration
const MAX_ID_RETRIES = 3;

// ---------------------------------------------------------------------------------------
// Response shaping - the ONLY place where identifiers are decrypted, and always masked.
// ---------------------------------------------------------------------------------------
function riskDto(rating) {
  if (!rating) return null;
  return {
    id: rating.id,
    score: rating.riskScore,
    level: rating.riskLevel,
    method: rating.assessmentMethod,
    assessedAt: rating.assessmentDate,
    ...rating.riskReasons, // { reasons, screening, requiresManualReview, thresholds }
  };
}

function customerDto(customer, ratings = []) {
  const [current, ...history] = ratings;
  return {
    id: customer.id,
    customerId: customer.customerCode,
    customerType: customer.customerType.typeName,
    name: customer.fullName,
    email: customer.email,
    phone: customer.phone,
    address: customer.address,
    country: customer.country,
    countryName: COUNTRIES[customer.country] || customer.country,
    panMasked: maskPan(decrypt(customer.panNumber)),
    aadhaarMasked: customer.aadhaarNumber ? maskAadhaar(decrypt(customer.aadhaarNumber)) : null,
    dateOfBirth: customer.dateOfBirth,
    occupation: customer.occupation,
    companyRegistrationNumber: customer.companyRegistrationNumber,
    businessActivity: customer.businessActivity,
    dateOfIncorporation: customer.dateOfIncorporation,
    registrationStatus: customer.registrationStatus,
    createdAt: customer.createdAt,
    updatedAt: customer.updatedAt,
    currentRisk: riskDto(current),
    riskHistory: history.map((r) => ({ score: r.riskScore, level: r.riskLevel, assessedAt: r.assessmentDate, method: r.assessmentMethod })),
  };
}

// ---------------------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------------------

/** Converts validated form data into the columns of the Customer table. */
function toCustomerRow(customerType, data) {
  const base = {
    customerTypeId: TYPE_IDS[customerType],
    email: data.email,
    phone: data.phone,
    address: data.address,
    country: data.country,
    panNumber: encrypt(data.panNumber),
    panHash: blindIndex('PAN', data.panNumber),
  };
  if (customerType === 'Individual') {
    return {
      ...base,
      fullName: data.fullName,
      dateOfBirth: data.dateOfBirth,
      occupation: data.occupation,
      aadhaarNumber: encrypt(data.aadhaarNumber),
      aadhaarHash: blindIndex('AADHAAR', data.aadhaarNumber),
    };
  }
  return {
    ...base,
    fullName: data.legalName,
    companyRegistrationNumber: data.registrationNumber,
    businessActivity: data.businessActivity,
    dateOfIncorporation: data.dateOfIncorporation,
  };
}

/** Friendly duplicate check before inserting (the UNIQUE constraints remain the real guard). */
async function findDuplicate(customerType, data) {
  const or = [{ panHash: blindIndex('PAN', data.panNumber) }];
  if (customerType === 'Individual') or.push({ aadhaarHash: blindIndex('AADHAAR', data.aadhaarNumber) });
  else or.push({ companyRegistrationNumber: data.registrationNumber });

  const existing = await prisma.customer.findFirst({ where: { OR: or }, select: { customerCode: true, panHash: true, aadhaarHash: true } });
  if (!existing) return null;

  const field =
    existing.panHash === blindIndex('PAN', data.panNumber)
      ? 'panNumber'
      : customerType === 'Individual' && existing.aadhaarHash === blindIndex('AADHAAR', data.aadhaarNumber)
        ? 'aadhaarNumber'
        : 'registrationNumber';
  return { field, customerId: existing.customerCode };
}

const DUPLICATE_MESSAGES = {
  panNumber: 'A customer with this PAN is already registered',
  aadhaarNumber: 'A customer with this Aadhaar number is already registered',
  registrationNumber: 'A company with this registration number is already registered',
};

/** Maps a Prisma unique-constraint violation (P2002) to a readable field name. */
function duplicateFieldFromError(err) {
  const target = [].concat(err.meta?.target ?? []).join(',');
  if (target.includes('pan_hash')) return 'panNumber';
  if (target.includes('aadhaar_hash')) return 'aadhaarNumber';
  if (target.includes('company_registration_number')) return 'registrationNumber';
  if (target.includes('customer_id')) return 'customerId';
  return null;
}

/**
 * Registers a customer: generates the Customer ID, saves the customer and stores the first
 * RiskRating in ONE transaction, so a customer never exists without an initial assessment.
 */
async function registerCustomer(customerType, data) {
  const duplicate = await findDuplicate(customerType, data);
  if (duplicate) {
    throw conflict('DUPLICATE_CUSTOMER', DUPLICATE_MESSAGES[duplicate.field], {
      [duplicate.field]: DUPLICATE_MESSAGES[duplicate.field],
      existingCustomerId: duplicate.customerId,
    });
  }

  const row = toCustomerRow(customerType, data);
  const risk = assessRisk(
    {
      customerType,
      fullName: row.fullName,
      country: data.country,
      occupation: data.occupation,
      businessActivity: data.businessActivity,
      dateOfBirth: data.dateOfBirth,
      dateOfIncorporation: data.dateOfIncorporation,
    },
    new Date()
  );

  for (let attempt = 1; attempt <= MAX_ID_RETRIES; attempt += 1) {
    try {
      const created = await prisma.$transaction(async (tx) => {
        // ID comes from the database sequence - never from the client.
        const [{ code }] = await tx.$queryRaw`SELECT next_customer_code() AS code`;
        const customer = await tx.customer.create({ data: { ...row, customerCode: code } });
        const rating = await tx.riskRating.create({
          data: {
            customerId: customer.id,
            riskScore: risk.score,
            riskLevel: risk.level,
            assessmentMethod: risk.method,
            riskReasons: {
              reasons: risk.reasons,
              screening: risk.screening,
              requiresManualReview: risk.requiresManualReview,
              thresholds: risk.thresholds,
            },
          },
        });
        // Audit events are written in the same transaction: the customer never exists without them. No PAN, Aadhaar, name or contact details.
        await audit.record(tx, {
          actionType: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: customer.id, entityRef: customer.customerCode, customerId: customer.id,
          newValues: { customerType, country: customer.country, registrationStatus: customer.registrationStatus },
          reason: 'Customer registered',
        });
        await audit.record(tx, {
          actionType: 'RISK_ASSESSMENT_CREATED', entityType: 'RiskRating', entityId: rating.id, entityRef: rating.assessmentCode, customerId: customer.id,
          newValues: { riskScore: rating.riskScore, riskLevel: rating.riskLevel, assessmentStatus: rating.assessmentStatus, method: rating.assessmentMethod },
          reason: 'Initial risk classification at onboarding',
        });
        return { customer, rating };
      });
      return getCustomer(created.customer.customerCode);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const field = duplicateFieldFromError(err);
        if (field === 'customerId') continue; // ID conflict: take the next number and retry
        if (field) {
          // Two identical submissions raced past the pre-check; the DB constraint caught it.
          throw conflict('DUPLICATE_CUSTOMER', DUPLICATE_MESSAGES[field], { [field]: DUPLICATE_MESSAGES[field] });
        }
      }
      throw err;
    }
  }
  throw new AppError(503, 'CUSTOMER_ID_CONFLICT', 'Could not allocate a unique Customer ID. Please try again.');
}

// ---------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------

/** Accepts the business ID ("CUS-000001") or the numeric database id. */
async function getCustomer(idParam) {
  let where;
  if (/^CUS-\d+$/i.test(idParam)) where = { customerCode: idParam.toUpperCase() };
  else if (/^\d{1,9}$/.test(idParam)) where = { id: Number(idParam) };
  else throw badRequest('Customer ID must look like CUS-000001');

  const customer = await prisma.customer.findUnique({
    where,
    include: { customerType: true, riskRatings: { orderBy: [{ assessmentDate: 'desc' }, { id: 'desc' }] } },
  });
  if (!customer) throw notFound(`Customer ${idParam} was not found`);
  return customerDto(customer, customer.riskRatings);
}

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * Paginated list. The "current" risk is the newest RiskRating per customer, so this uses SQL
 * (a LATERAL join) rather than Prisma's relation filters.
 */
async function listCustomers({ page, pageSize, search, type, risk }) {
  const conditions = [];
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(Prisma.sql`(c.full_name ILIKE ${pattern} OR c.customer_id ILIKE ${pattern})`);
  }
  if (type) conditions.push(Prisma.sql`t.type_name = ${type}`);
  if (risk) conditions.push(Prisma.sql`r.risk_level = ${risk}`);
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const from = Prisma.sql`
    FROM "Customer" c
    JOIN "CustomerType" t ON t.id = c.customer_type_id
    LEFT JOIN LATERAL (
      SELECT rr.risk_level, rr.risk_score FROM "RiskRating" rr
      WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1
    ) r ON true`;

  const [rows, [{ total }]] = await Promise.all([
    prisma.$queryRaw`
      SELECT c.id, c.customer_id AS "customerId", t.type_name AS "customerType", c.full_name AS name,
             c.email, c.phone, c.country, c.registration_status AS "registrationStatus",
             c.created_at AS "createdAt", r.risk_level AS "riskLevel", r.risk_score AS "riskScore"
      ${from} ${where}
      ORDER BY c.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    prisma.$queryRaw`SELECT COUNT(*) AS total ${from} ${where}`,
  ]);

  const totalItems = Number(total);
  return {
    items: rows.map((r) => ({ ...r, countryName: COUNTRIES[r.country] || r.country })),
    pagination: { page, pageSize, totalItems, totalPages: Math.max(Math.ceil(totalItems / pageSize), 1) },
  };
}

module.exports = { registerCustomer, getCustomer, listCustomers, toCustomerRow, TYPE_IDS };
