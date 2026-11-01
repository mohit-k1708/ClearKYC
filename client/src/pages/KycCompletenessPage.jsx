import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { listExceptions } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import useDebounce from '../hooks/useDebounce';
import { ErrorBanner, PageHeader, Pagination, RiskBadge, Spinner, TypeBadge } from '../components/ui';
import { CustomerPicker, EXCEPTION_LABELS, ExceptionBadge, ExpiryBadge } from '../components/kycUi';

const TILES = [
  { type: 'MISSING_DOCUMENT', accent: 'border-l-slate-400' },
  { type: 'PENDING_VERIFICATION', accent: 'border-l-sky-500' },
  { type: 'REJECTED', accent: 'border-l-red-500' },
  { type: 'REQUIRES_RESUBMISSION', accent: 'border-l-orange-500' },
  { type: 'EXPIRED', accent: 'border-l-rose-700' },
  { type: 'EXPIRING_SOON', accent: 'border-l-amber-500' },
];

/**
 * KYC Completeness overview: which customers have missing, pending, rejected, expired or soon-to-expire
 * documents. Everything is calculated by the server from the stored records.
 */
export default function KycCompletenessPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const type = params.get('type') || '';
  const customerType = params.get('customerType') || '';
  const risk = params.get('risk') || '';
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

  const { data, loading, error, reload } = useAsync(
    () => listExceptions({ page, pageSize: 15, type, customerType, risk, search: urlSearch }),
    [page, type, customerType, risk, urlSearch]
  );
  const summary = data?.summary;
  const rows = data?.data ?? [];

  return (
    <>
      <PageHeader title="KYC completeness" subtitle="Customer document completion (KYC completeness): which customers still owe us documents, and which documents are missing, waiting, rejected or running out." />

      <div className="card mb-6 p-4">
        <label htmlFor="kyc-customer" className="mb-1 block text-sm font-medium text-slate-700">
          Check one customer
        </label>
        <CustomerPicker id="kyc-customer" value="" onChange={(code) => code && navigate(`/kyc/${code}`)} />
        <p className="mt-1 text-xs text-slate-500">Pick a customer to see their completeness percentage and every requirement.</p>
      </div>

      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data && <Spinner label="Calculating from stored records…" />}

      {summary && (
        <>
          <div className="mb-2 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {TILES.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => update({ type: type === t.type ? '' : t.type, page: '' })}
                className={`card border-l-4 ${t.accent} p-5 text-left transition hover:shadow-md ${type === t.type ? 'ring-2 ring-brand-600' : ''}`}
                aria-pressed={type === t.type}
              >
                <div className="text-sm text-slate-500">{EXCEPTION_LABELS[t.type]}</div>
                <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{summary.byType[t.type].toLocaleString('en-IN')}</div>
              </button>
            ))}
          </div>
          <p className="mb-6 text-sm text-slate-500">
            {summary.customersWithExceptions} of {summary.customersChecked} customers have at least one exception. {summary.submittedNotVerified} submitted documents are not verified. One exception is shown per customer and document type,
            based on the best document submitted.
          </p>
        </>
      )}

      <div className="card">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <input className="input lg:col-span-2" type="search" placeholder="Search by customer name or ID" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search exceptions" />
          <select className="input" value={customerType} onChange={(e) => update({ customerType: e.target.value, page: '' })} aria-label="Filter by customer type">
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

        {!loading || data ? (
          <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Issue</th>
                  <th className="px-4 py-3">Document</th>
                  <th className="px-4 py-3">Expiry</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((e) => (
                  <tr key={`${e.customerId}-${e.type}-${e.documentType}`} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link to={`/kyc/${e.customerId}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">
                        {e.customerId}
                      </Link>
                      <div className="text-slate-900">{e.customerName}</div>
                      <div className="mt-1 flex gap-1.5">
                        <TypeBadge type={e.customerType} />
                        <RiskBadge level={e.riskLevel} />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <ExceptionBadge type={e.type} />
                      <div className="mt-1 max-w-xs text-xs text-slate-500">{e.message}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{e.documentType}</div>
                      {!e.isMandatory && <div className="text-xs text-slate-500">optional</div>}
                    </td>
                    <td className="px-4 py-3">{e.documentId ? <ExpiryBadge state={e.expiryState} days={e.daysToExpiry} /> : <span className="text-slate-400">—</span>}</td>
                    <td className="px-4 py-3 text-right">
                      {e.documentId ? (
                        <Link to={e.type === 'PENDING_VERIFICATION' ? `/documents/${e.documentId}/review` : `/documents/${e.documentId}`} className="font-medium text-brand-700 hover:underline">
                          {e.type === 'PENDING_VERIFICATION' ? 'Review' : 'Open document'}
                        </Link>
                      ) : (
                        <Link to={`/documents/new?customer=${e.customerId}&type=${encodeURIComponent(e.documentType)}`} className="font-medium text-brand-700 hover:underline">
                          Add document
                        </Link>
                      )}
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-slate-500">
                      No exceptions match. {summary?.totalExceptions === 0 && 'Every checked customer is up to date.'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        ) : null}
        {data && data.pagination.totalItems > 0 && <Pagination pagination={data.pagination} onPage={(p) => update({ page: p > 1 ? String(p) : '' })} />}
      </div>
    </>
  );
}
