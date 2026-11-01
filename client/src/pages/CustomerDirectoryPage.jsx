import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { listCustomers } from '../services/api';
import useAsync from '../hooks/useAsync';
import useDebounce from '../hooks/useDebounce';
import { AddCustomerButton, ErrorBanner, PageHeader, Pagination, RiskBadge, Spinner, StatusBadge, TypeBadge } from '../components/ui';

const PAGE_SIZE = 10;

/**
 * Customer directory. Filters live in the URL (?search=&type=&risk=&page=), so the browser Back
 * button works and dashboard cards can link straight to a filtered list.
 */
export default function CustomerDirectoryPage() {
  const [params, setParams] = useSearchParams();
  const type = params.get('type') || '';
  const risk = params.get('risk') || '';
  const page = Number(params.get('page') || 1);
  const urlSearch = params.get('search') || '';

  // The text box updates instantly; the API is queried after the user pauses typing.
  const [searchText, setSearchText] = useState(urlSearch);
  const debouncedSearch = useDebounce(searchText);

  useEffect(() => {
    if (debouncedSearch !== urlSearch) update({ search: debouncedSearch, page: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch]);

  function update(changes) {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  }

  const { data, loading, error, reload } = useAsync(
    () => listCustomers({ page, pageSize: PAGE_SIZE, search: urlSearch, type, risk }),
    [page, urlSearch, type, risk]
  );
  const rows = data?.data ?? [];
  const hasFilters = Boolean(urlSearch || type || risk);

  return (
    <>
      <PageHeader title="Customers" subtitle="Everyone who has registered with you. Search by name or customer ID, or filter by type and risk level.">
        <AddCustomerButton />
      </PageHeader>

      <div className="card">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <input
            className="input lg:col-span-2"
            type="search"
            placeholder="Search by name or Customer ID (e.g. CUS-000012)"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            aria-label="Search customers"
          />
          <select className="input" value={type} onChange={(e) => update({ type: e.target.value, page: '' })} aria-label="Filter by customer type">
            <option value="">All customer types</option>
            <option>Individual</option>
            <option>Company</option>
          </select>
          <select className="input" value={risk} onChange={(e) => update({ risk: e.target.value, page: '' })} aria-label="Filter by risk level">
            <option value="">All risk levels</option>
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
          </select>
        </div>

        <ErrorBanner error={error} onRetry={reload} />

        {loading && !data ? (
          <Spinner label="Loading customers…" />
        ) : (
          <div className={`overflow-x-auto transition-opacity ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Customer ID</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">Type</th>
                  <th className="px-4 py-3">Risk</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Registered</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">
                      <Link to={`/customers/${c.customerId}`} className="font-medium text-brand-700 hover:underline">
                        {c.customerId}
                      </Link>
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">{c.name}</td>
                    <td className="px-4 py-3"><TypeBadge type={c.customerType} /></td>
                    <td className="px-4 py-3"><RiskBadge level={c.riskLevel} /></td>
                    <td className="px-4 py-3"><StatusBadge status={c.registrationStatus} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{new Date(c.createdAt).toLocaleDateString('en-IN')}</td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-slate-500">
                      {hasFilters ? 'No customers match your search or filters.' : 'No customers registered yet.'}
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
