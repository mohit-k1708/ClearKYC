/**
 * OWNERSHIP_OVER_100
 *
 * Makes the beneficial owners of a company add up to more than 100%. Two variants; the original ownership records are preserved
 * in both:
 *   extra_owner     a new owner is added with 5-25% (the existing owners are not touched)
 *   inflate_share   the smallest owner's share is raised by 5-20 points; the ownership bridge keeps the earlier share as a closed
 *                   history row (effective_to = reference date) and opens a new one, exactly as the application would
 * The recorded ownership check (OwnershipValidation) is insert-only history and keeps saying "reconciled": it was true when made.
 */
const { addMonths, addDays } = require('../../server/src/utils/dates');
const { normaliseName } = require('../../server/src/services/ownershipEngine');
const { FIRST, LAST } = require('../generators/customerGenerator');
const { encryptDeterministic, blindIndex } = require('../utils/syntheticCrypto');
const { pick } = require('./common');

module.exports = {
  issueType: 'OWNERSHIP_OVER_100',
  entityType: 'Customer',
  severity: 'HIGH',
  rule: 'ownershipRule',
  async inject(ctx, count) {
    const companies = (await ctx.db.query(
      `SELECT c.id, c.customer_id AS code, count(b.id)::int AS owners
         FROM "Customer" c JOIN "BeneficialOwner" b ON b.customer_id = c.id WHERE c.customer_type_id = 2
        GROUP BY c.id, c.customer_id HAVING sum(b.ownership_percentage) = 100 ORDER BY c.id`
    )).rows;
    const issues = [];
    let n = 0;
    for (const c of pick(ctx, companies, count, (x) => x.id)) {
      const variant = c.owners >= 2 && n % 2 === 0 ? 'inflate_share' : 'extra_owner';
      n += 1;
      const before = (await ctx.db.query('SELECT id, full_name, ownership_percentage::text AS pct FROM "BeneficialOwner" WHERE customer_id = $1 ORDER BY id', [c.id])).rows;
      let change;
      if (variant === 'inflate_share') {
        const smallest = [...before].sort((a, b) => Number(a.pct) - Number(b.pct) || a.id - b.id)[0];
        const delta = ctx.rng.int(5, 20);
        const next = Number(smallest.pct) + delta;
        await ctx.db.query('BEGIN');
        try {
          // the ownership bridge is maintained by hand here so its dates come from the reference date, not from the machine clock
          await ctx.db.query('ALTER TABLE "BeneficialOwner" DISABLE TRIGGER "BeneficialOwner_mirror_update"');
          await ctx.db.query('UPDATE "BeneficialOwner" SET ownership_percentage = $1, updated_by_id = $2, updated_at = $3::timestamp WHERE id = $4', [next, ctx.rng.pick(ctx.people.analysts), ctx.stamp, smallest.id]);
          const cur = (await ctx.db.query('SELECT *, effective_from::text AS from_day FROM "CompanyOwnership" WHERE beneficial_owner_id = $1 AND effective_to IS NULL', [smallest.id])).rows[0];
          if (cur.from_day < ctx.referenceDate) {
            await ctx.db.query('UPDATE "CompanyOwnership" SET effective_to = $1::date, updated_at = $2::timestamp WHERE id = $3', [ctx.referenceDate, ctx.stamp, cur.id]);
            await ctx.db.query(
              `INSERT INTO "CompanyOwnership" (company_customer_id, beneficial_owner_id, person_ref, ownership_percentage, ownership_type, control_type, effective_from, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::timestamp, $8::timestamp)`,
              [cur.company_customer_id, cur.beneficial_owner_id, cur.person_ref, next, cur.ownership_type, cur.control_type, ctx.referenceDate, ctx.stamp]
            );
          } else {
            await ctx.db.query('UPDATE "CompanyOwnership" SET ownership_percentage = $1, updated_at = $2::timestamp WHERE id = $3', [next, ctx.stamp, cur.id]);
          }
          await ctx.db.query('ALTER TABLE "BeneficialOwner" ENABLE TRIGGER "BeneficialOwner_mirror_update"');
          await ctx.db.query('COMMIT');
        } catch (err) {
          await ctx.db.query('ROLLBACK');
          throw err;
        }
        change = { table: 'BeneficialOwner', key: c.code, before: { owner_id: smallest.id, ownership_percentage: Number(smallest.pct) }, after: { owner_id: smallest.id, ownership_percentage: next } };
      } else {
        let name;
        do name = `${ctx.rng.pick(FIRST)} ${ctx.rng.pick(LAST)}`;
        while (before.some((b) => b.full_name === name)); // a new person, not one of the existing owners
        const dob = addDays(addMonths(ctx.referenceDate, -12 * ctx.rng.int(30, 60)), -ctx.rng.int(0, 364));
        const pct = ctx.rng.int(5, 25);
        await ctx.db.query(
          `INSERT INTO "BeneficialOwner" (customer_id, full_name, date_of_birth, country_of_residence, nationality, ownership_percentage, ownership_type, control_type, pep_status, identity_hash, created_by_id, updated_by_id, created_at, updated_at)
           VALUES ($1, $2, $3, 'IN', 'IN', $4, 'Direct', 'Shareholding', 'No', $5, $6, $6, $7::timestamp, $7::timestamp)`,
          [c.id, name, encryptDeterministic(dob), pct, blindIndex('OWNER', `${normaliseName(name)}|${dob}`), ctx.rng.pick(ctx.people.analysts), ctx.stamp]
        );
        change = { table: 'BeneficialOwner', key: c.code, before: null, after: { added_owner: name, ownership_percentage: pct } };
      }
      const total = (await ctx.db.query('SELECT sum(ownership_percentage)::text AS t FROM "BeneficialOwner" WHERE customer_id = $1', [c.id])).rows[0].t;
      issues.push({
        entity_id: c.code, related_customer_id: c.code,
        description: `${c.code} now has beneficial owners holding ${Number(total)}% in total.`,
        injection_method: variant, change,
      });
    }
    return issues;
  },
};
