/**
 * Shared Scene 4 UI pieces: badges, due dates, and the case timeline.
 */
import { formatDate, formatDateTime } from '../utils/format';

const PILL = 'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset';

export const ROLE_LABELS = { Analyst: 'Operations Analyst', Reviewer: 'Compliance Reviewer', Admin: 'Administrator', System: 'System' };

const SEVERITY = {
  Critical: 'bg-red-100 text-red-800 ring-red-700/30',
  High: 'bg-orange-50 text-orange-700 ring-orange-600/25',
  Medium: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  Low: 'bg-slate-100 text-slate-600 ring-slate-500/25',
};
/** Used for both exception severity and case priority (the same four words). */
export function SeverityBadge({ level }) {
  return <span className={`${PILL} ${SEVERITY[level] || SEVERITY.Low}`}>{level}</span>;
}

const EXCEPTION_STATUS = {
  Open: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  'In Review': 'bg-violet-50 text-violet-700 ring-violet-600/20',
  Resolved: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
};
export function ExceptionStatusBadge({ status }) {
  return <span className={`${PILL} ${EXCEPTION_STATUS[status]}`}>{status}</span>;
}

const CASE_STATUS = {
  Open: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  Assigned: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  'In Progress': 'bg-teal-50 text-teal-700 ring-teal-600/20',
  'Pending Customer': 'bg-amber-50 text-amber-700 ring-amber-600/20',
  Escalated: 'bg-fuchsia-50 text-fuchsia-700 ring-fuchsia-600/25',
  Resolved: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  Closed: 'bg-slate-100 text-slate-600 ring-slate-500/25',
};
export function CaseStatusBadge({ status }) {
  return <span className={`${PILL} ${CASE_STATUS[status]}`}>{status}</span>;
}

/** Due date with an overdue marker computed by the server (daysOverdue). */
export function DueDate({ date, overdue, days }) {
  return (
    <span className="whitespace-nowrap">
      <span className={overdue ? 'font-medium text-red-700' : 'text-slate-600'}>{formatDate(date)}</span>
      {overdue && <span className="ml-1.5 rounded bg-red-50 px-1.5 py-0.5 text-[11px] font-medium text-red-700">{days}d overdue</span>}
    </span>
  );
}

export function Person({ person, empty = 'Unassigned' }) {
  if (!person) return <span className="text-slate-400">{empty}</span>;
  return (
    <span>
      <span className="text-slate-900">{person.name}</span>
      <span className="block text-[11px] text-slate-500">{person.roleLabel || ROLE_LABELS[person.role] || person.role}</span>
    </span>
  );
}

// ---- Case timeline ----------------------------------------------------------------------------------------
const ACTION_LABELS = {
  CREATED: 'Case created',
  ASSIGNED_ANALYST: 'Analyst assigned',
  UNASSIGNED_ANALYST: 'Analyst removed',
  ASSIGNED_REVIEWER: 'Compliance reviewer assigned',
  UNASSIGNED_REVIEWER: 'Compliance reviewer removed',
  PRIORITY_CHANGED: 'Priority changed',
  STARTED: 'Investigation started',
  CUSTOMER_INFO_REQUESTED: 'Waiting for the customer',
  CUSTOMER_RESPONDED: 'Customer responded',
  ESCALATED: 'Escalated to compliance',
  SUBMITTED_FOR_REVIEW: 'Submitted for review',
  RESOLUTION_APPROVED: 'Resolution approved',
  RESOLUTION_REJECTED: 'Resolution rejected',
  RETURNED_TO_ANALYST: 'Returned to the analyst',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  REOPENED: 'Reopened',
  REVIEW_COMPLETED: 'Periodic review completed',
  EXCEPTION_RESOLVED: 'Linked exception resolved',
};

/** The complete case timeline: status changes, assignments and notes, newest first. Entries are never edited. */
export function CaseTimeline({ items }) {
  if (!items?.length) return <p className="text-sm text-slate-500">Nothing recorded yet.</p>;
  return (
    <ol>
      {items.map((t, i) => (
        <li key={t.id} className="relative pb-5 pl-7 last:pb-0">
          {i < items.length - 1 && <span className="absolute left-[7px] top-4 h-full w-px bg-slate-200" aria-hidden="true" />}
          <span className={`absolute left-0 top-1.5 h-[15px] w-[15px] rounded-full border-2 border-white ring-2 ${t.kind === 'note' ? 'bg-amber-400 ring-amber-300/50' : i === 0 ? 'bg-brand-600 ring-brand-600/30' : 'bg-slate-300 ring-slate-200'}`} aria-hidden="true" />
          {t.kind === 'note' ? (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-slate-800">Note</span>
                <span className="text-xs text-slate-500">{formatDateTime(t.at)}</span>
              </div>
              <p className="mt-1 whitespace-pre-wrap rounded-md bg-amber-50 px-3 py-2 text-sm text-slate-800">{t.note}</p>
              <p className="mt-1 text-xs text-slate-500">by {t.by.name} ({t.by.roleLabel})</p>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium text-slate-800">{ACTION_LABELS[t.action] || t.action}</span>
                {t.previousStatus && t.previousStatus !== t.newStatus ? (
                  <span className="inline-flex items-center gap-1.5">
                    <CaseStatusBadge status={t.previousStatus} />
                    <span className="text-slate-400">→</span>
                    <CaseStatusBadge status={t.newStatus} />
                  </span>
                ) : (
                  <CaseStatusBadge status={t.newStatus} />
                )}
                <span className="text-xs text-slate-500">{formatDateTime(t.at)}</span>
              </div>
              <p className="mt-0.5 text-xs text-slate-500">by {t.by.name} ({t.by.roleLabel})</p>
              {t.remarks && <p className="mt-1 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{t.remarks}</p>}
            </>
          )}
        </li>
      ))}
    </ol>
  );
}
