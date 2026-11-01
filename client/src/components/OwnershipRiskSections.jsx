import { Link } from 'react-router-dom';
import { getRiskSummary, listBeneficialOwners } from '../services/ownershipApi';
import useAsync from '../hooks/useAsync';
import { ErrorBanner, RiskBadge, Spinner } from './ui';
import { AssessedBy, LevelChange, ManualReviewReasons, OverallResult, OwnershipBar, OwnershipStatusBadge, ReasonsTable, ScreeningBadge } from './riskUi';

/** "Ownership" section of the customer profile (company customers only). */
export function OwnershipSection({ customerId }) {
  const { data, loading, error, reload } = useAsync(() => listBeneficialOwners(customerId), [customerId]);
  const v = data?.validation;

  return (
    <section className="card p-5 sm:p-6" aria-labelledby="profile-ownership">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="profile-ownership" className="text-base font-semibold">Beneficial ownership</h2>
          {v && <OwnershipStatusBadge status={v.status} />}
        </div>
        <div className="flex flex-wrap gap-3 text-sm">
          <Link to={`/ownership/${customerId}`} className="font-medium text-brand-700 hover:underline">Manage ownership</Link>
          <Link to={`/ownership/owners/new?customer=${customerId}`} className="btn btn-primary !py-1">+ Add owner</Link>
        </div>
      </div>
      {loading && !data && <Spinner label="Loading owners…" />}
      <ErrorBanner error={error} onRetry={reload} />
      {data && (
        <>
          <p className="mb-3 text-sm text-slate-600">{v.message}</p>
          <p className="mb-3 text-sm text-slate-600">
            Total ownership: <strong className="tabular-nums">{v.ownerCount === 0 ? '—' : `${v.totalPercentage}%`}</strong> from <strong>{v.ownerCount}</strong> owner{v.ownerCount === 1 ? '' : 's'}.
          </p>
          {data.owners.length > 0 && <div className="mb-4"><OwnershipBar owners={data.owners} total={v.totalPercentage} /></div>}
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-2.5">Owner</th><th className="px-4 py-2.5 text-right">Ownership</th><th className="px-4 py-2.5">Type</th><th className="px-4 py-2.5">Owner risk</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.owners.map((o) => (
                  <tr key={o.id}>
                    <td className="px-4 py-2.5"><Link to={`/ownership/owners/${o.id}`} className="font-medium text-brand-700 hover:underline">{o.fullName}</Link></td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{o.ownershipPercentage == null ? <span className="text-orange-700">missing</span> : `${o.ownershipPercentage}%`}</td>
                    <td className="px-4 py-2.5 text-slate-600">{o.ownershipType}</td>
                    <td className="px-4 py-2.5"><RiskBadge level={o.risk.level} /></td>
                  </tr>
                ))}
                {data.owners.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500">No beneficial owners recorded yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/** "Risk" section of the customer profile: current risk, reasons, owner screening outcomes and earlier assessments. */
export function RiskSection({ customerId }) {
  const { data: s, loading, error, reload } = useAsync(() => getRiskSummary(customerId), [customerId]);
  const cur = s?.customerRisk.current;

  return (
    <section className="card p-5 sm:p-6" aria-labelledby="profile-risk">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h2 id="profile-risk" className="text-base font-semibold">Risk and ownership assessment</h2>
        <Link to={`/risk/${customerId}`} className="font-medium text-brand-700 hover:underline text-sm">Customer risk summary</Link>
      </div>
      {loading && !s && <Spinner label="Calculating risk…" />}
      <ErrorBanner error={error} onRetry={reload} />
      {s && cur && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-4">
            <div className="text-4xl font-semibold tabular-nums">{cur.riskScore}<span className="text-base font-normal text-slate-400"> / 100</span></div>
            <OverallResult level={cur.riskLevel} status={cur.status} />
            <p className="text-xs text-slate-500">{cur.assessmentId} · <AssessedBy person={cur.assessedBy} date={cur.assessmentDate} /></p>
          </div>
          {s.customerRisk.reassessmentRecommended && (
            <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-sm text-amber-900">
              Reassessment recommended: a new assessment would give {s.customerRisk.wouldBe.riskScore} ({s.customerRisk.wouldBe.overallResult}).
            </p>
          )}
          <ManualReviewReasons items={cur.manualReviewReasons} />
          <div>
            <h3 className="mb-2 text-sm font-medium text-slate-700">Risk reasons</h3>
            <ReasonsTable reasons={cur.reasons} />
          </div>

          {s.ownershipValidation.applicable && s.ownershipValidation.owners.length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-slate-700">Owner screening outcomes</h3>
              <ul className="divide-y divide-slate-100 text-sm">
                {s.ownershipValidation.owners.map((o) => (
                  <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <Link to={`/ownership/owners/${o.id}`} className="font-medium text-brand-700 hover:underline">{o.fullName}</Link>
                    <RiskBadge level={o.riskLevel} />
                    <ScreeningBadge label="PEP" outcome={o.screening.pep} />
                    <ScreeningBadge label="Sanctions" outcome={o.screening.sanctions} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <h3 className="mb-2 text-sm font-medium text-slate-700">Previous assessments</h3>
            <ul className="divide-y divide-slate-100 text-sm">
              {s.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                  <span className="font-mono text-xs font-medium text-slate-700">{h.assessmentId}</span>
                  <LevelChange previous={h.previousRiskLevel} next={h.riskLevel} />
                  <span className="tabular-nums text-slate-600">score {h.riskScore}</span>
                  <AssessedBy person={h.assessedBy} date={h.assessmentDate} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
