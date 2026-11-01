/**
 * Owner screening records.
 *
 * !! Nothing here connects to a real sanctions or PEP database. Outcomes are SYNTHETIC: either typed in by
 * the reviewer ("manual"), or produced by matching the owner's name against a small FICTIONAL list
 * ("simulated"). A match found that way is only ever a POTENTIAL match that needs review. !!
 *
 * Four states are kept distinct:
 *   Confirmed        a match established after investigation
 *   Potential Match  a possible match that requires investigation. It is NOT confirmed
 *   No Match         screened, nothing found
 *   Not Screened     no record exists yet (never stored as a value)
 *
 * Every screening is a NEW row. Earlier screenings are history and are never edited or deleted.
 */
const prisma = require('../utils/prisma');
const { notFound } = require('../utils/errors');
const { SIMULATED_OWNER_WATCHLISTS } = require('../config/ownershipRules');
const { pointsForScreening, normaliseName } = require('./ownershipEngine');
const { screeningDto } = require('./ownershipService');
const audit = require('./auditService');

const SIMULATED_REMARK = 'The owner name matches an entry on the fictional demo watch-list (simulated). This is only a POTENTIAL match: it needs review and is not confirmed.';

async function listScreenings(ownerId) {
  const owner = await prisma.beneficialOwner.findUnique({ where: { id: ownerId }, select: { id: true, fullName: true } });
  if (!owner) throw notFound(`Beneficial owner ${ownerId} was not found`);
  const rows = await prisma.ownerScreening.findMany({ where: { beneficialOwnerId: ownerId }, orderBy: { id: 'desc' }, include: { screenedBy: true } });
  const latest = {};
  for (const r of rows) if (!latest[r.screeningType]) latest[r.screeningType] = r.screeningResult;
  return {
    owner,
    // "Not Screened" is shown when no record of that type exists.
    status: { PEP: latest.PEP ?? 'Not Screened', Sanctions: latest.Sanctions ?? 'Not Screened' },
    items: rows.map(screeningDto),
  };
}

/** @param {{screeningType:string, mode:string, screeningResult?:string, remarks?:string}} data already validated */
async function createScreening(ownerId, data, actor) {
  const owner = await prisma.beneficialOwner.findUnique({ where: { id: ownerId }, select: { id: true, fullName: true } });
  if (!owner) throw notFound(`Beneficial owner ${ownerId} was not found`);

  let result;
  let remarks;
  let source;
  if (data.mode === 'simulated') {
    const hit = SIMULATED_OWNER_WATCHLISTS[data.screeningType].includes(normaliseName(owner.fullName));
    result = hit ? 'Potential Match' : 'No Match';
    remarks = hit ? SIMULATED_REMARK : data.remarks ?? null;
    source = 'Simulated list match';
  } else {
    result = data.screeningResult;
    remarks = data.remarks ?? null;
    source = 'Manual entry (synthetic)';
  }

  const row = await prisma.$transaction(async (tx) => {
    const previous = await tx.ownerScreening.findFirst({ where: { beneficialOwnerId: ownerId, screeningType: data.screeningType }, orderBy: { id: 'desc' } });
    const created = await tx.ownerScreening.create({
      data: {
        beneficialOwnerId: ownerId,
        screeningType: data.screeningType,
        screeningResult: result,
        riskPoints: pointsForScreening(data.screeningType, result), // calculated here, never accepted from the client
        remarks,
        source,
        screenedById: actor.id,
      },
      include: { screenedBy: true },
    });
    const ownerRow = await tx.beneficialOwner.findUnique({ where: { id: ownerId }, select: { customerId: true } });
    // A "Potential Match" is recorded as exactly that: it stays a potential match until a person records another outcome.
    await audit.record(tx, {
      actionType: 'SCREENING_RECORDED', entityType: 'OwnerScreening', entityId: created.id, entityRef: `owner #${ownerId} / ${data.screeningType}`, customerId: ownerRow.customerId,
      previousValues: previous ? { screeningResult: previous.screeningResult } : null, newValues: { screeningType: data.screeningType, screeningResult: result, source },
      reason: remarks, actor,
    });
    return created;
  });
  return screeningDto(row);
}

module.exports = { listScreenings, createScreening };
