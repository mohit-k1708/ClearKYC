/**
 * scripts/localPostgres.js
 *
 * Starts a self-contained PostgreSQL server for local development (no installer,
 * no admin rights). Data is stored in the ".pgdata" folder at the project root.
 *
 *   npm run db:local
 *
 * Leave this terminal open while you work; press Ctrl+C to stop the database.
 * If you prefer your own PostgreSQL installation, skip this script and just point
 * DATABASE_URL in .env at it.
 *
 * The "postgres/postgres" credentials are for local development only.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const EmbeddedPostgres = require('embedded-postgres').default;

const dataDir = path.join(__dirname, '..', '.pgdata');
const port = Number(process.env.LOCAL_PG_PORT || 5433);
const dbName = 'clearkyc';

async function main() {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: true,
    // UTF8 so customer names in any script (e.g. Devanagari) are stored correctly.
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
  });

  // Only initialise the cluster the first time (when the folder is empty).
  const alreadyInitialised = fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  if (!alreadyInitialised) {
    console.log('Initialising a new local PostgreSQL cluster in .pgdata ...');
    await pg.initialise();
  }

  await pg.start();

  try {
    await pg.createDatabase(dbName);
    console.log(`Created database "${dbName}".`);
  } catch (err) {
    // "already exists" is expected after the first run.
    if (!/already exists/i.test(String(err.message))) throw err;
  }

  console.log(`\nPostgreSQL is running on localhost:${port} (database "${dbName}").`);
  console.log('Press Ctrl+C to stop.\n');

  const shutdown = async () => {
    console.log('\nStopping PostgreSQL ...');
    try {
      await pg.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Could not start the local PostgreSQL:', err);
  process.exit(1);
});
