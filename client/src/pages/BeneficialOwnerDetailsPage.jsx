import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { createScreening, getOwner } from '../services/ownershipApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, Field, PageHeader, RiskBadge, Spinner } from '../components/ui';
import { Fact } from '../components/kycUi';
import { ScreeningBadge } from '../components/riskUi';
import { formatDate, formatDateTime } from '../utils/format';

const RESULTS = ['No Match', 'Potential Match', 'Confirmed'];

/** One beneficial owner: details, Owner Risk Assessment (indicators and points), and screening history. */
export default function BeneficialOwnerDetailsPage() {
  const { id } = useParams();
  const toast = useToast();
  const { current: person } = useReviewer();
  const { data: o, loading, error, reload } = useAsync(() => getOwner(id), [id]);
  const canDecide = Boolean(person?.canDecide);

  const [type, setType] = useState('Sanctions');
  const [mode, setMode] = useState('simulated');
  const [result, setResult] = useState('No Match');
  const [remarks, setRemarks] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (mode === 'manual' && result !== 'No Match' && !remarks.trim()) errs.remarks = `Remarks are required when the result is ${result}`;
    setFieldErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      const body = mode === 'simulated' ? { screeningType: type, mode, remarks: remarks.trim() } : { screeningType: type, mode, screeningResult: result, remarks: remarks.trim() };
      const saved = await createScreening(id, body);
      toast.success(`${type} screening recorded: ${saved.screeningResult}.`);
      setRemarks('');
      reload();
    } catch (err) {
      setFieldErrors(err.fields || {});
      setFormError(err);
    } finally {
      setSaving(false);
    }
  }

  const risk = o?.risk;

  return (
    <>
      <PageHeader title={o ? o.fullName : 'Beneficial owner'} subtitle={o ? `Owner of ${o.customer.name} (${o.customer.customerId})` : `Owner #${id}`}>
        <div className="flex flex-wrap gap-2">
          {o && <Link to={`/ownership/${o.customer.customerId}`} className="btn btn-secondary">← Company ownership</Link>}
          {o && <Link to={`/ownership/owners/${o.id}/person`} className="btn btn-secondary" data-testid="all-companies-link">All companies of this person</Link>}
          {o && <Link to={`/ownership/owners/${o.id}/edit`} className="btn btn-primary">Edit owner</Link>}
        </div>
      </PageHeader>

      {loading && !o && <Spinner label="Loading owner…" />}
      <ErrorBanner error={error} onRetry={error?.status === 404 ? undefined : reload} />

      {o && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="min-w-0 space-y-6 lg:col-span-2">
            <section className="card p-5 sm:p-6">
              <h2 className="mb-4 text-base font-semibold">Owner details</h2>
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <Fact label="Full name">{o.fullName}</Fact>
                <Fact label="Date of birth">{o.dateOfBirth ? formatDate(o.dateOfBirth) : <span className="text-orange-700">missing</span>}</Fact>
                <Fact label="Country of residence">{o.countryOfResidenceName || <span className="text-orange-700">missing</span>}</Fact>
                <Fact label="Nationality">{o.nationalityName || <span className="text-orange-700">missing</span>}</Fact>
                <Fact label="Ownership">{o.ownershipPercentage == null ? <span className="text-orange-700">missing</span> : `${o.ownershipPercentage}%`}</Fact>
                <Fact label="Ownership type">{o.ownershipType}</Fact>
                <Fact label="Control type">{o.controlType}</Fact>
                <Fact label="PEP status (declared)">{o.pepStatus}</Fact>
                <Fact label="Notes">{o.notes}</Fact>
                <Fact label="Last updated">{formatDateTime(o.updatedAt)}</Fact>
              </dl>
            </section>

            <section className="card p-5 sm:p-6" aria-labelledby="owner-risk-heading">
              <div className="mb-1 flex flex-wrap items-center gap-3">
                <h2 id="owner-risk-heading" className="text-base font-semibold">Owner risk assessment</h2>
                <RiskBadge level={risk.level} />
                <span className="text-sm tabular-nums text-slate-600">{risk.points} point{risk.points === 1 ? '' : 's'}</span>
              </div>
              <p className="mb-4 text-xs text-slate-500">Prototype scoring: 0-2 Low, 3-5 Medium, 6 or more High. These are illustrative rules, not regulatory standards.</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <tr><th className="py-2 pr-4">Indicator</th><th className="py-2 pr-4">Outcome</th><th className="py-2 pr-4">Detail</th><th className="py-2 text-right">Points</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {risk.indicators.map((i) => (
                      <tr key={i.indicator}>
                        <td className="py-2 pr-4 align-top font-medium text-slate-900">{i.indicator}</td>
                        <td className="py-2 pr-4 align-top">
                          {['PEP status', 'Sanctions screening'].includes(i.indicator) ? <ScreeningBadge outcome={i.outcome} /> : <span className="text-slate-700">{i.outcome}</span>}
                        </td>
                        <td className="py-2 pr-4 text-slate-600">{i.detail}</td>
                        <td className="py-2 text-right tabular-nums">+{i.points}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {risk.reviewReasons.length > 0 && (
                <div className="mt-4 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
                  <p className="font-medium">Needs review (not a rejection)</p>
                  <ul className="mt-1 list-disc space-y-1 pl-5">{risk.reviewReasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul>
                </div>
              )}
            </section>

            <section className="card p-5 sm:p-6">
              <h2 className="mb-3 text-base font-semibold">Screening history</h2>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-left text-sm">
                  <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <tr><th className="py-2 pr-4">Type</th><th className="py-2 pr-4">Result</th><th className="py-2 pr-4">Source and remarks</th><th className="py-2 pr-4">Recorded</th><th className="py-2 text-right">Points</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {o.screenings.map((s) => (
                      <tr key={s.id}>
                        <td className="py-2 pr-4 align-top font-medium">{s.screeningType}</td>
                        <td className="py-2 pr-4 align-top"><ScreeningBadge outcome={s.screeningResult} /></td>
                        <td className="py-2 pr-4 text-slate-600"><span className="text-xs text-slate-500">{s.source}</span>{s.remarks && <div>{s.remarks}</div>}</td>
                        <td className="py-2 pr-4 align-top text-xs text-slate-500">{formatDateTime(s.screenedAt)}<br />{s.screenedBy?.name}</td>
                        <td className="py-2 text-right align-top tabular-nums">+{s.riskPoints}</td>
                      </tr>
                    ))}
                    {o.screenings.length === 0 && <tr><td colSpan={5} className="py-6 text-center text-slate-500">Not screened yet.</td></tr>}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-slate-500">Each screening is a new record. Earlier outcomes are never changed.</p>
            </section>
          </div>

          <aside className="min-w-0 space-y-6">
            <section className="card p-5">
              <h2 className="mb-3 text-base font-semibold">Current screening</h2>
              <div className="flex flex-col items-start gap-2">
                <ScreeningBadge label="PEP" outcome={risk.screening.pep} />
                <ScreeningBadge label="Sanctions" outcome={risk.screening.sanctions} />
              </div>
              <p className="mt-3 text-xs leading-relaxed text-slate-500">
                <strong>Confirmed</strong>: established after investigation. <strong>Potential match</strong>: possible, needs investigation, not confirmed. <strong>No match</strong>: screened, nothing found.{' '}
                <strong>Not screened</strong>: no record yet.
              </p>
            </section>

            <form onSubmit={submit} noValidate className="card space-y-3 p-5">
              <h2 className="text-base font-semibold">Record screening</h2>
              <p className="text-xs text-slate-500">Outcomes are synthetic. There is no connection to any real PEP or sanctions database.</p>
              {!person && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">Choose who you are acting as in the sidebar.</p>}
              {person && !canDecide && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">{person.name} ({person.role}) cannot record screening outcomes. Choose a Reviewer or Admin.</p>}
              {formError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800">{formError.message}</p>}
              <fieldset disabled={!canDecide || saving} className="min-w-0 space-y-3">
                <Field label="Screening type">
                  <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                    <option>Sanctions</option>
                    <option>PEP</option>
                  </select>
                </Field>
                <div className="space-y-1.5 text-sm">
                  <label className="flex items-start gap-2"><input type="radio" name="mode" checked={mode === 'simulated'} onChange={() => setMode('simulated')} className="mt-1" /><span>Simulated list match <span className="block text-xs text-slate-500">Compares the name with a fictional demo list. Can only give Potential match or No match.</span></span></label>
                  <label className="flex items-start gap-2"><input type="radio" name="mode" checked={mode === 'manual'} onChange={() => setMode('manual')} className="mt-1" /><span>Enter an outcome <span className="block text-xs text-slate-500">Record a synthetic outcome you choose.</span></span></label>
                </div>
                {mode === 'manual' && (
                  <Field label="Result" error={fieldErrors.screeningResult}>
                    <select className="input" value={result} onChange={(e) => setResult(e.target.value)}>
                      {RESULTS.map((r) => <option key={r}>{r}</option>)}
                    </select>
                  </Field>
                )}
                <Field label="Remarks" required={mode === 'manual' && result !== 'No Match'} error={fieldErrors.remarks}>
                  <textarea rows={3} maxLength={1000} className={`input ${fieldErrors.remarks ? 'input-error' : ''}`} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
                </Field>
                <button type="submit" className="btn btn-primary w-full">{saving ? 'Saving…' : 'Record screening'}</button>
              </fieldset>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}
