/**
 * Cross-company view of one beneficial owner (a person).
 *
 * The same real person can own or control several companies. Each company has its own BeneficialOwner row, and the bridge table
 * CompanyOwnership (kept in step with those rows by database triggers) groups them under one `person_ref`: 'PER-' + the first 12
 * characters of the owner's identity hash (keyed hash of normalised name + date of birth), or 'OWN-<id>' when the date of birth is
 * unknown. This service only READS that bridge: nothing is copied or duplicated.
 *
 * Limit (documented): a person recorded without a date of birth cannot be recognised in other companies, because a name alone is
 * not a safe identity. Such an owner appears with their one company only.
 */
const prisma = require('../utils/prisma');
const { badRequest, notFound } = require('../utils/errors');
const { COUNTRIES } = require('../config/options');
const { assessOwnerRisk } = require('./ownershipEngine');
const { toEngineOwner, latestByType } = require('./ownershipService');

const REF = /^(PER-[0-9a-f]{12}|OWN-\d{6})$/;
const RANK = { High: 3, Medium: 2, Low: 1 };

const personRefFor = (row) => (row.identityHash ? `PER-${row.identityHash.slice(0, 12)}` : `OWN-${String(row.id).padStart(6, '0')}`);
const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

/** The person's reference for an owner record (404 when there is no such owner). */
async function personRefOfOwner(ownerId) {
  const row = await prisma.beneficialOwner.findUnique({ where: { id: ownerId }, select: { id: true, identityHash: true } });
  if (!row) throw notFound(`Beneficial owner ${ownerId} was not found`);
  return personRefFor(row);
}

/** The person and every company they are associated with. */
async function getPerson(personRef) {
  if (!REF.test(String(personRef))) throw badRequest('A person reference looks like PER-0123456789ab');
  const links = await prisma.companyOwnership.findMany({
    where: { personRef },
    orderBy: [{ companyCustomerId: 'asc' }, { effectiveFrom: 'desc' }, { id: 'desc' }],
    include: {
      company: { include: { customerType: true, riskRatings: { orderBy: [{ assessmentDate: 'desc' }, { id: 'desc' }], take: 1 } } },
      beneficialOwner: { include: { screenings: { orderBy: { id: 'desc' } } } },
    },
  });
  if (links.length === 0) throw notFound(`No beneficial owner has the reference ${personRef}`);

  const toCompany = (l) => {
    const row = l.beneficialOwner;
    const owner = toEngineOwner(row);
    const risk = assessOwnerRisk(owner, latestByType(row.screenings));
    return {
      ownerId: row.id,
      company: { id: l.company.id, customerId: l.company.customerCode, name: l.company.fullName, riskLevel: l.company.riskRatings[0]?.riskLevel ?? null },
      ownershipPercentage: l.ownershipPercentage === null ? null : Number(l.ownershipPercentage),
      ownershipType: l.ownershipType,
      controlType: l.controlType,
      pepStatus: row.pepStatus,
      ownerRiskLevel: risk.level,
      effectiveFrom: iso(l.effectiveFrom),
      effectiveTo: iso(l.effectiveTo),
    };
  };
  const all = links.map(toCompany);
  const current = all.filter((c) => c.effectiveTo === null);
  const former = all.filter((c) => c.effectiveTo !== null);

  const newest = links.map((l) => l.beneficialOwner).sort((a, b) => b.updatedAt - a.updatedAt || b.id - a.id)[0];
  const dob = toEngineOwner(newest).dateOfBirth;
  const names = [...new Set(links.map((l) => l.beneficialOwner.fullName))];
  const pep = links.some((l) => l.beneficialOwner.pepStatus === 'Yes');
  const highest = [...new Set(current.map((c) => c.ownerRiskLevel))].sort((a, b) => RANK[b] - RANK[a])[0] ?? null;

  return {
    person: {
      personRef,
      name: newest.fullName,
      namesRecorded: names,
      birthYear: dob ? Number(dob.slice(0, 4)) : null,
      nationality: newest.nationality,
      nationalityName: newest.nationality ? COUNTRIES[newest.nationality] || newest.nationality : null,
      countryOfResidence: newest.countryOfResidence,
      countryOfResidenceName: newest.countryOfResidence ? COUNTRIES[newest.countryOfResidence] || newest.countryOfResidence : null,
      declaredPep: pep,
      recognisedAcrossCompanies: personRef.startsWith('PER-'),
    },
    companies: current,
    formerCompanies: former,
    summary: { companyCount: current.length, formerCompanyCount: former.length, highestOwnerRisk: highest },
    note: personRef.startsWith('PER-')
      ? 'People are recognised across companies by their name and date of birth. The same name with a different date of birth is treated as a different person.'
      : 'No date of birth is recorded for this owner, so they cannot be matched with owners of other companies.',
  };
}

module.exports = { getPerson, personRefOfOwner, personRefFor };
