import { Link } from 'react-router-dom';
import { CompletenessBadge, ExpiryBadge, StatusBadge } from './kycUi';

const COUNTERS = [
  { key: 'mandatory', label: 'Mandatory documents', tone: 'text-slate-900' },
  { key: 'verified', label: 'Verified', tone: 'text-emerald-700' },
  { key: 'missing', label: 'Missing', tone: 'text-slate-700' },
  { key: 'pendingVerification', label: 'Pending verification', tone: 'text-sky-700' },
  { key: 'rejected', label: 'Rejected', tone: 'text-red-700' },
  { key: 'requiresResubmission', label: 'Needs resubmission', tone: 'text-orange-700' },
  { key: 'expired', label: 'Expired', tone: 'text-rose-800' },
];

/**
 * KYC completeness for one customer. Every number comes from the server (calculated from stored
 * records); nothing here is computed in the browser. Used on the KYC page and the customer profile.
 */
export default function KycPanel({ kyc }) {
  const { percentage, status, totals, requirements, extraDocuments, customer } = kyc;
  const barColor = status === 'Complete' ? 'bg-emerald-500' : status === 'Partially Complete' ? 'bg-amber-500' : 'bg-slate-300';

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
        <div>
          <div className="text-xs uppercase tracking-wide text-slate-500">KYC completeness</div>
          <div className="text-4xl font-semibold tabular-nums text-slate-900">{percentage === null ? '—' : `${percentage}%`}</div>
        </div>
        <CompletenessBadge status={status} />
        <p className="text-xs text-slate-500">
          {customer.customerType} · {customer.riskLevel} risk · calculated {kyc.asOf}
        </p>
      </div>

      <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={percentage ?? 0} aria-valuemin="0" aria-valuemax="100" aria-label="KYC completeness">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${percentage ?? 0}%` }} />
      </div>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {COUNTERS.map((c) => (
          <div key={c.key} className="rounded-lg bg-slate-50 px-3 py-2.5">
            <dt className="text-xs text-slate-500">{c.label}</dt>
            <dd className={`text-2xl font-semibold tabular-nums ${c.tone}`}>{totals[c.key]}</dd>
          </div>
        ))}
      </dl>
      {totals.expiringSoon > 0 && (
        <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {totals.expiringSoon} verified mandatory document{totals.expiringSoon > 1 ? 's' : ''} will expire within {kyc.expiryWarningDays} days. They still count as verified until the expiry date passes.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2.5">Required document</th>
              <th className="px-4 py-2.5">State</th>
              <th className="px-4 py-2.5">Expiry</th>
              <th className="px-4 py-2.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {requirements.map((r) => (
              <tr key={r.requirementId}>
                <td className="px-4 py-2.5 font-medium text-slate-900">
                  {r.documentType}
                  {!r.isMandatory && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-slate-600">Optional</span>}
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={r.state} />
                  {r.document && r.document.status !== r.state && r.state !== 'Pending Verification' && <span className="ml-2 text-xs text-slate-500">recorded as {r.document.status}</span>}
                </td>
                <td className="px-4 py-2.5">{r.document ? <ExpiryBadge state={r.document.expiryState} days={r.document.daysToExpiry} /> : <span className="text-slate-400">—</span>}</td>
                <td className="px-4 py-2.5 text-right">
                  {r.document ? (
                    <Link to={`/documents/${r.document.id}`} className="font-medium text-brand-700 hover:underline">
                      View
                    </Link>
                  ) : (
                    <Link to={`/documents/new?customer=${customer.customerId}&type=${encodeURIComponent(r.documentType)}`} className="font-medium text-brand-700 hover:underline">
                      Add document
                    </Link>
                  )}
                </td>
              </tr>
            ))}
            {requirements.length === 0 && (
              <tr>
                <td colSpan={4} className="px-4 py-8 text-center text-slate-500">
                  No KYC requirements apply to a {customer.customerType} customer with {customer.riskLevel} risk. Add some on the KYC Requirements page.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {extraDocuments.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-medium text-slate-700">Other submitted documents (not required for this customer)</h3>
          <ul className="text-sm text-slate-600">
            {extraDocuments.map((d) => (
              <li key={d.id}>
                <Link to={`/documents/${d.id}`} className="text-brand-700 hover:underline">
                  {d.documentType}
                </Link>{' '}
                <StatusBadge status={d.effectiveStatus} />
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs leading-relaxed text-slate-500">
        Completeness = verified mandatory documents ÷ total mandatory documents × 100. A document counts only when a reviewer marked it Verified <strong>and</strong> its expiry date has not passed. A
        Verified status is the result of a simulated manual review, not a government or identity-provider check.
      </p>
    </div>
  );
}
