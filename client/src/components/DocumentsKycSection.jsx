import { Link } from 'react-router-dom';
import { getCompleteness, listCustomerDocuments } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import { ErrorBanner, Spinner } from './ui';
import KycPanel from './KycPanel';
import { ExpiryBadge, NameMismatchBadge, StatusBadge } from './kycUi';
import { formatDate } from '../utils/format';

/**
 * "Documents & KYC" section for the Scene 1 customer profile: required documents with their states,
 * the submitted documents, and the server-calculated completeness percentage.
 */
export default function DocumentsKycSection({ customerId }) {
  const kyc = useAsync(() => getCompleteness(customerId), [customerId]);
  const docs = useAsync(() => listCustomerDocuments(customerId), [customerId]);

  return (
    <section className="card p-5 sm:p-6" aria-labelledby="docs-kyc-heading">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id="docs-kyc-heading" className="text-base font-semibold">
          Documents &amp; KYC
        </h2>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link to={`/kyc/${customerId}`} className="font-medium text-brand-700 hover:underline">
            Full KYC view
          </Link>
          <Link to={`/documents/new?customer=${customerId}`} className="btn btn-primary !py-1">
            + Add Document
          </Link>
        </div>
      </div>

      {kyc.loading && !kyc.data && <Spinner label="Calculating KYC completeness…" />}
      <ErrorBanner error={kyc.error} onRetry={kyc.reload} />
      {kyc.data && <KycPanel kyc={kyc.data} />}

      <h3 className="mb-2 mt-8 text-sm font-medium text-slate-700">Submitted documents</h3>
      <ErrorBanner error={docs.error} onRetry={docs.reload} />
      {docs.data && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-2.5">Document</th>
                <th className="px-4 py-2.5">Submitted</th>
                <th className="px-4 py-2.5">Expiry</th>
                <th className="px-4 py-2.5">Verification</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {docs.data.items.map((d) => (
                <tr key={d.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-900">{d.documentType}</td>
                  <td className="px-4 py-2.5 text-slate-600">{formatDate(d.submissionDate)}</td>
                  <td className="px-4 py-2.5"><ExpiryBadge state={d.expiryState} days={d.daysToExpiry} /></td>
                  <td className="px-4 py-2.5">
                    <StatusBadge status={d.status} />
                    {d.effectiveStatus === 'Expired' && d.status !== 'Expired' && <span className="ml-1.5"><StatusBadge status="Expired" /></span>}
                    {d.nameCheck?.status === 'Mismatch' && <span className="ml-1.5"><NameMismatchBadge check={d.nameCheck} /></span>}
                  </td>
                  <td className="px-4 py-2.5 text-right">
                    <Link to={`/documents/${d.id}`} className="font-medium text-brand-700 hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
              {docs.data.items.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                    No documents submitted yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
