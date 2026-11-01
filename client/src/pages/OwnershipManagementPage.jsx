import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { listOwnershipOverview } from '../services/ownershipApi';
import useAsync from '../hooks/useAsync';
import useDebounce from '../hooks/useDebounce';
import { ErrorBanner, PageHeader, Pagination, Spinner } from '../components/ui';
import { OWNERSHIP_STATUS_LABELS, OverallResult, OwnershipStatusBadge } from '../components/riskUi';

const PAGE_SIZE = 10;

/**
 * Ownership Management: every company customer with its ownership status. Search by company ID, company
 * name or an owner's name. Beneficial ownership applies to companies only.
 */
export default function OwnershipManagementPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
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

  const { data, loading, error, reload } = useAsync(() => listOwnershipOverview({ page, pageSize: PAGE_SIZE, search: urlSearch, status }), [page, urlSearch, status]);
  const rows = data?.data ?? [];

  return (
    <>
      <PageHeader title="Ownership management" subtitle="The people who own or control each company (beneficial owners), and whether their shares add up to exactly 100%.">
        <Link to="/ownership/owners/new" className="btn btn-primary">
          + Add Beneficial Owner
        </Link>
      </PageHeader>

      <div className="card">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <input className="input sm:col-span-2" type="search" placeholder="Search by company ID, company name or owner name" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search companies and owners" />
          <select className="input" value={status} onChange={(e) => update({ status: e.target.value, page: '' })} aria-label="Filter by ownership status">
            <option value="">All ownership statuses</option>
            {Object.entries(OWNERSHIP_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? (
          <Spinner label="Loading companies…" />
        ) : (
          <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[820px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Company</th>
                  <th className="px-4 py-3 text-right">Owners</th>
                  <th className="px-4 py-3 text-right">Total ownership</th>
                  <th className="px-4 py-3">Ownership status</th>
                  <th className="px-4 py-3">Current risk</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link to={`/ownership/${c.customerId}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">
                        {c.customerId}
                      </Link>
                      <div className="font-medium text-slate-900">{c.name}</div>
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{c.ownerCount}</td>
                    <td className="px-4 py-3 text-right tabular-nums">
                      {c.ownerCount === 0 ? '—' : `${c.totalPercentage}%`}
                      {c.missingCount > 0 && <div className="text-xs text-orange-700">{c.missingCount} without %</div>}
                    </td>
                    <td className="px-4 py-3"><OwnershipStatusBadge status={c.validationStatus} /></td>
                    <td className="px-4 py-3">{c.riskLevel ? <OverallResult level={c.riskLevel} status={c.assessmentStatus} /> : '—'}</td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/ownership/${c.customerId}`} className="font-medium text-brand-700 hover:underline">
                        Manage
                      </Link>
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-slate-500">
                      {urlSearch || status ? 'No companies match your search or filter.' : 'No company customers yet. Register a company first.'}
                    </td>
                  </tr>
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
