import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Controller, useForm } from 'react-hook-form';
import { createDocument, getDocument, getDocumentTypes, updateDocument } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import { useToast } from '../components/Toast';
import { ErrorBanner, Field, PageHeader, Spinner } from '../components/ui';
import { CustomerPicker } from '../components/kycUi';
import { todayIso } from '../utils/validators';

const MAX_BYTES = 2 * 1024 * 1024;
const FILE_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'png'];
const NUMBER_FORMAT = /^[A-Za-z0-9][A-Za-z0-9\-/ ]{2,39}$/;

/**
 * Add a document record (route /documents/new) or edit its metadata (/documents/:id/edit).
 * The file is optional. Everything is re-validated by the server.
 */
export default function DocumentFormPage() {
  const { id } = useParams();
  const editing = Boolean(id);
  const [query] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const types = useAsync(getDocumentTypes, []);
  const existing = useAsync(() => (editing ? getDocument(id) : Promise.resolve(null)), [id]);

  const form = useForm({
    mode: 'onTouched',
    defaultValues: { customerId: query.get('customer') || '', documentType: query.get('type') || '', documentNumber: '', nameOnDocument: '', issueDate: '', expiryDate: '', submissionDate: todayIso(), notes: '' },
  });
  const { register, control, handleSubmit, setError, reset, watch, formState: { errors } } = form;

  // Fill the form when editing.
  useEffect(() => {
    const d = existing.data;
    if (d) {
      reset({ customerId: d.customer.customerId, documentType: d.documentType, documentNumber: '', nameOnDocument: d.nameOnDocument || '', issueDate: d.issueDate || '', expiryDate: d.expiryDate || '', submissionDate: d.submissionDate || '', notes: d.notes || '' });
    }
  }, [existing.data, reset]);

  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const fileInput = useRef(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState(null);
  const inFlight = useRef(false);

  const documentType = watch('documentType');
  const issueDate = watch('issueDate');
  const requiresNumber = (types.data ?? []).find((t) => t.name === documentType)?.requiresNumber;

  function pickFile(e) {
    const f = e.target.files?.[0];
    setFileError('');
    if (!f) return setFile(null);
    const ext = f.name.split('.').pop().toLowerCase();
    if (!FILE_EXTENSIONS.includes(ext)) setFileError('Only PDF, JPG or PNG files are accepted');
    else if (f.size > MAX_BYTES) setFileError('The file is larger than 2 MB');
    else return setFile(f);
    setFile(null);
    return undefined;
  }

  const onSubmit = handleSubmit(async (values) => {
    if (inFlight.current || fileError) return;
    inFlight.current = true;
    setSubmitting(true);
    setFormError(null);

    const body = new FormData();
    Object.entries(values).forEach(([k, v]) => {
      if (editing && k === 'customerId') return; // the owner cannot change
      if (typeof v === 'string' && (v.trim() !== '' || (editing && k === 'nameOnDocument'))) body.append(k, v.trim()); // a blank name on edit clears it
    });
    if (file) body.append('file', file);

    try {
      const saved = editing ? await updateDocument(id, body) : await createDocument(body);
      toast.success(editing ? 'Document updated.' : 'Document added. It is Pending until a reviewer verifies it.');
      navigate(`/documents/${saved.id}`);
    } catch (err) {
      Object.entries(err.fields || {}).forEach(([name, message]) => {
        if (name === 'file') setFileError(message);
        else if (name in values) setError(name, { type: 'server', message });
      });
      setFormError(err);
      if (err.status === 0 || err.status >= 500) toast.error(err.message);
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  });

  const loading = types.loading || (editing && existing.loading);
  const d = existing.data;

  return (
    <>
      <PageHeader title={editing ? 'Edit document' : 'Add document'} subtitle={editing ? `Document #${id}` : 'Record a document submitted by an existing customer'}>
        <Link to={editing ? `/documents/${id}` : '/documents'} className="btn btn-secondary">
          ← Back
        </Link>
      </PageHeader>

      {loading && <Spinner label="Loading…" />}
      <ErrorBanner error={types.error || existing.error} onRetry={() => { types.reload(); existing.reload(); }} />

      {!loading && !types.error && !existing.error && (
        <form onSubmit={onSubmit} noValidate className="card space-y-6 p-5 sm:p-6">
          {formError && (
            <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {formError.message}
            </div>
          )}

          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <strong>Use synthetic data only.</strong> Do not enter real PAN, Aadhaar, passport or other identity numbers and do not upload real identity documents. Number and date checks here are format checks, not
            proof that a document is genuine.
          </div>

          {editing && d?.status !== 'Pending' && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900">
              This document is currently <strong>{d?.status}</strong>. If you change the document type, number, dates or file, it goes back to <strong>Pending</strong> for re-verification (the earlier
              decisions stay in the history). Changing only the notes keeps the status.
            </div>
          )}

          <div className="grid gap-5 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Field label="Customer" required error={errors.customerId?.message} hint={editing ? 'The customer cannot be changed after the document is added.' : 'Choose an existing customer'}>
                <Controller
                  name="customerId"
                  control={control}
                  rules={{ required: 'Choose an existing customer' }}
                  render={({ field }) => <CustomerPicker value={field.value} onChange={field.onChange} disabled={editing} invalid={Boolean(errors.customerId)} />}
                />
              </Field>
            </div>

            <Field label="Document type" required error={errors.documentType?.message}>
              <select className={`input ${errors.documentType ? 'input-error' : ''}`} {...register('documentType', { required: 'Document type is required' })}>
                <option value="">Select a document type</option>
                {(types.data ?? []).map((t) => (
                  <option key={t.name}>{t.name}</option>
                ))}
              </select>
            </Field>

            <Field
              label="Document number (synthetic)"
              required={Boolean(requiresNumber) && !editing}
              error={errors.documentNumber?.message}
              hint={editing ? `Currently ${d?.documentNumberMasked || 'none'}. Leave blank to keep it.` : requiresNumber ? 'Required for this document type. Example: SYN-PAN-123456' : 'Optional for this document type'}
            >
              <input
                className={`input ${errors.documentNumber ? 'input-error' : ''}`}
                autoComplete="off"
                placeholder="SYN-PAN-123456"
                {...register('documentNumber', {
                  validate: (v) => {
                    const value = (v || '').trim();
                    if (!value) return requiresNumber && !editing ? 'A document number is required for this document type' : true;
                    return NUMBER_FORMAT.test(value) || 'Use 3-40 characters: letters, digits, dash, slash or space';
                  },
                })}
              />
            </Field>

            <div className="sm:col-span-2">
              <Field
                label="Name printed on the document"
                error={errors.nameOnDocument?.message}
                hint="Copy the name exactly as it appears on the document. It is compared with the customer's registered name: capitals, spacing, titles and initials do not matter. A real difference is flagged for the reviewer, never rejected automatically."
              >
                <input
                  className={`input ${errors.nameOnDocument ? 'input-error' : ''}`}
                  autoComplete="off"
                  maxLength={200}
                  {...register('nameOnDocument', { maxLength: { value: 200, message: 'Use at most 200 characters' } })}
                />
              </Field>
            </div>

            <Field label="Issue date" required error={errors.issueDate?.message}>
              <input
                type="date"
                max={todayIso()}
                className={`input ${errors.issueDate ? 'input-error' : ''}`}
                {...register('issueDate', { validate: { required: (v) => !!v || 'Issue date is required', past: (v) => !v || v <= todayIso() || 'Issue date cannot be in the future' } })}
              />
            </Field>

            <Field label="Expiry date" error={errors.expiryDate?.message} hint="Leave blank if the document does not expire">
              <input
                type="date"
                className={`input ${errors.expiryDate ? 'input-error' : ''}`}
                {...register('expiryDate', { validate: (v) => !v || !issueDate || v >= issueDate || 'Expiry date cannot be before the issue date' })}
              />
            </Field>

            <Field label="Submission date" required error={errors.submissionDate?.message}>
              <input
                type="date"
                max={todayIso()}
                className={`input ${errors.submissionDate ? 'input-error' : ''}`}
                {...register('submissionDate', {
                  validate: {
                    required: (v) => !!v || 'Submission date is required',
                    past: (v) => !v || v <= todayIso() || 'Submission date cannot be in the future',
                    order: (v) => !v || !issueDate || v >= issueDate || 'Submission date cannot be before the issue date',
                  },
                })}
              />
            </Field>

            <Field label="Document file" error={fileError} hint={editing && d?.file ? `Current file: ${d.file.name}. Choose a file to replace it.` : 'Optional. PDF, JPG or PNG, up to 2 MB.'}>
              <input ref={fileInput} type="file" accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png" onChange={pickFile} className="block w-full text-sm text-slate-600 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100" />
            </Field>

            <div className="sm:col-span-2">
              <Field label="Notes" error={errors.notes?.message}>
                <textarea rows={3} maxLength={1000} className={`input ${errors.notes ? 'input-error' : ''}`} {...register('notes', { maxLength: { value: 1000, message: 'Notes must be at most 1000 characters' } })} />
              </Field>
            </div>
          </div>

          <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
            Adding or uploading a document does <strong>not</strong> verify it. It starts as Pending and only a reviewer's decision can mark it Verified. Document numbers are encrypted before storage and shown masked.
            Files are stored on disk, never in the database.
          </p>

          <div className="flex flex-wrap justify-end gap-3 border-t border-slate-100 pt-5">
            <Link to={editing ? `/documents/${id}` : '/documents'} className="btn btn-secondary">
              Cancel
            </Link>
            <button type="submit" className="btn btn-primary min-w-40" disabled={submitting}>
              {submitting ? (
                <>
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" /> Saving…
                </>
              ) : editing ? (
                'Save changes'
              ) : (
                'Add document'
              )}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
