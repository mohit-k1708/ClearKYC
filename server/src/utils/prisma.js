// One shared Prisma client for the whole server (creating many clients exhausts DB connections).
require('../config/env'); // make sure .env is loaded before Prisma reads DATABASE_URL
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

module.exports = prisma;
