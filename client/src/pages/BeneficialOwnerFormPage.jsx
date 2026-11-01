import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { createOwner, getOwner, getOwnershipOptions, updateOwner } from '../services/ownershipApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, Field, PageHeader, Spinner } from '../components/ui';
import { CustomerPicker } from '../components/kycUi';
import { todayIso } from '../utils/validators';

/**
 * Add a beneficial owner (/ownership/owners/new) or edit one (/ownership/owners/:id/edit).
 * Owners belong to company customers only, so the picker lists companies. The server re-validates everything.
 */
export default function BeneficialOwnerFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const [query] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { current: person } = useReviewer();

  const options = useAsync(getOwnershipOptions, []);
  const existing = useAsync(() => (editing ? getOwner(id) : Promise.resolve(null)), [id]);

  const form = useForm({
    mode: 'onTouched',
    defaultValues: { customerId: query.get('customer') || '', fullName: '', dateOfBirth: '', countryOfResidence: '', nationality: '', ownershipPercentage: '', ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'Unknown', notes: '' },
  });
  const { register, control, handleSubmit, setError, reset, formState: { errors } } = form;

  useEffect(() => {
    const o = existing.data;
    if (o) {
      reset({
        customerId: o.customer.customerId,
        fullName: o.fullName,
        dateOfBirth: o.dateOfBirth || '',
        countryOfResidence: o.countryOfResidence || '',
        nationality: o.nationality || '',
        ownershipPercentage: o.ownershipPercentage ?? '',
        ownershipType: o.ownershipType,
        controlType: o.controlType,
        pepStatus: o.pepStatus,
        notes: o.notes || '',
      });
    }
  }, [existing.data, reset]);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const inFlight = useRef(false);

  const onSubmit = handleSubmit(async (values) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setFormError(null);
    const { customerId, ...fields } = values;
    const body = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
    try {
      const saved = editing ? await updateOwner(id, body) : await createOwner(customerId, body);
      toast.success(editing ? 'Owner updated.' : 'Beneficial owner added.');
      navigate(editing ? `/ownership/owners/${saved.id}` : `/ownership/${customerId}`);
    } catch (err) {
      Object.entries(err.fields || {}).forEach(([name, message]) => {
        if (name in values) setError(name, { type: 'server', message });
      });
      setFormError(err);
      if (err.status === 0 || err.status >= 500) toast.error(err.message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  });

  const opts = options.data;
  const loading = options.loading || (editing && existing.loading);
  const countryOptions = (opts?.countries ?? []).map((c) => (
    <option key={c.code} value={c.code}>
      {c.name}
    </option>
  ));

  return (
    <>
      <PageHeader title={editing ? 'Edit beneficial owner' : 'Add beneficial owner'} subtitle="An individual who ultimately owns or controls a company customer">
        <Link to={editing ? `/ownership/owners/${id}` : '/ownership'} className="btn btn-secondary">← Back</Link>
      </PageHeader>

      {loading && <Spinner label="Loading…" />}
      <ErrorBanner error={options.error || existing.error} onRetry={() => { options.reload(); existing.reload(); }} />

      {opts && !loading && !existing.error && (
        <form onSubmit={onSubmit} noValidate className="card space-y-6 p-5 sm:p-6">
          {!person && (
            <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              Choose who you are acting as (<strong>Acting as</strong> in the sidebar) before saving, so the change is attributed to someone.
            </div>
          )}
          {formError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-medium">{formError.message}</p>
              {formError.fields?.existingOwnerId && (
                <p className="mt-1">
                  <Link to={`/ownership/owners/${formError.fields.existingOwnerId}/edit`} className="underline">Edit the existing owner record</Link>
                </p>
              )}
            </div>
          )}
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <strong>Use synthetic data only.</strong> Do not enter real people's details. Date of birth is encrypted when stored. Leave a field blank only if the information is genuinely not yet known: missing information is flagged and adds to the owner's risk.
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Company customer" required error={errors.customerId?.message} hint={editing ? 'The company cannot be changed after the owner is added.' : 'Only company customers can have beneficial owners'}>
                <Controller name="customerId" control={control} rules={{ required: 'Choose a company customer' }} render={({ field }) => <CustomerPicker type="Company" value={field.value} onChange={field.onChange} disabled={editing} invalid={Boolean(errors.customerId)} />} />
              </Field>
            </div>

            <Field label="Owner full name" required error={errors.fullName?.message}>
              <input className={`input ${errors.fullName ? 'input-error' : ''}`} autoComplete="off" {...register('fullName', { validate: (v) => (v || '').trim().length >= 2 || 'Owner full name is required' })} />
            </Field>

            <Field label="Date of birth" error={errors.dateOfBirth?.message} hint="Encrypted when stored">
              <input type="date" max={todayIso()} className={`input ${errors.dateOfBirth ? 'input-error' : ''}`} {...register('dateOfBirth', { validate: (v) => !v || v <= todayIso() || 'Date of birth cannot be in the future' })} />
            </Field>

            <Field label="Country of residence" error={errors.countryOfResidence?.message}>
              <select className="input" {...register('countryOfResidence')}>
                <option value="">Not known yet</option>
                {countryOptions}
              </select>
            </Field>

            <Field label="Nationality" error={errors.nationality?.message}>
              <select className="input" {...register('nationality')}>
                <option value="">Not known yet</option>
                {countryOptions}
              </select>
            </Field>

            <Field label="Ownership percentage" error={errors.ownershipPercentage?.message} hint="Greater than 0 and at most 100, up to 2 decimals. The owners' percentages should add up to 100%.">
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className={`input ${errors.ownershipPercentage ? 'input-error' : ''}`}
                {...register('ownershipPercentage', {
                  validate: (v) => {
                    if (v === '' || v === null || v === undefined) return true;
                    const n = Number(v);
                    if (Number.isNaN(n)) return 'Ownership percentage must be a number';
                    if (n <= 0) return 'Ownership percentage must be greater than 0';
                    if (n > 100) return 'Ownership percentage cannot be more than 100';
                    return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 || 'Use at most 2 decimal places';
                  },
                })}
              />
            </Field>

            <Field label="Ownership type" required error={errors.ownershipType?.message} hint="Indirect means held through another entity">
              <select className="input" {...register('ownershipType', { required: 'Ownership type is required' })}>
                {opts.ownershipTypes.map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>

            <Field label="Control type" required error={errors.controlType?.message}>
              <select className="input" {...register('controlType', { required: 'Control type is required' })}>
                {opts.controlTypes.map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>

            <Field label="PEP status (declared)" required error={errors.pepStatus?.message} hint="What the owner declared. Screening outcomes are recorded separately.">
              <select className="input" {...register('pepStatus', { required: 'PEP status is required' })}>
                {opts.pepStatuses.map((t) => <option key={t}>{t}</option>)}
              </select>
            </Field>

            <div className="sm:col-span-2">
              <Field label="Notes" error={errors.notes?.message}>
                <textarea rows={3} maxLength={1000} className="input" {...register('notes')} />
              </Field>
            </div>
          </div>

          <div className="flex flex-wrap justify-end gap-3 border-t border-slate-100 pt-5">
            <Link to={editing ? `/ownership/owners/${id}` : '/ownership'} className="btn btn-secondary">Cancel</Link>
            <button type="submit" className="btn btn-primary min-w-40" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Saving…
                </>
              ) : editing ? (
                'Save changes'
              ) : (
                'Add owner'
              )}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
