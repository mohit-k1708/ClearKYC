import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getOwnershipValidation, listBeneficialOwners, recordOwnershipValidation } from '../services/ownershipApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, PageHeader, RiskBadge, Spinner } from '../components/ui';
import { OwnershipBar, OwnershipStatusBadge, ScreeningBadge } from '../components/riskUi';
import { formatDateTime } from '../utils/format';

const TONE = {
  RECONCILED: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  EXCEEDS_100: 'border-red-200 bg-red-50 text-red-900',
  BELOW_100: 'border-amber-200 bg-amber-50 text-amber-900',
  MISSING_PERCENTAGE: 'border-orange-200 bg-orange-50 text-orange-900',
  NO_OWNERS: 'border-slate-200 bg-slate-50 text-slate-800',
};

/** One company's ownership: validation message, ownership structure, owners, and recorded checks. */
export default function CompanyOwnershipPage() {
  const { customerId } = useParams();
  const toast = useToast();
  const { current: person } = useReviewer();
  const owners = useAsync(() => listBeneficialOwners(customerId), [customerId]);
  const validation = useAsync(() => getOwnershipValidation(customerId), [customerId]);
  const [recording, setRecording] = useState(false);

  const data = owners.data;
  const v = data?.validation;

  async function record() {
    setRecording(true);
    try {
      const r = await recordOwnershipValidation(customerId);
      toast.success(`Ownership check recorded: ${r.validationStatus.replace('_', ' ').toLowerCase()}.`);
      validation.reload();
      owners.reload();
    } catch (err) {
      toast.error(err.status === 401 ? 'Choose who you are acting as in the sidebar first.' : err.message);
    } finally {
      setRecording(false);
    }
  }

  return (
    <>
      <PageHeader title={data ? data.customer.name : 'Company ownership'} subtitle={`Company ${customerId}`}>
        <div className="flex flex-wrap gap-2">
          <Link to="/ownership" className="btn btn-secondary">← Ownership</Link>
          <Link to={`/risk/${customerId}`} className="btn btn-secondary">Risk summary</Link>
          <Link to={`/ownership/owners/new?customer=${customerId}`} className="btn btn-primary">+ Add owner</Link>
        </div>
      </PageHeader>

      {owners.loading && !data && <Spinner label="Loading ownership…" />}
      <ErrorBanner error={owners.error} onRetry={owners.error?.status === 404 || owners.error?.code === 'NOT_A_COMPANY' ? undefined : owners.reload} />

      {data && (
        <div className="space-y-6">
          {/* Ownership validation */}
          <section className="card p-5 sm:p-6" aria-labelledby="validation-heading">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="validation-heading" className="text-base font-semibold">Ownership validation</h2>
                <OwnershipStatusBadge status={v.status} />
              </div>
              <button type="button" className="btn btn-secondary !py-1" onClick={record} disabled={recording}>
                {recording ? 'Recording…' : 'Record ownership check'}
              </button>
            </div>
            <div role="status" className={`mb-4 rounded-lg border p-3 text-sm ${TONE[v.status]}`}>{v.message}</div>
            {v.issues.map((i) => (
              <p key={i.message} className="mb-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-sm text-amber-900">{i.message}</p>
            ))}
            {data.complexity.isComplex && (
              <p className="mb-4 rounded-lg border border-violet-200 bg-violet-50 p-2.5 text-sm text-violet-900">
                <strong>Complex ownership structure:</strong> {data.complexity.reasons.join('; ')}. This is reviewed manually.
              </p>
            )}
            <div className="mb-4 flex flex-wrap items-end gap-x-8 gap-y-2">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Total ownership</div>
                <div className="text-3xl font-semibold tabular-nums">{v.ownerCount === 0 ? '—' : `${v.totalPercentage}%`}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Owners</div>
                <div className="text-3xl font-semibold tabular-nums">{v.ownerCount}</div>
              </div>
              <p className="max-w-md text-xs text-slate-500">
                {v.lastRecorded ? <>Last recorded check: {formatDateTime(v.lastRecorded.checkedAt)} ({v.lastRecorded.validationStatus.replace('_', ' ').toLowerCase()}).</> : 'No ownership check has been recorded yet.'}
                {validation.data?.recordedCheckOutdated && v.lastRecorded && <span className="text-amber-700"> Owners have changed since then.</span>}
              </p>
            </div>
            {data.owners.length > 0 && <OwnershipBar owners={data.owners} total={v.totalPercentage} />}
            {!person && <p className="mt-3 text-xs text-slate-500">To record a check, choose who you are acting as in the sidebar.</p>}
          </section>

          {/* Owners */}
          <section className="card p-5 sm:p-6" aria-labelledby="owners-heading">
            <h2 id="owners-heading" className="mb-4 text-base font-semibold">Beneficial owners</h2>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[920px] text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5">Owner</th>
                    <th className="px-4 py-2.5 text-right">Ownership</th>
                    <th className="px-4 py-2.5">Type and control</th>
                    <th className="px-4 py-2.5">Residence</th>
                    <th className="px-4 py-2.5">Screening</th>
                    <th className="px-4 py-2.5">Owner risk</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.owners.map((o) => (
                    <tr key={o.id} className="align-top hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <Link to={`/ownership/owners/${o.id}`} className="font-medium text-brand-700 hover:underline">{o.fullName}</Link>
                        <div className="text-xs text-slate-500">{o.birthYear ? `Born ${o.birthYear}` : 'Date of birth missing'} · {o.nationalityName || 'nationality missing'}</div>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums">{o.ownershipPercentage == null ? <span className="text-orange-700">missing</span> : `${o.ownershipPercentage}%`}</td>
                      <td className="px-4 py-3">
                        <div>{o.ownershipType}</div>
                        <div className="text-xs text-slate-500">{o.controlType}</div>
                      </td>
                      <td className="px-4 py-3">{o.countryOfResidenceName || <span className="text-orange-700">missing</span>}<div className="text-xs text-slate-500">PEP declared: {o.pepStatus}</div></td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col items-start gap-1">
                          <ScreeningBadge label="PEP" outcome={o.risk.screening.pep} />
                          <ScreeningBadge label="Sanctions" outcome={o.risk.screening.sanctions} />
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <RiskBadge level={o.risk.level} />
                        <div className="mt-1 text-xs tabular-nums text-slate-500">{o.risk.points} point{o.risk.points === 1 ? '' : 's'}</div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-right">
                        <Link to={`/ownership/owners/${o.id}`} className="mr-3 font-medium text-brand-700 hover:underline">Details</Link>
                        <Link to={`/ownership/owners/${o.id}/person`} className="mr-3 font-medium text-brand-700 hover:underline">All companies</Link>
                        <Link to={`/ownership/owners/${o.id}/edit`} className="font-medium text-slate-700 hover:underline">Edit</Link>
                      </td>
                    </tr>
                  ))}
                  {data.owners.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-4 py-10 text-center text-slate-500">
                        No beneficial owners recorded yet. <Link to={`/ownership/owners/new?customer=${customerId}`} className="font-medium text-brand-700 underline">Add the first owner</Link>.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-500">
              A beneficial owner is an individual who ultimately owns or controls the company. Screening outcomes are synthetic: nothing is checked against a real PEP or sanctions database. A <strong>Potential match</strong> needs
              investigation and is not a confirmed match.
            </p>
          </section>

          {/* Recorded checks */}
          {validation.data?.history.length > 0 && (
            <section className="card p-5 sm:p-6">
              <h2 className="mb-3 text-base font-semibold">Recorded ownership checks</h2>
              <ul className="divide-y divide-slate-100 text-sm">
                {validation.data.history.map((h) => (
                  <li key={h.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <OwnershipStatusBadge status={h.validationStatus} />
                    <span className="tabular-nums">{h.totalOwnershipPercentage}% from {h.ownerCount} owner{h.ownerCount === 1 ? '' : 's'}</span>
                    <span className="text-xs text-slate-500">{formatDateTime(h.checkedAt)} · {h.checkedBy ? `${h.checkedBy.name}` : 'system'}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-slate-500">Earlier checks are never changed: each check is a new record.</p>
            </section>
          )}
        </div>
      )}
    </>
  );
}
