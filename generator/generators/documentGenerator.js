/**
 * Documents and their verification history (Task 7).
 *
 * How the exact document count is reached WITHOUT random completeness percentages
 *   1. The documents a customer is asked for come from the KYC requirements of their type and CURRENT risk level.
 *   2. The challenge fixes the total (20,000 for the full set), which is lower than "every customer submitted everything"
 *      (about 27,000). So customers have submitted different numbers of documents; the rest are simply missing and the
 *      application's own KYC engine reports them as missing. More recently onboarded customers are more often incomplete.
 *   3. A share of documents are REPLACEMENTS: an earlier copy that was rejected / returned / expired, followed by a newer copy.
 *
 * Every document gets an outcome (verified, expiring, expired, pending, in review, rejected, resubmit). The outcome decides
 * the dates and the verification history, and an outcome is only possible if the dates work out against the reference date:
 *   - Expiry = issue date + the validity of that document type (config/kycRules.js). Some types never expire.
 *   - An "expired" document keeps its Verified decision (a reviewer verified it while it was valid), but its expiry date is
 *     before the reference date, so the KYC engine never counts it as valid.
 *   - A document is never submitted before the customer was onboarded, and never decided after the reference date.
 */
const { addDays, daysBetween } = require('../../server/src/utils/dates');
const { parseIso } = require('../../server/src/utils/dates');
const { typeInfo } = require('../../server/src/config/kycRules');
const { documentCode } = require('../utils/idGenerator');
const { encryptDeterministic, blindIndex } = require('../utils/syntheticCrypto');
const { at } = require('./customerGenerator');
const { nameOnDocument } = require('../utils/nameVariants');

const HOUR = 3_600_000;
const MINUTE = 60_000;
const REMARKS = {
  Verified: ['Checked against the submitted copy (synthetic review).', 'Details match the customer record (synthetic review).', null],
  Rejected: ['The copy is unreadable. A clear copy is needed (synthetic review).', 'The name on the document does not match the customer record (synthetic review).', 'The document is incomplete: a page is missing (synthetic review).'],
  'Requires Resubmission': ['Please upload a recent, clearly legible copy (synthetic review).', 'The submitted copy is cut off at the edges, please resubmit (synthetic review).', 'A newer document is needed to complete the file (synthetic review).'],
  'In Review': ['Review started (synthetic).', null],
};

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/** Document types a customer must provide, in the order of the requirement list (identity document first). */
function slotsByGroup(requirements) {
  const map = new Map();
  for (const r of requirements) {
    const key = `${r.customerType}|${r.riskLevel}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  }
  return map;
}

/** Possible (submission, issue, expiry) dates for an outcome, or null when the dates cannot work for this customer. */
function planDates(outcome, validity, onb, ref, r) {
  const gap = r.int(0, validity ? 40 : 30);
  const between = (lo, hi) => (lo <= hi ? lo + Math.floor(r.next() * (hi - lo + 1)) : null);
  const dayOf = (iso) => daysBetween(onb, iso); // days since onboarding
  const refDay = dayOf(ref);
  const toIso = (day) => addDays(onb, day);

  if (!validity) {
    if (outcome === 'expiring' || outcome === 'expired') return null;
    let s;
    if (outcome === 'verified') s = between(0, Math.min(refDay, 30));
    else {
      const recent = Math.floor(120 * r.next() ** 1.6);
      s = Math.max(0, refDay - recent);
    }
    return { s: toIso(s), issue: toIso(s - gap), expiry: null };
  }

  // documents that expire: pick the expiry day, derive issue (expiry - validity) and submission (issue + gap)
  const range = {
    verified: [refDay + 91, refDay + validity - gap],
    expiring: [refDay, refDay + 90],
    expired: [refDay - 420, refDay - 1],
  }[outcome];
  if (range) {
    const lo = Math.max(range[0], validity - gap); // submission on or after the onboarding day
    const hi = outcome === 'expiring' ? Math.min(range[1], refDay + validity - gap) : range[1];
    const e = between(lo, hi);
    if (e === null) return null;
    const s = e - validity + gap;
    return { s: toIso(s), issue: toIso(s - gap), expiry: toIso(e) };
  }
  const recent = Math.floor(120 * r.next() ** 1.6);
  const s = Math.max(0, refDay - recent);
  return { s: toIso(s), issue: toIso(s - gap), expiry: toIso(s - gap + validity) };
}

function chooseOutcome(cfg, validity, onb, ref, r) {
  const boost = validity ? cfg.ratios.expiryBoost : 1;
  const weights = cfg.ratios.documentOutcomes.map(([o, w]) => [o, o === 'expiring' || o === 'expired' ? w * boost : w]);
  // Try outcomes in a weighted order until one is possible on the dates available.
  const pool = [...weights];
  while (pool.length > 0) {
    const outcome = r.weighted(pool);
    const plan = planDates(outcome, validity, onb, ref, r);
    if (plan) return { outcome, plan };
    pool.splice(pool.findIndex(([o]) => o === outcome), 1);
  }
  const plan = planDates('pending', validity, onb, ref, r);
  return { outcome: 'pending', plan };
}

/** Verification decisions for an outcome, as [status, lag days after the previous step]. */
function pathFor(outcome, r) {
  const review = r.chance(0.6) ? [['In Review', r.int(0, 2)]] : [];
  switch (outcome) {
    case 'pending': return [];
    case 'in_review': return [['In Review', r.int(0, 4)]];
    case 'rejected': return [...review, ['Rejected', r.int(0, 6)]];
    case 'resubmit': return [...review, ['Requires Resubmission', r.int(0, 6)]];
    default: return [...review, ['Verified', r.int(0, 6)]]; // verified, expiring, expired
  }
}

function generateDocuments(cfg, rng, customers, currentRisk, requirements, people, counters) {
  const r = rng.fork('documents');
  const ref = cfg.referenceDate;
  const refEnd = new Date(`${ref}T23:59:59.000Z`).getTime();
  const D = cfg.counts.documents;
  const replacements = Math.round(D * cfg.ratios.replacementDocumentRate);
  const base = D - replacements;

  const groups = slotsByGroup(requirements);
  const requirementIdOf = new Map(requirements.map((q) => [`${q.customerType}|${q.riskLevel}|${q.documentType}`, q.id]));

  // 1. how many of the requested documents each customer has submitted (older customers are more often complete)
  const plans = customers.map((c) => {
    const slots = groups.get(`${c.type}|${currentRisk.get(c.id).riskLevel}`);
    const ageFraction = Math.min(daysBetween(c.onboardedDay, ref) / cfg.ratios.onboardingWindowDays, 1);
    const complete = r.chance(0.3 + 0.6 * ageFraction);
    return { c, slots, cap: slots.length, count: complete ? slots.length : r.int(1, slots.length - 1) };
  });
  const capacity = plans.reduce((s, p) => s + p.cap, 0);
  if (base < plans.length || base > capacity) {
    throw new Error(`The requested ${D} documents cannot be generated for ${plans.length} customers: ${replacements} replacements + ${base} first copies must fit between ${plans.length} (one per customer) and ${capacity} (everything requested).`);
  }
  let total = plans.reduce((s, p) => s + p.count, 0);
  const order = r.shuffle(plans.map((_, i) => i));
  while (total !== base) {
    const step = total > base ? -1 : 1;
    for (const i of order) {
      if (total === base) break;
      const p = plans[i];
      if ((step < 0 && p.count > 1) || (step > 0 && p.count < p.cap)) { p.count += step; total += step; }
    }
  }

  // 2. which requested documents were submitted: the identity document first, then a random subset of the others
  const docs = [];
  for (const p of plans) {
    const { c } = p;
    const chosen = [p.slots[0], ...r.shuffle(p.slots.slice(1)).slice(0, p.count - 1)].sort((a, b) => p.slots.indexOf(a) - p.slots.indexOf(b));
    for (const req of chosen) {
      const validity = typeInfo(req.documentType)?.validityDays ?? null;
      const { outcome, plan } = chooseOutcome(cfg, validity, c.onboardedDay, ref, r);
      docs.push({ c, req, validity, outcome, plan, replaces: null });
    }
  }

  // 3. replacements: an earlier unusable copy of the same document type, submitted before the current one
  const candidates = r.shuffle(docs.filter((d) => ['verified', 'expiring', 'pending', 'in_review'].includes(d.outcome) && daysBetween(d.c.onboardedDay, d.plan.s) >= 8));
  if (candidates.length < replacements) throw new Error(`Only ${candidates.length} documents are eligible to be replacements, ${replacements} are needed.`);
  const olderDocs = [];
  for (const d of candidates.slice(0, replacements)) {
    const room = daysBetween(d.c.onboardedDay, d.plan.s);
    const canExpire = d.validity && room >= d.validity + 10;
    const outcome = r.weighted([['rejected', 45], ['resubmit', 35], ['expired', canExpire ? 25 : 0]]);
    let s;
    let expiry = null;
    const gap = r.int(0, d.validity ? 40 : 30);
    if (outcome === 'expired') {
      s = addDays(d.c.onboardedDay, r.int(0, room - d.validity - 1));
      expiry = addDays(s, d.validity - gap);
    } else {
      s = addDays(d.plan.s, -r.int(8, Math.min(120, room)));
      if (d.validity) expiry = addDays(s, d.validity - gap);
    }
    const older = { c: d.c, req: d.req, validity: d.validity, outcome, plan: { s, issue: addDays(s, -gap), expiry }, replaces: true };
    olderDocs.push(older);
    d.isReplacement = true;
  }
  docs.push(...olderDocs);

  // 4. numbering: by submission date, then customer, then position in the requirement list
  docs.sort((a, b) => a.plan.s.localeCompare(b.plan.s) || a.c.id - b.c.id || a.req.id - b.req.id || (a.replaces ? -1 : 1));

  const documents = [];
  const verifications = [];
  const perCustomer = new Map();

  for (const d of docs) {
    const id = documents.length + 1;
    const { c, req, plan } = d;
    const info = typeInfo(req.documentType);
    const seq = counters.next(`DOC:${c.code}`);
    const code = documentCode(c.code, seq);
    perCustomer.set(c.id, (perCustomer.get(c.id) || 0) + 1);

    let number = null;
    if (info.requiresNumber) {
      if (req.documentType === 'PAN' || req.documentType === 'Business PAN') number = c.pan;
      else if (req.documentType === 'Certificate of Incorporation') number = c.row.companyRegistrationNumber;
      else number = `SYN-${info.abbr}-${r.digits(8)}`;
    }

    // verification history
    let submittedMs = at(plan.s, r).getTime();
    if (plan.s === c.onboardedDay) submittedMs = Math.max(submittedMs, c.onboardedAt.getTime() + r.int(5, 120) * MINUTE); // never before the customer existed
    const submitted = new Date(submittedMs);
    const steps = [{ status: 'Pending', reviewerId: null, remarks: null, when: submitted }];
    const expiryEnd = plan.expiry ? new Date(`${plan.expiry}T23:59:59.000Z`).getTime() : Infinity;
    let when = submitted.getTime();
    for (const [status, lagDays] of pathFor(d.outcome, r)) {
      const wanted = when + lagDays * 24 * HOUR + r.int(30, 600) * MINUTE;
      when = Math.max(when, Math.min(wanted, refEnd, status === 'Verified' ? expiryEnd : Infinity));
      const remarks = r.pick(REMARKS[status] || [null]);
      steps.push({ status, reviewerId: r.pick(people.deciders), remarks, when: new Date(when) });
    }
    const last = steps[steps.length - 1];

    const fileAttached = r.chance(cfg.ratios.fileAttachedRate);
    const doc = {
      id, customerId: c.id, requirementId: requirementIdOf.get(`${c.type}|${currentRisk.get(c.id).riskLevel}|${req.documentType}`) ?? null, documentType: req.documentType,
      documentNumber: number ? encryptDeterministic(number) : null,
      documentNumberHash: number ? blindIndex(`DOC:${req.documentType}`, number) : null,
      issueDate: parseIso(plan.issue), expiryDate: plan.expiry ? parseIso(plan.expiry) : null, submissionDate: parseIso(plan.s), notes: null,
      fileReference: fileAttached ? `syn-doc-${String(id).padStart(6, '0')}.pdf` : null,
      originalFileName: fileAttached ? `${slug(req.documentType)}.pdf` : null,
      fileMimeType: fileAttached ? 'application/pdf' : null,
      fileSizeBytes: fileAttached ? r.int(40_000, 900_000) : null,
      status: last.status, businessId: code, nameOnDocument: nameOnDocument(c, r), createdAt: submitted, updatedAt: last.when,
    };
    documents.push({
      ...doc, row: doc, customerCode: c.code, outcome: d.outcome, isReplacement: Boolean(d.isReplacement), isReplaced: Boolean(d.replaces),
      submissionIso: plan.s, issueIso: plan.issue, expiryIso: plan.expiry, steps,
    });
    steps.forEach((s, k) => verifications.push({ documentId: id, seq: k, reviewerId: s.reviewerId, status: s.status, remarks: s.remarks, verificationDate: s.when, createdAt: s.when }));
  }

  // verification ids follow the order the decisions were made (a document's own steps stay in order)
  verifications.sort((a, b) => a.verificationDate - b.verificationDate || a.documentId - b.documentId || a.seq - b.seq);
  verifications.forEach((v, i) => { v.id = i + 1; });

  const outcomeCounts = {};
  for (const d of documents) outcomeCounts[d.outcome] = (outcomeCounts[d.outcome] || 0) + 1;
  return {
    documents,
    verifications,
    summary: { documents: documents.length, firstCopies: base, replacements, capacity, customersWithDocuments: perCustomer.size, outcomes: outcomeCounts },
  };
}

module.exports = { generateDocuments };
