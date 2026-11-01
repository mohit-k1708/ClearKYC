/**
 * DOCUMENT_REUSED_ACROSS_CUSTOMERS
 *
 * The same document number or the same stored file appears on documents of DIFFERENT customers. The first document with that
 * number / file is treated as the original; every later one belonging to another customer is flagged for investigation, unless the
 * sharing is explainable from the relationship context:
 *   - both customers are companies with a common beneficial owner (the same person), AND
 *   - the document type is one that a group can legitimately share (config/detectionRules.js: an address proof, a bank statement ...).
 * A PAN, a certificate of incorporation or a photograph is never legitimately shared. Documents of the same customer are ignored.
 */
const { PARAMETERS } = require('../config/detectionRules');

module.exports = {
  issueType: 'DOCUMENT_REUSED_ACROSS_CUSTOMERS',
  async run(db) {
    const docs = (await db.query(
      `SELECT d.id, d.business_id, d.customer_id, c.customer_id AS code, c.customer_type_id AS ctype, d.document_type, d.document_number_hash AS hash, d.file_reference AS file
         FROM "Document" d JOIN "Customer" c ON c.id = d.customer_id
        WHERE d.document_number_hash IS NOT NULL OR d.file_reference IS NOT NULL ORDER BY d.id`
    )).rows;
    const links = (await db.query('SELECT company_customer_id AS company, person_ref FROM "CompanyOwnership"')).rows;
    const people = new Map();
    for (const l of links) {
      if (!people.has(l.company)) people.set(l.company, new Set());
      people.get(l.company).add(l.person_ref);
    }
    const related = (a, b) => {
      const x = people.get(a.customer_id);
      const y = people.get(b.customer_id);
      return Boolean(x && y && a.ctype === 2 && b.ctype === 2 && [...x].some((p) => y.has(p)));
    };

    const groups = new Map();
    for (const d of docs) {
      for (const key of [d.hash && `H|${d.document_type}|${d.hash}`, d.file && `F|${d.file}`]) {
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(d);
      }
    }

    const flagged = new Map();
    let shared = 0;
    for (const [key, list] of groups) {
      if (new Set(list.map((d) => d.customer_id)).size < 2) continue;
      shared += 1;
      const original = list[0];
      for (const d of list.slice(1)) {
        if (d.customer_id === original.customer_id || flagged.has(d.id)) continue;
        const shareable = PARAMETERS.shareableDocumentTypes;
        const legitimate = related(original, d) && shareable.includes(d.document_type) && shareable.includes(original.document_type);
        if (legitimate) continue;
        const what = key.startsWith('H|') ? 'document number' : 'stored file';
        flagged.set(d.id, {
          entityId: d.business_id, customer: d.code,
          description: `The same ${what} was already used by ${original.business_id} of ${original.code}, a customer with no ownership link to ${d.code}. Possible document reuse: investigate.`,
        });
      }
    }
    return { findings: [...flagged.values()], notes: { groupsSharedAcrossCustomers: shared } };
  },
};
