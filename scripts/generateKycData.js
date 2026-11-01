/**
 * scripts/generateKycData.js - reproducible SYNTHETIC data for Scene 2.
 *
 *   node scripts/generateKycData.js                    # reviewers + requirements + documents for up to 100 customers
 *   node scripts/generateKycData.js --reset            # first delete all documents and verification history
 *   node scripts/generateKycData.js --limit=300        # more customers
 *   node scripts/generateKycData.js --as-of=2026-10-22 # fixed "today" => identical data on any day
 *   node scripts/generateKycData.js --requirements-only
 *
 * What it creates
 *   - 4 synthetic reviewers (2 Reviewers, 1 Admin, 1 Analyst who is NOT allowed to decide)
 *   - the sample KYC requirements from the specification (existing rows are left untouched)
 *   - documents + verification history for existing Scene 1 customers (if there are no customers,
 *     the Scene 1 generator is run first)
 *
 * Every customer is given one of 7 realistic scenarios (all verified, missing documents, pending,
 * rejected, expired, expiring within 30 days, verified-but-incomplete). Completeness percentages are
 * NEVER generated: they are calculated from these records by the same engine the API uses.
 *
 * Same seed (default 20261022) + same --as-of + --reset  =>  identical records.
 * All document numbers are synthetic ("SYN-..."); no real identity documents are used.
 */
require('../server/src/config/env');
const path = require('path');
const { spawnSync } = require('child_process');
const prisma = require('../server/src/utils/prisma');
const { encrypt, blindIndex } = require('../server/src/utils/crypto');
const { todayIso, addDays, parseIso } = require('../server/src/utils/dates');
const { DEFAULT_REQUIREMENTS, DEFAULT_REVIEWERS, EFFECTIVE_FROM_DEFAULT, AUTHORISED_ROLES, typeInfo } = require('../server/src/config/kycRules');
const { evaluateCustomerKyc, isRequirementCurrent } = require('../server/src/services/kycEngine');
const { loadRequirements } = require('../server/src/services/kycService');
const audit = require('../server/src/services/auditService');

const DEFAULT_SEED = 20261022;
const TYPE_IDS = { Individual: 1, Company: 2 };

// ---- CLI arguments ---------------------------------------------------------------------------
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
  })
);
const seed = Number(args.seed ?? DEFAULT_SEED);
const limit = Number(args.limit ?? 100);
const asOf = args['as-of'] || todayIso();
const AUDIT_FOR_STATUS = { 'In Review': 'VERIFICATION_STARTED', Verified: 'DOCUMENT_VERIFIED', Rejected: 'DOCUMENT_REJECTED', 'Requires Resubmission': 'DOCUMENT_RESUBMISSION_REQUESTED', Pending: 'VERIFICATION_RESET' };
if (!parseIso(asOf)) {
  console.error('--as-of must be a date like 2026-10-22');
  process.exit(1);
}
if (!Number.isInteger(limit) || limit < 1) {
  console.error('--limit must be a positive whole number');
  process.exit(1);
}

// ---- Seeded random numbers (mulberry32, same generator as Scene 1) ---------------------------
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
const digits = (n) => Array.from({ length: n }, () => int(0, 9)).join('');
function shuffle(list) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = int(0, i);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---- Reference data (reviewers and requirements) --------------------------------------------------
async function seedReferenceData() {
  for (const r of DEFAULT_REVIEWERS) {
    await prisma.reviewer.upsert({ where: { email: r.email }, update: {}, create: r });
  }
  let created = 0;
  for (const group of DEFAULT_REQUIREMENTS) {
    for (const documentType of group.documents) {
      const key = { customerTypeId: TYPE_IDS[group.customerType], riskLevel: group.riskLevel, documentType, effectiveFrom: parseIso(EFFECTIVE_FROM_DEFAULT) };
      const existing = await prisma.kYCRequirement.findUnique({ where: { customerTypeId_riskLevel_documentType_effectiveFrom: key } });
      if (!existing) {
        await prisma.kYCRequirement.create({ data: { ...key, isMandatory: true, isActive: true } });
        created += 1;
      }
    }
  }
  console.log(`Reference data ready: ${DEFAULT_REVIEWERS.length} reviewers, ${created} new requirements (existing rows left untouched).`);
}

// ---- Scenarios ----------------------------------------------------------------------------------------
const SCENARIOS = ['ALL_VERIFIED', 'MISSING', 'PENDING', 'REJECTED', 'EXPIRED', 'EXPIRING_SOON', 'VERIFIED_INCOMPLETE'];

/**
 * Decides what happens to each mandatory requirement of one customer.
 * Outcomes: verified | verified_expired | verified_expiring | pending | in_review | rejected | resubmit | missing
 */
function planOutcomes(scenario, reqs) {
  // Document types that normally expire go first, so expiry scenarios have a document that can expire.
  const order = shuffle(reqs).sort((a, b) => Number(Boolean(typeInfo(b.documentType)?.validityDays)) - Number(Boolean(typeInfo(a.documentType)?.validityDays)));
  const outcomes = new Map(order.map((r) => [r.documentType, 'verified']));
  const set = (i, outcome) => order[i] && outcomes.set(order[i].documentType, outcome);
  const n = order.length;

  switch (scenario) {
    case 'MISSING': {
      const missing = Math.max(1, Math.floor(n / 2));
      const tail = shuffle(order.map((r) => r.documentType));
      tail.slice(0, missing).forEach((t) => outcomes.set(t, 'missing'));
      tail.slice(missing).forEach((t, i) => outcomes.set(t, i === 0 || rand() < 0.5 ? 'verified' : 'pending'));
      break;
    }
    case 'PENDING': {
      const pendingDocs = shuffle(order.map((r) => r.documentType));
      pendingDocs.forEach((t, i) => outcomes.set(t, i === 0 ? 'pending' : i === 1 && rand() < 0.6 ? 'in_review' : rand() < 0.5 ? 'pending' : 'verified'));
      break;
    }
    case 'REJECTED': {
      const docs = shuffle(order.map((r) => r.documentType));
      outcomes.set(docs[0], 'rejected');
      if (docs[1]) outcomes.set(docs[1], 'resubmit');
      break;
    }
    case 'EXPIRED':
      set(0, 'verified_expired');
      if (n >= 4 && rand() < 0.4) set(1, 'verified_expired');
      break;
    case 'EXPIRING_SOON':
      set(0, 'verified_expiring');
      if (n >= 4 && rand() < 0.4) set(1, 'verified_expiring');
      break;
    case 'VERIFIED_INCOMPLETE': {
      const submitted = Math.min(n - 1, Math.max(1, Math.ceil(n * 0.6)));
      shuffle(order.map((r) => r.documentType)).forEach((t, i) => outcomes.set(t, i < submitted ? 'verified' : 'missing'));
      break;
    }
    default: // ALL_VERIFIED
      break;
  }
  return outcomes;
}

/** Dates for one document so that issue <= submission, and expiry matches the outcome. */
function makeDates(outcome, validityDays) {
  let issue;
  let submission;
  let expiry = null;
  if (outcome === 'verified_expired') {
    expiry = addDays(asOf, -int(1, 60));
    issue = addDays(expiry, -int(30, 360));
    submission = addDays(issue, int(1, Math.max(1, Math.round((parseIso(expiry) - parseIso(issue)) / 86_400_000))));
  } else if (outcome === 'verified_expiring') {
    expiry = addDays(asOf, int(2, 28));
    issue = addDays(asOf, -int(100, 400));
    submission = addDays(issue, int(1, 60));
  } else {
    submission = addDays(asOf, -int(10, 150));
    issue = addDays(submission, -int(1, 300));
    if (validityDays) expiry = addDays(asOf, int(45, 400)); // comfortably more than 30 days away
  }
  return { issue, submission, expiry };
}

const REMARKS = {
  verified: ['Details match the submitted record.', 'Document is legible and consistent.', 'Checked against the customer profile. Accepted.'],
  rejected: ['Name does not match the customer record.', 'Document is illegible. Please provide a clear copy.', 'Document appears altered. Rejected pending explanation.'],
  resubmit: ['Please resubmit a copy issued in the last 3 months.', 'Image is cropped. Please resubmit the full page.'],
  inReview: ['Picked up for review.'],
};

/** Verification history for one document: a list of { status, remarks, reviewer?, on } in order. */
function planHistory(outcome, submission, deciders, expiry) {
  // Decisions are never dated in the future, nor after the document already expired.
  const latest = expiry && expiry < asOf ? expiry : asOf;
  const step = (from, days) => {
    const next = addDays(from, days);
    return next > latest ? latest : next;
  };
  const reviewer = () => pick(deciders);
  const history = [{ status: 'Pending', remarks: 'Submitted, awaiting review', reviewer: null, on: submission }];
  let on = submission;
  const add = (status, remarks, days = int(1, 4)) => {
    on = step(on, days);
    history.push({ status, remarks, reviewer: reviewer(), on });
  };

  if (outcome === 'in_review') add('In Review', pick(REMARKS.inReview));
  if (outcome === 'rejected') {
    if (rand() < 0.5) add('In Review', pick(REMARKS.inReview), 1);
    add('Rejected', pick(REMARKS.rejected));
  }
  if (outcome === 'resubmit') add('Requires Resubmission', pick(REMARKS.resubmit));
  if (['verified', 'verified_expired', 'verified_expiring'].includes(outcome)) {
    if (rand() < 0.2) {
      // A document that was rejected, corrected (metadata edit resets it to Pending), then verified.
      add('Rejected', pick(REMARKS.rejected), 1);
      history.push({ status: 'Pending', remarks: 'Re-verification required: file changed after the previous decision (Rejected)', reviewer: null, on: step(on, 1) });
      on = history[history.length - 1].on;
    } else if (rand() < 0.5) {
      add('In Review', pick(REMARKS.inReview), 1);
    }
    add('Verified', pick(REMARKS.verified));
  }
  return history;
}

const atTen = (iso) => new Date(`${iso}T10:00:00.000Z`);

// ---- Main --------------------------------------------------------------------------------------
async function main() {
  console.log(`Scene 2 synthetic data (seed ${seed}, as of ${asOf})`);
  await seedReferenceData();
  if (args['requirements-only']) return;

  // Customers come from Scene 1. If there are none, run the Scene 1 generator first.
  if ((await prisma.customer.count()) === 0) {
    console.log('No customers found: running the Scene 1 generator first (60 customers) ...');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'generateCustomers.js'), '--count=60'], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('Scene 1 customer generation failed');
  }

  if (args.reset) {
    console.log('Resetting: deleting ALL documents and verification history ...');
    await prisma.$transaction([
      prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
      // The audit events of the deleted documents go with them (audit events are otherwise immutable).
      prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE entity_type = 'Document'`,
      prisma.$executeRaw`DELETE FROM "IdCounter" WHERE scope LIKE 'DOC:%'`, // DOC-CUS-000001-001 starts again at 001
      prisma.$executeRawUnsafe('TRUNCATE TABLE "Verification", "Document" RESTART IDENTITY'),
    ]);
  }

  const customers = await prisma.$queryRaw`
    SELECT c.id, c.customer_id AS "customerId", t.type_name AS "customerType", r.risk_level AS "riskLevel",
           EXISTS (SELECT 1 FROM "Document" d WHERE d.customer_id = c.id) AS "hasDocuments"
    FROM "Customer" c
    JOIN "CustomerType" t ON t.id = c.customer_type_id
    LEFT JOIN LATERAL (
      SELECT rr.risk_level FROM "RiskRating" rr WHERE rr.customer_id = c.id ORDER BY rr.assessment_date DESC, rr.id DESC LIMIT 1
    ) r ON true
    ORDER BY c.id`;
  const targets = customers.filter((c) => c.riskLevel && !c.hasDocuments).slice(0, limit);
  const skipped = customers.filter((c) => c.hasDocuments).length;
  if (skipped) console.log(`${skipped} customers already have documents and are left untouched (use --reset to start over).`);

  const requirements = await loadRequirements();
  const reviewers = await prisma.reviewer.findMany({ where: { isActive: true }, orderBy: { id: 'asc' } });
  const deciders = reviewers.filter((r) => AUTHORISED_ROLES.includes(r.role)).map((r) => r.id);
  if (deciders.length === 0) throw new Error('No active Reviewer or Admin exists to record verification decisions');

  const scenarioCounts = {};
  let docCount = 0;
  let verificationCount = 0;
  let block = [];

  for (let i = 0; i < targets.length; i += 1) {
    if (block.length === 0) block = shuffle(SCENARIOS); // every block of 7 customers covers all 7 scenarios
    const scenario = block.pop();
    const customer = targets[i];
    scenarioCounts[scenario] = (scenarioCounts[scenario] || 0) + 1;

    // The customer's mandatory requirements today (one per document type).
    const reqs = [...new Map(
      requirements
        .filter((r) => r.customerType === customer.customerType && r.riskLevel === customer.riskLevel && isRequirementCurrent(r, asOf) && r.isMandatory)
        .map((r) => [r.documentType, r])
    ).values()];
    const outcomes = planOutcomes(scenario, reqs);

    for (const req of reqs) {
      const outcome = outcomes.get(req.documentType);
      if (outcome === 'missing') continue;
      const info = typeInfo(req.documentType);
      const { issue, submission, expiry } = makeDates(outcome, info?.validityDays);
      const history = planHistory(outcome, submission, deciders, expiry);
      const number = info?.requiresNumber ? `SYN-${info.abbr}-${digits(6)}` : null;

      await prisma.$transaction(async (tx) => {
        const doc = await tx.document.create({
          data: {
            customerId: customer.id,
            requirementId: req.id,
            documentType: req.documentType,
            documentNumber: number ? encrypt(number) : null,
            documentNumberHash: number ? blindIndex(`DOC:${req.documentType}`, number) : null,
            issueDate: parseIso(issue),
            expiryDate: expiry ? parseIso(expiry) : null,
            submissionDate: parseIso(submission),
            notes: 'Synthetic test document (generated data)',
          },
        });
        // Inserted in order: the database trigger keeps Document.status equal to the newest record.
        const ref = `${customer.customerId} / ${req.documentType}`;
        await audit.record(tx, { actionType: 'DOCUMENT_SUBMITTED', entityType: 'Document', entityId: doc.id, entityRef: ref, customerId: customer.id, actor: null, newValues: { documentType: req.documentType, issueDate: issue, expiryDate: expiry ?? null, submissionDate: submission, status: 'Pending', hasNumber: Boolean(number), hasFile: false }, reason: 'Document submitted (synthetic data generator)' });
        let previousStatus = 'Pending';
        for (const [index, h] of history.entries()) {
          await tx.verification.create({
            data: { documentId: doc.id, reviewerId: h.reviewer, status: h.status, remarks: h.remarks, verificationDate: atTen(h.on), createdAt: atTen(h.on) },
          });
          // The opening Pending record is part of the submission; every later decision is its own audit event.
          if (index === 0 && h.status === 'Pending' && !h.reviewer) continue;
          const person = h.reviewer ? reviewers.find((r) => r.id === h.reviewer) : null;
          await audit.record(tx, { actionType: AUDIT_FOR_STATUS[h.status] ?? 'VERIFICATION_RESET', entityType: 'Document', entityId: doc.id, entityRef: ref, customerId: customer.id, actor: person, previousValues: { status: previousStatus }, newValues: { status: h.status }, reason: h.remarks ?? null });
          previousStatus = h.status;
        }
      });
      docCount += 1;
      verificationCount += history.length;
    }
  }

  console.log(`Created ${docCount} documents with ${verificationCount} verification records for ${targets.length} customers.`);
  console.log('Scenarios assigned:', scenarioCounts);

  // Report what the ENGINE calculates from the stored rows (nothing here is random).
  const docs = await prisma.document.findMany({ select: { id: true, customerId: true, documentType: true, status: true, expiryDate: true, submissionDate: true } });
  const byCustomer = new Map();
  docs.forEach((d) => byCustomer.set(d.customerId, [...(byCustomer.get(d.customerId) || []), d]));
  const completeness = {};
  const exceptions = {};
  for (const c of customers.filter((x) => x.riskLevel)) {
    const r = evaluateCustomerKyc({ customerType: c.customerType, riskLevel: c.riskLevel, requirements, documents: byCustomer.get(c.id) || [], asOf });
    completeness[r.status] = (completeness[r.status] || 0) + 1;
    r.exceptions.forEach((e) => (exceptions[e.type] = (exceptions[e.type] || 0) + 1));
  }
  console.log('Calculated completeness status counts:', completeness);
  console.log('Calculated exceptions:', exceptions);
}

main()
  .catch((err) => {
    console.error('Generation failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
