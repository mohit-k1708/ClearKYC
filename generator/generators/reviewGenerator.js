/**
 * Periodic review schedules, exceptions and review cases (Tasks 10-11).
 *
 * Nothing is invented. At the reference date the application's own engines look at the generated customers, documents,
 * owners and risk ratings and report the CONDITIONS that exist (missing, expired, rejected documents, ownership issues,
 * high risk, potential screening matches, overdue reviews). Those conditions become the active exceptions. In addition,
 * conditions that existed in the past and were cleared (an unusable document that was later replaced, a review that was
 * completed late) become resolved exceptions, with the dates the records themselves imply.
 *
 * Review cases are opened for exactly `counts.reviewCases` of these real conditions:
 *   - every overdue periodic review gets its case (the application would create it on its next detection run anyway);
 *   - about a fifth of the cases are historical (Resolved / Closed), for conditions that really cleared;
 *   - the rest are active cases, preferring the more serious conditions.
 * A case never contradicts its exception: an active case belongs to an active exception (status "In Review"), a Resolved or
 * Closed case belongs to a resolved one.
 */
const { addDays, addMonths, daysBetween, parseIso } = require('../../server/src/utils/dates');
const { PERIODIC_REVIEW, EXCEPTION_TYPES, SLA_DAYS, ACTIVE_EXCEPTION_STATUSES } = require('../../server/src/config/reviewRules');
const { evaluateCustomerKyc } = require('../../server/src/services/kycEngine');
const { detectConditions, documentConditions, keyOf } = require('../../server/src/services/exceptionEngine');
const { requiresApproval } = require('../../server/src/services/caseWorkflow');
const { buildOwnerAnalysis } = require('../../server/src/services/ownershipService');
const { reviewCode } = require('../utils/idGenerator');
const { caseCode, exceptionCode } = require('../utils/idGenerator');

const HOUR = 3_600_000;
const MIN = 60_000;
const DAY = 86_400_000;
const SEVERITY_RANK = { Low: 1, Medium: 2, High: 3, Critical: 4 };
const NOT_CASE_WORTHY = new Set(['DOCUMENT_AWAITING_VERIFICATION', 'DOCUMENT_EXPIRING_SOON', 'PERIODIC_REVIEW_DUE_SOON']);
const ANALYST_NOTES = [
  'Reviewed the customer file and the documents on record.',
  'Contacted the customer by e-mail (synthetic) and asked for the missing information.',
  'Checked the latest documents against the requirement list.',
  'Discussed the case with the compliance reviewer; waiting for the next update.',
  'Customer confirmed the details; supporting documents will follow.',
];
const RESOLUTION_NOTES = {
  document: 'A valid replacement document was received and checked; the exception cleared.',
  periodic: 'The periodic KYC review was completed and the customer file was brought up to date.',
  other: 'The issue was reviewed and resolved; the records now show no remaining concern.',
};

function generateReview(cfg, rng, input) {
  const { customers, currentRisk, ownersByCompany, ownership, documents, requirements, validations, people, counters } = input;
  const r = rng.fork('review');
  const ref = cfg.referenceDate;
  const refEnd = Date.parse(`${ref}T23:59:59.000Z`);
  const N = cfg.counts.reviewCases;
  const cap = (ms) => new Date(Math.min(ms, refEnd));
  const dayStart = (iso) => Date.parse(`${iso}T00:00:00.000Z`);
  const detectionTime = (iso, c) => cap(Math.max(dayStart(iso) + 2 * HOUR + r.int(0, 180) * MIN, c.onboardedAt.getTime() + MIN));

  // ---- engine inputs -----------------------------------------------------------------------------------------------
  const engineReqs = requirements.map((q) => ({ id: q.id, customerType: q.customerType, riskLevel: q.riskLevel, documentType: q.documentType, isMandatory: q.isMandatory, isActive: q.isActive, effectiveFrom: q.effectiveFrom, effectiveTo: q.effectiveTo }));
  const docsByCustomer = new Map();
  const docById = new Map();
  for (const d of documents) {
    docById.set(d.id, d);
    if (!docsByCustomer.has(d.customerId)) docsByCustomer.set(d.customerId, []);
    docsByCustomer.get(d.customerId).push(d);
  }
  const validationByCustomer = new Map(validations.map((v) => [v.customerId, v]));
  const screeningTime = new Map();
  for (const s of ownership.screenings) screeningTime.set(s.beneficialOwnerId, Math.max(screeningTime.get(s.beneficialOwnerId) ?? 0, s.screenedAt.getTime()));
  const requirementIdOf = new Map(requirements.map((q) => [`${q.customerType}|${q.riskLevel}|${q.documentType}`, q.id]));

  // ---- periodic review schedules ---------------------------------------------------------------------------------
  const schedules = [];
  const currentSchedule = new Map();
  const lateCycles = []; // completed cycles that were finished after their due date
  for (const c of customers) {
    const rating = currentRisk.get(c.id);
    const level = rating.riskLevel;
    const months = PERIODIC_REVIEW.intervalMonths[level];
    let last = c.onboardedDay;
    let cycle = 1;
    let created = rating.createdAt;
    for (;;) {
      const next = addMonths(last, months);
      const row = {
        id: schedules.length + 1, customerId: c.id, cycleNumber: cycle, riskLevel: level, lastReviewDate: parseIso(last), nextReviewDate: parseIso(next), reviewIntervalMonths: months,
        status: 'Scheduled', completedAt: null, completedById: null, completionNotes: null, createdAt: created, updatedAt: created, lastIso: last, nextIso: next, completionIso: null, lateDays: 0,
      };
      schedules.push(row);
      if (next > ref || !r.chance(cfg.ratios.completedReviewRate)) { currentSchedule.set(c.id, row); break; }
      const late = r.chance(0.4);
      const completionIso = late ? addDays(next, r.int(1, 45)) : addDays(next, -r.int(0, 20));
      if (completionIso > ref) { currentSchedule.set(c.id, row); break; } // not finished yet: it is overdue today
      const completedAt = cap(dayStart(completionIso) + 9 * HOUR + r.int(0, 480) * MIN);
      Object.assign(row, {
        status: 'Completed', completedAt, completedById: r.pick(people.deciders), completionNotes: 'Periodic review completed: documents and risk rating were re-checked (synthetic).',
        updatedAt: completedAt, completionIso, lateDays: late ? daysBetween(next, completionIso) : 0,
      });
      if (late) lateCycles.push({ row, c });
      last = completionIso;
      created = completedAt;
      cycle += 1;
    }
  }

  // ---- active conditions -> exceptions ---------------------------------------------------------------------------------
  const contexts = new Map();
  const exceptions = [];
  const activeByKey = new Map();
  const detectedAtByKey = new Map();

  const detectedFor = (cond, c, rating, schedule) => {
    const doc = cond.sourceType === 'Document' ? docById.get(cond.sourceId) : null;
    const step = (status) => doc?.steps.filter((s) => s.status === status).pop();
    switch (cond.type) {
      case 'MANDATORY_DOCUMENT_MISSING': return detectionTime(addDays(c.onboardedDay, r.int(1, 14)), c);
      case 'DOCUMENT_EXPIRED': return detectionTime(addDays(doc.expiryIso, 1), c);
      case 'DOCUMENT_EXPIRING_SOON': return cap(Math.max(dayStart(addDays(doc.expiryIso, -30)) + 2 * HOUR, doc.steps[doc.steps.length - 1].when.getTime() + HOUR));
      case 'DOCUMENT_REJECTED': return cap(step('Rejected').when.getTime() + HOUR);
      case 'DOCUMENT_REQUIRES_RESUBMISSION': return cap(step('Requires Resubmission').when.getTime() + HOUR);
      case 'DOCUMENT_AWAITING_VERIFICATION': return detectionTime(addDays(doc.submissionIso, 1), c);
      case 'PERIODIC_REVIEW_OVERDUE': return detectionTime(addDays(schedule.nextIso, 1), c);
      case 'PERIODIC_REVIEW_DUE_SOON': return cap(Math.max(dayStart(addDays(schedule.nextIso, -PERIODIC_REVIEW.upcomingDays)) + 2 * HOUR, schedule.createdAt.getTime() + HOUR));
      default:
        if (cond.sourceType === 'BeneficialOwner') return cap((screeningTime.get(cond.sourceId) ?? c.onboardedAt.getTime()) + 10 * MIN);
        if (cond.type.startsWith('OWNERSHIP')) return cap((validationByCustomer.get(c.id)?.checkedAt.getTime() ?? c.onboardedAt.getTime()) + 5 * MIN);
        return cap(rating.createdAt.getTime() + 5 * MIN);
    }
  };

  const conditionsByCustomer = new Map();
  for (const c of customers) {
    const rating = currentRisk.get(c.id);
    const schedule = currentSchedule.get(c.id);
    const customer = { id: c.id, code: c.code, name: c.fullName, customerType: c.type, riskLevel: rating.riskLevel };
    const kyc = evaluateCustomerKyc({ customerType: c.type, riskLevel: rating.riskLevel, requirements: engineReqs, documents: docsByCustomer.get(c.id) || [], asOf: ref });
    const ownershipAnalysis = c.isCompany ? buildOwnerAnalysis(ownersByCompany.get(c.id) || []) : null;
    const ctx = {
      customer, kyc, ownership: ownershipAnalysis,
      rating: { id: rating.id, code: rating.assessmentCode, riskLevel: rating.riskLevel, riskScore: rating.riskScore, status: rating.assessmentStatus, screening: rating.riskReasons.screening },
      schedule: { id: schedule.id, nextReviewDate: schedule.nextReviewDate, cycleNumber: schedule.cycleNumber, riskLevel: schedule.riskLevel, reviewIntervalMonths: schedule.reviewIntervalMonths },
    };
    const conditions = detectConditions({ ...ctx, unresolvedClosedCases: [], asOf: ref });
    contexts.set(c.id, ctx);
    conditionsByCustomer.set(c.id, conditions);
    for (const cond of conditions) {
      const at = detectedFor(cond, c, rating, schedule);
      detectedAtByKey.set(cond.key, at);
      if (cond.alertOnly || activeByKey.has(cond.key)) continue;
      const e = {
        customerId: c.id, exceptionType: cond.type, description: cond.description, severity: cond.severity, sourceEntityType: cond.sourceType, sourceEntityId: cond.sourceId,
        dedupeKey: cond.key, status: 'Open', detectedAt: at, resolvedAt: null, resolvedById: null, resolutionType: null, resolutionNotes: null, createdAt: at, updatedAt: at,
        cases: [], historical: false,
      };
      activeByKey.set(cond.key, e);
      exceptions.push(e);
    }
  }

  // ---- historical (cleared) conditions ----------------------------------------------------------------------------------
  // an unusable earlier copy of a document that was replaced by a newer one
  const customerById = new Map(customers.map((c) => [c.id, c]));
  const replacementPairs = [];
  const bySlot = new Map();
  for (const d of documents) {
    const key = `${d.customerId}|${d.documentType}`;
    if (!bySlot.has(key)) bySlot.set(key, []);
    bySlot.get(key).push(d);
  }
  for (const list of bySlot.values()) {
    if (list.length < 2) continue;
    const newest = list[list.length - 1];
    for (const old of list.slice(0, -1)) replacementPairs.push({ old, newest });
  }
  const TYPE_FOR_OUTCOME = { rejected: 'REJECTED', resubmit: 'REQUIRES_RESUBMISSION', expired: 'EXPIRED' };
  const historicalDocExceptions = [];
  for (const { old, newest } of replacementPairs) {
    const engineType = TYPE_FOR_OUTCOME[old.outcome];
    if (!engineType) continue;
    const c = customerById.get(old.customerId);
    const rating = currentRisk.get(c.id);
    const decision = old.steps[old.steps.length - 1];
    const detectedMs = old.outcome === 'expired' ? detectionTime(addDays(old.expiryIso, 1), c).getTime() : Math.min(decision.when.getTime() + HOUR, refEnd);
    const detectedIso = new Date(detectedMs).toISOString().slice(0, 10);
    const kycLike = {
      asOf: detectedIso, requirements: [{ documentType: old.documentType, requirementId: requirementIdOf.get(`${c.type}|${rating.riskLevel}|${old.documentType}`) }], extraDocuments: [],
      exceptions: [{ type: engineType, documentType: old.documentType, isMandatory: true, document: { id: old.id, status: old.status, expiryDate: old.expiryIso, daysToExpiry: old.expiryIso ? daysBetween(detectedIso, old.expiryIso) : null, submissionDate: old.submissionIso } }],
    };
    const [cond] = documentConditions({ id: c.id, riskLevel: rating.riskLevel }, kycLike);
    if (!cond) continue;
    const resolvedMs = Math.min(Math.max(detectedMs + HOUR, dayStart(addDays(newest.submissionIso, 1)) + 3 * HOUR + r.int(0, 120) * MIN), refEnd);
    historicalDocExceptions.push({ cond, c, detectedMs, resolvedMs });
  }
  const historical = [];
  for (const h of historicalDocExceptions) {
    historical.push({
      customerId: h.c.id, exceptionType: h.cond.type, description: h.cond.description, severity: h.cond.severity, sourceEntityType: h.cond.sourceType, sourceEntityId: h.cond.sourceId, dedupeKey: h.cond.key,
      status: 'Resolved', detectedAt: new Date(h.detectedMs), resolvedAt: new Date(h.resolvedMs), resolvedById: null, resolutionType: 'Condition cleared',
      resolutionNotes: `The underlying records no longer show this condition (checked ${new Date(h.resolvedMs).toISOString().slice(0, 10)}).`, createdAt: new Date(h.detectedMs), updatedAt: new Date(h.resolvedMs),
      cases: [], historical: true, kind: 'document',
    });
  }
  // a periodic review completed after its due date was overdue for a while
  for (const { row, c } of lateCycles) {
    const overdue = row.lateDays;
    const severity = overdue > 90 ? 'Critical' : overdue > 30 ? 'High' : 'Medium';
    const detectedAt = detectionTime(addDays(row.nextIso, 1), c);
    const resolvedAt = new Date(Math.max(row.completedAt.getTime(), detectedAt.getTime() + HOUR));
    historical.push({
      customerId: c.id, exceptionType: 'PERIODIC_REVIEW_OVERDUE', description: `The periodic KYC review was due on ${row.nextIso} and is ${overdue} day${overdue === 1 ? '' : 's'} overdue.`, severity,
      sourceEntityType: 'ReviewSchedule', sourceEntityId: row.id, dedupeKey: keyOf(c.id, 'PERIODIC_REVIEW_OVERDUE', 'ReviewSchedule', row.id), status: 'Resolved', detectedAt, resolvedAt, resolvedById: null,
      resolutionType: 'Condition cleared', resolutionNotes: `The underlying records no longer show this condition (checked ${row.completionIso}).`, createdAt: detectedAt, updatedAt: resolvedAt, cases: [], historical: true,
      kind: 'periodic', schedule: row,
    });
  }
  exceptions.push(...historical);

  // ---- numbering: by detection time -------------------------------------------------------------------------------------
  exceptions.sort((a, b) => a.detectedAt - b.detectedAt || a.customerId - b.customerId || a.exceptionType.localeCompare(b.exceptionType) || a.dedupeKey.localeCompare(b.dedupeKey));
  exceptions.forEach((e, i) => { e.id = i + 1; e.exceptionCode = exceptionCode(i + 1); });

  // ---- choosing the cases --------------------------------------------------------------------------------------------------
  const dueSchedules = [...currentSchedule.values()].filter((s) => s.nextIso <= ref);
  const mandatory = dueSchedules.map((s) => ({
    schedule: s,
    exception: exceptions.find((e) => !e.historical && ['PERIODIC_REVIEW_OVERDUE', 'PERIODIC_REVIEW_DUE_SOON'].includes(e.exceptionType) && e.sourceEntityId === s.id) ?? null,
  }));
  if (mandatory.length > N) throw new Error(`${mandatory.length} periodic reviews are overdue but only ${N} review cases are configured.`);

  const activeCandidates = exceptions.filter((e) => !e.historical && !NOT_CASE_WORTHY.has(e.exceptionType) && e.exceptionType !== 'PERIODIC_REVIEW_OVERDUE');
  const historicalCandidates = historical;
  const need = N - mandatory.length;
  let historicalCount = Math.min(Math.round(N * cfg.ratios.historicalCaseShare), historicalCandidates.length, need);
  let activeCount = need - historicalCount;
  if (activeCount > activeCandidates.length) {
    historicalCount = Math.min(historicalCandidates.length, historicalCount + (activeCount - activeCandidates.length));
    activeCount = need - historicalCount;
  }
  if (activeCount > activeCandidates.length) throw new Error(`Only ${activeCandidates.length + historicalCandidates.length + mandatory.length} real conditions are available for ${N} review cases.`);

  const ranked = activeCandidates.map((e) => ({ e, score: SEVERITY_RANK[e.severity] + r.next() * 2.2 })).sort((a, b) => b.score - a.score || a.e.id - b.e.id);
  const chosenActive = ranked.slice(0, activeCount).map((x) => x.e);
  const chosenHistorical = r.shuffle(historicalCandidates).slice(0, historicalCount);

  const specs = [
    ...mandatory.map((m) => ({ kind: 'periodic-active', e: m.exception, schedule: m.schedule })),
    ...chosenActive.map((e) => ({ kind: 'active', e })),
    ...chosenHistorical.map((e) => ({ kind: 'historical', e })),
  ];

  // ---- building the cases with their history ---------------------------------------------------------------------------
  const cases = [];
  const history = [];
  const notes = [];
  const pickAnalyst = () => r.pick(people.analysts);
  const pickReviewer = () => r.pick(people.deciders);

  for (const spec of specs) {
    const exc = spec.e;
    const schedule = spec.schedule ?? exc.schedule ?? null;
    const c = customerById.get(exc ? exc.customerId : schedule.customerId);
    const rating = currentRisk.get(c.id);
    const isPeriodic = Boolean(schedule);
    const caseType = isPeriodic ? 'Periodic KYC Review' : EXCEPTION_TYPES[exc.exceptionType].caseType;
    const priority = exc ? exc.severity : rating.riskLevel === 'High' ? 'High' : 'Medium';
    const approval = requiresApproval({ caseType, priority, customerRiskLevel: rating.riskLevel });
    const label = exc ? EXCEPTION_TYPES[exc.exceptionType].label : 'Periodic review';

    let createdMs;
    if (spec.kind === 'periodic-active') createdMs = Math.min(Math.max(dayStart(addDays(schedule.nextIso, 1)) + 5 * MIN, (exc ? exc.detectedAt.getTime() : 0) + 5 * MIN), refEnd);
    else if (isPeriodic) createdMs = exc.detectedAt.getTime() + 5 * MIN;
    else createdMs = exc.detectedAt.getTime() + r.int(1, 48) * HOUR;
    // A team works a backlog: an old exception is usually picked up recently, so most active cases are still inside their SLA
    // (about a third are past it, which the data-quality check reports as a warning, as it should).
    if (spec.kind === 'active') createdMs = Math.max(createdMs, refEnd - Math.floor(r.next() * SLA_DAYS[priority] * 1.5 * DAY));
    if (spec.kind === 'historical') createdMs = Math.min(createdMs, exc.resolvedAt.getTime() - 30 * MIN);
    createdMs = Math.min(Math.max(createdMs, c.onboardedAt.getTime() + MIN), refEnd);
    const createdAt = new Date(createdMs);
    const creator = isPeriodic ? null : r.chance(0.5) ? pickAnalyst() : pickReviewer();

    // target status
    let status;
    if (spec.kind === 'historical') status = r.chance(0.7) ? 'Closed' : 'Resolved';
    else {
      const avail = refEnd - createdMs;
      const options = avail < 2 * HOUR ? [['Open', 1]] : avail < DAY ? [['Open', 2], ['Assigned', 2]] : avail < 3 * DAY ? [['Open', 2], ['Assigned', 3], ['In Progress', 3]]
        : [['Open', 2], ['Assigned', 3], ['In Progress', 4], ['Pending Customer', 1.5], ['Escalated', 2]];
      status = r.weighted(options);
    }

    const analyst = status === 'Open' ? null : pickAnalyst();
    const needsReviewer = status === 'Escalated' || ((status === 'Resolved' || status === 'Closed') && approval);
    const reviewer = needsReviewer ? pickReviewer() : null;

    // timeline
    const steps = [];
    let t = createdMs;
    const push = (action, prev, next, by, remarks, lagMin = 0) => {
      t = Math.min(t + lagMin * MIN, refEnd);
      steps.push({ action, previousStatus: prev, newStatus: next, changedById: by, remarks, changedAt: new Date(t) });
    };
    const lag = (minH, maxH) => r.int(minH * 60, maxH * 60);
    push('CREATED', null, 'Open', creator, isPeriodic && !creator ? 'Created by the system: the periodic review became due.' : exc ? `Created from exception ${exc.exceptionCode}` : 'Created manually');
    let current = 'Open';
    if (analyst) {
      push('ASSIGNED_ANALYST', 'Open', 'Assigned', creator ?? pickReviewer(), 'Assigned to the analyst for investigation', lag(1, 24));
      current = 'Assigned';
    }
    const reach = (target) => ['Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated', 'Resolved', 'Closed'].indexOf(target);
    if (analyst && reach(status) >= reach('In Progress')) {
      push('STARTED', 'Assigned', 'In Progress', analyst, 'Investigation started', lag(1, 36));
      current = 'In Progress';
    }
    let proposalPending = false;
    let proposedById = null;
    let resolutionNotes = null;
    let resolvedAt = null;
    let closedAt = null;
    const finalNotes = isPeriodic ? RESOLUTION_NOTES.periodic : RESOLUTION_NOTES[exc?.kind === 'document' ? 'document' : 'other'];

    if (status === 'Pending Customer') {
      push('CUSTOMER_INFO_REQUESTED', 'In Progress', 'Pending Customer', analyst, 'Asked the customer for more information (synthetic).', lag(1, 30));
      current = 'Pending Customer';
    } else if (status === 'Escalated') {
      push('ASSIGNED_REVIEWER', 'In Progress', 'In Progress', pickReviewer(), `Compliance reviewer assigned`, lag(1, 24));
      if (approval) {
        proposedById = analyst;
        proposalPending = true;
        resolutionNotes = 'Proposed resolution: the issue has been investigated and the file is ready for approval.';
        push('SUBMITTED_FOR_REVIEW', 'In Progress', 'Escalated', analyst, resolutionNotes, lag(1, 30));
      } else {
        push('ESCALATED', 'In Progress', 'Escalated', analyst, 'Escalated to a compliance reviewer for a second opinion.', lag(1, 30));
      }
      current = 'Escalated';
    } else if (status === 'Resolved' || status === 'Closed') {
      let excClearedLogged = false;
      const logExceptionCleared = () => {
        if (excClearedLogged || !exc?.resolvedAt) return;
        excClearedLogged = true;
        t = Math.max(t, exc.resolvedAt.getTime());
        steps.push({ action: 'EXCEPTION_RESOLVED', previousStatus: current, newStatus: current, changedById: null, remarks: `Linked exception ${exc.exceptionCode} was resolved automatically: its condition no longer exists.`, changedAt: new Date(Math.min(t, refEnd)) });
      };
      if (approval) {
        proposedById = analyst;
        resolutionNotes = finalNotes;
        push('ASSIGNED_REVIEWER', current, current, pickReviewer(), 'Compliance reviewer assigned', lag(1, 12));
        push('SUBMITTED_FOR_REVIEW', current, 'Escalated', analyst, finalNotes, lag(1, 24));
        current = 'Escalated';
        logExceptionCleared();
        t = Math.max(t, exc?.resolvedAt?.getTime() ?? 0);
        push('RESOLUTION_APPROVED', 'Escalated', 'Resolved', reviewer, 'Resolution approved.', lag(1, 24));
      } else {
        logExceptionCleared();
        resolutionNotes = finalNotes;
        push(isPeriodic ? 'REVIEW_COMPLETED' : 'RESOLVED', current, 'Resolved', analyst, finalNotes, lag(1, 24));
      }
      resolvedAt = new Date(t);
      current = 'Resolved';
      if (status === 'Closed') {
        push('CLOSED', 'Resolved', 'Closed', analyst, 'Closed after resolution.', lag(12, 96));
        closedAt = new Date(t);
        current = 'Closed';
      }
    }

    const slaDue = isPeriodic && schedule ? schedule.nextReviewDate : parseIso(addDays(createdAt.toISOString().slice(0, 10), SLA_DAYS[priority]));
    const row = {
      customerId: c.id, exceptionId: exc ? exc.id : null, reviewScheduleId: schedule ? schedule.id : null, periodicCycle: schedule ? schedule.cycleNumber : null,
      caseTitle: `${label}: ${c.fullName}`.slice(0, 150),
      caseType,
      description: isPeriodic
        ? `The periodic KYC review for ${c.fullName} was due on ${schedule.nextIso} (${schedule.reviewIntervalMonths}-month interval for ${schedule.riskLevel} risk). ${spec.kind === 'periodic-active' ? 'Created automatically when the review became due.' : 'Created automatically; the review was completed later.'}`
        : exc.description,
      priority, assignedAnalystId: analyst, assignedReviewerId: reviewer, status, dueDate: slaDue, resolutionNotes, requiresApproval: approval, proposalPending, proposedById,
      createdById: creator, createdAt, updatedAt: steps[steps.length - 1].changedAt, resolvedAt, closedAt, steps, customerCode: c.code,
    };
    cases.push(row);
    if (exc) exc.cases.push(row);

    // internal notes by the analyst while the case was worked
    if (analyst && reach(status) >= reach('In Progress')) {
      const count = r.int(0, status === 'In Progress' ? 2 : 3);
      const startT = steps.find((s) => s.action === 'STARTED').changedAt.getTime();
      const endT = steps[steps.length - 1].changedAt.getTime();
      for (let k = 0; k < count; k += 1) {
        row.pendingNotes = row.pendingNotes || [];
        row.pendingNotes.push({ authorId: analyst, note: r.pick(ANALYST_NOTES), createdAt: new Date(startT + Math.floor(((endT - startT) * (k + 1)) / (count + 1))) });
      }
    }
  }

  // ---- case numbering: by creation time ----------------------------------------------------------------------------------
  cases.sort((a, b) => a.createdAt - b.createdAt || a.customerId - b.customerId);
  cases.forEach((cs, i) => {
    cs.id = i + 1;
    cs.caseCode = caseCode(i + 1);
    const year = cs.createdAt.getUTCFullYear();
    cs.reviewCode = reviewCode(cs.customerCode, year, counters.next(`REV:${cs.customerCode}`, year));
    for (const s of cs.steps) history.push({ reviewCaseId: cs.id, ...s });
    for (const n of cs.pendingNotes || []) notes.push({ reviewCaseId: cs.id, ...n });
  });
  history.sort((a, b) => a.changedAt - b.changedAt || a.reviewCaseId - b.reviewCaseId);
  history.forEach((h, i) => { h.id = i + 1; });
  notes.sort((a, b) => a.createdAt - b.createdAt || a.reviewCaseId - b.reviewCaseId);
  notes.forEach((n, i) => { n.id = i + 1; });

  // an exception with an active case is "In Review"
  for (const e of exceptions) {
    const active = e.cases.filter((cs) => ['Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated'].includes(cs.status));
    if (!e.historical && active.length > 0) {
      e.status = 'In Review';
      e.updatedAt = new Date(Math.max(e.detectedAt.getTime(), Math.min(...active.map((cs) => cs.createdAt.getTime()))));
    }
  }
  void ACTIVE_EXCEPTION_STATUSES;

  const exceptionRows = exceptions;
  const stats = {
    schedules: schedules.length, overdueSchedules: dueSchedules.length, lateCompletedCycles: lateCycles.length,
    exceptions: exceptions.length, activeExceptions: exceptions.filter((e) => !e.historical).length, resolvedExceptions: historical.length,
    cases: cases.length, historicalCases: chosenHistorical.length, periodicOverdueCases: mandatory.length,
  };
  return { schedules, exceptions: exceptionRows, cases, caseHistory: history, caseNotes: notes, contexts, conditionsByCustomer, activeByKey, detectedAtByKey, stats };
}

module.exports = { generateReview };
