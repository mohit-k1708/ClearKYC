import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getReviewOptions, listCases } from '../services/reviewApi';
import { listReviewers } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import useDebounce from '../hooks/useDebounce';
import useReviewer from '../hooks/useReviewer';
import { ErrorBanner, PageHeader, Pagination, Spinner } from '../components/ui';
import { CaseStatusBadge, DueDate, Person, SeverityBadge } from '../components/reviewUi';

const PAGE_SIZE = 10;

/** Review Cases: formal investigations. Filters live in the URL so dashboard cards can link to a filtered list. */
export default function ReviewCasesPage() {
  const [params, setParams] = useSearchParams();
  const { current: person } = useReviewer();
  const status = params.get('status') || 'active';
  const priority = params.get('priority') || '';
  const caseType = params.get('caseType') || '';
  const analyst = params.get('assignedAnalystId') || '';
  const reviewer = params.get('assignedReviewerId') || '';
  const unassigned = params.get('unassigned') || '';
  const overdue = params.get('overdue') || '';
  const customerId = params.get('customerId') || '';
  const page = Number(params.get('page') || 1);
  const urlSearch = params.get('search') || '';

  const [searchText, setSearchText] = useState(urlSearch);
  const debounced = useDebounce(searchText);
  useEffect(() => {
    if (debounced !== urlSearch) update({ search: debounced, page: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  function update(changes) {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  }

  const options = useAsync(getReviewOptions, []);
  const people = useAsync(listReviewers, []);
  const { data, loading, error, reload } = useAsync(
    () => listCases({ page, pageSize: PAGE_SIZE, search: urlSearch, status, priority, caseType, assignedAnalystId: analyst, assignedReviewerId: reviewer, unassigned, overdue, customerId }),
    [page, urlSearch, status, priority, caseType, analyst, reviewer, unassigned, overdue, customerId]
  );
  const rows = data?.data ?? [];
  const hasFilters = Boolean(urlSearch || priority || caseType || analyst || reviewer || unassigned || overdue || customerId || status !== 'active');
  const analysts = (people.data ?? []).filter((p) => ['Analyst', 'Admin'].includes(p.role));
  const reviewers = (people.data ?? []).filter((p) => ['Reviewer', 'Admin'].includes(p.role));

  return (
    <>
      <PageHeader title="Review cases" subtitle="A case is a task to look into a problem with a customer and fix it. Follow each case from start to finish.">
        <Link to="/cases/new" className="btn btn-primary">+ New Case</Link>
      </PageHeader>

      <div className="card">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <input className="input lg:col-span-2" type="search" placeholder="Search by case ID, title, customer ID or name" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search cases" />
          <select className="input" value={status} onChange={(e) => update({ status: e.target.value === 'active' ? '' : e.target.value, page: '' })} aria-label="Filter by status">
            <option value="active">Active cases</option>
            <option value="closed">Resolved and closed</option>
            {(options.data?.caseStatuses ?? []).map((s) => <option key={s}>{s}</option>)}
            {status.includes(',') && <option value={status}>{status.split(',').join(' + ')}</option>}
          </select>
          <select className="input" value={priority} onChange={(e) => update({ priority: e.target.value, page: '' })} aria-label="Filter by priority">
            <option value="">All priorities</option>
            <option>Critical</option><option>High</option><option>Medium</option><option>Low</option>
            {priority.includes(',') && <option value={priority}>{priority.split(',').join(' + ')}</option>}
          </select>
          <select className="input lg:col-span-2" value={caseType} onChange={(e) => update({ caseType: e.target.value, page: '' })} aria-label="Filter by case type">
            <option value="">All case types</option>
            {(options.data?.caseTypes ?? []).map((t) => <option key={t}>{t}</option>)}
          </select>
          <select className="input" value={analyst} onChange={(e) => update({ assignedAnalystId: e.target.value, page: '' })} aria-label="Filter by assigned analyst">
            <option value="">Any analyst</option>
            {analysts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select className="input" value={reviewer} onChange={(e) => update({ assignedReviewerId: e.target.value, page: '' })} aria-label="Filter by assigned reviewer">
            <option value="">Any reviewer</option>
            {reviewers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-700 lg:col-span-4">
            {person && <label className="flex items-center gap-2"><input type="checkbox" checked={analyst === String(person.id)} onChange={(e) => update({ assignedAnalystId: e.target.checked ? String(person.id) : '', page: '' })} /> Assigned to me</label>}
            <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(unassigned)} onChange={(e) => update({ unassigned: e.target.checked ? 'true' : '', page: '' })} /> Unassigned</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(overdue)} onChange={(e) => update({ overdue: e.target.checked ? 'true' : '', page: '' })} /> Overdue</label>
            {hasFilters && <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => { setSearchText(''); setParams({}, { replace: true }); }}>Clear filters</button>}
          </div>
        </div>
        {customerId && <p className="px-4 pb-3 text-sm text-slate-600">Showing cases for <span className="font-mono">{customerId}</span>.</p>}

        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? (
          <Spinner label="Loading cases…" />
        ) : (
          <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Case ID</th>
                  <th className="px-4 py-3">Customer ID</th>
                  <th className="px-4 py-3">Case type</th>
                  <th className="px-4 py-3">Priority</th>
                  <th className="px-4 py-3">Assigned analyst</th>
                  <th className="px-4 py-3">Assigned reviewer</th>
                  <th className="px-4 py-3">Due date</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => (
                  <tr key={c.id} className="align-top hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link to={`/cases/${c.id}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">{c.caseId}</Link>
                      <div className="max-w-[16rem] truncate text-xs text-slate-500" title={c.caseTitle}>{c.caseTitle}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Link to={`/customers/${c.customerId}`} className="font-mono text-xs text-brand-700 hover:underline">{c.customerId}</Link>
                      <div className="text-xs text-slate-500">{c.customerName}</div>
                    </td>
                    <td className="px-4 py-3">{c.caseType}{c.requiresApproval && <div className="text-[11px] text-violet-700">needs approval</div>}</td>
                    <td className="px-4 py-3"><SeverityBadge level={c.priority} /></td>
                    <td className="px-4 py-3"><Person person={c.assignedAnalyst} /></td>
                    <td className="px-4 py-3"><Person person={c.assignedReviewer} empty="None" /></td>
                    <td className="px-4 py-3"><DueDate date={c.dueDate} overdue={c.isOverdue} days={c.daysOverdue} /></td>
                    <td className="px-4 py-3"><CaseStatusBadge status={c.status} />{c.proposalPending && <div className="mt-1 text-[11px] text-violet-700">awaiting approval</div>}</td>
                    <td className="px-4 py-3 text-right"><Link to={`/cases/${c.id}`} className="font-medium text-brand-700 hover:underline">Open</Link></td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-500">{hasFilters ? 'No cases match your filters.' : 'No active cases. Create one from an exception or start a new case.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pagination.totalItems > 0 && <Pagination pagination={data.pagination} onPage={(p) => update({ page: p > 1 ? String(p) : '' })} />}
      </div>
    </>
  );
}
