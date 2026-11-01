import { Link, useSearchParams } from 'react-router-dom';
import { listDocuments } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { ErrorBanner, PageHeader, Pagination, Spinner } from '../components/ui';
import { ExpiryBadge, StatusBadge } from '../components/kycUi';
import { formatDate } from '../utils/format';

const TABS = [
  { status: 'Pending', label: 'Pending' },
  { status: 'In Review', label: 'In Review' },
  { status: 'Requires Resubmission', label: 'Needs resubmission' },
  { status: 'Rejected', label: 'Rejected' },
];

/** The reviewer's work queue: documents waiting for a decision (and ones sent back or rejected). */
export default function VerificationQueuePage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'Pending';
  const page = Number(params.get('page') || 1);
  const { current } = useReviewer();

  const { data, loading, error, reload } = useAsync(() => listDocuments({ status, page, pageSize: 10 }), [status, page]);
  const rows = data?.data ?? [];

  const go = (next) => setParams(next, { replace: true });

  return (
    <>
      <PageHeader title="Verification review" subtitle="Open a document to check it and record whether it is accepted (verification review)." />

      {!current && (
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Choose who you are acting as (<strong>Acting as</strong> in the sidebar) before recording decisions. You can still look at documents without choosing.
        </div>
      )}

      <div className="card">
        <div className="flex flex-wrap gap-2 border-b border-slate-200 p-3" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.status}
              role="tab"
              aria-selected={status === t.status}
              onClick={() => go({ status: t.status })}
              className={`rounded-full px-3.5 py-1.5 text-sm font-medium transition ${status === t.status ? 'bg-brand-700 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? (
          <Spinner label="Loading queue…" />
        ) : (
          <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Document</th>
                  <th className="px-4 py-3">Submitted</th>
                  <th className="px-4 py-3">Expiry</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs text-brand-700">{d.customer.customerId}</span>
                      <div className="text-slate-900">{d.customer.name}</div>
                    </td>
                    <td className="px-4 py-3 font-medium text-slate-900">{d.documentType}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(d.submissionDate)}</td>
                    <td className="px-4 py-3"><ExpiryBadge state={d.expiryState} days={d.daysToExpiry} /></td>
                    <td className="px-4 py-3"><StatusBadge status={d.status} /></td>
                    <td className="px-4 py-3 text-right">
                      <Link to={`/documents/${d.id}/review`} className="btn btn-primary !py-1">
                        Review
                      </Link>
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-slate-500">
                      Nothing in “{TABS.find((t) => t.status === status)?.label}”.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pagination.totalItems > 0 && <Pagination pagination={data.pagination} onPage={(p) => go({ status, ...(p > 1 ? { page: String(p) } : {}) })} />}
      </div>
    </>
  );
}
