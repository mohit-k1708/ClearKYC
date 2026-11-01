import { Link, useParams } from 'react-router-dom';
import { getCompleteness, listCustomerDocuments } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import { ErrorBanner, PageHeader, RiskBadge, Spinner, TypeBadge } from '../components/ui';
import KycPanel from '../components/KycPanel';
import { ExceptionBadge, ExpiryBadge, StatusBadge } from '../components/kycUi';
import { formatDate } from '../utils/format';

/** KYC completeness for one customer: percentage, counters, every requirement, and their documents. */
export default function CustomerKycPage() {
  const { customerId } = useParams();
  const kyc = useAsync(() => getCompleteness(customerId), [customerId]);
  const docs = useAsync(() => listCustomerDocuments(customerId), [customerId]);
  const k = kyc.data;

  return (
    <>
      <PageHeader title={k ? k.customer.name : 'KYC completeness'} subtitle={`Customer ${customerId}`}>
        <div className="flex flex-wrap gap-2">
          <Link to="/kyc" className="btn btn-secondary">
            ← KYC completeness
          </Link>
          <Link to={`/customers/${customerId}`} className="btn btn-secondary">
            Customer profile
          </Link>
          <Link to={`/documents/new?customer=${customerId}`} className="btn btn-primary">
            + Add Document
          </Link>
        </div>
      </PageHeader>

      {kyc.loading && !k && <Spinner label="Calculating completeness…" />}
      <ErrorBanner error={kyc.error} onRetry={kyc.error?.status === 404 ? undefined : kyc.reload} />

      {k && (
        <div className="space-y-6">
          <section className="card p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <TypeBadge type={k.customer.customerType} />
              <RiskBadge level={k.customer.riskLevel} />
            </div>
            <KycPanel kyc={k} />
          </section>

          {k.exceptions.length > 0 && (
            <section className="card p-5 sm:p-6">
              <h2 className="mb-3 text-base font-semibold">Needs attention</h2>
              <ul className="divide-y divide-slate-100">
                {k.exceptions.map((e) => (
                  <li key={`${e.type}-${e.documentType}`} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                    <span className="flex flex-wrap items-center gap-2">
                      <ExceptionBadge type={e.type} />
                      <span className="font-medium text-slate-900">{e.documentType}</span>
                      <span className="text-slate-500">{e.message}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="card p-5 sm:p-6">
            <h2 className="mb-3 text-base font-semibold">All documents</h2>
            {docs.loading && !docs.data ? (
              <Spinner label="Loading documents…" />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="py-2 pr-4">Document</th>
                      <th className="py-2 pr-4">Submitted</th>
                      <th className="py-2 pr-4">Expiry</th>
                      <th className="py-2 pr-4">Status</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {(docs.data?.items ?? []).map((d) => (
                      <tr key={d.id}>
                        <td className="py-2 pr-4 font-medium text-slate-900">{d.documentType}</td>
                        <td className="py-2 pr-4 text-slate-600">{formatDate(d.submissionDate)}</td>
                        <td className="py-2 pr-4"><ExpiryBadge state={d.expiryState} days={d.daysToExpiry} /></td>
                        <td className="py-2 pr-4"><StatusBadge status={d.effectiveStatus === 'Expired' ? 'Expired' : d.status} /></td>
                        <td className="py-2 text-right">
                          <Link to={`/documents/${d.id}`} className="font-medium text-brand-700 hover:underline">View</Link>
                        </td>
                      </tr>
                    ))}
                    {docs.data && docs.data.items.length === 0 && (
                      <tr>
                        <td colSpan={5} className="py-6 text-center text-slate-500">No documents submitted yet.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>
      )}
    </>
  );
}
