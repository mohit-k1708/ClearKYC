/**
 * Beneficial ownership (Task 8): valid baseline structures for every company customer.
 *
 *  - one company has 1-4 owners whose shares add up to exactly 100.00 (no deliberate errors: those belong to Phase 3);
 *  - a share of the owner slots is filled by a person who already owns ANOTHER company (same name, birth date and identity hash,
 *    a different percentage in each company): the CompanyOwnership bridge, filled automatically by the database trigger
 *    when these rows are inserted, links every company-owner pair with its own percentage and effective date;
 *  - every owner is screened for PEP and sanctions (synthetic outcomes; a "Potential Match" is only a possible match);
 *  - one reconciled ownership check is recorded per company.
 */
const { addDays, addMonths } = require('../../server/src/utils/dates');
const { normaliseName, pointsForScreening } = require('../../server/src/services/ownershipEngine');
const { buildOwnerAnalysis } = require('../../server/src/services/ownershipService');
const { FIRST, LAST } = require('./customerGenerator');
const { encryptDeterministic, blindIndex } = require('../utils/syntheticCrypto');

const CONTROL = [['Shareholding', 75], ['Voting rights', 9], ['Right to appoint or remove directors', 7], ['Senior managing official', 6], ['Other means of control', 3]];

/** Splits 100.00% into k shares of at least 5%, in whole basis points so the total is exactly 10000 (= 100.00%). */
function splitShares(k, r) {
  if (k === 1) return [10000];
  const min = 500;
  const rest = 10000 - min * k;
  const weights = Array.from({ length: k }, () => r.next() ** 1.3 + 0.15);
  const sum = weights.reduce((s, w) => s + w, 0);
  const parts = weights.map((w) => min + Math.floor((rest * w) / sum));
  parts[0] += 10000 - parts.reduce((s, p) => s + p, 0);
  return parts.sort((a, b) => b - a);
}

function generateOwnership(cfg, rng, customers, people) {
  const r = rng.fork('ownership');
  const refEnd = new Date(`${cfg.referenceDate}T23:59:59.000Z`);
  const companies = customers.filter((c) => c.isCompany);
  const persons = [];
  const owners = [];
  const screenings = [];
  const validations = [];
  const ownersByCompany = new Map();
  let ownerId = 0;
  let screeningId = 0;

  const newPerson = (company) => {
    const first = r.pick(FIRST);
    const last = r.pick(LAST);
    const age = r.int(24, 78);
    const dob = addDays(addMonths(company.onboardedDay, -12 * age), -r.int(0, 364));
    const country = r.chance(0.9) ? 'IN' : r.pick(['US', 'GB', 'SG', 'AE']);
    const person = {
      index: persons.length, fullName: `${first} ${last}`, dob, nationality: country, residence: country, companies: new Set(),
      pep: r.chance(cfg.ratios.pepPotentialRate) ? 'Potential Match' : 'No Match',
      sanctions: r.chance(cfg.ratios.sanctionsPotentialRate) ? 'Potential Match' : 'No Match',
      pepStatus: r.weighted([['No', 96], ['Unknown', 3], ['Yes', 1]]),
    };
    person.identityHash = blindIndex('OWNER', `${normaliseName(person.fullName)}|${dob}`);
    persons.push(person);
    return person;
  };

  for (const company of companies) {
    const k = r.weighted(cfg.ratios.ownersPerCompany);
    const shares = splitShares(k, r);
    const chosen = [];
    for (let s = 0; s < k; s += 1) {
      let person = null;
      if (persons.length > 0 && r.chance(cfg.ratios.sharedPersonRate)) {
        // an existing person who owns fewer than the maximum number of companies and is not already an owner of this one
        for (let attempt = 0; attempt < 8 && !person; attempt += 1) {
          const cand = persons[r.int(0, persons.length - 1)];
          if (cand.companies.size < cfg.ratios.maxCompaniesPerPerson && !cand.companies.has(company.id) && !chosen.includes(cand)) person = cand;
        }
      }
      if (!person) {
        do person = newPerson(company);
        while (chosen.some((c) => c.identityHash === person.identityHash)); // no duplicate person inside one company
      }
      person.companies.add(company.id);
      chosen.push(person);
    }

    const rows = [];
    chosen.forEach((person, s) => {
      ownerId += 1;
      const createdAt = new Date(Math.min(company.onboardedAt.getTime() + r.int(2, 72 * 60) * 60_000, refEnd.getTime()));
      const row = {
        id: ownerId, customerId: company.id, fullName: person.fullName, dateOfBirth: encryptDeterministic(person.dob), countryOfResidence: person.residence, nationality: person.nationality,
        ownershipPercentage: shares[s] / 100, ownershipType: r.chance(0.8) ? 'Direct' : 'Indirect', controlType: r.weighted(CONTROL), pepStatus: person.pepStatus,
        notes: null, identityHash: person.identityHash, createdById: r.pick(people.analysts), updatedById: null, createdAt, updatedAt: createdAt,
      };
      row.updatedById = row.createdById;
      owners.push(row);

      const list = [];
      for (const [type, result] of [['PEP', person.pep], ['Sanctions', person.sanctions]]) {
        screeningId += 1;
        const screenedAt = new Date(Math.min(createdAt.getTime() + r.int(20, 180) * 60_000, refEnd.getTime()));
        const sc = {
          id: screeningId, beneficialOwnerId: ownerId, screeningType: type, screeningResult: result, riskPoints: pointsForScreening(type, result),
          remarks: result === 'Potential Match' ? 'The name is similar to an entry on the fictional demo watch-list. This is only a POTENTIAL match: it needs review and is not confirmed.' : null,
          source: 'Manual entry (synthetic)', screenedById: r.pick(people.reviewers), screenedAt, createdAt: screenedAt,
        };
        screenings.push(sc);
        list.push(sc);
      }
      // engine shape: newest screening first
      rows.push({ ...row, screenings: list.sort((a, b) => b.id - a.id) });
    });
    ownersByCompany.set(company.id, rows);

    const analysis = buildOwnerAnalysis(rows);
    const checkedAt = new Date(Math.min(Math.max(...rows.map((o) => o.createdAt.getTime())) + r.int(30, 600) * 60_000, refEnd.getTime()));
    validations.push({
      id: validations.length + 1, customerId: company.id, totalOwnershipPercentage: analysis.validation.totalPercentage, ownerCount: analysis.validation.ownerCount,
      validationStatus: analysis.validation.status, validationMessage: analysis.validation.message, checkedById: r.pick(people.analysts), checkedAt,
    });
  }

  const multi = persons.filter((p) => p.companies.size > 1);
  return { owners, screenings, validations, ownersByCompany, summary: { persons: persons.length, ownerRows: owners.length, peopleOwningSeveralCompanies: multi.length, maxCompaniesPerPerson: multi.reduce((m, p) => Math.max(m, p.companies.size), 1) } };
}

module.exports = { generateOwnership, splitShares };
