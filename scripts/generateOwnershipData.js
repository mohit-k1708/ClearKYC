/**
 * scripts/generateOwnershipData.js - reproducible SYNTHETIC data for Scene 3.
 *
 *   node scripts/generateOwnershipData.js                 # beneficial owners, screenings and assessments for up to 30 companies
 *   node scripts/generateOwnershipData.js --reset         # first remove all Scene 3 data (owners, screenings, ownership checks, Scene 3 assessments)
 *   node scripts/generateOwnershipData.js --limit=100     # more companies
 *   node scripts/generateOwnershipData.js --seed=7
 *
 * It uses the SAME service code as the API (create owner, record screening, record ownership check,
 * run risk assessment), so nothing is inserted in a way the application could not produce. Final risk
 * levels are CALCULATED from the documented rules (server/src/config/ownershipRules.js); none are assigned.
 *
 * Every company gets one of nine scenarios (a block of nine companies covers all of them):
 *   1 ownership exactly 100%            4 no beneficial owners             7 potential PEP match
 *   2 ownership above 100%              5 low-risk beneficial owner        8 potential sanctions match
 *   3 ownership below 100%              6 high-risk beneficial owner       9 complex ownership structure
 * Each company's story has two stages, so the risk history shows a change over time:
 *   stage A: owners added, not yet screened  -> ownership check + assessment
 *   stage B: screening outcomes recorded     -> ownership check + assessment
 *
 * Everything is fictional. Screening outcomes are synthetic: nothing is checked against any real PEP or
 * sanctions list. Assessment dates are the real time of the run (the database does not allow back-dating).
 * Same seed + same Scene 1/2 data + --reset  =>  the same owners, percentages, screenings and calculated results.
 */
require('../server/src/config/env');
const path = require('path');
const { spawnSync } = require('child_process');
const prisma = require('../server/src/utils/prisma');
const ownershipService = require('../server/src/services/ownershipService');
const screeningService = require('../server/src/services/screeningService');
const riskService = require('../server/src/services/riskAssessmentService');
const { DEFAULT_REVIEWERS } = require('../server/src/config/kycRules');

const DEFAULT_SEED = 20261022;

// ---- CLI arguments -----------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const seed = Number(args.seed ?? DEFAULT_SEED);
const limit = Number(args.limit ?? 30);
if (!Number.isInteger(limit) || limit < 1) {
  console.error('--limit must be a positive whole number');
  process.exit(1);
}

// ---- Seeded random numbers (mulberry32, as in the other generators) -----------------------------
function mulberry32(a) {
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const int = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (list) => list[int(0, list.length - 1)];
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Fictional people -------------------------------------------------------------------------------
const FIRST = ['Aditi', 'Rohit', 'Neha', 'Kunal', 'Sana', 'Vikram', 'Pooja', 'Imran', 'Tanvi', 'Arnav', 'Leela', 'Dev', 'Mira', 'Yash', 'Zara', 'Ishan'];
const LAST = ['Banerjee', 'Chauhan', 'Desai', 'Ghosh', 'Hegde', 'Khanna', 'Lal', 'Mishra', 'Naidu', 'Oberoi', 'Pandey', 'Rastogi', 'Saxena', 'Trivedi', 'Varma', 'Wadhwa'];
const usedNames = new Set();
function personName() {
  let name;
  do name = `${pick(FIRST)} ${pick(LAST)}`;
  while (usedNames.has(name));
  usedNames.add(name);
  return name;
}
const dob = () => `${int(1950, 1992)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;

/** One owner. Defaults describe a complete, low-risk, direct shareholder resident in India. */
function owner(pct, over = {}) {
  return {
    fullName: over.fullName ?? personName(),
    dateOfBirth: dob(),
    countryOfResidence: 'IN',
    nationality: 'IN',
    ownershipPercentage: pct,
    ownershipType: 'Direct',
    controlType: 'Shareholding',
    pepStatus: 'No',
    notes: 'Synthetic beneficial owner (generated data)',
    screen: { PEP: { result: 'No Match' }, Sanctions: { result: 'No Match' } }, // outcomes recorded in stage B
    ...over,
  };
}

// ---- Scenarios -----------------------------------------------------------------------------------------
const SCENARIOS = {
  EXACT_100: () => [owner(50), owner(30), owner(20)],
  OVER_100: () => [owner(60), owner(50)],
  UNDER_100: () => [owner(40), owner(30)],
  NO_OWNERS: () => [],
  LOW_RISK_OWNER: () => [owner(60), owner(40, { countryOfResidence: 'US', nationality: 'US' })],
  HIGH_RISK_OWNER: () => [
    // confirmed PEP (3) + high-risk country (2) + missing nationality (1) = 6 owner points = High
    owner(70, { countryOfResidence: 'IR', nationality: null, pepStatus: 'Yes', screen: { PEP: { result: 'Confirmed', remarks: 'Confirmed PEP after review (synthetic outcome)' }, Sanctions: { result: 'No Match' } } }),
    owner(30),
  ],
  POTENTIAL_PEP: () => [
    owner(55, { pepStatus: 'Unknown', screen: { PEP: { result: 'Potential Match', remarks: 'Possible PEP match, needs review (synthetic outcome)' }, Sanctions: { result: 'No Match' } } }),
    owner(45),
  ],
  POTENTIAL_SANCTIONS: () => [
    // The name is on the FICTIONAL demo list, so a simulated screening returns a POTENTIAL match (never a confirmed one).
    owner(50, { fullName: pick(['Viktor Demo Petrov', 'Darius Demo Volkov', 'Nadia Demo Karimova']), screen: { PEP: { result: 'No Match' }, Sanctions: { mode: 'simulated' } } }),
    owner(50),
  ],
  COMPLEX: () => [
    owner(30, { ownershipType: 'Indirect', controlType: 'Voting rights', countryOfResidence: 'SG', nationality: 'IN' }),
    owner(20, { countryOfResidence: 'AE', nationality: 'IN' }),
    owner(15, { ownershipType: 'Indirect', countryOfResidence: 'US', nationality: 'US' }),
    owner(15),
    owner(10, { controlType: 'Other means of control' }),
    owner(10, { controlType: 'Senior managing official' }),
  ],
};
const SCENARIO_NAMES = Object.keys(SCENARIOS);

// ---- Main ----------------------------------------------------------------------------------------------
async function ensureReviewers() {
  if ((await prisma.reviewer.count()) === 0) {
    console.log('No reviewers found: creating the sample reviewers first ...');
    const r = spawnSync(process.execPath, [path.join(__dirname, 'generateKycData.js'), '--requirements-only'], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('Could not create the sample reviewers');
  }
  const byEmail = async (email) => {
    const p = await prisma.reviewer.findUnique({ where: { email } });
    if (!p) throw new Error(`Sample person ${email} is missing: run npm run generate:kyc first`);
    return p;
  };
  const analystEmail = DEFAULT_REVIEWERS.find((r) => r.role === 'Analyst').email;
  const reviewerEmail = DEFAULT_REVIEWERS.find((r) => r.role === 'Reviewer').email;
  return { analyst: await byEmail(analystEmail), reviewer: await byEmail(reviewerEmail) };
}

async function reset() {
  console.log('Resetting: removing owners, screenings, ownership checks and Scene 3 risk assessments ...');
  await prisma.$transaction([
    // Maintenance switch: history tables are normally insert-only.
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.ownershipValidation.deleteMany({}),
    prisma.beneficialOwner.deleteMany({}), // screenings are removed with their owners
    prisma.riskRating.deleteMany({ where: { assessmentMethod: { startsWith: 'RULES_V2' } } }),
    // Scene 5: the audit events of the records just removed go with them (audit events are otherwise immutable).
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE entity_type IN ('BeneficialOwner', 'OwnerScreening', 'OwnershipValidation') OR action_type = 'RISK_CLASSIFICATION_CHANGED' OR (entity_type = 'RiskRating' AND NOT EXISTS (SELECT 1 FROM "RiskRating" r WHERE r.id = "AuditEvent".entity_id))`,
  ]);
  // Keep RSK ids gap-free: the next one is the number after the highest remaining.
  await prisma.$executeRawUnsafe(`SELECT setval('risk_assessment_seq', coalesce((SELECT max(substr(assessment_code, 5)::int) FROM "RiskRating"), 0) + 1, false)`);
}

async function main() {
  console.log(`Scene 3 synthetic data (seed ${seed})`);
  const actors = await ensureReviewers();
  if (args.reset) await reset();

  // Scenario 4 deliberately leaves a company without owners, so a re-run cannot tell "unseeded" from "scenario 4".
  // Seeding is therefore all-or-nothing: stop if Scene 3 data exists and --reset was not given.
  if (!args.reset && (await prisma.beneficialOwner.count()) > 0) {
    console.log('Scene 3 data already exists. Nothing changed. Use --reset to remove it and generate it again.');
    return;
  }

  const companies = await prisma.customer.findMany({
    where: { customerType: { typeName: 'Company' } },
    orderBy: { id: 'asc' },
    select: { id: true, customerCode: true, fullName: true },
  });
  const targets = companies.slice(0, limit);
  if (targets.length < SCENARIO_NAMES.length) {
    console.warn(`Only ${targets.length} company customers are available, so not every scenario can appear. Generate more with: npm run generate:customers -- --count=200 --reset`);
  }

  const assigned = {};
  let block = [];
  let ownerCount = 0;
  let screeningCount = 0;
  let assessmentCount = 0;

  for (const company of targets) {
    if (block.length === 0) block = shuffle(SCENARIO_NAMES); // every block of nine covers all nine scenarios
    const scenario = block.pop();
    assigned[scenario] = (assigned[scenario] || 0) + 1;
    const owners = SCENARIOS[scenario]();

    // Stage A: owners are added (not yet screened), the ownership is checked and the customer is assessed.
    const created = [];
    for (const o of owners) {
      const { screen, ...data } = o;
      const saved = await ownershipService.createOwner(company.customerCode, data, actors.analyst);
      created.push({ id: saved.id, screen });
      ownerCount += 1;
    }
    await ownershipService.recordOwnershipValidation(company.customerCode, actors.analyst);
    await riskService.createAssessment(company.customerCode, actors.reviewer, { remarks: 'Assessment after owners were recorded (synthetic data)', force: true });
    assessmentCount += 1;

    // Stage B: screening outcomes are recorded, the ownership is checked again and the customer is reassessed.
    for (const c of created) {
      for (const type of ['PEP', 'Sanctions']) {
        const s = c.screen[type];
        await screeningService.createScreening(c.id, { screeningType: type, mode: s.mode || 'manual', screeningResult: s.result, remarks: s.remarks }, actors.reviewer);
        screeningCount += 1;
      }
    }
    if (created.length > 0) {
      await ownershipService.recordOwnershipValidation(company.customerCode, actors.analyst);
      await riskService.createAssessment(company.customerCode, actors.reviewer, { remarks: 'Assessment after screening outcomes were recorded (synthetic data)', force: true });
      assessmentCount += 1;
    }
  }

  console.log(`Created ${ownerCount} beneficial owners, ${screeningCount} screening records and ${assessmentCount} risk assessments for ${targets.length} companies.`);
  console.log('Scenarios assigned:', assigned);

  // Report what the rules CALCULATED (nothing here was assigned).
  const latest = await prisma.$queryRaw`
    SELECT r.risk_level AS level, r.assessment_status AS status, count(*)::int AS n
    FROM "Customer" c JOIN "CustomerType" t ON t.id = c.customer_type_id AND t.type_name = 'Company'
    JOIN LATERAL (SELECT rr.risk_level, rr.assessment_status FROM "RiskRating" rr WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1) r ON true
    GROUP BY 1, 2 ORDER BY 1, 2`;
  console.log('Calculated current risk of company customers (level / status):', latest.map((l) => `${l.level} / ${l.status}: ${l.n}`));
  const overview = await ownershipService.listOwnershipOverview({ page: 1, pageSize: 100 });
  const statuses = {};
  overview.items.forEach((i) => (statuses[i.validationStatus] = (statuses[i.validationStatus] || 0) + 1));
  console.log('Calculated ownership validation of company customers:', statuses);
}

main()
  .catch((err) => {
    console.error('Generation failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
