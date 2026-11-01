import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { listDocuments, getDocumentTypes } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import useDebounce from '../hooks/useDebounce';
import { ErrorBanner, PageHeader, Pagination, Spinner } from '../components/ui';
import { ExpiryBadge, NameMismatchBadge, StatusBadge } from '../components/kycUi';
import { formatDate } from '../utils/format';

const PAGE_SIZE = 10;
const STATUSES = ['Pending', 'In Review', 'Verified', 'Rejected', 'Requires Resubmission'];
const EXPIRY = ['Valid', 'Expiring Soon', 'Expired', 'No Expiry'];

/**
 * Documents list. Search (customer ID/name or document type) and filters live in the URL, like the
 * customer directory, so filtered views can be bookmarked and the Back button works.
 */
export default function DocumentsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || '';
  const expiry = params.get('expiry') || '';
  const documentType = params.get('documentType') || '';
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

  const types = useAsync(getDocumentTypes, []);
  const { data, loading, error, reload } = useAsync(
    () => listDocuments({ page, pageSize: PAGE_SIZE, search: urlSearch, status, expiry, documentType, customerId }),
    [page, urlSearch, status, expiry, documentType, customerId]
  );
  const rows = data?.data ?? [];
  const hasFilters = Boolean(urlSearch || status || expiry || documentType || customerId);

  return (
    <>
      <PageHeader title="Documents" subtitle="Every document customers have sent us, and whether a reviewer has checked it yet (verification status).">
        <Link to={`/documents/new${customerId ? `?customer=${customerId}` : ''}`} className="btn btn-primary">
          + Add Document
        </Link>
      </PageHeader>

      <div className="card">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <input
            className="input lg:col-span-4"
            type="search"
            placeholder="Search by customer ID, customer name or document type"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            aria-label="Search documents"
          />
          <select className="input" value={status} onChange={(e) => update({ status: e.target.value, page: '' })} aria-label="Filter by verification status">
            <option value="">All statuses</option>
            {STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select className="input" value={expiry} onChange={(e) => update({ expiry: e.target.value, page: '' })} aria-label="Filter by expiry">
            <option value="">Any expiry</option>
            {EXPIRY.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <select className="input" value={documentType} onChange={(e) => update({ documentType: e.target.value, page: '' })} aria-label="Filter by document type">
            <option value="">All document types</option>
            {(types.data ?? []).map((t) => (
              <option key={t.name}>{t.name}</option>
            ))}
          </select>
          {hasFilters ? (
            <button type="button" className="btn btn-secondary" onClick={() => { setSearchText(''); setParams({}, { replace: true }); }}>
              Clear filters
            </button>
          ) : (
            <span />
          )}
        </div>
        {customerId && <p className="px-4 pb-3 text-sm text-slate-600">Showing documents for customer <span className="font-mono">{customerId}</span>.</p>}

        <ErrorBanner error={error} onRetry={reload} />

        {loading && !data ? (
          <Spinner label="Loading documents…" />
        ) : (
          <div className={`overflow-x-auto transition-opacity ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Document</th>
                  <th className="px-4 py-3">Issued</th>
                  <th className="px-4 py-3">Expiry</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <Link to={`/customers/${d.customer.customerId}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">
                        {d.customer.customerId}
                      </Link>
                      <div className="text-slate-900">{d.customer.name}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{d.documentType}</div>
                      <div className="font-mono text-xs text-slate-500">{d.documentNumberMasked || 'no number'}</div>
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(d.issueDate)}</td>
                    <td className="px-4 py-3">
                      <div className="whitespace-nowrap text-slate-600">{d.expiryDate ? formatDate(d.expiryDate) : '—'}</div>
                      <ExpiryBadge state={d.expiryState} days={d.daysToExpiry} />
                    </td>
                    <td className="px-4 py-3">
                      <StatusBadge status={d.status} />
                      {d.effectiveStatus === 'Expired' && d.status !== 'Expired' && (
                        <div className="mt-1">
                          <StatusBadge status="Expired" />
                        </div>
                      )}
                      {d.nameCheck?.status === 'Mismatch' && <div className="mt-1"><NameMismatchBadge check={d.nameCheck} /></div>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(d.submissionDate)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/documents/${d.id}`} className="font-medium text-brand-700 hover:underline">
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                      {hasFilters ? 'No documents match your search or filters.' : 'No documents yet. Add the first one, or load samples with npm run generate:kyc.'}
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
