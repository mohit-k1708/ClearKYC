/**
 * Scene 5 synthetic data: a small, reproducible alert workflow history and a data-quality run on top of Scenes 1-4.
 *
 *   node scripts/generateScene5Data.js                 # use the existing alerts and work on some of them
 *   node scripts/generateScene5Data.js --reset         # first remove alerts, validation runs and their audit events, then detect again
 *   node scripts/generateScene5Data.js --as-of=2026-10-22   # detection date (defaults to today)
 *
 * Nothing here invents records. Alerts are DERIVED from the customers' real documents, ownership, risk and review data by the
 * same detection run the application uses. This script only ACTS on some of them, through the same service functions the
 * API uses (acknowledge, start work, resolve, dismiss), so every action is audited exactly as a real one would be. Which alerts
 * are chosen comes from the seeded random generator (seed 20261022), so the same data always gives the same history.
 * Audit events for customers, documents, owners, risk and cases were already written when Scenes 1-4 were generated.
 *
 * Order for a full rebuild:
 *   npm run generate:customers -- --reset
 *   npm run generate:kyc -- --reset --as-of=2026-10-22
 *   npm run generate:ownership -- --reset
 *   npm run generate:reviews -- --reset --as-of=2026-10-22
 *   npm run generate:scene5 -- --reset
 */
require('../server/src/config/env');
const prisma = require('../server/src/utils/prisma');
const { todayIso, parseIso } = require('../server/src/utils/dates');
const exceptionService = require('../server/src/services/exceptionService');
const alertService = require('../server/src/services/alertService');
const dataQuality = require('../server/src/services/dataQualityService');

const DEFAULT_SEED = 20261022;
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const seed = Number(args.seed ?? DEFAULT_SEED);
const asOf = args['as-of'] || todayIso();
if (!parseIso(asOf)) { console.error('--as-of must be a date like 2026-10-22'); process.exit(1); }

function mulberry32(a) {
  return function next() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

async function people() {
  const get = (email) => prisma.reviewer.findUnique({ where: { email } });
  const p = { analyst: await get('priya.analyst@example.com'), analyst2: await get('arjun.analyst@example.com'), reviewer: await get('asha.reviewer@example.com'), reviewer2: await get('rahul.reviewer@example.com') };
  if (Object.values(p).some((x) => !x)) throw new Error('The demo people do not exist yet. Run the Scene 1-4 generators first (see the header of this file).');
  return p;
}

async function reset() {
  console.log('Resetting: removing alerts, validation runs and their audit events ...');
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE entity_type IN ('Alert', 'ValidationRun', 'Export')`,
    prisma.$executeRawUnsafe('TRUNCATE TABLE "Alert", "ValidationIssue", "ValidationRun" RESTART IDENTITY'),
  ]);
  await prisma.$executeRawUnsafe('ALTER SEQUENCE alert_seq RESTART WITH 1');
}

const REMARKS = {
  ack: ['Seen; will follow up with the relationship manager.', 'Acknowledged during the morning queue review.', 'Noted. Customer file is being checked.'],
  progress: ['Working on this today.', 'Contacting the customer for an updated document.'],
  resolve: ['Customer supplied the missing information and the file was updated.', 'Reviewed with the relationship manager; no further action needed for this alert.', 'Checked the records: handled through the linked review case.'],
  dismiss: ['Informational alert; the matching case already covers this customer.'],
};
const pick = (list) => list[Math.floor(rand() * list.length)];

async function main() {
  console.log(`Scene 5 synthetic data (seed ${seed}, as of ${asOf})`);
  if ((await prisma.customer.count()) === 0) throw new Error('No customers found. Run the Scene 1-4 generators first (see the header of this file).');
  const who = await people();

  if (args.reset) await reset();
  else if ((await prisma.alert.count({ where: { status: { notIn: ['New'] } } })) > 0) {
    console.log('Alert workflow data already exists. Nothing changed. Use --reset to remove it and generate it again.');
    return;
  }

  // 1. Alerts come from detection (a no-op for anything already detected).
  const detected = await exceptionService.detect({ asOf });
  console.log(`Detection: ${detected.alertsCreated} alerts created, ${detected.alertsResolved} resolved automatically, ${detected.created} exceptions created.`);

  // 2. Work on a seeded selection of the ACTIVE alerts, in a fixed order, through the same functions the API uses.
  const active = await prisma.alert.findMany({ where: { status: 'New' }, orderBy: { id: 'asc' } });
  const ordinary = shuffle(active.filter((a) => !['POTENTIAL_PEP_MATCH', 'POTENTIAL_SANCTIONS_MATCH'].includes(a.alertType)));
  const investigations = shuffle(active.filter((a) => ['POTENTIAL_PEP_MATCH', 'POTENTIAL_SANCTIONS_MATCH'].includes(a.alertType)));
  const lowMedium = ordinary.filter((a) => ['Low', 'Medium'].includes(a.severity));
  const high = ordinary.filter((a) => a.severity === 'High');
  const used = new Set();
  const take = (list, n) => list.filter((a) => !used.has(a.id)).slice(0, n).map((a) => { used.add(a.id); return a; });

  const done = { acknowledged: 0, inProgress: 0, resolved: 0, dismissed: 0 };
  for (const a of take(ordinary, 6)) { await alertService.acknowledgeAlert(a.id, who.analyst, { remarks: pick(REMARKS.ack) }); done.acknowledged += 1; }
  for (const a of take(ordinary, 4)) { await alertService.changeAlertStatus(a.id, who.analyst2, { status: 'In Progress', remarks: pick(REMARKS.progress) }); done.inProgress += 1; }
  for (const a of take(lowMedium, 3)) { await alertService.resolveAlert(a.id, who.analyst, { resolutionNotes: pick(REMARKS.resolve) }); done.resolved += 1; }
  for (const a of take(high, 1)) { await alertService.resolveAlert(a.id, who.reviewer, { resolutionNotes: pick(REMARKS.resolve) }); done.resolved += 1; }
  for (const a of take(lowMedium, 1)) { await alertService.changeAlertStatus(a.id, who.reviewer2, { status: 'Dismissed', remarks: pick(REMARKS.dismiss) }); done.dismissed += 1; }
  // A potential sanctions / PEP match is only acknowledged and put in progress: it stays a POTENTIAL match until investigated.
  for (const a of investigations.slice(0, 2)) { await alertService.acknowledgeAlert(a.id, who.reviewer, { remarks: 'Potential match acknowledged; investigation to follow. Not confirmed.' }); done.acknowledged += 1; }
  console.log('Alert workflow actions:', done);

  // 3. One data quality run (checks only read the data).
  const run = await dataQuality.runValidation(who.reviewer);
  console.log(`Data quality run ${run.runId}: ${run.totalChecks} checks, ${run.passedChecks} passed, ${run.failedChecks} failed, ${run.warnings} warnings.`);

  const [byStatus, audit] = await Promise.all([
    prisma.$queryRaw`SELECT status, count(*)::int AS n FROM "Alert" GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw`SELECT count(*)::int AS n, count(DISTINCT action_type)::int AS actions FROM "AuditEvent"`,
  ]);
  console.log('Alerts by status:', Object.fromEntries(byStatus.map((r) => [r.status, r.n])));
  console.log(`Audit trail: ${audit[0].n} events across ${audit[0].actions} action types.`);
}

main()
  .catch((err) => { console.error('Generation failed:', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
