import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { createRiskAssessment, getRiskSummary } from '../services/ownershipApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, PageHeader, RiskBadge, Spinner, TypeBadge } from '../components/ui';
import { CompletenessBadge } from '../components/kycUi';
import { AssessedBy, LevelChange, ManualReviewReasons, OverallResult, OwnershipStatusBadge, ReasonsTable, ScoreComponents, ScreeningBadge } from '../components/riskUi';

/**
 * Customer Risk Summary. Three DIFFERENT questions are answered in three separate cards:
 *   Customer risk         what is this customer's risk level?
 *   Ownership validation  is the ownership structure reconciled? (companies only)
 *   KYC completeness      are the required documents present and valid?
 * A customer can be 100% KYC complete and still High risk, or Low risk with missing documents.
 */
export default function CustomerRiskPage() {
  const { customerId } = useParams();
  const toast = useToast();
  const { current: person } = useReviewer();
  const { data: s, loading, error, reload } = useAsync(() => getRiskSummary(customerId), [customerId]);

  const [remarks, setRemarks] = useState('');
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState(null);
  const canDecide = Boolean(person?.canDecide);

  async function run(force = false) {
    setRunning(true);
    setNotice(null);
    try {
      const a = await createRiskAssessment(customerId, { remarks: remarks.trim(), force });
      toast.success(`Assessment ${a.assessmentId} recorded: ${a.overallResult}.`);
      setRemarks('');
      reload();
    } catch (err) {
      if (err.code === 'NO_CHANGE') setNotice({ message: err.message, canForce: true });
      else setNotice({ message: err.message, canForce: false, error: true });
    } finally {
      setRunning(false);
    }
  }

  const cur = s?.customerRisk.current;
  const preview = s?.customerRisk.wouldBe;
  const delta = cur && preview ? preview.riskScore - cur.riskScore : 0;

  return (
    <>
      <PageHeader title={s ? s.customer.name : 'Customer risk summary'} subtitle={`Customer ${customerId}`}>
        <div className="flex flex-wrap gap-2">
          <Link to={`/customers/${customerId}`} className="btn btn-secondary">Customer profile</Link>
          {s?.customer.customerType === 'Company' && <Link to={`/ownership/${customerId}`} className="btn btn-secondary">Ownership</Link>}
          <Link to={`/risk-history?customerId=${customerId}`} className="btn btn-secondary">Risk history</Link>
        </div>
      </PageHeader>

      {loading && !s && <Spinner label="Calculating from stored records…" />}
      <ErrorBanner error={error} onRetry={error?.status === 404 ? undefined : reload} />

      {s && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2"><TypeBadge type={s.customer.customerType} /></div>
          <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600">{s.separation}</p>

          {s.customerRisk.reassessmentRecommended && (
            <div role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <strong>Reassessment recommended.</strong> Ownership, screening or customer data has changed since {cur?.assessmentId}. A new assessment would give <strong>{preview.riskScore}</strong> ({preview.overallResult})
              {cur && delta !== 0 ? `, ${delta > 0 ? '+' : ''}${delta} compared with the current ${cur.riskScore}` : ''}.
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            {/* 1. Customer risk (headline) */}
            <section className="card p-5" aria-labelledby="risk-card">
              <h2 id="risk-card" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">1. Customer risk</h2>
              {cur ? (
                <>
                  <div className="text-4xl font-semibold tabular-nums">{cur.riskScore}<span className="text-base font-normal text-slate-400"> / 100</span></div>
                  <div className="mt-2"><OverallResult level={cur.riskLevel} status={cur.status} /></div>
                  <p className="mt-2 text-xs text-slate-500">{cur.assessmentId} · <AssessedBy person={cur.assessedBy} date={cur.assessmentDate} /></p>
                </>
              ) : (
                <p className="text-sm text-slate-500">No assessment recorded.</p>
              )}
            </section>

            {/* 2. Ownership validation */}
            <section className="card p-5" aria-labelledby="own-card">
              <h2 id="own-card" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">2. Ownership validation</h2>
              {s.ownershipValidation.applicable ? (
                <>
                  <OwnershipStatusBadge status={s.ownershipValidation.status} />
                  <div className="mt-2 text-2xl font-semibold tabular-nums">{s.ownershipValidation.ownerCount === 0 ? '—' : `${s.ownershipValidation.totalPercentage}%`}</div>
                  <p className="mt-1 text-xs text-slate-600">{s.ownershipValidation.message}</p>
                  <Link to={`/ownership/${customerId}`} className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">Manage ownership</Link>
                </>
              ) : (
                <p className="text-sm text-slate-500">{s.ownershipValidation.message}</p>
              )}
            </section>

            {/* 3. KYC completeness */}
            <section className="card p-5" aria-labelledby="kyc-card">
              <h2 id="kyc-card" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">3. KYC completeness</h2>
              {s.kycCompleteness ? (
                <>
                  <div className="text-4xl font-semibold tabular-nums">{s.kycCompleteness.percentage === null ? '—' : `${s.kycCompleteness.percentage}%`}</div>
                  <div className="mt-2"><CompletenessBadge status={s.kycCompleteness.status} /></div>
                  <p className="mt-2 text-xs text-slate-500">{s.kycCompleteness.totals.verified} of {s.kycCompleteness.totals.mandatory} mandatory documents verified. Not used in the risk score.</p>
                  <Link to={`/kyc/${customerId}`} className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">Open KYC completeness</Link>
                </>
              ) : (
                <p className="text-sm text-slate-500">Not available.</p>
              )}
            </section>
          </div>

          {/* Current assessment reasons */}
          {cur && (
            <section className="card p-5 sm:p-6">
              <h2 className="mb-1 text-base font-semibold">Why the customer is {cur.overallResult}</h2>
              <p className="mb-4 text-xs text-slate-500">Assessment {cur.assessmentId}. Prototype rules ({cur.method}), not regulatory standards.</p>
              <div className="space-y-4">
                <ManualReviewReasons items={cur.manualReviewReasons} />
                <ReasonsTable reasons={cur.reasons} />
                {cur.components && <div><h3 className="mb-1 text-sm font-medium text-slate-700">How the score was built</h3><ScoreComponents components={cur.components} /></div>}
                {cur.ownerBreakdown.length > 0 && (
                  <div>
                    <h3 className="mb-2 text-sm font-medium text-slate-700">Beneficial owners at the time</h3>
                    <ul className="divide-y divide-slate-100 text-sm">
                      {cur.ownerBreakdown.map((o) => (
                        <li key={o.ownerId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                          <Link to={`/ownership/owners/${o.ownerId}`} className="font-medium text-brand-700 hover:underline">{o.name}</Link>
                          <span className="tabular-nums text-slate-500">{o.ownershipPercentage == null ? 'no %' : `${o.ownershipPercentage}%`}</span>
                          <RiskBadge level={o.level} /><span className="text-xs text-slate-500">{o.points} pts</span>
                          <ScreeningBadge label="PEP" outcome={o.screening.pep} /><ScreeningBadge label="Sanctions" outcome={o.screening.sanctions} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </section>
          )}

          {/* New assessment */}
          <section className="card p-5 sm:p-6">
            <h2 className="mb-1 text-base font-semibold">Run a new assessment</h2>
            <p className="mb-3 text-sm text-slate-600">
              If assessed now: <strong className="tabular-nums">{preview.riskScore}</strong> <OverallResult level={preview.riskLevel} status={preview.status} />. Recording adds a new record to the history. Earlier assessments are never changed.
            </p>
            {!person && <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900">Choose who you are acting as in the sidebar.</p>}
            {person && !canDecide && <p role="alert" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900">{person.name} ({person.role}) cannot run risk assessments. Choose a Reviewer or Admin.</p>}
            {notice && (
              <div role="alert" className={`mb-3 rounded-lg border p-2.5 text-sm ${notice.error ? 'border-red-200 bg-red-50 text-red-800' : 'border-sky-200 bg-sky-50 text-sky-900'}`}>
                {notice.message}{' '}
                {notice.canForce && <button type="button" className="font-medium underline" onClick={() => run(true)}>Record it anyway</button>}
              </div>
            )}
            <div className="flex flex-wrap items-end gap-3">
              <label className="min-w-0 flex-1 basis-64 text-sm">
                <span className="mb-1 block font-medium text-slate-700">Note (optional)</span>
                <input className="input" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} disabled={!canDecide || running} placeholder="Why is this assessment being run?" />
              </label>
              <button type="button" className="btn btn-primary" onClick={() => run(false)} disabled={!canDecide || running}>
                {running ? 'Assessing…' : 'Run assessment'}
              </button>
            </div>
          </section>

          {/* History */}
          <section className="card p-5 sm:p-6">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold">Recent assessments</h2>
              <Link to={`/risk-history?customerId=${customerId}`} className="text-sm font-medium text-brand-700 hover:underline">Full history</Link>
            </div>
            <ul className="divide-y divide-slate-100 text-sm">
              {s.history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                  <span className="font-mono text-xs font-medium text-slate-700">{h.assessmentId}</span>
                  <LevelChange previous={h.previousRiskLevel} next={h.riskLevel} />
                  <span className="tabular-nums text-slate-600">score {h.riskScore}</span>
                  {h.status === 'Requires Manual Review' && <span className="text-xs font-medium text-violet-700">manual review</span>}
                  <AssessedBy person={h.assessedBy} date={h.assessmentDate} />
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </>
  );
}
