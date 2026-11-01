import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { createCase, getException, getReviewOptions } from '../services/reviewApi';
import { listReviewers } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, Field, PageHeader, Spinner } from '../components/ui';
import { CustomerPicker } from '../components/kycUi';
import { ExceptionStatusBadge, SeverityBadge } from '../components/reviewUi';
import { todayIso } from '../utils/validators';

/**
 * Create a review case: manually, or from an exception (/cases/new?exception=ID), which fills in the customer, type,
 * priority and description from the exception.
 */
export default function CaseFormPage() {
  const [query] = useSearchParams();
  const exceptionId = query.get('exception');
  const navigate = useNavigate();
  const toast = useToast();
  const { current: person } = useReviewer();

  const options = useAsync(getReviewOptions, []);
  const people = useAsync(listReviewers, []);
  const exception = useAsync(() => (exceptionId ? getException(exceptionId) : Promise.resolve(null)), [exceptionId]);
  const e = exception.data;

  const form = useForm({ mode: 'onTouched', defaultValues: { customerId: query.get('customer') || '', caseTitle: '', caseType: '', description: '', priority: '', dueDate: '', assignedAnalystId: '', assignedReviewerId: '' } });
  const { register, control, handleSubmit, setError, formState: { errors } } = form;
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const inFlight = useRef(false);

  const isReviewerRole = ['Reviewer', 'Admin'].includes(person?.role);
  const all = people.data ?? [];
  const analysts = isReviewerRole ? all.filter((p) => ['Analyst', 'Admin'].includes(p.role)) : all.filter((p) => p.id === person?.id);
  const reviewers = all.filter((p) => ['Reviewer', 'Admin'].includes(p.role));

  const onSubmit = handleSubmit(async (values) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setFormError(null);
    const body = {};
    Object.entries(values).forEach(([k, v]) => {
      if (typeof v === 'string' && v.trim() !== '') body[k] = ['assignedAnalystId', 'assignedReviewerId'].includes(k) ? Number(v) : v.trim();
    });
    if (e) { body.exceptionId = e.id; delete body.customerId; }
    try {
      const created = await createCase(body);
      toast.success(`Case ${created.caseId} created.`);
      navigate(`/cases/${created.id}`);
    } catch (err) {
      Object.entries(err.fields || {}).forEach(([name, message]) => { if (name in values) setError(name, { type: 'server', message }); });
      setFormError(err);
      if (err.status === 0 || err.status >= 500) toast.error(err.message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  });

  const loading = options.loading || people.loading || exception.loading;

  return (
    <>
      <PageHeader title="New review case" subtitle={e ? `From exception ${e.exceptionId}` : 'Open a formal investigation for a customer'}>
        <Link to={e ? '/exceptions' : '/cases'} className="btn btn-secondary">← Back</Link>
      </PageHeader>

      {loading && <Spinner label="Loading…" />}
      <ErrorBanner error={options.error || people.error || exception.error} onRetry={() => { options.reload(); people.reload(); exception.reload(); }} />

      {!loading && options.data && !exception.error && (
        <form onSubmit={onSubmit} noValidate className="card space-y-6 p-5 sm:p-6">
          {!person && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Choose who you are acting as (<strong>Acting as</strong> in the sidebar) before creating a case.</div>}
          {formError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-medium">{formError.message}</p>
              {formError.fields?.existingCaseId && <p className="mt-1"><Link className="underline" to={`/cases/${formError.fields.existingCaseId}`}>Open the existing case {formError.fields.existingCaseCode}</Link></p>}
            </div>
          )}

          {e && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
              <div className="mb-1 flex flex-wrap items-center gap-2"><span className="font-mono text-xs">{e.exceptionId}</span><SeverityBadge level={e.severity} /><ExceptionStatusBadge status={e.status} /></div>
              <p className="font-medium text-slate-900">{e.typeLabel}</p>
              <p className="text-slate-600">{e.description}</p>
              <p className="mt-1 text-xs text-slate-500">Customer <span className="font-mono">{e.customerId}</span> · {e.customerName}. The case type, priority and description below are suggestions from this exception. You can change them.</p>
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            {!e && (
              <div className="sm:col-span-2">
                <Field label="Customer" required error={errors.customerId?.message}>
                  <Controller name="customerId" control={control} rules={{ required: e ? false : 'Choose an existing customer' }} render={({ field }) => <CustomerPicker value={field.value} onChange={field.onChange} invalid={Boolean(errors.customerId)} />} />
                </Field>
              </div>
            )}
            <div className="sm:col-span-2">
              <Field label="Case title" required={!e} error={errors.caseTitle?.message} hint={e ? 'Leave blank to use the suggested title' : undefined}>
                <input className={`input ${errors.caseTitle ? 'input-error' : ''}`} {...register('caseTitle', { validate: (v) => e || (v || '').trim().length >= 3 || 'Case title is required (at least 3 characters)' })} />
              </Field>
            </div>
            <Field label="Case type" required={!e} error={errors.caseType?.message} hint={e ? `Suggested: ${e.caseType || ''}` : undefined}>
              <select className={`input ${errors.caseType ? 'input-error' : ''}`} {...register('caseType', { validate: (v) => e || !!v || 'Case type is required' })}>
                <option value="">{e ? 'Use the suggested type' : 'Select a case type'}</option>
                {options.data.caseTypes.map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Priority" error={errors.priority?.message} hint="Sets the default due date: Critical 3 days, High 7, Medium 14, Low 30">
              <select className="input" {...register('priority')}>
                <option value="">{e ? `Use the exception severity (${e.severity})` : 'Medium (default)'}</option>
                {options.data.priorities.map((p) => <option key={p}>{p}</option>)}
              </select>
            </Field>
            <Field label="Due date" error={errors.dueDate?.message} hint="Leave blank for the default">
              <input type="date" min={todayIso()} className={`input ${errors.dueDate ? 'input-error' : ''}`} {...register('dueDate', { validate: (v) => !v || v >= todayIso() || 'Due date cannot be in the past' })} />
            </Field>
            <Field label="Assigned analyst" error={errors.assignedAnalystId?.message} hint={isReviewerRole ? undefined : 'You can only assign a case to yourself'}>
              <select className="input" {...register('assignedAnalystId')}>
                <option value="">Unassigned</option>
                {analysts.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </Field>
            {isReviewerRole && (
              <Field label="Assigned compliance reviewer" error={errors.assignedReviewerId?.message}>
                <select className="input" {...register('assignedReviewerId')}>
                  <option value="">None</option>
                  {reviewers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </Field>
            )}
            <div className="sm:col-span-2">
              <Field label="Description" error={errors.description?.message}>
                <textarea rows={4} maxLength={2000} className="input" {...register('description')} />
              </Field>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-3 border-t border-slate-100 pt-5">
            <Link to={e ? '/exceptions' : '/cases'} className="btn btn-secondary">Cancel</Link>
            <button type="submit" className="btn btn-primary min-w-40" disabled={submitting}>
              {submitting ? <><span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Creating…</> : 'Create case'}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
