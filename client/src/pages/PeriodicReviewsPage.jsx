import { Fragment, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { completeSchedule, createCase, getReviewDashboard, listSchedules } from '../services/reviewApi';
import { runDetectionJob } from '../services/phase6Api';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, Field, PageHeader, Pagination, RiskBadge, Spinner } from '../components/ui';
import { CaseStatusBadge } from '../components/reviewUi';
import { formatDate } from '../utils/format';
import { todayIso } from '../utils/validators';
import { http, call } from '../services/api';

const TABS = [
  { id: 'overdue', label: 'Overdue', path: '/reviews/overdue' },
  { id: 'upcoming', label: 'Upcoming (30 days)', path: '/reviews/upcoming' },
  { id: 'all', label: 'All schedules and history', path: '/review-schedules' },
];
const STATE_STYLE = {
  Overdue: 'bg-red-50 text-red-700 ring-red-600/20',
  'Due soon': 'bg-amber-50 text-amber-700 ring-amber-600/20',
  Scheduled: 'bg-slate-100 text-slate-600 ring-slate-500/25',
  Completed: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  Superseded: 'bg-slate-100 text-slate-500 ring-slate-400/25',
};

/**
 * Periodic KYC reviews. The interval depends on the customer's risk level (illustrative, configurable: Low 36 months,
 * Medium 24, High 12). Completing a review recalculates the next due date.
 */
export default function PeriodicReviewsPage() {
  const toast = useToast();
  const { current: person } = useReviewer();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') || 'overdue';
  const page = Number(params.get('page') || 1);
  const search = params.get('search') || '';
  const tabDef = TABS.find((t) => t.id === tab) || TABS[0];
  const canComplete = ['Reviewer', 'Admin'].includes(person?.role);

  const dash = useAsync(getReviewDashboard, []);
  const { data, loading, error, reload } = useAsync(
    () => call(() => http.get(tabDef.path, { params: { page, pageSize: 10, search } })),
    [tab, page, search]
  );
  const rows = data?.data ?? [];

  const [form, setForm] = useState(null); // { id, notes, reviewDate }
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [progress, setProgress] = useState(null);

  const update = (changes) => {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  };

  async function runDetection() {
    setBusy('detect');
    try {
      const r = await runDetectionJob(setProgress); // background job with progress
      toast.success(`Detection finished: ${r.casesCreated} periodic review case${r.casesCreated === 1 ? '' : 's'} created for reviews that are due, ${r.created} new exception${r.created === 1 ? '' : 's'}.`);
      reload();
      dash.reload();
    } catch (err) {
      toast.error(err.status === 401 ? 'Choose who you are acting as in the sidebar first.' : err.message);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  async function makeCase(s) {
    setBusy(`case-${s.id}`);
    try {
      const created = await createCase({ customerId: s.customerId, reviewScheduleId: s.id, caseTitle: `Periodic KYC review (cycle ${s.cycleNumber})`, caseType: 'Periodic KYC Review', description: `Periodic review due ${s.nextReviewDate}.` });
      toast.success(`Case ${created.caseId} created.`);
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  }

  async function complete(e) {
    e.preventDefault();
    setFormError(null);
    if (form.notes.trim().length < 10) return setFormError({ message: 'Completion notes are required (at least 10 characters).' });
    setBusy(`complete-${form.id}`);
    try {
      const r = await completeSchedule(form.id, { notes: form.notes.trim(), ...(form.reviewDate ? { reviewDate: form.reviewDate } : {}) });
      toast.success(`Review completed. Next review due ${formatDate(r.next.nextReviewDate)}.`);
      setForm(null);
      reload();
      dash.reload();
    } catch (err) {
      setFormError(err);
    } finally {
      setBusy(null);
    }
  }

  const d = dash.data;

  return (
    <>
      <PageHeader title="Periodic KYC reviews" subtitle="Customers are re-checked regularly. See which reviews are past their due date and which are coming up (periodic KYC reviews).">
        <button type="button" className="btn btn-primary" onClick={runDetection} disabled={busy === 'detect'}>{busy === 'detect' ? (progress?.total ? `Checking… ${progress.processed}/${progress.total} (${progress.percent}%)` : 'Checking…') : 'Run detection'}</button>
      </PageHeader>

      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        Review intervals follow the customer's risk level (illustrative defaults: <strong>Low 36 months, Medium 24, High 12</strong>). They are configurable settings, not legal requirements. Detection creates a review case when a review becomes due.
      </div>

      {d && (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <button type="button" onClick={() => update({ tab: 'overdue', page: '' })} className={`card border-l-4 border-l-red-500 p-4 text-left transition hover:shadow-md ${tab === 'overdue' ? 'ring-2 ring-brand-600' : ''}`}>
            <div className="text-sm text-slate-500">Overdue reviews</div><div className="mt-1 text-3xl font-semibold tabular-nums">{d.overduePeriodicReviews}</div>
          </button>
          <button type="button" onClick={() => update({ tab: 'upcoming', page: '' })} className={`card border-l-4 border-l-amber-500 p-4 text-left transition hover:shadow-md ${tab === 'upcoming' ? 'ring-2 ring-brand-600' : ''}`}>
            <div className="text-sm text-slate-500">Upcoming (30 days)</div><div className="mt-1 text-3xl font-semibold tabular-nums">{d.upcomingPeriodicReviews}</div>
          </button>
          <Link to="/cases?caseType=Periodic%20KYC%20Review" className="card border-l-4 border-l-teal-500 p-4 transition hover:shadow-md">
            <div className="text-sm text-slate-500">Periodic review cases</div><div className="mt-1 text-sm font-medium text-brand-700">View cases →</div>
          </Link>
        </div>
      )}

      <div className="card">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 p-3">
          <div role="tablist" className="flex flex-wrap gap-2">
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => update({ tab: t.id, page: '' })} className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${tab === t.id ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>{t.label}</button>
            ))}
          </div>
          <input className="input !w-64 max-w-full" type="search" placeholder="Search customer ID or name" value={search} onChange={(e) => update({ search: e.target.value, page: '' })} aria-label="Search reviews" />
        </div>

        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? <Spinner label="Loading reviews…" /> : (
          <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Customer</th><th className="px-4 py-3">Risk</th><th className="px-4 py-3">Last review</th><th className="px-4 py-3">Next review due</th><th className="px-4 py-3">State</th><th className="px-4 py-3">Case</th><th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((s) => (
                  <Fragment key={s.id}>
                    <tr className="align-top hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link to={`/customers/${s.customerId}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">{s.customerId}</Link>
                        <div className="text-slate-900">{s.customerName}</div>
                        <div className="text-[11px] text-slate-500">Cycle {s.cycleNumber}</div>
                      </td>
                      <td className="px-4 py-3"><RiskBadge level={s.riskLevel} /><div className="mt-1 text-[11px] text-slate-500">every {s.reviewIntervalMonths} months</div>{s.riskLevelChanged && <div className="mt-1 text-[11px] text-amber-700">now {s.currentRiskLevel}: re-based by detection</div>}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(s.lastReviewDate)}</td>
                      <td className="whitespace-nowrap px-4 py-3">{formatDate(s.nextReviewDate)}{s.daysUntilDue !== null && <div className={`text-xs ${s.daysUntilDue < 0 ? 'font-medium text-red-700' : 'text-slate-500'}`}>{s.daysUntilDue < 0 ? `${Math.abs(s.daysUntilDue)} days overdue` : s.daysUntilDue === 0 ? 'due today' : `in ${s.daysUntilDue} days`}</div>}</td>
                      <td className="px-4 py-3"><span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STATE_STYLE[s.state]}`}>{s.state}</span></td>
                      <td className="px-4 py-3">{s.activeCase ? <Link to={`/cases/${s.activeCase.id}`} className="inline-flex flex-col gap-1 text-xs font-medium text-brand-700 hover:underline">{s.activeCase.caseCode}<CaseStatusBadge status={s.activeCase.status} /></Link> : <span className="text-slate-400">—</span>}</td>
                      <td className="px-4 py-3 text-right">
                        {s.status === 'Scheduled' ? (
                          <div className="flex flex-col items-end gap-1.5">
                            {!s.activeCase && <button type="button" className="btn btn-secondary !py-1" disabled={busy === `case-${s.id}`} onClick={() => makeCase(s)}>Create case</button>}
                            {canComplete && <button type="button" className="btn btn-primary !py-1" onClick={() => { setForm({ id: s.id, notes: '', reviewDate: '' }); setFormError(null); }}>Complete review</button>}
                          </div>
                        ) : <span className="text-xs text-slate-500">{s.completedAt ? `Completed ${formatDate(s.completedAt)}` : s.status}</span>}
                      </td>
                    </tr>
                    {form?.id === s.id && (
                      <tr className="bg-slate-50/70">
                        <td colSpan={7} className="px-4 py-4">
                          <form onSubmit={complete} className="grid gap-3 sm:grid-cols-3" aria-label="Complete review">
                            {formError && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-800 sm:col-span-3">{formError.message}</p>}
                            <div className="sm:col-span-2"><Field label="Completion notes" required hint="What was reviewed and the conclusion"><textarea rows={2} className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></Field></div>
                            <Field label="Review date" hint="Defaults to today"><input type="date" max={todayIso()} className="input" value={form.reviewDate} onChange={(e) => setForm({ ...form, reviewDate: e.target.value })} /></Field>
                            <div className="flex gap-2 sm:col-span-3">
                              <button type="submit" className="btn btn-primary" disabled={busy === `complete-${s.id}`}>{busy === `complete-${s.id}` ? 'Saving…' : 'Complete and schedule the next review'}</button>
                              <button type="button" className="btn btn-secondary" onClick={() => setForm(null)}>Cancel</button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {!loading && rows.length === 0 && !error && <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-500">{tab === 'overdue' ? 'No overdue reviews.' : tab === 'upcoming' ? 'No reviews due in the next 30 days.' : 'No review schedules yet. Run detection to create them.'}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pagination.totalItems > 0 && <Pagination pagination={data.pagination} onPage={(p) => update({ page: p > 1 ? String(p) : '' })} />}
      </div>
      {!canComplete && <p className="mt-3 text-xs text-slate-500">Only a compliance reviewer or an administrator can complete a review. Choose one in the sidebar to see the button.</p>}
    </>
  );
}
