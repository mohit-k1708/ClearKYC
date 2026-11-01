/**
 * Idempotent seed for the CustomerType lookup table.
 * (The migration already inserts these rows; this keeps `prisma migrate reset` happy.)
 * Fixed ids 1 = Individual and 2 = Company are required by a CHECK constraint on "Customer".
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  for (const [id, typeName] of [[1, 'Individual'], [2, 'Company']]) {
    await prisma.customerType.upsert({ where: { id }, update: { typeName }, create: { id, typeName } });
  }
  console.log('Customer types ready: Individual, Company');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
