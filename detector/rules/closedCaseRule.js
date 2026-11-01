/** CLOSED_WITHOUT_RESOLUTION: a review case is Closed (with a closed date) but has no documented resolution notes. */
module.exports = {
  issueType: 'CLOSED_WITHOUT_RESOLUTION',
  async run(db) {
    const { rows } = await db.query(
      `SELECT rc.review_code AS entity_id, c.customer_id AS customer, rc.case_code, rc.closed_at::date::text AS closed_on
         FROM "ReviewCase" rc JOIN "Customer" c ON c.id = rc.customer_id
        WHERE rc.status = 'Closed' AND rc.closed_at IS NOT NULL AND btrim(coalesce(rc.resolution_notes, '')) = ''
        ORDER BY rc.id`
    );
    return {
      findings: rows.map((r) => ({
        entityId: r.entity_id, customer: r.customer,
        description: `Case ${r.case_code} was closed on ${r.closed_on} but has no documented resolution.`,
      })),
      notes: {},
    };
  },
};
