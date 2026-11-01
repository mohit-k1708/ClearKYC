import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { listRiskAssessments } from '../services/ownershipApi';
import useAsync from '../hooks/useAsync';
import useDebounce from '../hooks/useDebounce';
import { ErrorBanner, PageHeader, Pagination, Spinner, TypeBadge } from '../components/ui';
import { AssessedBy, LevelChange, ManualReviewReasons, OverallResult, ReasonsTable, ScoreComponents } from '../components/riskUi';
import { formatDateTime } from '../utils/format';

const PAGE_SIZE = 10;

/**
 * Risk Assessment History: every assessment ever recorded, newest first. Rows are never edited: a new
 * assessment is a new row. Open a row to see the reasons and how the score was built.
 */
export default function RiskHistoryPage() {
  const [params, setParams] = useSearchParams();
  const get = (k) => params.get(k) || '';
  const riskLevel = get('riskLevel');
  const status = get('status');
  const customerType = get('customerType');
  const customerId = get('customerId');
  const from = get('from');
  const to = get('to');
  const urlSearch = get('search');
  const page = Number(params.get('page') || 1);

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

  const [open, setOpen] = useState(null);
  const { data, loading, error, reload } = useAsync(
    () => listRiskAssessments({ page, pageSize: PAGE_SIZE, search: urlSearch, riskLevel, status, customerType, customerId, from, to }),
    [page, urlSearch, riskLevel, status, customerType, customerId, from, to]
  );
  const rows = data?.data ?? [];
  const hasFilters = Boolean(urlSearch || riskLevel || status || customerType || customerId || from || to);

  return (
    <>
      <PageHeader title="Risk assessment history" subtitle="Each customer's risk level (risk assessment), and how and why it changed over time." />

      <div className="card">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <input className="input lg:col-span-2" type="search" placeholder="Search by customer ID, name or assessment ID (RSK-000001)" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search assessments" />
          <select className="input" value={riskLevel} onChange={(e) => update({ riskLevel: e.target.value, page: '' })} aria-label="Filter by risk level">
            <option value="">All risk levels</option>
            <option>Low</option><option>Medium</option><option>High</option>
          </select>
          <select className="input" value={status} onChange={(e) => update({ status: e.target.value, page: '' })} aria-label="Filter by assessment status">
            <option value="">All statuses</option>
            <option>Completed</option><option>Requires Manual Review</option>
          </select>
          <select className="input" value={customerType} onChange={(e) => update({ customerType: e.target.value, page: '' })} aria-label="Filter by customer type">
            <option value="">All customer types</option>
            <option>Individual</option><option>Company</option>
          </select>
          <label className="text-xs text-slate-500">From<input type="date" className="input mt-0.5" value={from} onChange={(e) => update({ from: e.target.value, page: '' })} /></label>
          <label className="text-xs text-slate-500">To<input type="date" className="input mt-0.5" value={to} onChange={(e) => update({ to: e.target.value, page: '' })} /></label>
          {hasFilters && (
            <button type="button" className="btn btn-secondary self-end" onClick={() => { setSearchText(''); setParams({}, { replace: true }); }}>Clear filters</button>
          )}
        </div>
        {customerId && <p className="px-4 pb-3 text-sm text-slate-600">Showing assessments for <span className="font-mono">{customerId}</span>.</p>}

        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? (
          <Spinner label="Loading assessments…" />
        ) : (
          <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[940px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Assessment</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Risk level</th>
                  <th className="px-4 py-3 text-right">Score</th>
                  <th className="px-4 py-3">Result</th>
                  <th className="px-4 py-3">Assessed by</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((a) => (
                  <Fragment key={a.id}>
                    <tr className="align-top hover:bg-slate-50">
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-medium text-slate-800">{a.assessmentId}</td>
                      <td className="px-4 py-3">
                        <Link to={`/risk/${a.customerId}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">{a.customerId}</Link>
                        <div className="text-slate-900">{a.customerName}</div>
                        <TypeBadge type={a.customerType} />
                      </td>
                      <td className="px-4 py-3"><LevelChange previous={a.previousRiskLevel} next={a.riskLevel} /></td>
                      <td className="px-4 py-3 text-right tabular-nums">{a.riskScore}</td>
                      <td className="px-4 py-3"><OverallResult level={a.riskLevel} status={a.status} /></td>
                      <td className="px-4 py-3"><div className="text-sm text-slate-800">{a.assessedBy.name}</div><div className="text-xs text-slate-500">{formatDateTime(a.assessmentDate)}</div></td>
                      <td className="px-4 py-3 text-right">
                        <button type="button" className="font-medium text-brand-700 hover:underline" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>
                          {open === a.id ? 'Hide reasons' : 'Reasons'}
                        </button>
                      </td>
                    </tr>
                    {open === a.id && (
                      <tr className="bg-slate-50/70">
                        <td colSpan={7} className="px-4 py-4">
                          <div className="space-y-4">
                            <p className="text-xs text-slate-500">Method {a.method} · <AssessedBy person={a.assessedBy} date={a.assessmentDate} />{a.assessorNote ? ` · Note: ${a.assessorNote}` : ''}</p>
                            <ManualReviewReasons items={a.manualReviewReasons} />
                            <ReasonsTable reasons={a.reasons} />
                            {a.components && <div><h3 className="mb-1 text-sm font-medium text-slate-700">How the score was built</h3><ScoreComponents components={a.components} /></div>}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-500">{hasFilters ? 'No assessments match your filters.' : 'No assessments recorded yet.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pagination.totalItems > 0 && <Pagination pagination={data.pagination} onPage={(p) => update({ page: p > 1 ? String(p) : '' })} />}
      </div>
      <p className="mt-3 text-xs text-slate-500">Assessments are insert-only. The database refuses to change or delete an earlier one.</p>
    </>
  );
}
