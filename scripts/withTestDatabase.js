#!/usr/bin/env node
/**
 * Runs a command with DATABASE_URL pointing at the dedicated TEST database (created and seeded if it does not exist yet).
 *
 *   node scripts/withTestDatabase.js node --test --test-concurrency=1 "server/tests/*.test.js"
 *
 * The development database URL is kept in DEV_DATABASE_URL (only so the tools that need the server address can find it); the
 * command itself only ever sees the test database in DATABASE_URL.
 */
const { spawnSync } = require('child_process');
const path = require('path');
const { ensureTestDatabase, testDatabaseUrl, TEST_DB } = require('./testDatabase');

(async () => {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new Error('Give the command to run, for example: node scripts/withTestDatabase.js node --test server/tests');
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const dev = process.env.DEV_DATABASE_URL || process.env.DATABASE_URL;
  await ensureTestDatabase();
  const url = testDatabaseUrl();
  if (new URL(url).pathname.slice(1) !== TEST_DB) throw new Error('Refusing to run: the URL does not point at the test database.');
  const res = spawnSync(args[0] === 'node' ? process.execPath : args[0], args.slice(1), {
    cwd: path.join(__dirname, '..'), stdio: 'inherit', env: { ...process.env, DEV_DATABASE_URL: dev, DATABASE_URL: url },
  });
  process.exit(res.status ?? 1);
})().catch((err) => {
  console.error(`withTestDatabase: ${err.message}`);
  process.exit(1);
});
