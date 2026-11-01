#!/usr/bin/env node
/**
 * Database backup, restore and listing for the local PostgreSQL server. Uses PostgreSQL's own template copy, so a backup is a
 * complete, transaction-consistent copy of the database (data, schema, triggers, sequences) stored as another database.
 *
 *   npm run db:backup                              copy `clearkyc` to clearkyc_backup_<date>      (add --name=clearkyc_backup_x)
 *   npm run db:backups                             list the databases (name, size)
 *   npm run db:restore -- --from=clearkyc_backup_x --confirm-replace-clearkyc
 *                                                  REPLACES `clearkyc` with that backup (destructive, needs the confirm flag)
 *
 * A template copy needs the source database to have no other connections: stop the API first (or pass --force, which disconnects
 * every other session from the source database; the API reconnects by itself on the next request).
 * Only databases named clearkyc... can be touched.
 */
const path = require('path');
const { Client } = require('pg');

const NAME = /^clearkyc[a-z0-9_]*$/;

function parse(argv) {
  const a = {};
  for (const x of argv) {
    if (!x.startsWith('--')) continue;
    const [k, v] = x.slice(2).split('=');
    a[k] = v === undefined ? true : v;
  }
  return a;
}

function admin() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
  const u = new URL(process.env.DATABASE_URL);
  const main = u.pathname.slice(1);
  u.pathname = '/postgres';
  u.search = '';
  return { client: new Client({ connectionString: u.toString() }), main };
}

async function disconnect(client, name) {
  await client.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
}

async function run(argv = process.argv.slice(2), command = argv.find((x) => !x.startsWith('--')) || process.env.npm_lifecycle_event?.replace('db:', '')) {
  const a = parse(argv);
  const { client, main } = admin();
  await client.connect();
  try {
    if (command === 'list' || command === 'backups') {
      const rows = (await client.query(`SELECT datname AS name, pg_size_pretty(pg_database_size(datname)) AS size FROM pg_database WHERE datname LIKE 'clearkyc%' ORDER BY 1`)).rows;
      for (const r of rows) console.log(`  ${r.name.padEnd(40)} ${r.size}`);
      return rows;
    }
    if (command === 'backup') {
      const source = a.source || main;
      const name = a.name || `clearkyc_backup_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
      if (!NAME.test(source) || !NAME.test(name) || source === name) throw new Error('Names must look like clearkyc_something and differ.');
      if ((await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) throw new Error(`${name} already exists: pick another --name (existing backups are never overwritten).`);
      if (a.force) await disconnect(client, source);
      try {
        await client.query(`CREATE DATABASE "${name}" TEMPLATE "${source}"`);
      } catch (err) {
        throw new Error(`Could not copy ${source}: ${err.message}. Stop the API (or add --force) and try again.`);
      }
      console.log(`Backup created: ${name} (copy of ${source})`);
      return name;
    }
    if (command === 'restore') {
      const from = a.from;
      if (!from || !NAME.test(from) || from === main) throw new Error('Give --from=<a backup database name>.');
      if (!a['confirm-replace-clearkyc']) throw new Error(`This REPLACES ${main} with ${from} and cannot be undone. Add --confirm-replace-clearkyc if you are sure (take a new backup of ${main} first with: npm run db:backup).`);
      if (!(await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [from])).rowCount) throw new Error(`${from} does not exist.`);
      await disconnect(client, main);
      await disconnect(client, from);
      await client.query(`DROP DATABASE IF EXISTS "${main}"`);
      await client.query(`CREATE DATABASE "${main}" TEMPLATE "${from}"`);
      console.log(`${main} was replaced with the contents of ${from}. Restart the API.`);
      return main;
    }
    throw new Error('Use: backup | list | restore');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  run().catch((err) => {
    console.error(`db backup tool: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { run };
