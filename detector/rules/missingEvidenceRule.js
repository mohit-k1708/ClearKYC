/**
 * APPROVED_WITH_MISSING_EVIDENCE
 *
 * For every customer whose CURRENT onboarding decision is "Approved", the rule rebuilds what was true on the day of the decision:
 *   - the risk level then in force (the newest risk assessment made on or before the decision);
 *   - the mandatory requirements of that customer type and level whose effective window contains the decision date (a decision
 *     that pre-dates the first requirement set is judged against that first set);
 *   - for each mandatory document type, whether a document of that type had been submitted, was Verified (the newest verification
 *     made on or before the decision) and had not expired on the decision date.
 * A customer is flagged when at least one mandatory type fails. Completeness TODAY is not used: a document that expired after a
 * correct approval does not make the approval wrong, and a document verified after the approval does not repair it.
 */
const epoch = (col) => `(extract(epoch from ${col}) * 1000)::bigint`;
const dayOf = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);

module.exports = {
  issueType: 'APPROVED_WITH_MISSING_EVIDENCE',
  async run(db) {
    const approved = (await db.query(
      `SELECT d.customer_id, c.customer_id AS code, t.type_name AS type, ${epoch('d.decided_at')} AS decided
         FROM (SELECT DISTINCT ON (customer_id) * FROM "OnboardingDecision" ORDER BY customer_id, decided_at DESC, id DESC) d
         JOIN "Customer" c ON c.id = d.customer_id JOIN "CustomerType" t ON t.id = c.customer_type_id
        WHERE d.decision = 'Approved' ORDER BY d.customer_id`
    )).rows;
    if (approved.length === 0) return { findings: [], notes: { approvedCustomers: 0 } };

    const ids = approved.map((a) => a.customer_id);
    const rows = async (sql, params) => (await db.query(sql, params)).rows; // one query at a time on this client
    const ratings = await rows(`SELECT customer_id, risk_level, ${epoch('assessment_date')} AS at FROM "RiskRating" WHERE customer_id = ANY($1) ORDER BY customer_id, assessment_date, id`, [ids]);
    const requirements = await rows('SELECT t.type_name AS type, q.risk_level, q.document_type, q.is_mandatory, q.is_active, q.effective_from::text AS from_day, q.effective_to::text AS to_day FROM "KYCRequirement" q JOIN "CustomerType" t ON t.id = q.customer_type_id');
    const documents = await rows('SELECT id, customer_id, document_type, submission_date::text AS submitted, expiry_date::text AS expiry FROM "Document" WHERE customer_id = ANY($1)', [ids]);
    const verifications = await rows(`SELECT v.document_id, v.status, ${epoch('v.verification_date')} AS at FROM "Verification" v JOIN "Document" d ON d.id = v.document_id WHERE d.customer_id = ANY($1) ORDER BY v.document_id, v.id`, [ids]);

    const group = (rows, key) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) || []), r]), new Map());
    const ratingsBy = group(ratings, 'customer_id');
    const docsBy = group(documents, 'customer_id');
    const verifBy = group(verifications, 'document_id');
    const reqBy = group(requirements.filter((q) => q.is_mandatory && q.is_active), 'type');

    const findings = [];
    for (const a of approved) {
      const decided = Number(a.decided);
      const day = dayOf(decided);
      const history = ratingsBy.get(a.customer_id) || [];
      const level = ([...history].reverse().find((x) => Number(x.at) <= decided) ?? history[0])?.risk_level;
      const forLevel = (reqBy.get(a.type) || []).filter((q) => q.risk_level === level);
      const inForce = forLevel.filter((q) => q.from_day <= day && (!q.to_day || q.to_day >= day));
      const required = [...new Set((inForce.length > 0 ? inForce : forLevel).map((q) => q.document_type))];

      const problems = [];
      for (const type of required) {
        const docs = (docsBy.get(a.customer_id) || []).filter((d) => d.document_type === type && d.submitted <= day);
        if (docs.length === 0) { problems.push(`${type} (not submitted)`); continue; }
        const valid = docs.some((d) => {
          const state = [...(verifBy.get(d.id) || [])].reverse().find((v) => Number(v.at) <= decided);
          return state?.status === 'Verified' && (!d.expiry || d.expiry >= day);
        });
        if (!valid) problems.push(`${type} (submitted but not a verified, unexpired document on that day)`);
      }
      if (problems.length > 0) {
        findings.push({
          entityId: a.code, customer: a.code,
          description: `Approved on ${day}, but mandatory evidence was not in place at that time: ${problems.join('; ')}.`,
        });
      }
    }
    return { findings, notes: { approvedCustomers: approved.length } };
  },
};
