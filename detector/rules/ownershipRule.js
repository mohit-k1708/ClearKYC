/** OWNERSHIP_OVER_100: the beneficial owners of a company add up to more than 100%. Computed from the owner rows themselves. */
module.exports = {
  issueType: 'OWNERSHIP_OVER_100',
  async run(db) {
    const { rows } = await db.query(
      `SELECT c.customer_id AS entity_id, sum(b.ownership_percentage)::text AS total, count(*)::int AS owners
         FROM "BeneficialOwner" b JOIN "Customer" c ON c.id = b.customer_id
        GROUP BY c.id, c.customer_id HAVING sum(b.ownership_percentage) > 100 ORDER BY c.id`
    );
    return {
      findings: rows.map((r) => ({
        entityId: r.entity_id, customer: r.entity_id,
        description: `The ${r.owners} beneficial owners of this company hold ${Number(r.total)}% in total, which is more than 100%.`,
      })),
      notes: {},
    };
  },
};
