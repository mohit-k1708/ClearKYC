/**
 * Reference data (generated first): the two customer types, the people who work in the review workflow, and the KYC
 * requirements. The requirements are the application's own sample rules (config/kycRules.js), numbered KYC-2026-000001...
 */
const { DEFAULT_REQUIREMENTS, DEFAULT_REVIEWERS, EFFECTIVE_FROM_DEFAULT } = require('../../server/src/config/kycRules');
const { SCENE4_DEMO_USERS } = require('../../server/src/config/reviewRules');
const { parseIso, addDays } = require('../../server/src/utils/dates');
const { requirementCode } = require('../utils/idGenerator');

const TYPE_IDS = { Individual: 1, Company: 2 };

function generateReference(cfg, counters) {
  const created = new Date(`${addDays(cfg.referenceDate, -1200)}T09:00:00.000Z`);
  const reviewers = [...DEFAULT_REVIEWERS, ...SCENE4_DEMO_USERS].map((p, i) => ({ id: i + 1, name: p.name, email: p.email, role: p.role, isActive: true, createdAt: created }));
  const people = {
    all: reviewers,
    roleOf: new Map(reviewers.map((p) => [p.id, p.role])),
    reviewers: reviewers.filter((p) => p.role === 'Reviewer').map((p) => p.id), // may record decisions
    admins: reviewers.filter((p) => p.role === 'Admin').map((p) => p.id),
    analysts: reviewers.filter((p) => p.role === 'Analyst').map((p) => p.id),
  };
  people.deciders = [...people.reviewers, ...people.admins];

  const effectiveFrom = EFFECTIVE_FROM_DEFAULT;
  const year = Number(effectiveFrom.slice(0, 4));
  const createdAt = new Date(`${effectiveFrom}T00:00:00.000Z`);
  const requirements = [];
  for (const rule of DEFAULT_REQUIREMENTS) {
    for (const documentType of rule.documents) {
      const id = requirements.length + 1;
      requirements.push({
        id, customerTypeId: TYPE_IDS[rule.customerType], customerType: rule.customerType, riskLevel: rule.riskLevel, documentType, isMandatory: true,
        effectiveFrom: parseIso(effectiveFrom), effectiveTo: null, isActive: true, createdAt, updatedAt: createdAt,
        businessId: requirementCode(year, counters.next('KYC', year)),
      });
    }
  }
  const customerTypes = [{ id: 1, typeName: 'Individual' }, { id: 2, typeName: 'Company' }];
  return { customerTypes, people, requirements };
}

module.exports = { generateReference, TYPE_IDS };
