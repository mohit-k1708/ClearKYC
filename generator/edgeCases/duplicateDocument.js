/**
 * DOCUMENT_REUSED_ACROSS_CUSTOMERS
 *
 * Makes a LATER document of one customer carry the document number (and stored file) of an EARLIER document of another customer
 * who has no ownership link to the first. The earlier document is the original and is not touched; the copy is the planted issue.
 *   copy_number   the number (and, when the original has one, the file) is copied
 *   copy_file     only the stored file reference is copied
 * Both customers keep all their other records.
 */
const { ownershipLinks, pick } = require('./common');

const NUMBERED = ['PAN', 'Business PAN', 'Address Proof', 'Bank Statement', 'Certificate of Incorporation'];

module.exports = {
  issueType: 'DOCUMENT_REUSED_ACROSS_CUSTOMERS',
  entityType: 'Document',
  severity: 'HIGH',
  rule: 'duplicateDocumentRule',
  async inject(ctx, count) {
    const docs = (await ctx.db.query(
      `SELECT d.id, d.business_id, d.customer_id, c.customer_id AS code, c.customer_type_id AS ctype, d.document_type, d.document_number AS number, d.document_number_hash AS hash,
              d.file_reference, d.original_file_name, d.file_mime_type, d.file_size_bytes
         FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.document_number_hash IS NOT NULL AND d.document_type = ANY($1) ORDER BY d.id`, [NUMBERED]
    )).rows;
    const related = await ownershipLinks(ctx.db);
    const byType = new Map();
    for (const d of docs) byType.set(d.document_type, [...(byType.get(d.document_type) || []), d]);

    const issues = [];
    let n = 0;
    for (const original of ctx.rng.shuffle(docs)) {
      if (issues.length >= count) break;
      if (ctx.used.customers.has(original.customer_id)) continue;
      const later = ctx.rng.shuffle((byType.get(original.document_type) || []).filter((b) => b.id > original.id && b.customer_id !== original.customer_id
        && b.ctype === original.ctype && !ctx.used.customers.has(b.customer_id) && !related(original.customer_id, b.customer_id)));
      const copy = later[0];
      if (!copy) continue;
      const method = original.file_reference && n % 2 === 1 ? 'copy_file' : 'copy_number';
      n += 1;
      ctx.used.customers.add(original.customer_id);
      ctx.used.customers.add(copy.customer_id);
      const file = [original.file_reference, original.original_file_name, original.file_mime_type, original.file_size_bytes];
      if (method === 'copy_number') {
        await ctx.db.query(
          `UPDATE "Document" SET document_number = $1, document_number_hash = $2,
                  file_reference = COALESCE($3, file_reference), original_file_name = COALESCE($4, original_file_name), file_mime_type = COALESCE($5, file_mime_type), file_size_bytes = COALESCE($6, file_size_bytes)
            WHERE id = $7`, [original.number, original.hash, ...file, copy.id]
        );
      } else {
        await ctx.db.query('UPDATE "Document" SET file_reference = $1, original_file_name = $2, file_mime_type = $3, file_size_bytes = $4 WHERE id = $5', [...file, copy.id]);
      }
      issues.push({
        entity_id: copy.business_id, related_customer_id: copy.code,
        description: `${copy.business_id} (${copy.code}) reuses the ${method === 'copy_number' ? 'document number' : 'stored file'} of ${original.business_id} (${original.code}); the two customers have no ownership link.`,
        injection_method: method,
        change: { table: 'Document', key: copy.business_id, before: { document_number_hash: copy.hash, file_reference: copy.file_reference }, after: { copied_from: original.business_id, method } },
      });
    }
    return issues;
  },
};
