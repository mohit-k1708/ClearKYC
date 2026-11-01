/**
 * scripts/generateCustomers.js - reproducible SYNTHETIC customer data.
 *
 * Usage:
 *   node scripts/generateCustomers.js                      # small dev set (50 customers)
 *   node scripts/generateCustomers.js --count=5000         # larger set
 *   node scripts/generateCustomers.js --count=200 --seed=7 # different (still reproducible) data
 *   node scripts/generateCustomers.js --reset              # wipe customers + restart IDs at CUS-000001 first
 *   node scripts/generateCustomers.js --dry-run            # print a preview, write nothing
 *
 * Same seed + same --reset  =>  identical customers with identical Customer IDs.
 * (Without --reset the new customers are appended and continue from the current sequence value.)
 *
 * Everything is fictional: names are random combinations, emails use example.com, and the
 * PAN / Aadhaar values follow the *format* only. They are random test values and are NOT
 * checked against any real registry, so a collision with a real number is theoretically possible.
 * Risk levels come from the same rule engine the API uses (server/src/services/riskService.js).
 */
require('../server/src/config/env');
const prisma = require('../server/src/utils/prisma');
const { assessRisk } = require('../server/src/services/riskService');
const { toCustomerRow } = require('../server/src/services/customerService');
const { COUNTRIES, BUSINESS_ACTIVITIES, OCCUPATIONS } = require('../server/src/config/options');
const audit = require('../server/src/services/auditService');

const DEFAULT_SEED = 20261022;
const DEFAULT_COUNT = 50;
// Fixed "today" so that age / company-age rules give the same result on every run.
const REFERENCE_DATE = new Date('2026-10-22T00:00:00.000Z');

// ---- CLI arguments -----------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const seed = Number(args.seed ?? DEFAULT_SEED);
const count = Number(args.count ?? DEFAULT_COUNT);
if (!Number.isInteger(count) || count < 1) {
  console.error('--count must be a positive whole number');
  process.exit(1);
}

// ---- Seeded random number generator (mulberry32) ---------------------------------------------
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
const letters = (n) => Array.from({ length: n }, () => String.fromCharCode(65 + int(0, 25))).join('');
const digits = (n) => Array.from({ length: n }, () => int(0, 9)).join('');
const pad = (n, w) => String(n).padStart(w, '0');

// ---- Fictional data pools -------------------------------------------------------------------
const FIRST = ['Aarav', 'Vivaan', 'Aditya', 'Ishaan', 'Kabir', 'Rohan', 'Arjun', 'Neel', 'Ananya', 'Diya', 'Meera', 'Saanvi', 'Kavya', 'Isha', 'Riya', 'Tara', 'Farhan', 'Zoya', 'Karan', 'Pooja'];
const LAST = ['Sharma', 'Verma', 'Iyer', 'Nair', 'Reddy', 'Patel', 'Gupta', 'Mehta', 'Khan', 'Bose', 'Das', 'Joshi', 'Kulkarni', 'Chopra', 'Menon', 'Rao', 'Singh', 'Pillai'];
const COMPANY_A = ['Bluewave', 'Orchid', 'Nimbus', 'Cedar', 'Sunrise', 'Pioneer', 'Lotus', 'Granite', 'Horizon', 'Silverline', 'Evergreen', 'Zenith'];
const COMPANY_B = ['Technologies', 'Industries', 'Traders', 'Logistics', 'Foods', 'Healthcare', 'Constructions', 'Exports', 'Solutions', 'Ventures'];
const COMPANY_SUFFIX = ['Pvt Ltd', 'LLP', 'Ltd', 'Pvt Ltd', 'Pvt Ltd'];
const CITIES = ['Mumbai', 'Delhi', 'Bengaluru', 'Chennai', 'Pune', 'Hyderabad', 'Kolkata', 'Ahmedabad', 'Jaipur', 'Kochi'];
const STREETS = ['MG Road', 'Park Street', 'Station Road', 'Lake View Lane', 'Residency Road', 'Temple Street', 'Gandhi Nagar'];
const COUNTRY_CODES = Object.keys(COUNTRIES);

// Mostly domestic customers with a realistic tail of foreign and higher-risk ones.
function pickCountry() {
  const roll = rand();
  if (roll < 0.82) return 'IN';
  if (roll < 0.93) return pick(['US', 'GB', 'SG', 'AE', 'CA', 'AU', 'DE']);
  return pick(COUNTRY_CODES);
}

function address(country) {
  return `${int(1, 250)}, ${pick(STREETS)}, ${pick(CITIES)}${country === 'IN' ? '' : ' (overseas address)'}`;
}

function phone() {
  return `+91${pick(['6', '7', '8', '9'])}${digits(9)}`;
}

// Synthetic identifiers. PAN: "Z" + 2 random letters + holder type + letter + 4 digits + letter.
const usedPan = new Set();
const usedAadhaar = new Set();
const usedReg = new Set();
function uniqueFrom(set, make) {
  let value;
  do value = make();
  while (set.has(value));
  set.add(value);
  return value;
}
const makePan = (holder) => uniqueFrom(usedPan, () => `Z${letters(2)}${holder}${letters(1)}${digits(4)}${letters(1)}`);
const makeAadhaar = () => uniqueFrom(usedAadhaar, () => `${int(2, 9)}${digits(11)}`);

// ---- Customer builders ------------------------------------------------------------------------
function makeIndividual() {
  const first = pick(FIRST);
  const last = pick(LAST);
  const country = pickCountry();
  const dob = new Date(Date.UTC(int(1950, 2006), int(0, 11), int(1, 28)));
  return {
    customerType: 'Individual',
    data: {
      fullName: `${first} ${last}`,
      dateOfBirth: dob,
      email: `${first}.${last}${int(1, 9999)}@example.com`.toLowerCase(),
      phone: phone(),
      address: address(country),
      panNumber: makePan('P'),
      aadhaarNumber: makeAadhaar(),
      occupation: pick(OCCUPATIONS),
      country,
    },
  };
}

function makeCompany() {
  const name = `${pick(COMPANY_A)} ${pick(COMPANY_B)} ${pick(COMPANY_SUFFIX)}`;
  const country = pickCountry();
  const incorporated = new Date(Date.UTC(int(1995, 2026), int(0, 9), int(1, 28)));
  const slug = name.split(' ')[0].toLowerCase();
  return {
    customerType: 'Company',
    data: {
      legalName: name,
      registrationNumber: uniqueFrom(usedReg, () => `U${digits(5)}MH${incorporated.getUTCFullYear()}PTC${digits(6)}`),
      panNumber: makePan(pick(['C', 'C', 'C', 'F', 'T'])),
      email: `contact${int(1, 9999)}@${slug}-demo.example.com`,
      phone: phone(),
      address: address(country),
      country,
      businessActivity: pick(BUSINESS_ACTIVITIES),
      dateOfIncorporation: incorporated,
    },
  };
}

// ---- Main ---------------------------------------------------------------------------------
async function main() {
  console.log(`Generating ${count} synthetic customers (seed ${seed}) ...`);

  // 70% individuals, 30% companies, decided by the seeded generator.
  const generated = Array.from({ length: count }, () => (rand() < 0.7 ? makeIndividual() : makeCompany()));

  // Never create dates in the future relative to the fixed reference date.
  for (const g of generated) {
    const key = g.customerType === 'Individual' ? 'dateOfBirth' : 'dateOfIncorporation';
    if (g.data[key] > REFERENCE_DATE) g.data[key] = new Date(REFERENCE_DATE);
  }

  const prepared = generated.map(({ customerType, data }) => {
    const row = toCustomerRow(customerType, data);
    const risk = assessRisk(
      { customerType, fullName: row.fullName, country: data.country, occupation: data.occupation, businessActivity: data.businessActivity, dateOfBirth: data.dateOfBirth, dateOfIncorporation: data.dateOfIncorporation },
      REFERENCE_DATE
    );
    return { row, risk };
  });

  const tally = prepared.reduce((t, p) => ({ ...t, [p.risk.level]: (t[p.risk.level] || 0) + 1 }), {});
  console.log('Risk distribution (from the documented rules):', tally);

  if (args['dry-run']) {
    console.log('Dry run - nothing written. First customer:', { name: prepared[0].row.fullName, risk: prepared[0].risk.level });
    return;
  }

  if (args.reset) {
    console.log('Resetting: deleting ALL customers and restarting the Customer ID sequence at CUS-000001 ...');
    // Scene 2, 3, 4 and 5 tables reference Customer, so they are emptied in the same statement. The audit trail is immutable
    // for the application; this maintenance script is the only thing that may clear it, with the explicit maintenance switch.
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
      prisma.$executeRawUnsafe(
        'TRUNCATE TABLE "IdCounter", "OnboardingDecision", "CompanyOwnership", "AuditEvent", "Alert", "ValidationIssue", "ValidationRun", "CaseNote", "CaseHistory", "ReviewCase", "Exception", "ReviewSchedule", "Verification", "Document", "OwnerScreening", "BeneficialOwner", "OwnershipValidation", "RiskRating", "Customer" RESTART IDENTITY'
      ),
    ]);
    await prisma.$executeRawUnsafe('ALTER SEQUENCE audit_event_seq RESTART WITH 1'); // Scene 5: AUD-000001 and ALT-000001 again
    await prisma.$executeRawUnsafe('ALTER SEQUENCE alert_seq RESTART WITH 1');
    await prisma.$executeRawUnsafe('ALTER SEQUENCE exception_seq RESTART WITH 1'); // Scene 4: EXC-000001 and CASE-000001 again
    await prisma.$executeRawUnsafe('ALTER SEQUENCE review_case_seq RESTART WITH 1');
    await prisma.$executeRawUnsafe('ALTER SEQUENCE customer_code_seq RESTART WITH 1');
    await prisma.$executeRawUnsafe('ALTER SEQUENCE risk_assessment_seq RESTART WITH 1'); // Scene 3: RSK-000001 again
  }

  // Insert one by one, in order, so Customer IDs are assigned deterministically (CUS-000001, 000002 ...).
  let created = 0;
  let firstId;
  let lastId;
  for (const { row, risk } of prepared) {
    const [{ code }] = await prisma.$queryRaw`SELECT next_customer_code() AS code`;
    firstId ??= code;
    lastId = code;
    // Same as the application: the customer, the first rating and their audit events are saved together (done by "System").
    await prisma.$transaction(async (tx) => {
      const customer = await tx.customer.create({
        data: {
          ...row,
          customerCode: code,
          riskRatings: {
            create: {
              riskScore: risk.score,
              riskLevel: risk.level,
              assessmentMethod: risk.method,
              riskReasons: { reasons: risk.reasons, screening: risk.screening, requiresManualReview: risk.requiresManualReview, thresholds: risk.thresholds },
            },
          },
        },
        include: { riskRatings: true, customerType: true },
      });
      const rating = customer.riskRatings[0];
      await audit.record(tx, { actionType: 'CUSTOMER_CREATED', entityType: 'Customer', entityId: customer.id, entityRef: code, customerId: customer.id, actor: null, newValues: { customerType: customer.customerType.typeName, country: customer.country, registrationStatus: customer.registrationStatus }, reason: 'Customer registered (synthetic data generator)' });
      await audit.record(tx, { actionType: 'RISK_ASSESSMENT_CREATED', entityType: 'RiskRating', entityId: rating.id, entityRef: rating.assessmentCode, customerId: customer.id, actor: null, newValues: { riskScore: rating.riskScore, riskLevel: rating.riskLevel, assessmentStatus: rating.assessmentStatus, method: rating.assessmentMethod }, reason: 'Initial risk classification at onboarding' });
    });
    created += 1;
    if (created % 500 === 0) console.log(`  ... ${created}/${count}`);
  }
  console.log(`Done. Created ${created} customers (${firstId} to ${lastId}).`);
}

main()
  .catch((err) => {
    if (err.code === 'P2002') {
      console.error('A generated value already exists in the database. Re-run with --reset to start from a clean slate.');
    } else {
      console.error('Generation failed:', err.message);
    }
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
