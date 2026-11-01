/**
 * Audit events (Task 13): one event for every generated action, written from the generated records themselves, never invented.
 * Each event references a record that exists (entity type + database id + business reference + customer), carries the actor
 * (a reviewer, or the System for automatic detection) and the timestamp of the action it describes.
 *
 * Sensitive values (PAN, Aadhaar, document numbers, dates of birth) are never put into an event.
 */
const { auditCode } = require('../utils/idGenerator');

// Case history entries -> audit action types (the same mapping the application's audit service uses).
const CASE_ACTION_MAP = {
  CREATED: 'CASE_CREATED', ASSIGNED_ANALYST: 'CASE_ASSIGNED', UNASSIGNED_ANALYST: 'CASE_ASSIGNED', ASSIGNED_REVIEWER: 'CASE_ASSIGNED', UNASSIGNED_REVIEWER: 'CASE_ASSIGNED',
  PRIORITY_CHANGED: 'CASE_PRIORITY_CHANGED', ESCALATED: 'CASE_ESCALATED', RESOLVED: 'CASE_RESOLVED', RESOLUTION_APPROVED: 'CASE_RESOLVED', REVIEW_COMPLETED: 'CASE_RESOLVED',
  CLOSED: 'CASE_CLOSED', REOPENED: 'CASE_REOPENED',
};
const DOCUMENT_STATUS_ACTION = { 'In Review': 'VERIFICATION_STARTED', Verified: 'DOCUMENT_VERIFIED', Rejected: 'DOCUMENT_REJECTED', 'Requires Resubmission': 'DOCUMENT_RESUBMISSION_REQUESTED' };

function generateAudit(cfg, rng, data) {
  const r = rng.fork('audit');
  const { customers, reference, ownership, risk, documents, review, alerts, cases } = data;
  const roleOf = reference.people.roleOf;
  const refEnd = Date.parse(`${cfg.referenceDate}T23:59:59.000Z`);
  const events = [];
  let order = 0;

  const add = (actionType, entityType, entityId, entityRef, customerId, createdAt, userId, extra = {}) => {
    const event = {
      userId: userId ?? null, userRole: userId ? roleOf.get(userId) : 'System', actionType, entityType, entityId: entityId ?? null, entityRef: entityRef ?? null,
      customerId: customerId ?? null, createdAt, order: (order += 1),
    };
    if (extra.previousValues) event.previousValues = extra.previousValues;
    if (extra.newValues) event.newValues = extra.newValues;
    if (extra.reason) event.reason = String(extra.reason).slice(0, 500);
    events.push(event);
  };
  const analyst = () => r.pick(reference.people.analysts);

  for (const q of reference.requirements) {
    add('REQUIREMENT_CREATED', 'KYCRequirement', q.id, q.businessId, null, q.createdAt, r.pick(reference.people.admins), { newValues: { customerType: q.customerType, riskLevel: q.riskLevel, documentType: q.documentType, isMandatory: q.isMandatory } });
  }
  for (const c of customers) {
    add('CUSTOMER_CREATED', 'Customer', c.id, c.code, c.id, c.onboardedAt, analyst(), { newValues: { customerType: c.type, country: c.country, registrationStatus: 'Registered' } });
  }
  for (const d of data.approvals.decisions) {
    add('ONBOARDING_DECISION_RECORDED', 'OnboardingDecision', d.id, null, d.customerId, d.decidedAt, d.decidedById, { newValues: { decision: d.decision }, reason: d.notes });
  }
  const ownerCustomer = new Map(ownership.owners.map((o) => [o.id, o.customerId]));

  for (const rt of risk.ratings) {
    add('RISK_ASSESSMENT_CREATED', 'RiskRating', rt.id, rt.assessmentCode, rt.customerId, rt.createdAt, rt.assessedById, {
      newValues: { riskLevel: rt.riskLevel, riskScore: rt.riskScore, assessmentStatus: rt.assessmentStatus, method: rt.assessmentMethod },
    });
    if (rt.previousRiskLevel && rt.previousRiskLevel !== rt.riskLevel) {
      add('RISK_CLASSIFICATION_CHANGED', 'RiskRating', rt.id, rt.assessmentCode, rt.customerId, new Date(Math.min(rt.createdAt.getTime() + 1000, refEnd)), rt.assessedById, { previousValues: { riskLevel: rt.previousRiskLevel }, newValues: { riskLevel: rt.riskLevel } });
    }
  }

  for (const o of ownership.owners) {
    add('OWNER_ADDED', 'BeneficialOwner', o.id, null, o.customerId, o.createdAt, o.createdById, { newValues: { ownershipPercentage: o.ownershipPercentage, ownershipType: o.ownershipType, controlType: o.controlType } });
  }
  for (const s of ownership.screenings) {
    add('SCREENING_RECORDED', 'OwnerScreening', s.id, null, ownerCustomer.get(s.beneficialOwnerId), s.screenedAt, s.screenedById, { newValues: { screeningType: s.screeningType, screeningResult: s.screeningResult, source: s.source } });
  }
  for (const v of ownership.validations) {
    add('OWNERSHIP_VALIDATED', 'OwnershipValidation', v.id, null, v.customerId, v.checkedAt, v.checkedById, { newValues: { status: v.validationStatus, totalOwnershipPercentage: Number(v.totalOwnershipPercentage), ownerCount: v.ownerCount } });
  }

  for (const d of documents.documents) {
    add('DOCUMENT_SUBMITTED', 'Document', d.id, d.businessId, d.customerId, d.createdAt, analyst(), { newValues: { documentType: d.documentType, status: 'Pending', submissionDate: d.submissionIso } });
    let previous = 'Pending';
    for (const step of d.steps.slice(1)) {
      add(DOCUMENT_STATUS_ACTION[step.status], 'Document', d.id, d.businessId, d.customerId, step.when, step.reviewerId, { previousValues: { status: previous }, newValues: { status: step.status }, reason: step.remarks });
      previous = step.status;
    }
  }

  for (const s of review.schedules) {
    add('REVIEW_SCHEDULE_CREATED', 'ReviewSchedule', s.id, `cycle ${s.cycleNumber}`, s.customerId, s.createdAt, null, { newValues: { cycleNumber: s.cycleNumber, riskLevel: s.riskLevel, nextReviewDate: s.nextIso, intervalMonths: s.reviewIntervalMonths } });
    if (s.status === 'Completed') {
      add('PERIODIC_REVIEW_COMPLETED', 'ReviewSchedule', s.id, `cycle ${s.cycleNumber}`, s.customerId, s.completedAt, s.completedById, { previousValues: { cycleNumber: s.cycleNumber, lastReviewDate: s.lastIso }, newValues: { reviewDate: s.completionIso }, reason: s.completionNotes });
    }
  }
  for (const e of review.exceptions) {
    add('EXCEPTION_DETECTED', 'Exception', e.id, e.exceptionCode, e.customerId, e.detectedAt, null, {
      newValues: { exceptionType: e.exceptionType, severity: e.severity, sourceEntityType: e.sourceEntityType, sourceEntityId: e.sourceEntityId, status: 'Open' }, reason: e.description,
    });
    if (e.status === 'Resolved') {
      add('EXCEPTION_RESOLVED', 'Exception', e.id, e.exceptionCode, e.customerId, e.resolvedAt, null, { previousValues: { status: 'Open' }, newValues: { status: 'Resolved', resolutionType: e.resolutionType }, reason: e.resolutionNotes });
    }
  }
  for (const a of alerts) {
    add('ALERT_GENERATED', 'Alert', a.id, a.alertCode, a.customerId, a.createdAt, null, { newValues: { alertType: a.alertType, severity: a.severity, status: 'New', relatedEntityType: a.relatedEntityType, relatedEntityId: a.relatedEntityId }, reason: a.description });
    if (a.acknowledgedAt) add('ALERT_ACKNOWLEDGED', 'Alert', a.id, a.alertCode, a.customerId, a.acknowledgedAt, a.acknowledgedById, { previousValues: { status: 'New' }, newValues: { status: 'Acknowledged' } });
    if (a.status === 'In Progress') add('ALERT_STATUS_CHANGED', 'Alert', a.id, a.alertCode, a.customerId, a.updatedAt, a.acknowledgedById, { previousValues: { status: 'Acknowledged' }, newValues: { status: 'In Progress' } });
    if (a.status === 'Resolved') add('ALERT_RESOLVED', 'Alert', a.id, a.alertCode, a.customerId, a.resolvedAt, a.resolvedById, { previousValues: { status: 'New' }, newValues: { status: 'Resolved', resolutionType: a.resolutionType }, reason: a.resolutionNotes });
  }
  for (const cs of cases) {
    for (const h of cs.steps) {
      if (h.action === 'EXCEPTION_RESOLVED') continue; // the exception has its own event
      add(CASE_ACTION_MAP[h.action] ?? 'CASE_STATUS_CHANGED', 'ReviewCase', cs.id, cs.caseCode, cs.customerId, h.changedAt, h.changedById, {
        previousValues: h.previousStatus ? { status: h.previousStatus } : null,
        newValues: { status: h.newStatus, workflowAction: h.action, caseType: cs.caseType, priority: cs.priority, assignedAnalystId: cs.assignedAnalystId, assignedReviewerId: cs.assignedReviewerId }, reason: h.remarks,
      });
    }
    for (const n of cs.pendingNotes || []) add('CASE_NOTE_ADDED', 'ReviewCase', cs.id, cs.caseCode, cs.customerId, n.createdAt, n.authorId, { newValues: { noteLength: n.note.length } });
  }
  events.sort((a, b) => a.createdAt - b.createdAt || a.order - b.order);
  const rows = events.map((e, i) => {
    const { order: _order, ...rest } = e;
    return { id: i + 1, eventCode: auditCode(i + 1), ...rest };
  });
  const byAction = {};
  for (const e of rows) byAction[e.actionType] = (byAction[e.actionType] || 0) + 1;
  return { events: rows, stats: { events: rows.length, byAction } };
}

module.exports = { generateAudit, CASE_ACTION_MAP };
