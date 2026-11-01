import { Link } from 'react-router-dom';
import { listCases, listExceptions, listSchedules } from '../services/reviewApi';
import useAsync from '../hooks/useAsync';
import { ErrorBanner } from './ui';
import { CaseStatusBadge, SeverityBadge } from './reviewUi';
import { formatDate } from '../utils/format';

/** Scene 4 on the customer profile: next periodic review, active exceptions and the customer's review cases. */
export default function CustomerReviewSection({ customerId }) {
  const sched = useAsync(() => listSchedules({ customerId, status: 'Scheduled', pageSize: 1 }), [customerId]);
  const exc = useAsync(() => listExceptions({ customerId, pageSize: 20 }), [customerId]);
  const cases = useAsync(() => listCases({ customerId, status: 'active', pageSize: 20 }), [customerId]);

  const next = sched.data?.data?.[0];
  const exceptions = exc.data?.data ?? [];
  const caseRows = cases.data?.data ?? [];
  const error = sched.error || exc.error || cases.error;

  return (
    <section className="card p-5 sm:p-6" aria-labelledby="customer-review-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id="customer-review-heading" className="text-base font-semibold">Review cases and exceptions</h2>
        <div className="flex gap-3 text-sm">
          <Link className="font-medium text-brand-700 hover:underline" to={`/cases?customerId=${customerId}&status=closed`}>Closed cases</Link>
          <Link className="font-medium text-brand-700 hover:underline" to={`/cases/new?customer=${customerId}`}>+ New case</Link>
        </div>
      </div>
      <ErrorBanner error={error} onRetry={() => { sched.reload(); exc.reload(); cases.reload(); }} />

      <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-slate-500">Next periodic review</dt>
          <dd className="font-medium">
            {next ? <>{formatDate(next.nextReviewDate)} <span className={`text-xs ${next.state === 'Overdue' ? 'text-red-700' : 'text-slate-500'}`}>({next.state === 'Overdue' ? `${Math.abs(next.daysUntilDue)} days overdue` : `in ${next.daysUntilDue} days`})</span></> : <span className="text-slate-400">Not scheduled yet</span>}
          </dd>
        </div>
        <div className="min-w-0"><dt className="text-slate-500">Last review</dt><dd className="font-medium">{next ? formatDate(next.lastReviewDate) : '—'}</dd></div>
        <div className="min-w-0"><dt className="text-slate-500">Review interval</dt><dd className="font-medium">{next ? `${next.reviewIntervalMonths} months (${next.riskLevel} risk)` : '—'}</dd></div>
      </dl>

      <h3 className="mb-2 text-sm font-semibold text-slate-700">Active exceptions ({exceptions.filter((e) => e.status === 'Open' || e.status === 'Under Review').length})</h3>
      {exceptions.length === 0 ? <p className="mb-4 text-sm text-slate-500">No exceptions recorded.</p> : (
        <ul className="mb-4 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {exceptions.slice(0, 6).map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <SeverityBadge level={e.severity} />
              <span className="min-w-0 flex-1 break-words text-slate-700">{e.typeLabel}</span>
              <span className="text-xs text-slate-500">{e.status}</span>
            </li>
          ))}
          {exceptions.length > 6 && <li className="px-3 py-2 text-xs"><Link className="text-brand-700 hover:underline" to={`/exceptions?customerId=${customerId}`}>See all {exceptions.length}</Link></li>}
        </ul>
      )}

      <h3 className="mb-2 text-sm font-semibold text-slate-700">Active cases ({caseRows.length})</h3>
      {caseRows.length === 0 ? <p className="text-sm text-slate-500">No active review cases.</p> : (
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {caseRows.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <Link to={`/cases/${c.id}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">{c.caseId}</Link>
              <span className="min-w-0 flex-1 break-words text-slate-700">{c.caseTitle}</span>
              <SeverityBadge level={c.priority} />
              <CaseStatusBadge status={c.status} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
