/**
 * Target database handling. The generator writes into its OWN database (clearkyc_starter, clearkyc_medium, clearkyc_full by
 * default), created and migrated on demand on the same PostgreSQL server, so the existing development data is never touched.
 * Writing into the main database needs two explicit flags (--reset and --confirm-reset-main-database).
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { MAIN_DATABASE, ADMIN_DATABASE } = require('../config/generatorConfig');

const ROOT = path.join(__dirname, '..', '..');

function urlFor(baseUrl, databaseName) {
  const u = new URL(baseUrl);
  u.pathname = `/${databaseName}`;
  u.search = '';
  return u.toString();
}

async function ensureDatabase(adminUrl, name) {
  const { Client } = require('pg');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (exists.rowCount === 0) {
      if (!/^[a-z0-9_]+$/.test(name)) throw new Error('--database may only contain lowercase letters, digits and underscores');
      await client.query(`CREATE DATABASE "${name}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
      return true;
    }
    return false;
  } finally {
    await client.end();
  }
}

function migrate(databaseUrl) {
  const cli = require.resolve('prisma/build/index.js', { paths: [ROOT] });
  const res = spawnSync(process.execPath, [cli, 'migrate', 'deploy'], { cwd: ROOT, env: { ...process.env, DATABASE_URL: databaseUrl }, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`prisma migrate deploy failed:\n${res.stdout}\n${res.stderr}`);
}

const BUSINESS_TABLES = [
  'IdCounter', 'CompanyOwnership', 'AuditEvent', 'Alert', 'ValidationIssue', 'ValidationRun', 'CaseNote', 'CaseHistory', 'ReviewCase', 'Exception',
  'ReviewSchedule', 'Verification', 'Document', 'OwnerScreening', 'BeneficialOwner', 'OwnershipValidation', 'RiskRating', 'OnboardingDecision', 'Customer', 'KYCRequirement', 'SystemSetting', 'Reviewer',
]; // SystemSetting (Phase 6 application settings) references Reviewer, so it must be truncated with it
const CODE_SEQUENCES = ['customer_code_seq', 'risk_assessment_seq', 'exception_seq', 'review_case_seq', 'alert_seq', 'audit_event_seq'];

/**
 * Creates/migrates the target database, opens a Prisma client on it and makes sure it is safe to write.
 * Must be called BEFORE any server module is loaded: the application modules read DATABASE_URL when they are first required.
 */
async function prepareDatabase(cfg) {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL is not set (see .env)');
  const targetUrl = urlFor(baseUrl, cfg.databaseName);
  const isMain = cfg.databaseName === MAIN_DATABASE;
  if (isMain && !(cfg.resetBeforeGeneration && cfg.confirmResetMain)) {
    throw new Error('The main database "clearkyc" holds your development data. To replace it, pass BOTH --reset and --confirm-reset-main-database. Otherwise the generator uses its own database (default clearkyc_<scale>).');
  }

  const created = await ensureDatabase(urlFor(baseUrl, ADMIN_DATABASE), cfg.databaseName);
  process.env.DATABASE_URL = targetUrl; // the application modules (rules engines) are loaded after this point
  migrate(targetUrl);
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient({ datasources: { db: { url: targetUrl } } });

  const existing = await prisma.customer.count();
  if (existing > 0 && !cfg.resetBeforeGeneration) {
    await prisma.$disconnect();
    throw new Error(`Database "${cfg.databaseName}" already contains ${existing} customers. Nothing was changed. Use --reset to regenerate it (this deletes the data in "${cfg.databaseName}" only).`);
  }
  if (cfg.resetBeforeGeneration) await resetDatabase(prisma);
  return { prisma, databaseUrl: targetUrl, createdDatabase: created };
}

async function resetDatabase(prisma) {
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`, // the audit trail is immutable for the application; only this maintenance switch lifts it
    prisma.$executeRawUnsafe(`TRUNCATE TABLE ${BUSINESS_TABLES.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY`),
  ]);
  for (const seq of CODE_SEQUENCES) await prisma.$executeRawUnsafe(`ALTER SEQUENCE ${seq} RESTART WITH 1`);
}

module.exports = { prepareDatabase, resetDatabase, urlFor, BUSINESS_TABLES, CODE_SEQUENCES };
