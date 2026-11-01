import { Link } from 'react-router-dom';
import { ErrorBanner, Field, PageHeader, Spinner } from './ui';
import useMeta from '../hooks/useMeta';

/** An <input> wired to react-hook-form, with label and error message. */
export function TextInput({ label, name, register, rules, errors, required = true, hint, type = 'text', ...rest }) {
  const error = errors[name]?.message;
  return (
    <Field label={label} error={error} hint={hint} required={required}>
      <input {...register(name, rules)} type={type} className={`input ${error ? 'input-error' : ''}`} aria-invalid={Boolean(error)} {...rest} />
    </Field>
  );
}

export function SelectInput({ label, name, register, rules, errors, options, placeholder, required = true }) {
  const error = errors[name]?.message;
  return (
    <Field label={label} error={error} required={required}>
      <select {...register(name, rules)} className={`input ${error ? 'input-error' : ''}`} aria-invalid={Boolean(error)}>
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

export function CountrySelect({ register, errors }) {
  const meta = useMeta();
  const options = (meta.data?.countries ?? []).map((c) => ({ value: c.code, label: c.name }));
  return <SelectInput label="Country" name="country" register={register} errors={errors} options={options} rules={{ required: 'Country is required' }} />;
}

/**
 * Page frame shared by both forms: title, loading state for reference data, the
 * server-error banner, and Cancel / Submit buttons.
 */
export default function RegistrationForm({ title, subtitle, onSubmit, submitting, formError, children }) {
  const meta = useMeta();

  return (
    <>
      <PageHeader title={title} subtitle={subtitle}>
        <Link to="/customers/new" className="btn btn-secondary">
          ← Change type
        </Link>
      </PageHeader>

      {meta.loading && <Spinner label="Loading form options…" />}
      {meta.error && <ErrorBanner error={meta.error} onRetry={meta.reload} />}

      {meta.data && (
        <form onSubmit={onSubmit} noValidate className="card space-y-6 p-5 sm:p-6">
          {formError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <p className="font-medium">{formError.message}</p>
              {formError.fields?.existingCustomerId && (
                <p className="mt-1">
                  Existing record:{' '}
                  <Link to={`/customers/${formError.fields.existingCustomerId}`} className="font-mono underline">
                    {formError.fields.existingCustomerId}
                  </Link>
                </p>
              )}
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">{children}</div>

          <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
            PAN and Aadhaar are checked for <strong>format only</strong>. A correctly formatted number is not proof that it is genuine or belongs to
            this customer. Identifiers are encrypted before storage and only shown masked.
          </p>

          <div className="flex flex-wrap justify-end gap-3 border-t border-slate-100 pt-5">
            <Link to="/customers" className="btn btn-secondary">
              Cancel
            </Link>
            <button type="submit" className="btn btn-primary min-w-40" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Registering…
                </>
              ) : (
                'Register customer'
              )}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
