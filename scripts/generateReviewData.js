/**
 * scripts/generateReviewData.js - reproducible SYNTHETIC data for Scene 4.
 *
 *   node scripts/generateReviewData.js                 # demo users, review schedules, detected exceptions and example cases
 *   node scripts/generateReviewData.js --reset         # first remove all Scene 4 data (exceptions, cases, history, notes, schedules)
 *   node scripts/generateReviewData.js --as-of=2026-10-22   # fixed "today" for the date-based rules
 *   node scripts/generateReviewData.js --seed=7
 *
 * Nothing here is invented: exceptions come from REAL DETECTION over the Scene 1-3 records (missing and expired
 * documents, ownership totals, risk assessments, screenings, review schedules), and every case is created and moved
 * through the SAME service code the API uses, by named demo users. Case statuses are the real result of those actions,
 * never arbitrary values. Where a case is "resolved" the underlying issue is really fixed first (a reviewer verifies the document).
 *
 * Demo users (no passwords: pick one in the sidebar "Acting as" list):
 *   Operations Analysts   Vikram, Priya, Arjun
 *   Compliance Reviewers  Asha, Rahul, Neha
 *   Administrator         Meera
 *
 * Scenarios (12): missing document, expired document, rejected document, ownership above 100%, no beneficial owners,
 * high-risk customer requiring manual review, potential PEP match, overdue periodic review, upcoming periodic review,
 * an escalated case, a case waiting for the customer, and a case resolved with complete notes. A thirteenth case is
 * closed while its issue persists, which detection reports as "previous review closed without proper resolution".
 *
 * Same seed + same Scene 1-3 data + --reset  =>  the same exceptions, cases and history (timestamps are the run time).
 */
require('../server/src/config/env');
const path = require('path');
const { spawnSync } = require('child_process');
const prisma = require('../server/src/utils/prisma');
const { todayIso, addDays, addMonths, parseIso } = require('../server/src/utils/dates');
const { SCENE4_DEMO_USERS } = require('../server/src/config/reviewRules');
const exceptionService = require('../server/src/services/exceptionService');
const caseService = require('../server/src/services/reviewCaseService');
const scheduleService = require('../server/src/services/reviewScheduleService');
const verificationService = require('../server/src/services/verificationService');
const { findCustomer } = require('../server/src/services/kycService');

const DEFAULT_SEED = 20261022;

// ---- CLI arguments ------------------------------------------------------------------------------------------
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

// ---- Setup ---------------------------------------------------------------------------------------------------------
async function people() {
  if ((await prisma.reviewer.count()) === 0) {
    console.log('No reviewers found: creating the sample reviewers first ...');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'generateKycData.js'), '--requirements-only'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Could not create the sample reviewers');
  }
  for (const u of SCENE4_DEMO_USERS) await prisma.reviewer.upsert({ where: { email: u.email }, update: {}, create: u });
  const get = (email) => prisma.reviewer.findUniqueOrThrow({ where: { email } });
  return {
    vikram: await get('vikram.analyst@example.com'),
    priya: await get('priya.analyst@example.com'),
    arjun: await get('arjun.analyst@example.com'),
    asha: await get('asha.reviewer@example.com'),
    rahul: await get('rahul.reviewer@example.com'),
    neha: await get('neha.compliance@example.com'),
    meera: await get('meera.admin@example.com'),
  };
}

async function reset() {
  console.log('Resetting: removing exceptions, cases, case history, notes and review schedules ...');
  // Scene 5 alerts point at exceptions, so they are removed too, together with the audit events of everything removed here.
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE entity_type IN ('ReviewCase', 'ReviewSchedule', 'Exception', 'Alert')`,
    prisma.$executeRaw`DELETE FROM "IdCounter" WHERE scope = 'ALT' OR scope LIKE 'REV:%'`, // ALT-2026-000001 and REV-... start again
    prisma.$executeRawUnsafe('TRUNCATE TABLE "Alert", "CaseNote", "CaseHistory", "ReviewCase", "Exception", "ReviewSchedule" RESTART IDENTITY'),
  ]);
  await prisma.$executeRawUnsafe('ALTER SEQUENCE alert_seq RESTART WITH 1');
  await prisma.$executeRawUnsafe('ALTER SEQUENCE exception_seq RESTART WITH 1');
  await prisma.$executeRawUnsafe('ALTER SEQUENCE review_case_seq RESTART WITH 1');
}

/** Open exceptions of a type that do not have a case yet, in a seeded random order, one per customer. */
async function candidates(type, used) {
  const rows = await prisma.exception.findMany({ where: { exceptionType: type, status: 'Open', cases: { none: {} } }, orderBy: { id: 'asc' } });
  return shuffle(rows).filter((e) => !used.has(e.customerId));
}

// ---- Main ------------------------------------------------------------------------------------------------------------
async function main() {
  console.log(`Scene 4 synthetic data (seed ${seed}, as of ${asOf})`);
  if ((await prisma.customer.count()) === 0) throw new Error('No customers found. Run the Scene 1 generator first: npm run generate:customers -- --reset (then generate:kyc and generate:ownership)');
  const u = await people();
  if (args.reset) await reset();
  else if ((await prisma.exception.count()) > 0) {
    console.log('Scene 4 data already exists. Nothing changed. Use --reset to remove it and generate it again.');
    return;
  }

  // 1. Periodic review schedules for the "overdue" and "upcoming" scenarios (the rest are created by detection).
  const customers = await prisma.customer.findMany({ select: { id: true, customerCode: true }, orderBy: { id: 'asc' } });
  const picks = shuffle(customers);
  const usedCustomers = new Set();
  const scheduleScenarios = [
    { daysFromDue: -20, label: 'overdue by 20 days' },
    { daysFromDue: -45, label: 'overdue by 45 days' },
    { daysFromDue: -100, label: 'overdue by 100 days' },
    { daysFromDue: 15, label: 'due in 15 days' },
    { daysFromDue: 25, label: 'due in 25 days' },
  ];
  for (const s of scheduleScenarios) {
    const c = picks.pop();
    usedCustomers.add(c.id);
    const customer = await findCustomer(c.customerCode);
    const interval = scheduleService.intervalFor(customer.riskLevel);
    // last review date so that the next review falls `daysFromDue` days from today
    const last = addMonths(addDays(asOf, s.daysFromDue), -interval);
    await scheduleService.createSchedule(c.customerCode, { lastReviewDate: last });
    console.log(`  schedule: ${c.customerCode} (${customer.riskLevel} risk, ${interval}-month interval) ${s.label}`);
  }

  // 2. Detection over the real records. This creates the exceptions, and the periodic review cases that are due.
  const detected = await exceptionService.detect({ asOf });
  console.log(`Detection: ${detected.created} exceptions created, ${detected.casesCreated} periodic review cases created for ${detected.customersChecked} customers.`);

  // 3. Cases through the real workflow, by named demo users.
  const used = new Set();
  const made = [];
  const note = (label, c) => { made.push(`${label}: ${c.caseId} (${c.status}) for ${c.customer.customerId}`); };
  /** `needsNoApproval`: pick a customer whose case the analyst can resolve alone (not High risk). */
  async function fromException(type, label, creator, fn, { needsNoApproval = false } = {}) {
    let exc = null;
    for (const candidate of await candidates(type, used)) {
      if (needsNoApproval && (await findCustomer(candidate.customerId)).riskLevel === 'High') continue;
      exc = candidate;
      break;
    }
    if (!exc) { console.warn(`  (no open ${type} exception available for "${label}")`); return null; }
    used.add(exc.customerId);
    const created = await caseService.createCase({ exceptionId: exc.id }, creator);
    const final = await fn(created.caseId, created);
    note(label, final || created);
    return final || created;
  }
  const go = (caseId, body, who) => caseService.transitionCase(caseId, body, who);
  const asg = (caseId, body, who) => caseService.assignCase(caseId, body, who);
  const addNote = (caseId, text, who) => caseService.addNote(caseId, { note: text }, who);

  // 1. Missing mandatory document: analyst takes the case and starts the investigation
  await fromException('MANDATORY_DOCUMENT_MISSING', '1 missing document', u.priya, async (id) => {
    await asg(id, { assignedAnalystId: u.priya.id }, u.priya);
    await go(id, { action: 'start' }, u.priya);
    return addNote(id, 'Checked the customer file: the document was never received. Preparing a request to the customer.', u.priya);
  });

  // 11. Case waiting for the customer
  await fromException('MANDATORY_DOCUMENT_MISSING', '11 waiting for the customer', u.vikram, async (id) => {
    await asg(id, { assignedAnalystId: u.vikram.id }, u.vikram);
    await go(id, { action: 'start' }, u.vikram);
    return go(id, { action: 'request_customer', remarks: 'Requested the missing document from the customer by email. Waiting for a reply.' }, u.vikram);
  });

  // 2. Expired document
  await fromException('DOCUMENT_EXPIRED', '2 expired document', u.vikram, async (id) => {
    await asg(id, { assignedAnalystId: u.vikram.id }, u.vikram);
    await go(id, { action: 'start' }, u.vikram);
    return addNote(id, 'The expiry date has passed. The customer must provide a current copy.', u.vikram);
  });

  // 3. Rejected document: assigned to an analyst by a reviewer, not started yet
  await fromException('DOCUMENT_REJECTED', '3 rejected document', u.arjun, (id) => asg(id, { assignedAnalystId: u.arjun.id, remarks: 'Please follow up on the rejected document' }, u.asha));

  // 4. Ownership above 100%: needs compliance approval, so the analyst submits a proposal
  await fromException('OWNERSHIP_EXCEEDS_100', '4 ownership above 100%', u.priya, async (id) => {
    await asg(id, { assignedAnalystId: u.priya.id, assignedReviewerId: u.rahul.id }, u.asha);
    await go(id, { action: 'start' }, u.priya);
    await addNote(id, 'The percentages add up to more than 100%. Asked the customer for the shareholder register.', u.priya);
    return go(id, { action: 'submit_for_review', resolutionNotes: 'Proposed: ask the customer to correct the percentages and send a signed register before the owners are confirmed.', reviewerId: u.rahul.id }, u.priya);
  });

  // 5. Company without beneficial owners: created by the administrator, still unassigned
  await fromException('OWNERSHIP_NO_OWNERS', '5 no beneficial owners', u.meera, async () => null);

  // 6. High-risk customer requiring manual review: approval needed
  await fromException('RISK_MANUAL_REVIEW_REQUIRED', '6 high-risk, manual review', u.arjun, async (id) => {
    await asg(id, { assignedAnalystId: u.arjun.id }, u.arjun);
    await go(id, { action: 'start' }, u.arjun);
    return addNote(id, 'Reviewing the assessment reasons and the owner screening outcomes.', u.arjun);
  });

  // 7 + 10. Potential PEP match, escalated to a compliance reviewer
  await fromException('POTENTIAL_PEP_MATCH', '7 and 10 potential PEP match, escalated', u.priya, async (id) => {
    await asg(id, { assignedAnalystId: u.priya.id }, u.priya);
    await go(id, { action: 'start' }, u.priya);
    await addNote(id, 'The name matches, the date of birth does not. This needs a compliance decision: it is a potential match, not confirmed.', u.priya);
    return go(id, { action: 'escalate', remarks: 'Potential PEP match needs compliance review', reviewerId: u.neha.id }, u.priya);
  });

  // Potential sanctions match: investigated, never treated as confirmed
  await fromException('POTENTIAL_SANCTIONS_MATCH', 'potential sanctions match', u.arjun, async (id) => {
    await asg(id, { assignedAnalystId: u.arjun.id, assignedReviewerId: u.neha.id, priority: 'Critical' }, u.neha);
    await go(id, { action: 'start' }, u.arjun);
    return addNote(id, 'Comparing the owner against the demo watch-list entry. Potential match only: it must be investigated, not assumed.', u.arjun);
  });

  // 12. Resolved with complete notes: the document is really verified first, then the case is resolved and closed
  for (const closeIt of [false, true]) {
    await fromException('DOCUMENT_AWAITING_VERIFICATION', closeIt ? '12 resolved and closed' : '12 resolved with complete notes', u.priya, async (id) => {
      const exc = await prisma.exception.findFirstOrThrow({ where: { cases: { some: { caseCode: id } } } });
      await asg(id, { assignedAnalystId: u.priya.id }, u.priya);
      await go(id, { action: 'start' }, u.priya);
      await verificationService.recordVerification(exc.sourceEntityId, u.asha, { status: 'Verified', remarks: 'Checked against the customer profile. Accepted.' });
      await go(id, { action: 'resolve', resolutionNotes: 'The reviewer verified the document after checking it against the customer profile. No further action is needed.' }, u.priya);
      return closeIt ? go(id, { action: 'close' }, u.priya) : caseService.getCase(id, u.priya);
    }, { needsNoApproval: true });
  }

  // 13. A case closed while the issue persists (reported by detection as "previous review closed without proper resolution")
  await fromException('DOCUMENT_REQUIRES_RESUBMISSION', '13 closed without fixing the issue', u.vikram, async (id) => {
    await asg(id, { assignedAnalystId: u.vikram.id }, u.vikram);
    return go(id, { action: 'close', resolutionNotes: 'Closed during a backlog clean-up. The customer has not resent the document.' }, u.asha);
  });

  // 8. Overdue periodic reviews: detection created the cases. One is assigned and started, the others stay open.
  const periodic = (await prisma.reviewCase.findMany({ where: { caseType: 'Periodic KYC Review', status: 'Open' }, orderBy: { dueDate: 'asc' } }));
  if (periodic[0]) {
    await asg(periodic[0].caseCode, { assignedAnalystId: u.vikram.id }, u.asha);
    const c = await go(periodic[0].caseCode, { action: 'start' }, u.vikram);
    note('8 overdue periodic review', c);
  }

  // Detection again: the new cases changed exception statuses, and the closed case raises its follow-up.
  const second = await exceptionService.detect({ asOf });
  console.log(`Second detection: ${second.created} created, ${second.resolved} resolved, ${second.unchanged} unchanged.`);

  console.log('\nExample cases (created through the real workflow):');
  made.forEach((m) => console.log('  ' + m));

  // Report what the records show (nothing random).
  const [byStatus, exByType, schedules] = await Promise.all([
    prisma.$queryRaw`SELECT status, count(*)::int n FROM "ReviewCase" GROUP BY 1 ORDER BY 1`,
    prisma.$queryRaw`SELECT status, severity, count(*)::int n FROM "Exception" GROUP BY 1, 2 ORDER BY 1, 2`,
    prisma.$queryRaw`SELECT count(*) FILTER (WHERE next_review_date < ${asOf}::date)::int overdue, count(*) FILTER (WHERE next_review_date >= ${asOf}::date AND next_review_date <= ${addDays(asOf, 30)}::date)::int upcoming FROM "ReviewSchedule" WHERE status = 'Scheduled'`,
  ]);
  console.log('\nCases by status:', Object.fromEntries(byStatus.map((r) => [r.status, r.n])));
  console.log('Exceptions by status and severity:', exByType.map((r) => `${r.status}/${r.severity}: ${r.n}`).join(', '));
  console.log('Periodic reviews:', schedules[0]);
}

main()
  .catch((err) => { console.error('Generation failed:', err.message); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
