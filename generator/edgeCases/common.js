/**
 * Shared helpers for the edge-case modules. Every module receives a context:
 *   ctx.db             a connected pg client on the isolated EDGE database (never the development database)
 *   ctx.referenceDate  YYYY-MM-DD
 *   ctx.stamp          the timestamp (end of the reference day) used for changes made "on the reference date"
 *   ctx.rng            a random stream dedicated to this module (forked from the seed by name)
 *   ctx.used           customers already involved in a planted issue or a legitimate control: one customer, one problem
 *   ctx.people         { reviewers, analysts, deciders } Reviewer ids
 */
const path = require('path');

function connectionString(database) {
  require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });
  const u = new URL(process.env.DATABASE_URL);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

/** Edit distance ratio (1 = identical). Only used to make sure a planted name is clearly different from the real one. */
function similarity(a, b) {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x === y) return 1;
  let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= y.length; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

/** customer id (database) -> Set of person_ref, from the ownership bridge. Two companies are RELATED when they share a person. */
async function ownershipLinks(db) {
  const rows = (await db.query('SELECT company_customer_id AS company, person_ref FROM "CompanyOwnership"')).rows;
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.company)) map.set(r.company, new Set());
    map.get(r.company).add(r.person_ref);
  }
  return (a, b) => {
    const x = map.get(a);
    const y = map.get(b);
    return Boolean(x && y && [...x].some((p) => y.has(p)));
  };
}

async function loadPeople(db) {
  const rows = (await db.query('SELECT id, role FROM "Reviewer" WHERE is_active ORDER BY id')).rows;
  const ids = (roles) => rows.filter((r) => roles.includes(r.role)).map((r) => r.id);
  return { reviewers: ids(['Reviewer']), analysts: ids(['Analyst']), deciders: ids(['Reviewer', 'Admin']) };
}

/** Picks up to `count` items in a seeded order, skipping customers that are already used, and marks the chosen ones used. */
function pick(ctx, candidates, count, customerOf) {
  const chosen = [];
  for (const item of ctx.rng.shuffle(candidates)) {
    if (chosen.length >= count) break;
    const customer = customerOf(item);
    if (ctx.used.customers.has(customer)) continue;
    ctx.used.customers.add(customer);
    chosen.push(item);
  }
  return chosen;
}

module.exports = { connectionString, similarity, ownershipLinks, loadPeople, pick };
