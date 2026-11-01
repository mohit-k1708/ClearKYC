/**
 * EXPIRED_DOCUMENT_MARKED_VALID
 *
 * Takes a currently valid, Verified document and moves its dates so that it had ALREADY EXPIRED when it was submitted - and
 * therefore when a reviewer verified it. The document stays Verified; its verification history is not touched.
 *
 * Only issue_date and expiry_date of the one document change (issue = expiry - the validity of that document type, so the
 * document still satisfies the table's date rules). The original dates are recorded in the manifest.
 */
const { typeInfo } = require('../../server/src/config/kycRules');
const { addDays } = require('../../server/src/utils/dates');
const { pick } = require('./common');

module.exports = {
  issueType: 'EXPIRED_DOCUMENT_MARKED_VALID',
  entityType: 'Document',
  severity: 'HIGH',
  rule: 'expiredDocumentRule',
  async inject(ctx, count) {
    const { rows } = await ctx.db.query(
      `SELECT d.id, d.business_id, d.customer_id, c.customer_id AS code, d.document_type, d.issue_date::text AS issue, d.expiry_date::text AS expiry, d.submission_date::text AS submitted
         FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id
         JOIN LATERAL (SELECT status FROM "Verification" v WHERE v.document_id = d.id ORDER BY v.id DESC LIMIT 1) v ON true
        WHERE d.expiry_date IS NOT NULL AND d.expiry_date > $1::date + 120 AND v.status = 'Verified'
          AND NOT EXISTS (SELECT 1 FROM "OnboardingDecision" od WHERE od.customer_id = d.customer_id AND od.decision = 'Approved') -- an approved customer's evidence must stay intact
        ORDER BY d.id`,
      [ctx.referenceDate]
    );
    const issues = [];
    for (const d of pick(ctx, rows, count, (x) => x.customer_id)) {
      const validity = typeInfo(d.document_type).validityDays;
      const newExpiry = addDays(d.submitted, -ctx.rng.int(5, 60)); // already expired when it was submitted
      const newIssue = addDays(newExpiry, -validity);
      await ctx.db.query('UPDATE "Document" SET issue_date = $1::date, expiry_date = $2::date WHERE id = $3', [newIssue, newExpiry, d.id]);
      issues.push({
        entity_id: d.business_id, related_customer_id: d.code,
        description: `${d.document_type} ${d.business_id} was moved to expire on ${newExpiry}, before its submission date ${d.submitted}; it stays Verified.`,
        injection_method: 'move_expiry_before_submission',
        change: { table: 'Document', key: d.business_id, before: { issue_date: d.issue, expiry_date: d.expiry }, after: { issue_date: newIssue, expiry_date: newExpiry } },
      });
    }
    return issues;
  },
};
