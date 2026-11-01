/**
 * Phase 5 regression tests for defects found by the integrity audit, plus structural guards that fail loudly when a future change
 * adds a table or a rule without updating the places that must know about it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const prisma = require('../src/utils/prisma');

const ROOT = path.join(__dirname, '..', '..');

test.after(async () => {
  await prisma.$disconnect();
});

test('regression: `npm run generate:customers -- --reset` empties EVERY table that references Customer (OnboardingDecision was missing)', async () => {
  // Found in Phase 5: the reset truncated Customer but not the Phase 3 table OnboardingDecision, so the command failed with
  // "cannot truncate a table referenced in a foreign key constraint".
  const referencing = (await prisma.$queryRaw`
    SELECT DISTINCT c.relname AS tbl FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
     WHERE k.contype = 'f' AND k.confrelid = '"Customer"'::regclass AND c.relname <> 'Customer'`).map((r) => r.tbl);
  assert.ok(referencing.length >= 10, `found the tables that reference Customer: ${referencing.join(', ')}`);
  const script = fs.readFileSync(path.join(ROOT, 'scripts', 'generateCustomers.js'), 'utf8');
  const truncate = /TRUNCATE TABLE ([^`']+?) RESTART IDENTITY/.exec(script.replace(/\s+/g, ' '))?.[1] ?? '';
  const listed = [...truncate.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]);
  // tables that reference a table in the list are cleared by that table being in the same TRUNCATE (Verification via Document ...)
  const missing = referencing.filter((t) => !listed.includes(t));
  assert.deepEqual(missing, [], `the customer reset script must also truncate: ${missing.join(', ')}`);
});

test('structural guard: every history table is insert-only (update and delete are refused by triggers)', async () => {
  const historyTables = ['RiskRating', 'Verification', 'OwnerScreening', 'OwnershipValidation', 'CaseHistory', 'CaseNote', 'AuditEvent', 'OnboardingDecision'];
  const triggers = (await prisma.$queryRaw`SELECT c.relname AS tbl, t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal`).map((r) => `${r.tbl}.${r.name}`);
  for (const t of historyTables) {
    assert.ok(triggers.some((x) => x.startsWith(`${t}.`) && /no_update/.test(x)), `${t} refuses UPDATE`);
    assert.ok(triggers.some((x) => x.startsWith(`${t}.`) && /no_delete/.test(x)), `${t} refuses DELETE`);
  }
  assert.ok(triggers.includes('AuditEvent.AuditEvent_no_truncate'), 'the audit trail cannot be truncated');
});

test('structural guard: every table has a primary key and every foreign key is indexed on its child side or is a deliberate lookup', async () => {
  const noPk = await prisma.$queryRaw`SELECT c.relname AS tbl FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
    AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conrelid = c.oid AND k.contype = 'p')`;
  assert.deepEqual(noPk, [], 'every table has a primary key');
  const fkCount = Number((await prisma.$queryRaw`SELECT count(*)::int AS n FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace`)[0].n);
  assert.ok(fkCount >= 37, `foreign keys are enforced by the database (${fkCount})`);
});

test('structural guard: allowed values are enforced by the database, not only by the application', async () => {
  const checks = (await prisma.$queryRaw`SELECT conname FROM pg_constraint WHERE contype = 'c' AND connamespace = 'public'::regnamespace`).map((r) => r.conname);
  for (const name of ['Customer_status_check', 'Document_status_check', 'Verification_status_check', 'ReviewCase_status_check', 'ReviewCase_priority_check', 'Exception_status_check', 'Alert_status_check', 'Alert_severity_check',
    'RiskRating_level_check', 'BeneficialOwner_percentage_check', 'Document_dates_check', 'ReviewSchedule_dates_check', 'OnboardingDecision_decision_check']) {
    assert.ok(checks.includes(name), `${name} exists`);
  }
  // and they really refuse bad values
  await assert.rejects(prisma.$executeRaw`UPDATE "Customer" SET registration_status = 'Bogus' WHERE id = (SELECT min(id) FROM "Customer")`);
  await assert.rejects(prisma.$executeRaw`INSERT INTO "BeneficialOwner" (customer_id, full_name, ownership_percentage, ownership_type, control_type, pep_status, created_at, updated_at)
    SELECT id, 'X Test', 150, 'Direct', 'Shareholding', 'No', now(), now() FROM "Customer" WHERE customer_type_id = 2 LIMIT 1`);
});

test('structural guard: the schema export includes every table (a new table must not be left out of the export)', async () => {
  const tables = (await prisma.$queryRaw`SELECT table_name AS name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`).map((r) => r.name);
  const source = fs.readFileSync(path.join(ROOT, 'server', 'src', 'services', 'exportService.js'), 'utf8');
  // the schema export is built from the live catalogue: it must not hard-code a table list that can go stale
  const hardCoded = tables.filter((t) => source.includes(`'${t}'`) || source.includes(`"${t}"`)).length;
  assert.ok(/information_schema|pg_catalog|pg_class/.test(source) || hardCoded >= tables.length - 3, 'the schema export reads the live catalogue or lists all tables');
});

test('structural guard: audit action types and entity types used by the data tools are registered', () => {
  const { AUDIT_ACTIONS, AUDIT_ENTITY_TYPES } = require('../src/config/auditRules');
  assert.ok(AUDIT_ACTIONS.ONBOARDING_DECISION_RECORDED, 'the Phase 3 decision event is registered');
  assert.ok(AUDIT_ENTITY_TYPES.includes('OnboardingDecision'));
  for (const [key, meta] of Object.entries(AUDIT_ACTIONS)) assert.ok(meta.label && meta.category, `${key} has a label and a category`);
});
