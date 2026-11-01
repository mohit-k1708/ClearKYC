import { Link, useLocation, useParams } from 'react-router-dom';
import { getCustomer } from '../services/api';
import useAsync from '../hooks/useAsync';
import { ErrorBanner, PageHeader, RiskBadge, Spinner, StatusBadge, TypeBadge } from '../components/ui';
import { formatDate, formatDateTime } from '../utils/format';
import DocumentsKycSection from '../components/DocumentsKycSection';
import { OwnershipSection, RiskSection } from '../components/OwnershipRiskSections';
import CustomerReviewSection from '../components/CustomerReviewSection';
import OnboardingDecisionSection from '../components/OnboardingDecisionSection';

function Detail({ label, children, mono }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 break-words text-sm text-slate-900 ${mono ? 'font-mono' : ''}`}>{children || '—'}</dd>
    </div>
  );
}

function RiskPanel({ risk, history }) {
  if (!risk) return <p className="text-sm text-slate-500">No risk assessment recorded.</p>;
  const { thresholds, screening } = risk;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-4">
        <div className="text-4xl font-semibold tabular-nums text-slate-900">{risk.score}<span className="text-base font-normal text-slate-400"> / 100</span></div>
        <RiskBadge level={risk.level} />
        <div className="text-xs text-slate-500">
          Method <span className="font-mono">{risk.method}</span> · assessed {formatDateTime(risk.assessedAt)}
        </div>
      </div>

      {risk.requiresManualReview && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          <strong>Flagged for manual review.</strong> A simulated screening check produced a potential match. This is not a rejection: the customer remains registered pending review.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="py-2 pr-4">Factor</th><th className="py-2 pr-4">Reason</th><th className="py-2 text-right">Points</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {risk.reasons.map((r, i) => (
              <tr key={i}>
                <td className="py-2 pr-4 align-top font-medium">
                  {r.factor}
                  {r.simulated && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Simulated</span>}
                </td>
                <td className="py-2 pr-4 text-slate-600">{r.description}</td>
                <td className="py-2 text-right tabular-nums">+{r.points}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid gap-3 text-sm sm:grid-cols-2">
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">PEP screening (simulated)</div>
          <div className="mt-1">{screening?.pep.potentialMatch ? `Potential match: ${screening.pep.basis}` : 'No potential match'}</div>
        </div>
        <div className="rounded-lg bg-slate-50 p-3">
          <div className="text-xs uppercase tracking-wide text-slate-500">Sanctions screening (simulated)</div>
          <div className="mt-1">{screening?.sanctions.potentialMatch ? `Potential match: ${screening.sanctions.basis}` : 'No potential match'}</div>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-slate-500">
        Thresholds (prototype assumption, not an official regulatory rule): Low below {thresholds.mediumFrom}, Medium {thresholds.mediumFrom}–{thresholds.highFrom - 1}, High {thresholds.highFrom}+.{' '}
        {screening?.note} Risk rating is separate from KYC completeness, which is not part of this scene.
      </p>

      {history.length > 0 && (
        <div>
          <h3 className="mb-1 text-sm font-medium text-slate-700">Earlier assessments</h3>
          <ul className="text-sm text-slate-600">
            {history.map((h, i) => <li key={i}>{formatDateTime(h.assessedAt)} — {h.level} ({h.score})</li>)}
          </ul>
        </div>
      )}
    </div>
  );
}

export default function CustomerProfilePage() {
  const { id } = useParams();
  const justRegistered = useLocation().state?.justRegistered;
  const { data: c, loading, error, reload } = useAsync(() => getCustomer(id), [id]);

  return (
    <>
      <PageHeader title={c ? c.name : 'Customer profile'} subtitle={c ? `Customer ID ${c.customerId}` : id}>
        <Link to="/customers" className="btn btn-secondary">← Back to customers</Link>
      </PageHeader>

      {loading && <Spinner label="Loading profile…" />}
      <ErrorBanner error={error} onRetry={error?.status === 404 ? undefined : reload} />

      {c && (
        <div className="space-y-6">
          {justRegistered && (
            <div className="rounded-lg border border-emerald-300 bg-emerald-50 px-4 py-3 text-sm text-emerald-900">
              Registration complete. The generated Customer ID is <strong className="font-mono">{c.customerId}</strong>.
            </div>
          )}

          <section className="card p-5 sm:p-6">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold">Customer details</h2>
              <TypeBadge type={c.customerType} />
              <StatusBadge status={c.registrationStatus} />
            </div>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
              <Detail label="Customer ID" mono>{c.customerId}</Detail>
              <Detail label={c.customerType === 'Company' ? 'Legal company name' : 'Full name'}>{c.name}</Detail>
              <Detail label="Country">{c.countryName}</Detail>
              <Detail label="Email">{c.email}</Detail>
              <Detail label="Phone">{c.phone}</Detail>
              <Detail label={c.customerType === 'Company' ? 'Registered office address' : 'Residential address'}>{c.address}</Detail>
              <Detail label={c.customerType === 'Company' ? 'Business PAN (masked)' : 'PAN (masked)'} mono>{c.panMasked}</Detail>
              {c.customerType === 'Individual' ? (
                <>
                  <Detail label="Aadhaar (masked)" mono>{c.aadhaarMasked}</Detail>
                  <Detail label="Date of birth">{formatDate(c.dateOfBirth)}</Detail>
                  <Detail label="Occupation">{c.occupation}</Detail>
                </>
              ) : (
                <>
                  <Detail label="Registration number" mono>{c.companyRegistrationNumber}</Detail>
                  <Detail label="Business activity">{c.businessActivity}</Detail>
                  <Detail label="Date of incorporation">{formatDate(c.dateOfIncorporation)}</Detail>
                </>
              )}
              <Detail label="Registered on">{formatDateTime(c.createdAt)}</Detail>
              <Detail label="Last updated">{formatDateTime(c.updatedAt)}</Detail>
            </dl>
          </section>

          <section className="card p-5 sm:p-6">
            <h2 className="mb-4 text-base font-semibold">Initial risk assessment</h2>
            <RiskPanel risk={c.currentRisk} history={c.riskHistory} />
          </section>

          {/* Scene 3 */}
          {c.customerType === 'Company' && <OwnershipSection customerId={c.customerId} />}
          <RiskSection customerId={c.customerId} />

          {/* Scene 2 */}
          <DocumentsKycSection customerId={c.customerId} />

          {/* Scene 4 */}
          <CustomerReviewSection customerId={c.customerId} />

          {/* Phase 6: approve or reject onboarding */}
          <OnboardingDecisionSection customerId={c.customerId} />
        </div>
      )}
    </>
  );
}
