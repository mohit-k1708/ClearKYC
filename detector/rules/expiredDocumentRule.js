/**
 * EXPIRED_DOCUMENT_MARKED_VALID
 *
 * A document whose expiry date is before the reference date and whose newest verification is still "Verified" - AND whose
 * Verified decision was recorded AFTER the expiry date, i.e. a reviewer accepted a document that had already expired.
 *
 * Why the last condition: a document that was verified while valid and expired later is an ordinary lifecycle state (its
 * Verified decision was correct on the day it was made, and the KYC engine reports it as Expired). Flagging those as well would
 * report thousands of correct records. The count of documents matching only the first two conditions is returned in `notes`.
 */
module.exports = {
  issueType: 'EXPIRED_DOCUMENT_MARKED_VALID',
  async run(db, { referenceDate }) {
    const latest = `JOIN LATERAL (SELECT status, verification_date FROM "Verification" v WHERE v.document_id = d.id ORDER BY v.id DESC LIMIT 1) v ON true`;
    const { rows } = await db.query(
      `SELECT d.business_id AS entity_id, c.customer_id AS customer, d.document_type, d.expiry_date::text AS expiry, v.verification_date::date::text AS verified_on
         FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id ${latest}
        WHERE d.expiry_date IS NOT NULL AND d.expiry_date < $1::date AND v.status = 'Verified' AND v.verification_date::date > d.expiry_date
        ORDER BY d.id`,
      [referenceDate]
    );
    const [{ n }] = (await db.query(
      `SELECT count(*)::int AS n FROM "Document" d ${latest} WHERE d.expiry_date IS NOT NULL AND d.expiry_date < $1::date AND v.status = 'Verified'`,
      [referenceDate]
    )).rows;
    return {
      findings: rows.map((r) => ({
        entityId: r.entity_id, customer: r.customer,
        description: `${r.document_type} expired on ${r.expiry} but was verified on ${r.verified_on}, after it had expired. It must not count as valid KYC evidence.`,
      })),
      notes: { expiredAndVerifiedLiteralRule: n, flagged: rows.length, explanation: 'Expired documents that were verified BEFORE they expired are normal and are not flagged.' },
    };
  },
};
