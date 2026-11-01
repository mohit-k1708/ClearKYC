/**
 * Legitimate look-alikes ("negative controls"). They are NOT in the answer key: the detector must leave them alone, so they test
 * for false positives.
 *
 *   shared_document_related_companies   two companies with a common beneficial owner use the same address proof (a group sharing a
 *                                       registered office). Same document number and stored file, but the relationship and the
 *                                       document type explain it.
 *
 * The baseline itself already contains the other look-alikes: name variants (capitals, titles, initials, reversed order, a
 * one-letter typo, "Pvt Ltd" written out), documents that expired AFTER a correct verification, and approvals that were correct
 * when made even though a document expired later. They are counted in the manifest.
 */
const { pick } = require('./common');

async function addSharedDocuments(ctx, count) {
  const pairs = (await ctx.db.query(
    `SELECT DISTINCT LEAST(a.company_customer_id, b.company_customer_id) AS x, GREATEST(a.company_customer_id, b.company_customer_id) AS y
       FROM "CompanyOwnership" a JOIN "CompanyOwnership" b ON a.person_ref = b.person_ref AND a.company_customer_id < b.company_customer_id ORDER BY 1, 2`
  )).rows;
  const proof = async (customer) => (await ctx.db.query(
    `SELECT id, business_id, document_number, document_number_hash, file_reference, original_file_name, file_mime_type, file_size_bytes
       FROM "Document" WHERE customer_id = $1 AND document_type = 'Address Proof' AND document_number_hash IS NOT NULL ORDER BY id`, [customer]
  )).rows[0];
  const out = [];
  for (const p of ctx.rng.shuffle(pairs)) {
    if (out.length >= count) break;
    if (ctx.used.customers.has(p.x) || ctx.used.customers.has(p.y)) continue;
    const [one, two] = [await proof(p.x), await proof(p.y)];
    if (!one || !two) continue;
    const [original, copy] = one.id < two.id ? [one, two] : [two, one];
    await ctx.db.query(
      `UPDATE "Document" SET document_number = $1, document_number_hash = $2,
              file_reference = COALESCE($3, file_reference), original_file_name = COALESCE($4, original_file_name), file_mime_type = COALESCE($5, file_mime_type), file_size_bytes = COALESCE($6, file_size_bytes)
        WHERE id = $7`,
      [original.document_number, original.document_number_hash, original.file_reference, original.original_file_name, original.file_mime_type, original.file_size_bytes, copy.id]
    );
    ctx.used.customers.add(p.x);
    ctx.used.customers.add(p.y);
    out.push({ kind: 'shared_document_related_companies', original_document: original.business_id, shared_by_document: copy.business_id, customer_ids: [p.x, p.y] });
  }
  return out;
}

/** Counts of the legitimate look-alikes that exist in the dataset (for the manifest). */
async function countLookAlikes(ctx) {
  const one = async (sql, params) => Number((await ctx.db.query(sql, params)).rows[0].n);
  return {
    documents_expired_after_a_correct_verification: await one(
      `SELECT count(*)::int AS n FROM "Document" d JOIN LATERAL (SELECT status, verification_date FROM "Verification" v WHERE v.document_id = d.id ORDER BY v.id DESC LIMIT 1) v ON true
        WHERE d.expiry_date < $1::date AND v.status = 'Verified' AND v.verification_date::date <= d.expiry_date`, [ctx.referenceDate]),
    documents_with_a_legitimate_name_variant: await one(`SELECT count(*)::int AS n FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.name_on_document <> c.full_name`),
    approvals_total: await one(`SELECT count(*)::int AS n FROM "OnboardingDecision" WHERE decision = 'Approved'`),
  };
}

module.exports = { addSharedDocuments, countLookAlikes, pick };
