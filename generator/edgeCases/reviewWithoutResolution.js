/**
 * CLOSED_WITHOUT_RESOLUTION
 *
 * Takes an ordinary Closed review case and erases its resolution notes. Status, closed date and the case history are untouched.
 *
 * The database normally REFUSES this state (check constraint ReviewCase_resolution_notes_check: a Resolved or Closed case must have
 * notes). A deliberately invalid record can therefore only exist in the isolated edge-case database, where that one constraint is
 * dropped. The runner records the relaxation in the manifest; the development database and the baseline keep the constraint.
 * Nothing is "fixed" afterwards.
 */
const { pick } = require('./common');

module.exports = {
  issueType: 'CLOSED_WITHOUT_RESOLUTION',
  entityType: 'ReviewCase',
  severity: 'MEDIUM',
  rule: 'closedCaseRule',
  relaxedConstraints: [{ table: 'ReviewCase', constraint: 'ReviewCase_resolution_notes_check', reason: 'A Closed case without resolution notes is impossible while this check exists.' }],
  async inject(ctx, count) {
    await ctx.db.query('ALTER TABLE "ReviewCase" DROP CONSTRAINT IF EXISTS "ReviewCase_resolution_notes_check"');
    const { rows } = await ctx.db.query(
      `SELECT rc.id, rc.review_code, rc.case_code, rc.customer_id, c.customer_id AS code, rc.resolution_notes, rc.closed_at::date::text AS closed_on
         FROM "ReviewCase" rc JOIN "Customer" c ON c.id = rc.customer_id
        WHERE rc.status = 'Closed' AND rc.closed_at IS NOT NULL AND btrim(coalesce(rc.resolution_notes, '')) <> '' ORDER BY rc.id`
    );
    const issues = [];
    for (const k of pick(ctx, rows, count, (x) => x.customer_id)) {
      await ctx.db.query('UPDATE "ReviewCase" SET resolution_notes = NULL WHERE id = $1', [k.id]);
      issues.push({
        entity_id: k.review_code, related_customer_id: k.code,
        description: `Case ${k.case_code} (${k.review_code}) is Closed (closed ${k.closed_on}) but its resolution notes were removed.`,
        injection_method: 'erase_resolution_notes',
        change: { table: 'ReviewCase', key: k.review_code, before: { resolution_notes: k.resolution_notes }, after: { resolution_notes: null } },
      });
    }
    return issues;
  },
};
