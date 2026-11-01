/**
 * APPROVED_WITH_MISSING_EVIDENCE
 *
 * Adds an "Approved" onboarding decision for a customer whose file was NOT complete at that moment. Two variants, both with every
 * other mandatory document verified (the example in the brief: PAN and Photograph verified, Address Proof missing):
 *   missing_document     one mandatory document type was never submitted
 *   unverified_document  one mandatory document was submitted but is still Pending / In Review
 * Only a new insert-only decision row is added; no document or verification is touched.
 */
const { pick } = require('./common');

const epoch = (col) => `(extract(epoch from ${col}) * 1000)::bigint`;

module.exports = {
  issueType: 'APPROVED_WITH_MISSING_EVIDENCE',
  entityType: 'Customer',
  severity: 'HIGH',
  rule: 'missingEvidenceRule',
  async inject(ctx, count) {
    const ref = ctx.referenceDate;
    const refEnd = Date.parse(`${ref}T23:59:59.000Z`);
    const customers = (await ctx.db.query(
      `SELECT c.id, c.customer_id AS code, t.type_name AS type, ${epoch('c.created_at')} AS created,
              (SELECT risk_level FROM "RiskRating" r WHERE r.customer_id = c.id ORDER BY r.id DESC LIMIT 1) AS level
         FROM "Customer" c JOIN "CustomerType" t ON t.id = c.customer_type_id
        WHERE NOT EXISTS (SELECT 1 FROM "OnboardingDecision" d WHERE d.customer_id = c.id AND d.decision IN ('Approved', 'Rejected')) ORDER BY c.id`
    )).rows;
    const requirements = (await ctx.db.query(
      `SELECT t.type_name AS type, q.risk_level, q.document_type FROM "KYCRequirement" q JOIN "CustomerType" t ON t.id = q.customer_type_id
        WHERE q.is_mandatory AND q.is_active AND q.effective_from <= $1::date AND (q.effective_to IS NULL OR q.effective_to >= $1::date)`, [ref]
    )).rows;
    const docs = (await ctx.db.query(
      `SELECT d.id, d.customer_id, d.document_type, d.expiry_date::text AS expiry, d.submission_date::text AS submitted, d.status,
              (SELECT ${epoch('min(v.verification_date)')} FROM "Verification" v WHERE v.document_id = d.id AND v.status = 'Verified') AS first_verified
         FROM "Document" d ORDER BY d.id`
    )).rows;
    const docsBy = new Map();
    for (const d of docs) docsBy.set(d.customer_id, [...(docsBy.get(d.customer_id) || []), d]);

    const candidates = [];
    for (const c of customers) {
      const required = [...new Set(requirements.filter((q) => q.type === c.type && q.risk_level === c.level).map((q) => q.document_type))];
      const mine = docsBy.get(c.id) || [];
      const verifiedAt = (type) => {
        const ok = mine.filter((d) => d.document_type === type && d.status === 'Verified' && d.first_verified !== null);
        return ok.length > 0 ? Math.min(...ok.map((d) => Number(d.first_verified))) : null;
      };
      const broken = required.filter((type) => verifiedAt(type) === null);
      if (broken.length !== 1 || required.length < 2) continue; // exactly one gap, the rest verified
      const type = broken[0];
      const gapDocs = mine.filter((d) => d.document_type === type);
      const others = required.filter((x) => x !== type).map(verifiedAt);
      const base = Math.max(Number(c.created) + 3 * 86_400_000, ...others);
      const latest = new Date(base + 49 * 3_600_000).toISOString().slice(0, 10);
      if (base + 49 * 3_600_000 > refEnd) continue; // no room before the reference date
      // the other documents must still be valid on the decision day, so the only gap is the one being planted
      const othersValid = required.filter((x) => x !== type).every((t) => mine.some((d) => d.document_type === t && d.status === 'Verified' && (!d.expiry || d.expiry >= latest)));
      if (!othersValid) continue;
      if (gapDocs.length === 0) candidates.push({ c, type, variant: 'missing_document', base });
      else if (gapDocs.every((d) => ['Pending', 'In Review'].includes(d.status))) {
        const submitted = Math.max(...gapDocs.map((d) => Date.parse(`${d.submitted}T00:00:00Z`)));
        candidates.push({ c, type, variant: 'unverified_document', base: Math.max(base, submitted) });
      }
    }

    const issues = [];
    for (const k of pick(ctx, candidates, count, (x) => x.c.id)) {
      const decidedAt = k.base + ctx.rng.int(1, 48) * 3_600_000;
      const by = ctx.rng.pick(ctx.people.deciders);
      const when = new Date(decidedAt).toISOString();
      await ctx.db.query(
        `INSERT INTO "OnboardingDecision" (customer_id, decision, decided_by_id, decided_at, notes, created_at) VALUES ($1, 'Approved', $2, $3::timestamp, $4, $3::timestamp)`,
        [k.c.id, by, when, 'Approved (synthetic edge case).']
      );
      issues.push({
        entity_id: k.c.code, related_customer_id: k.c.code,
        description: `${k.c.code} was approved on ${when.slice(0, 10)} while the mandatory ${k.type} was ${k.variant === 'missing_document' ? 'never submitted' : 'submitted but not verified'}.`,
        injection_method: k.variant,
        change: { table: 'OnboardingDecision', key: k.c.code, before: null, after: { decision: 'Approved', decided_at: when, gap: k.type } },
      });
    }
    return issues;
  },
};
