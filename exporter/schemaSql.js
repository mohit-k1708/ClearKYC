/**
 * schema.sql, built from the LIVE database catalogue (not from the Prisma file), so it is exactly what the dataset was written into:
 * sequences, functions, tables, primary / unique / check constraints, indexes, foreign keys and triggers - in an order that loads
 * into an empty database. Names are sorted, nothing machine- or time-specific is written, so the text is reproducible.
 */
// Phase 6 application settings are not KYC data: they are left out of the dataset (table, its sequence, index and helper functions).
const APP_TABLES = ['SystemSetting'];
const APP_FUNCTIONS = ['valid_expiry_alert_days', 'system_setting_check_reviewer'];
const list = (names) => names.map((n) => `'${n}'`).join(', ');
const TABLE_FILTER = `c.relnamespace = 'public'::regnamespace AND c.relkind = 'r' AND c.relname <> '_prisma_migrations' AND c.relname NOT IN (${list(APP_TABLES)})`;

async function buildSchemaSql(db) {
  const rows = async (sql) => (await db.query(sql)).rows;
  const out = [
    '-- ClearKYC database schema (PostgreSQL 17), generated from the live catalogue of the dataset database.',
    '-- Load order: sequences, functions, tables, keys and checks, indexes, foreign keys, triggers.',
    '-- Then load seed.sql, which disables the triggers while it inserts and enables them again afterwards.',
    '',
    'SET check_function_bodies = off; -- a function may mention a table that is created further down',
    'SET standard_conforming_strings = on;',
    '',
  ];

  out.push('-- Sequences');
  for (const s of await rows(`SELECT sequencename, data_type::text AS type, start_value, min_value, max_value, increment_by, cycle FROM pg_sequences WHERE schemaname = 'public' AND sequencename NOT IN (${list(APP_TABLES.map((t) => `${t}_id_seq`))}) ORDER BY sequencename`)) {
    out.push(`CREATE SEQUENCE "${s.sequencename}" AS ${s.type} START WITH ${s.start_value} INCREMENT BY ${s.increment_by} MINVALUE ${s.min_value} MAXVALUE ${s.max_value} CACHE 1${s.cycle ? ' CYCLE' : ' NO CYCLE'};`);
  }

  out.push('', '-- Functions');
  for (const f of await rows(`SELECT pg_get_functiondef(p.oid) AS def FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.proname NOT IN (${list(APP_FUNCTIONS)})
                               AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e') ORDER BY p.proname, pg_get_function_identity_arguments(p.oid)`)) {
    out.push(`${f.def.trim()};`, '');
  }

  const tables = await rows(`SELECT c.oid, c.relname FROM pg_class c WHERE ${TABLE_FILTER} ORDER BY c.relname`);
  out.push('-- Tables');
  for (const t of tables) {
    const cols = await rows(`SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS def
                              FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
                             WHERE a.attrelid = ${t.oid} AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`);
    const lines = cols.map((c) => `    "${c.attname}" ${c.type}${c.def ? ` DEFAULT ${c.def}` : ''}${c.attnotnull ? ' NOT NULL' : ''}`);
    out.push(`CREATE TABLE "${t.relname}" (\n${lines.join(',\n')}\n);`, '');
  }

  const constraints = await rows(`SELECT c.relname AS tbl, k.conname, k.contype, pg_get_constraintdef(k.oid) AS def FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
                                    WHERE ${TABLE_FILTER} AND k.connamespace = 'public'::regnamespace
                                    ORDER BY array_position(ARRAY['p','u','c','f']::"char"[], k.contype), c.relname, k.conname`);
  out.push('-- Primary keys, unique and check constraints');
  for (const k of constraints.filter((x) => x.contype !== 'f')) out.push(`ALTER TABLE "${k.tbl}" ADD CONSTRAINT "${k.conname}" ${k.def};`);

  out.push('', '-- Sequence ownership');
  for (const o of await rows(`SELECT s.relname AS seq, t.relname AS tbl, a.attname FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
                               JOIN pg_class t ON t.oid = d.refobjid JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
                              WHERE d.deptype = 'a' AND s.relnamespace = 'public'::regnamespace AND t.relname <> '_prisma_migrations' AND t.relname NOT IN (${list(APP_TABLES)}) ORDER BY s.relname`)) {
    out.push(`ALTER SEQUENCE "${o.seq}" OWNED BY "${o.tbl}"."${o.attname}";`);
  }

  out.push('', '-- Indexes');
  for (const i of await rows(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' AND tablename NOT IN (${list(APP_TABLES)})
                               AND indexname NOT IN (SELECT conname FROM pg_constraint WHERE connamespace = 'public'::regnamespace) ORDER BY tablename, indexname`)) {
    out.push(`${i.indexdef};`);
  }

  out.push('', '-- Foreign keys');
  for (const k of constraints.filter((x) => x.contype === 'f')) out.push(`ALTER TABLE "${k.tbl}" ADD CONSTRAINT "${k.conname}" ${k.def};`);

  out.push('', '-- Triggers');
  for (const t of await rows(`SELECT pg_get_triggerdef(t.oid) AS def FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal AND ${TABLE_FILTER} ORDER BY c.relname, t.tgname`)) {
    out.push(`${t.def};`);
  }
  return `${out.join('\n')}\n`;
}

module.exports = { buildSchemaSql };
