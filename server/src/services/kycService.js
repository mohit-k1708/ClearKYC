/**
 * KYC completeness and exceptions. Loads the data from the database and hands it to the pure
 * engine in kycEngine.js, so every number is calculated from stored records and never stored itself.
 */
const { Prisma } = require('@prisma/client');
const prisma = require('../utils/prisma');
const { notFound, badRequest } = require('../utils/errors');
const { todayIso, toIso } = require('../utils/dates');
const { EXPIRY_WARNING_DAYS } = require('../config/kycRules');
const { evaluateCustomerKyc, EXCEPTION, EXCEPTION_ORDER } = require('./kycEngine');

const DISCLAIMER =
  'Verification in this prototype is a simulated manual review. It is not a government or identity-provider check, and a Verified status does not prove that a document is genuine.';

const escapeLike = (text) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

const EXCEPTION_MESSAGES = {
  [EXCEPTION.MISSING]: 'Required document has not been submitted',
  [EXCEPTION.PENDING]: 'Submitted but not yet verified',
  [EXCEPTION.REJECTED]: 'Rejected by the reviewer',
  [EXCEPTION.RESUBMIT]: 'Reviewer asked for a resubmission',
  [EXCEPTION.EXPIRED]: 'Expiry date has passed, so it no longer counts as valid',
  [EXCEPTION.EXPIRING]: `Verified, but expires within ${EXPIRY_WARNING_DAYS} days`,
};

/**
 * Finds a customer by business ID (CUS-000001) or numeric id, with type and CURRENT risk level.
 * Throws 404 when the customer does not exist.
 */
async function findCustomer(idParam) {
  let where;
  if (/^CUS-\d+$/i.test(String(idParam))) where = { customerCode: String(idParam).toUpperCase() };
  else if (/^\d{1,9}$/.test(String(idParam))) where = { id: Number(idParam) };
  else throw badRequest('Customer ID must look like CUS-000001');

  const customer = await prisma.customer.findUnique({
    where,
    include: { customerType: true, riskRatings: { orderBy: [{ assessmentDate: 'desc' }, { id: 'desc' }], take: 1 } },
  });
  if (!customer) throw notFound(`Customer ${idParam} was not found`);
  return {
    id: customer.id,
    customerId: customer.customerCode,
    name: customer.fullName,
    customerType: customer.customerType.typeName,
    riskLevel: customer.riskRatings[0]?.riskLevel ?? null,
  };
}

async function loadRequirements() {
  const rows = await prisma.kYCRequirement.findMany({ include: { customerType: true } });
  return rows.map((r) => ({ ...r, customerType: r.customerType.typeName }));
}

/** KYC completeness for one customer, calculated now from the database. */
async function getCompleteness(idParam, asOf = todayIso()) {
  const customer = await findCustomer(idParam);
  if (!customer.riskLevel) throw badRequest('This customer has no risk rating yet, so requirements cannot be selected');

  const [requirements, documents] = await Promise.all([
    loadRequirements(),
    prisma.document.findMany({
      where: { customerId: customer.id },
      select: { id: true, documentType: true, status: true, expiryDate: true, submissionDate: true },
    }),
  ]);

  const result = evaluateCustomerKyc({ customerType: customer.customerType, riskLevel: customer.riskLevel, requirements, documents, asOf });
  return {
    customer: { id: customer.id, customerId: customer.customerId, name: customer.name, customerType: customer.customerType, riskLevel: customer.riskLevel },
    ...result,
    exceptions: result.exceptions.map((e) => ({ ...e, message: EXCEPTION_MESSAGES[e.type] })),
    expiryWarningDays: EXPIRY_WARNING_DAYS,
    disclaimer: DISCLAIMER,
  };
}

/**
 * KYC exceptions across customers (missing / pending / rejected / resubmission / expired / expiring).
 * Customers are evaluated in memory with the same engine as the single-customer endpoint.
 * Fine for thousands of customers; very large deployments should precompute or push this into SQL.
 */
async function listExceptions({ page, pageSize, type, customerType, risk, search }, asOf = todayIso()) {
  const conditions = [];
  if (customerType) conditions.push(Prisma.sql`t.type_name = ${customerType}`);
  if (risk) conditions.push(Prisma.sql`r.risk_level = ${risk}`);
  if (search) {
    const pattern = `%${escapeLike(search)}%`;
    conditions.push(Prisma.sql`(c.full_name ILIKE ${pattern} OR c.customer_id ILIKE ${pattern})`);
  }
  const where = conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;

  const [customers, requirements, documents] = await Promise.all([
    prisma.$queryRaw`
      SELECT c.id, c.customer_id AS "customerId", c.full_name AS name, t.type_name AS "customerType", r.risk_level AS "riskLevel"
      FROM "Customer" c
      JOIN "CustomerType" t ON t.id = c.customer_type_id
      LEFT JOIN LATERAL (
        SELECT rr.risk_level FROM "RiskRating" rr
        WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1
      ) r ON true
      ${where}
      ORDER BY c.id`,
    loadRequirements(),
    prisma.document.findMany({ select: { id: true, customerId: true, documentType: true, status: true, expiryDate: true, submissionDate: true } }),
  ]);

  const docsByCustomer = new Map();
  for (const d of documents) {
    if (!docsByCustomer.has(d.customerId)) docsByCustomer.set(d.customerId, []);
    docsByCustomer.get(d.customerId).push(d);
  }

  const all = [];
  const affected = new Set();
  for (const c of customers) {
    if (!c.riskLevel) continue;
    const result = evaluateCustomerKyc({
      customerType: c.customerType,
      riskLevel: c.riskLevel,
      requirements,
      documents: docsByCustomer.get(c.id) || [],
      asOf,
    });
    for (const e of result.exceptions) {
      affected.add(c.id);
      all.push({
        customerId: c.customerId,
        customerName: c.name,
        customerType: c.customerType,
        riskLevel: c.riskLevel,
        type: e.type,
        message: EXCEPTION_MESSAGES[e.type],
        documentType: e.documentType,
        isMandatory: e.isMandatory,
        documentId: e.document?.id ?? null,
        documentStatus: e.document?.status ?? null,
        expiryDate: e.document?.expiryDate ?? null,
        expiryState: e.document?.expiryState ?? null,
        daysToExpiry: e.document?.daysToExpiry ?? null,
      });
    }
  }

  const byType = Object.fromEntries(EXCEPTION_ORDER.map((t) => [t, 0]));
  all.forEach((e) => (byType[e.type] += 1));

  const filtered = (type ? all.filter((e) => e.type === type) : all).sort(
    (a, b) => EXCEPTION_ORDER.indexOf(a.type) - EXCEPTION_ORDER.indexOf(b.type) || a.customerId.localeCompare(b.customerId) || a.documentType.localeCompare(b.documentType)
  );
  const totalItems = filtered.length;

  return {
    asOf,
    summary: {
      customersChecked: customers.length,
      customersWithExceptions: affected.size,
      totalExceptions: all.length,
      byType,
      // submitted documents that are not (currently) verified: pending, in review, rejected, resubmission, expired
      submittedNotVerified: all.filter((e) => e.documentId && e.type !== EXCEPTION.EXPIRING).length,
    },
    items: filtered.slice((page - 1) * pageSize, page * pageSize),
    pagination: { page, pageSize, totalItems, totalPages: Math.max(Math.ceil(totalItems / pageSize), 1) },
  };
}

module.exports = { findCustomer, getCompleteness, listExceptions, loadRequirements, DISCLAIMER, toIso };
