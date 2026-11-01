/**
 * Counts for the review dashboard. Calculated from the database on every request.
 */
const prisma = require('../utils/prisma');
const { todayIso, addDays } = require('../utils/dates');
const { PERIODIC_REVIEW } = require('../config/reviewRules');

async function getSummary(asOf = todayIso()) {
  const end = addDays(asOf, PERIODIC_REVIEW.upcomingDays);
  const [c] = await prisma.$queryRaw`
    SELECT
      count(*) FILTER (WHERE status = 'Open')::int AS open,
      count(*) FILTER (WHERE status = 'Assigned')::int AS assigned,
      count(*) FILTER (WHERE status = 'In Progress')::int AS in_progress,
      count(*) FILTER (WHERE status = 'Pending Customer')::int AS pending_customer,
      count(*) FILTER (WHERE status = 'Escalated')::int AS escalated,
      count(*) FILTER (WHERE status = 'Resolved')::int AS resolved,
      count(*) FILTER (WHERE status = 'Closed')::int AS closed,
      count(*) FILTER (WHERE status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated') AND due_date < ${asOf}::date)::int AS overdue,
      count(*) FILTER (WHERE status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated') AND priority IN ('High', 'Critical'))::int AS high_priority,
      count(*) FILTER (WHERE status IN ('Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated') AND assigned_analyst_id IS NULL)::int AS unassigned,
      count(*) FILTER (WHERE status = 'Escalated' AND proposal_pending)::int AS awaiting_approval
    FROM "ReviewCase"`;
  const [s] = await prisma.$queryRaw`
    SELECT
      count(*) FILTER (WHERE next_review_date >= ${asOf}::date AND next_review_date <= ${end}::date)::int AS upcoming,
      count(*) FILTER (WHERE next_review_date < ${asOf}::date)::int AS overdue
    FROM "ReviewSchedule" WHERE status = 'Scheduled'`;
  const [e] = await prisma.$queryRaw`
    SELECT
      count(*) FILTER (WHERE status IN ('Open', 'In Review'))::int AS active,
      count(*) FILTER (WHERE status IN ('Open', 'In Review') AND severity = 'Critical')::int AS critical,
      count(*) FILTER (WHERE status IN ('Open', 'In Review') AND severity = 'High')::int AS high,
      count(*) FILTER (WHERE status = 'Open')::int AS without_case
    FROM "Exception"`;

  return {
    asOf,
    openCases: c.open + c.assigned, // waiting to be worked
    inProgressCases: c.in_progress + c.pending_customer,
    escalatedCases: c.escalated,
    overdueCases: c.overdue,
    highPriorityCases: c.high_priority,
    upcomingPeriodicReviews: s.upcoming,
    // extra detail for the pages
    overduePeriodicReviews: s.overdue,
    unassignedCases: c.unassigned,
    awaitingApprovalCases: c.awaiting_approval, // an analyst proposed a resolution and a compliance reviewer has not yet approved it
    byStatus: { Open: c.open, Assigned: c.assigned, 'In Progress': c.in_progress, 'Pending Customer': c.pending_customer, Escalated: c.escalated, Resolved: c.resolved, Closed: c.closed },
    exceptions: { active: e.active, critical: e.critical, high: e.high, withoutCase: e.without_case },
  };
}

module.exports = { getSummary };
