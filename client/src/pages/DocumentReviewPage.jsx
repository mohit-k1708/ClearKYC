import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { documentFileUrl, getDocument, recordVerification } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, Field, PageHeader, Spinner } from '../components/ui';
import { ExpiryBadge, Fact, NameCheckNotice, StatusBadge, VerificationHistory } from '../components/kycUi';
import { formatDate } from '../utils/format';

const DECISIONS = [
  { value: 'In Review', label: 'In Review', help: 'You have started checking this document.' },
  { value: 'Verified', label: 'Verified', help: 'The document is acceptable.' },
  { value: 'Rejected', label: 'Rejected', help: 'The document is not acceptable. Remarks are required.' },
  { value: 'Requires Resubmission', label: 'Requires Resubmission', help: 'Ask the customer for a corrected or newer document. Remarks are required.' },
];
const NEEDS_REMARKS = ['Rejected', 'Requires Resubmission'];

/**
 * Verification Review: the reviewer checks the document and records a decision. A decision is saved
 * as a NEW verification record with the reviewer, date and remarks; it never overwrites earlier ones.
 */
export default function DocumentReviewPage() {
  const { id } = useParams();
  const toast = useToast();
  const { current: reviewer } = useReviewer();
  const { data: d, loading, error, reload } = useAsync(() => getDocument(id), [id]);

  const [status, setStatus] = useState('');
  const [remarks, setRemarks] = useState('');
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const canDecide = Boolean(reviewer?.canDecide);
  const expired = d?.effectiveStatus === 'Expired';

  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!status) errs.status = 'Choose a decision';
    if (NEEDS_REMARKS.includes(status) && !remarks.trim()) errs.remarks = `Remarks are required when the decision is ${status}`;
    setFieldErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;

    setSaving(true);
    try {
      await recordVerification(id, { status, remarks: remarks.trim() });
      toast.success(`Decision recorded: ${status}.`);
      setStatus('');
      setRemarks('');
      reload();
    } catch (err) {
      setFieldErrors(err.fields || {});
      setFormError(err);
      if (err.status === 0 || err.status >= 500) toast.error(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHeader title="Verification review" subtitle={d ? `${d.documentType} · ${d.customer.name} (${d.customer.customerId})` : `Document #${id}`}>
        <Link to={`/documents/${id}`} className="btn btn-secondary">
          ← Document details
        </Link>
      </PageHeader>

      {loading && !d && <Spinner label="Loading document…" />}
      <ErrorBanner error={error} onRetry={error?.status === 404 ? undefined : reload} />

      {d && (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="space-y-6 lg:col-span-3">
            <section className="card p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">Check the document</h2>
                <StatusBadge status={d.status} />
                {expired && d.status !== 'Expired' && <StatusBadge status="Expired" />}
              </div>
              <NameCheckNotice check={d.nameCheck} />
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <Fact label="Customer (registered name)">{d.customer.name}</Fact>
                <Fact label="Name on the document">{d.nameOnDocument}</Fact>
                <Fact label="Customer risk level">{d.customer.riskLevel}</Fact>
                <Fact label="Document number (masked)" mono>{d.documentNumberMasked}</Fact>
                <Fact label="Issue date">{formatDate(d.issueDate)}</Fact>
                <Fact label="Expiry">
                  <span className="mr-2">{d.expiryDate ? formatDate(d.expiryDate) : '—'}</span>
                  <ExpiryBadge state={d.expiryState} days={d.daysToExpiry} />
                </Fact>
                <Fact label="Submission date">{formatDate(d.submissionDate)}</Fact>
                <Fact label="File">
                  {d.file ? (
                    <a className="font-medium text-brand-700 hover:underline" href={documentFileUrl(d.id)}>
                      Download {d.file.name}
                    </a>
                  ) : (
                    'No file uploaded'
                  )}
                </Fact>
                <Fact label="Notes">{d.notes}</Fact>
              </dl>
            </section>

            <section className="card p-5 sm:p-6">
              <h2 className="mb-4 text-base font-semibold">Verification history</h2>
              <VerificationHistory items={d.verifications} />
            </section>
          </div>

          <section className="card h-fit p-5 sm:p-6 lg:col-span-2">
            <h2 className="mb-1 text-base font-semibold">Record a decision</h2>
            <p className="mb-4 text-xs text-slate-500">Simulated manual review. This is not an external identity or government check.</p>

            {!reviewer && (
              <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                Choose who you are acting as in the sidebar (<strong>Acting as</strong>) before recording a decision.
              </div>
            )}
            {reviewer && !canDecide && (
              <div role="alert" className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                <strong>{reviewer.name}</strong> has the role <strong>{reviewer.role}</strong>, which cannot record verification decisions. Choose a Reviewer or Admin in the sidebar.
              </div>
            )}
            {expired && (
              <div className="mb-4 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">This document expired on {formatDate(d.expiryDate)}. It cannot be verified. You can reject it or ask for a resubmission.</div>
            )}
            {formError && (
              <div role="alert" className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                {formError.message}
              </div>
            )}

            <form onSubmit={submit} noValidate className="space-y-4">
              <fieldset disabled={!canDecide || saving} className="space-y-2">
                <legend className="mb-1 text-sm font-medium text-slate-700">
                  Decision <span className="text-red-500">*</span>
                </legend>
                {DECISIONS.map((o) => {
                  const blocked = o.value === 'Verified' && expired;
                  return (
                    <label key={o.value} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm ${status === o.value ? 'border-brand-600 bg-brand-50' : 'border-slate-200'} ${blocked ? 'cursor-not-allowed opacity-50' : ''}`}>
                      <input type="radio" name="decision" value={o.value} checked={status === o.value} disabled={blocked || o.value === d.status} onChange={() => setStatus(o.value)} className="mt-1" />
                      <span>
                        <span className="font-medium text-slate-900">{o.label}</span>
                        {o.value === d.status && <span className="ml-2 text-xs text-slate-500">(current status)</span>}
                        <span className="block text-xs text-slate-500">{o.help}</span>
                      </span>
                    </label>
                  );
                })}
                {fieldErrors.status && <p role="alert" className="text-xs text-red-600">{fieldErrors.status}</p>}
              </fieldset>

              <Field label="Remarks" required={NEEDS_REMARKS.includes(status)} error={fieldErrors.remarks} hint="Visible in the verification history">
                <textarea rows={4} maxLength={1000} disabled={!canDecide || saving} value={remarks} onChange={(e) => setRemarks(e.target.value)} className={`input ${fieldErrors.remarks ? 'input-error' : ''}`} />
              </Field>

              <button type="submit" className="btn btn-primary w-full" disabled={!canDecide || saving}>
                {saving ? (
                  <>
                    <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Saving…
                  </>
                ) : (
                  'Record decision'
                )}
              </button>
              {reviewer && canDecide && <p className="text-center text-xs text-slate-500">Recorded as {reviewer.name} ({reviewer.role})</p>}
            </form>
          </section>
        </div>
      )}
    </>
  );
}
