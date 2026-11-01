/**
 * Risk assessments (Task 9), calculated by the application's own rules, never assigned at random.
 *
 *  - every customer gets the initial onboarding assessment (rule set RULES_V1_PROTOTYPE) dated the day they were onboarded;
 *  - every company gets a second assessment once its owners were recorded (RULES_V2_OWNERSHIP_PROTOTYPE: adds the risk of its
 *    owners and of its ownership structure), with the previous level recorded;
 *  - the CURRENT risk level of a customer is its newest assessment, like everywhere else in the application.
 */
const { assessRisk } = require('../../server/src/services/riskService');
const { buildAssessment, toStoredReasons } = require('../../server/src/services/riskAssessmentService');
const { buildOwnerAnalysis } = require('../../server/src/services/ownershipService');
const { riskCode } = require('../utils/idGenerator');

function generateRisk(cfg, rng, customers, ownersByCompany, people) {
  const r = rng.fork('risk');
  const refEnd = new Date(`${cfg.referenceDate}T23:59:59.000Z`);
  const drafts = [];
  const currentByCustomer = new Map();

  for (const c of customers) {
    const profile = {
      customerType: c.type, fullName: c.fullName, country: c.country, occupation: c.occupation, businessActivity: c.businessActivity,
      dateOfBirth: c.dateOfBirth, dateOfIncorporation: c.dateOfIncorporation,
    };
    const initial = assessRisk(profile, c.onboardedAt);
    const first = {
      customerId: c.id, riskScore: initial.score, riskLevel: initial.level,
      riskReasons: { reasons: initial.reasons, screening: initial.screening, requiresManualReview: initial.requiresManualReview, thresholds: initial.thresholds },
      assessmentDate: c.onboardedAt, assessmentMethod: initial.method, createdAt: c.onboardedAt, assessedById: null, assessmentStatus: 'Completed', previousRiskLevel: null,
    };
    drafts.push(first);
    let current = first;

    if (c.isCompany) {
      const rows = ownersByCompany.get(c.id) || [];
      const analysis = buildOwnerAnalysis(rows);
      const when = new Date(Math.min(Math.max(...rows.map((o) => o.createdAt.getTime()), c.onboardedAt.getTime()) + r.int(60, 600) * 60_000, refEnd.getTime()));
      const a = buildAssessment({ customerType: { typeName: c.type }, fullName: c.fullName, country: c.country, occupation: c.occupation, businessActivity: c.businessActivity, dateOfBirth: c.dateOfBirth, dateOfIncorporation: c.dateOfIncorporation }, analysis, when);
      const second = {
        customerId: c.id, riskScore: a.score, riskLevel: a.level, riskReasons: toStoredReasons(a, 'Assessment after owners were recorded (synthetic data)'),
        assessmentDate: when, assessmentMethod: a.method, createdAt: when, assessedById: r.pick(people.reviewers), assessmentStatus: a.status, previousRiskLevel: first.riskLevel,
      };
      drafts.push(second);
      current = second;
    }
    currentByCustomer.set(c.id, current);
  }

  // numbered in the order the assessments were made
  drafts.sort((a, b) => a.assessmentDate - b.assessmentDate || a.customerId - b.customerId || (a.previousRiskLevel === null ? -1 : 1));
  const ratings = drafts.map((d, i) => ({ id: i + 1, assessmentCode: riskCode(i + 1), ...d }));
  const byDraft = new Map(drafts.map((d, i) => [d, ratings[i]]));
  for (const [id, d] of currentByCustomer) currentByCustomer.set(id, byDraft.get(d));
  return { ratings, currentByCustomer };
}

module.exports = { generateRisk };
