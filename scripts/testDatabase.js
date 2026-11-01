#!/usr/bin/env node
/**
 * The dedicated TEST database (`clearkyc_test`): an isolated PostgreSQL database on the same local server, built from the project's
 * own seed scripts, so backend and browser tests never touch the development database `clearkyc`.
 *
 *   npm run test:db:setup                 create it if missing (migrations + the five seed scripts)
 *   npm run test:db:reset                 drop and rebuild it (only ever the TEST database)
 *   node scripts/withTestDatabase.js <command ...>   run any command with DATABASE_URL pointing at the test database
 *
 * Safety: the name must start with clearkyc_test; the development database cannot be selected by this tool.
 */
const path = require('path');
const { spawnSync } = require('child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const TEST_DB = process.env.TEST_DATABASE_NAME || 'clearkyc_test';
if (!/^clearkyc_test[a-z0-9_]*$/.test(TEST_DB)) throw new Error(`The test database name must start with clearkyc_test (got ${TEST_DB}).`);

function urlFor(database) {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const base = process.env.DEV_DATABASE_URL || process.env.DATABASE_URL;
  const u = new URL(base);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

const testDatabaseUrl = () => urlFor(TEST_DB);

function child(args, env) {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`${args.join(' ')} failed:\n${(res.stdout || '').slice(-1500)}\n${(res.stderr || '').slice(-1500)}`);
  return res.stdout;
}

/** True when the test database has the tables and at least one customer. A database left behind by an interrupted setup has none. */
async function isSeeded() {
  const probe = new Client({ connectionString: testDatabaseUrl() });
  try {
    await probe.connect();
    const r = await probe.query(`SELECT CASE WHEN to_regclass('"Customer"') IS NULL THEN 0 ELSE (SELECT count(*) FROM "Customer") END AS n`);
    return Number(r.rows[0].n) > 0;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => {});
  }
}

async function ensureTestDatabase({ recreate: forceRecreate = false, log = console.log } = {}) {
  const admin = new Client({ connectionString: urlFor('postgres') });
  await admin.connect();
  let created = false;
  try {
    const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DB])).rowCount > 0;
    // an existing but empty test database (setup was interrupted, for example by a missing Prisma client) is rebuilt instead of reused
    const recreate = forceRecreate || (exists && !(await isSeeded()));
    if (exists && recreate && !forceRecreate) log(`${TEST_DB} exists but holds no data (an earlier setup was interrupted): rebuilding it.`);
    if (exists && recreate) {
      await admin.query(`DROP DATABASE "${TEST_DB}" WITH (FORCE)`); // the TEST database only: the name is validated above
    }
    if (!exists || recreate) {
      await admin.query(`CREATE DATABASE "${TEST_DB}" ENCODING 'UTF8' TEMPLATE template0 LC_COLLATE 'C' LC_CTYPE 'C'`);
      created = true;
    }
  } finally {
    await admin.end();
  }
  const env = { DATABASE_URL: testDatabaseUrl() };
  if (!created) {
    // an existing test database keeps its data, but always gets any new migration (a no-op when it is up to date)
    child([require.resolve('prisma/build/index.js', { paths: [ROOT] }), 'migrate', 'deploy'], env);
    return { database: TEST_DB, created: false };
  }
  log(`Building ${TEST_DB} ...`);
  child([require.resolve('prisma/build/index.js', { paths: [ROOT] }), 'migrate', 'deploy'], env);
  for (const [script, args] of [
    ['generateCustomers.js', ['--reset']], ['generateKycData.js', ['--reset']], ['generateOwnershipData.js', ['--reset']], ['generateReviewData.js', ['--reset']], ['generateScene5Data.js', ['--reset']],
  ]) {
    log(`  seed: ${script}`);
    child([path.join(ROOT, 'scripts', script), ...args], env);
  }
  const db = new Client({ connectionString: testDatabaseUrl() });
  await db.connect();
  const counts = (await db.query(`SELECT (SELECT count(*) FROM "Customer")::int AS customers, (SELECT count(*) FROM "Document")::int AS documents, (SELECT count(*) FROM "ReviewCase")::int AS review_cases, (SELECT count(*) FROM "Alert")::int AS alerts`)).rows[0];
  await db.end();
  log(`  ready: ${JSON.stringify(counts)}`);
  return { database: TEST_DB, created: true, counts };
}

if (require.main === module) {
  const recreate = process.argv.includes('--recreate');
  ensureTestDatabase({ recreate })
    .then((r) => console.log(r.created ? `\nTest database ${r.database} is ready.\n` : `\nTest database ${r.database} already exists (use npm run test:db:reset to rebuild it).\n`))
    .catch((err) => {
      console.error(`Test database setup stopped: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { ensureTestDatabase, testDatabaseUrl, TEST_DB };
