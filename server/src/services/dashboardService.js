/**
 * Dashboard counts. Everything is calculated from the database on every request,
 * so the numbers always match the stored records.
 */
const prisma = require('../utils/prisma');

async function getSummary() {
  // One query: customers joined to their newest risk rating, counted with FILTER.
  const [row] = await prisma.$queryRaw`
    SELECT
      COUNT(*)                                          AS total,
      COUNT(*) FILTER (WHERE t.type_name = 'Individual') AS individual,
      COUNT(*) FILTER (WHERE t.type_name = 'Company')    AS company,
      COUNT(*) FILTER (WHERE r.risk_level = 'Low')       AS low,
      COUNT(*) FILTER (WHERE r.risk_level = 'Medium')    AS medium,
      COUNT(*) FILTER (WHERE r.risk_level = 'High')      AS high
    FROM "Customer" c
    JOIN "CustomerType" t ON t.id = c.customer_type_id
    LEFT JOIN LATERAL (
      SELECT rr.risk_level FROM "RiskRating" rr
      WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1
    ) r ON true`;

  return {
    totalCustomers: Number(row.total),
    individualCustomers: Number(row.individual),
    companyCustomers: Number(row.company),
    lowRiskCustomers: Number(row.low),
    mediumRiskCustomers: Number(row.medium),
    highRiskCustomers: Number(row.high),
  };
}

module.exports = { getSummary };
