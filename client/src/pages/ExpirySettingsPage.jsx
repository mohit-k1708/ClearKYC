import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getExpirySettings, saveExpirySettings } from '../services/phase6Api';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, Field, PageHeader, Spinner } from '../components/ui';
import { formatDateTime } from '../utils/format';

const parse = (text) => text.split(/[\s,;]+/).filter(Boolean).map((t) => (/^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t));

/**
 * Document-expiry alert settings: how many days before a document expires an alert is raised (default 90, 60, 30, 7).
 * Everyone can see them; a Reviewer or Admin can change them. The server checks the rules (whole days above zero, no duplicates,
 * largest to smallest); detection uses the saved values the next time it runs.
 */
export default function ExpirySettingsPage() {
  const toast = useToast();
  const { current: person } = useReviewer();
  const { data, loading, error, reload } = useAsync(getExpirySettings, []);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const canDecide = Boolean(person?.canDecide);

  useEffect(() => {
    if (data) setText(data.expiryAlertDays.join(', '));
  }, [data]);

  async function submit(e) {
    e.preventDefault();
    setFormError(null);
    const values = parse(text);
    if (values.length === 0) return setFieldErrors({ expiryAlertDays: 'Enter at least one lead time, for example 90, 60, 30, 7.' });
    setFieldErrors({});
    setSaving(true);
    try {
      const saved = await saveExpirySettings(values, reason.trim());
      toast.success(`Saved: alerts at ${saved.expiryAlertDays.join(', ')} days before expiry. They apply the next time detection runs.`);
      setReason('');
      reload();
    } catch (err) {
      setFieldErrors(err.fields || {});
      setFormError(err);
    } finally {
      setSaving(false);
    }
    return undefined;
  }

  return (
    <>
      <PageHeader title="Expiry alert settings" subtitle="How many days before a document expires should an alert be raised?" />
      {loading && !data && <Spinner label="Loading settings…" />}
      <ErrorBanner error={error} onRetry={reload} />

      {data && (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
            <section className="card p-5 sm:p-6" data-testid="current-thresholds">
              <h2 className="mb-3 text-base font-semibold">In use now</h2>
              <ul className="flex flex-wrap gap-2" aria-label="Current lead times">
                {data.expiryAlertDays.map((d) => (
                  <li key={d} className="rounded-full bg-brand-50 px-3 py-1 text-sm font-medium text-brand-800 ring-1 ring-inset ring-brand-600/20">{d} days</li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-slate-600">
                A verified document raises one alert for the closest lead time it has reached. For example with {data.expiryAlertDays.join(', ')}: a document {data.expiryAlertDays.length > 1 ? Math.round((data.expiryAlertDays[0] + data.expiryAlertDays[1]) / 2) : data.expiryAlertDays[0]} days from expiry is in the {data.expiryAlertDays.length > 1 ? data.expiryAlertDays[0] : data.expiryAlertDays[0]}-day window.
              </p>
              <p className="mt-2 text-xs text-slate-500" data-testid="settings-source">
                {data.source === 'saved' ? <>Saved by <strong>{data.updatedBy?.name}</strong> ({data.updatedBy?.role}) on {formatDateTime(data.updatedAt)}{data.reason ? <> — “{data.reason}”</> : null}.</> : <>These are the built-in defaults; nobody has saved other values yet.</>}
                {' '}Changes apply the next time detection runs (<Link className="text-brand-700 hover:underline" to="/alerts">Alerts</Link> → Refresh alerts).
              </p>
            </section>

            <section className="card p-5 sm:p-6">
              <h2 className="mb-3 text-base font-semibold">Change history</h2>
              {data.history.length === 0 ? (
                <p className="text-sm text-slate-500">No changes have been saved yet.</p>
              ) : (
                <ol className="space-y-2 text-sm" data-testid="settings-history">
                  {data.history.map((h) => (
                    <li key={h.id} className="rounded-lg border border-slate-200 p-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-900">{h.expiryAlertDays.join(', ')} days</span>
                        <span className="text-slate-600">by {h.changedBy?.name} ({h.changedBy?.role})</span>
                        <span className="ml-auto text-xs text-slate-500">{formatDateTime(h.changedAt)}</span>
                      </div>
                      {h.reason && <p className="mt-1 text-slate-600">{h.reason}</p>}
                    </li>
                  ))}
                </ol>
              )}
              <p className="mt-3 text-xs text-slate-500">Earlier values are kept; a change adds a new entry and never overwrites one. Every change is also in the Audit Trail.</p>
            </section>
          </div>

          <form onSubmit={submit} noValidate className="card h-fit space-y-3 p-5 lg:col-span-2" aria-label="Change expiry alert settings">
            <h2 className="text-base font-semibold">Change the lead times</h2>
            {!person && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">Choose who you are acting as in the sidebar.</p>}
            {person && !canDecide && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">{person.name} ({person.role}) cannot change settings. Choose a Reviewer or Admin.</p>}
            {formError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800">{formError.message}</p>}
            <fieldset disabled={!canDecide || saving} className="min-w-0 space-y-3">
              <Field label="Days before expiry" required error={fieldErrors.expiryAlertDays} hint={`Whole days, separated by commas, largest first. At most ${data.limits.maxCount}.`}>
                <input className={`input ${fieldErrors.expiryAlertDays ? 'input-error' : ''}`} value={text} onChange={(e) => setText(e.target.value)} aria-label="Days before expiry" inputMode="numeric" autoComplete="off" />
              </Field>
              <Field label="Reason (optional)" error={fieldErrors.reason}>
                <input className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
              </Field>
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-500">{data.rules.map((r) => <li key={r}>{r}</li>)}</ul>
              <div className="flex gap-2">
                <button type="submit" className="btn btn-primary flex-1">{saving ? 'Saving…' : 'Save'}</button>
                <button type="button" className="btn btn-secondary" onClick={() => { setText(data.defaults.join(', ')); setFieldErrors({}); setFormError(null); }}>Use defaults</button>
              </div>
            </fieldset>
          </form>
        </div>
      )}
    </>
  );
}
