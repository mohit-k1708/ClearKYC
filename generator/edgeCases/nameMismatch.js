/**
 * DOCUMENT_NAME_MISMATCH
 *
 * Replaces the name written on a document with a clearly different name. For individuals either the first name changes and the
 * surname stays ("Amit Sharma" -> "Rahul Sharma") or the whole name is a different person; for companies a different company name.
 * The planted name must be unlike the real one: spelling variants, initials and titles are legitimate and are already in the baseline.
 */
const { FIRST, LAST } = require('../generators/customerGenerator');
const { similarity, pick } = require('./common');

const COMPANY_A = ['Northgate', 'Redwood', 'Quartz', 'Tidewater', 'Maple', 'Ironbridge', 'Falcon', 'Skyline'];
const COMPANY_B = ['Holdings', 'Enterprises', 'Systems', 'Agro', 'Motors', 'Networks'];

module.exports = {
  issueType: 'DOCUMENT_NAME_MISMATCH',
  entityType: 'Document',
  severity: 'MEDIUM',
  rule: 'nameMismatchRule',
  async inject(ctx, count) {
    const { rows } = await ctx.db.query(
      `SELECT d.id, d.business_id, d.customer_id, c.customer_id AS code, c.full_name, c.customer_type_id AS ctype, d.name_on_document, d.document_type
         FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.name_on_document IS NOT NULL ORDER BY d.id`
    );
    const issues = [];
    let n = 0;
    for (const d of pick(ctx, rows, count, (x) => x.customer_id)) {
      let wrong;
      let method;
      if (d.ctype === 2) {
        do wrong = `${ctx.rng.pick(COMPANY_A)} ${ctx.rng.pick(COMPANY_B)} Pvt Ltd`;
        while (similarity(wrong, d.full_name) > 0.5);
        method = 'different_company';
      } else {
        const [first, ...rest] = d.full_name.split(' ');
        const surname = rest.join(' ');
        if (n % 2 === 0) {
          do wrong = `${ctx.rng.pick(FIRST)} ${surname}`;
          while (similarity(wrong.split(' ')[0], first) > 0.5);
          method = 'different_first_name_same_surname';
        } else {
          do wrong = `${ctx.rng.pick(FIRST)} ${ctx.rng.pick(LAST)}`;
          while (similarity(wrong, d.full_name) > 0.5);
          method = 'different_person';
        }
        n += 1;
      }
      await ctx.db.query('UPDATE "Document" SET name_on_document = $1 WHERE id = $2', [wrong, d.id]);
      issues.push({
        entity_id: d.business_id, related_customer_id: d.code,
        description: `${d.document_type} ${d.business_id} now shows "${wrong}" while ${d.code} is registered as "${d.full_name}".`,
        injection_method: method,
        change: { table: 'Document', key: d.business_id, before: { name_on_document: d.name_on_document }, after: { name_on_document: wrong } },
      });
    }
    return issues;
  },
};
