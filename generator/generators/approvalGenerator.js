/**
 * Onboarding decisions (Phase 3 baseline). The valid baseline must contain NO "approved with missing evidence", so a customer is
 * approved only if, at the moment of the decision, every mandatory document of their type and risk level had a Verified decision and
 * had not expired. Every customer starts with a "Pending Review" entry; customers whose evidence was complete are approved shortly
 * after their last mandatory document was verified; a few customers who never completed their file were rejected; the rest stay
 * pending. A later expiry never makes an earlier approval wrong: the evidence is judged AT THE TIME of the decision.
 *
 * Requirements in force: the rule set whose effective window contains the decision date. Decisions that pre-date the first
 * requirement set (all sample rules take effect on 2026-01-01) are judged against that first set.
 */
const HOUR = 3_600_000;
const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function generateApprovals(cfg, rng, customers, ratings, documents, requirements, people) {
  const r = rng.fork('approvals');
  const ref = cfg.referenceDate;
  const refEnd = Date.parse(`${ref}T23:59:59.000Z`);
  const ratingsBy = new Map();
  for (const rt of ratings) {
    if (!ratingsBy.has(rt.customerId)) ratingsBy.set(rt.customerId, []);
    ratingsBy.get(rt.customerId).push(rt);
  }
  const docsBy = new Map();
  for (const d of documents) {
    if (!docsBy.has(d.customerId)) docsBy.set(d.customerId, []);
    docsBy.get(d.customerId).push(d);
  }
  const byKey = new Map();
  for (const q of requirements) {
    const key = `${q.customerType}|${q.riskLevel}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(q);
  }
  const levelAt = (list, tMs) => ([...list].reverse().find((x) => x.assessmentDate.getTime() <= tMs) ?? list[0]).riskLevel;
  const requiredTypes = (type, level, dateIso) => {
    const all = (byKey.get(`${type}|${level}`) || []).filter((q) => q.isMandatory && q.isActive);
    const inForce = all.filter((q) => iso(q.effectiveFrom.getTime()) <= dateIso && (!q.effectiveTo || iso(q.effectiveTo.getTime()) >= dateIso));
    return [...new Set((inForce.length > 0 ? inForce : all).map((q) => q.documentType))];
  };
  const statusAt = (doc, tMs) => [...doc.steps].reverse().find((s) => s.when.getTime() <= tMs)?.status ?? null;
  const validAt = (doc, tMs) => doc.submissionIso <= iso(tMs) && statusAt(doc, tMs) === 'Verified' && (!doc.expiryIso || doc.expiryIso >= iso(tMs));

  const decisions = [];
  const add = (customer, decision, decidedBy, decidedAt, notes) => decisions.push({ customerId: customer.id, decision, decidedById: decidedBy, decidedAt, notes, createdAt: decidedAt });
  const stats = { approved: 0, rejected: 0, pendingOnly: 0 };

  for (const c of customers) {
    add(c, 'Pending Review', r.pick(people.analysts), new Date(Math.min(c.onboardedAt.getTime() + r.int(1, 30) * MIN, refEnd)), 'Registered; documents requested (synthetic).');
    const docs = docsBy.get(c.id) || [];
    const list = ratingsBy.get(c.id);
    // earliest moment each mandatory type could be satisfied, using the final risk level for the first guess
    const guessTypes = requiredTypes(c.type, list[list.length - 1].riskLevel, ref);
    let ready = c.onboardedAt.getTime();
    let possible = true;
    for (const type of guessTypes) {
      const times = docs.filter((d) => d.documentType === type).flatMap((d) => d.steps.filter((s) => s.status === 'Verified').map((s) => s.when.getTime()));
      if (times.length === 0) { possible = false; break; }
      ready = Math.max(ready, Math.min(...times));
    }
    let approvedAt = null;
    if (possible && r.chance(0.97)) {
      const t = ready + r.int(1, 48) * HOUR;
      if (t <= refEnd) {
        const needed = requiredTypes(c.type, levelAt(list, t), iso(t));
        if (needed.every((type) => docs.some((d) => d.documentType === type && validAt(d, t)))) approvedAt = t;
      }
    }
    if (approvedAt !== null) {
      add(c, 'Approved', r.pick(people.deciders), new Date(approvedAt), 'All mandatory documents verified and valid at the time of approval (synthetic).');
      stats.approved += 1;
    } else if (daysSince(c.onboardedDay, ref) >= 120 && r.chance(0.03)) {
      add(c, 'Rejected', r.pick(people.deciders), new Date(Math.min(c.onboardedAt.getTime() + r.int(30, 110) * 24 * HOUR, refEnd)), 'Required evidence was not provided in time (synthetic).');
      stats.rejected += 1;
    } else {
      stats.pendingOnly += 1;
    }
  }

  decisions.sort((a, b) => a.decidedAt - b.decidedAt || a.customerId - b.customerId || (a.decision === 'Pending Review' ? -1 : 1));
  decisions.forEach((d, i) => { d.id = i + 1; });
  return { decisions, stats };
}

const daysSince = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

module.exports = { generateApprovals };
