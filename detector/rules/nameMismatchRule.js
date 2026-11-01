/**
 * DOCUMENT_NAME_MISMATCH
 *
 * Compares the name written on a document with the customer's registered name using the configurable comparison in
 * detector/nameMatcher.js (exact or normalised). Only a name that is different even after normalisation is reported, and only as
 * a POTENTIAL mismatch for manual review: spelling variants, initials, titles, reordering and company legal forms are accepted.
 */
const { compareNames } = require('../nameMatcher');
const defaults = require('../config/nameMatching');

module.exports = {
  issueType: 'DOCUMENT_NAME_MISMATCH',
  async run(db, { nameMatching = defaults } = {}) {
    const { rows } = await db.query(
      `SELECT d.business_id AS entity_id, c.customer_id AS customer, c.full_name, c.customer_type_id AS ctype, d.name_on_document AS on_document, d.document_type
         FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id WHERE d.name_on_document IS NOT NULL ORDER BY d.id`
    );
    const findings = [];
    const kinds = {};
    for (const r of rows) {
      const result = compareNames(r.full_name, r.on_document, { isCompany: r.ctype === 2, config: nameMatching });
      kinds[result.kind] = (kinds[result.kind] || 0) + 1;
      if (!result.match) {
        findings.push({
          entityId: r.entity_id, customer: r.customer,
          description: `The ${r.document_type} shows the name "${r.on_document}" but the customer is registered as "${r.full_name}". Potential name mismatch: needs manual review (not confirmed fraud).`,
        });
      }
    }
    return { findings, notes: { comparisons: rows.length, byKind: kinds, mode: nameMatching.mode } };
  },
};
