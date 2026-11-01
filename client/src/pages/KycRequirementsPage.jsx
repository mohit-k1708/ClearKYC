import { useState } from 'react';
import { listRequirements, createRequirement, updateRequirement, setRequirementActive, getDocumentTypes } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import { useToast } from '../components/Toast';
import { ErrorBanner, Field, PageHeader, Spinner, TypeBadge, RiskBadge } from '../components/ui';
import { formatDate } from '../utils/format';
import { todayIso } from '../utils/validators';

const EMPTY = { customerType: 'Individual', riskLevel: 'Low', documentType: '', isMandatory: true, effectiveFrom: todayIso(), effectiveTo: '', isActive: true };

/**
 * KYC Requirements: which documents each customer type + risk level must provide.
 * These are configurable SAMPLE business rules, not universal regulatory requirements.
 */
export default function KycRequirementsPage() {
  const toast = useToast();
  const [filters, setFilters] = useState({ customerType: '', riskLevel: '', isActive: '' });
  const { data, loading, error, reload } = useAsync(() => listRequirements(Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== ''))), [filters]);
  const types = useAsync(getDocumentTypes, []);

  const [editor, setEditor] = useState(null); // null = closed, { id?: number, values }
  const [busyId, setBusyId] = useState(null);

  const rows = data ?? [];
  const setFilter = (k) => (e) => setFilters((f) => ({ ...f, [k]: e.target.value }));

  async function toggle(r) {
    setBusyId(r.id);
    try {
      await setRequirementActive(r.id, !r.isActive);
      toast.success(`Requirement ${r.isActive ? 'deactivated' : 'activated'}.`);
      reload();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader title="KYC requirements" subtitle="Which documents each kind of customer must provide. Higher-risk customers need more.">
        <button type="button" className="btn btn-primary" onClick={() => setEditor({ values: { ...EMPTY } })}>
          + Add Requirement
        </button>
      </PageHeader>

      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        These are <strong>configurable sample business rules</strong>, not universal regulatory requirements. A change here immediately changes the KYC completeness of every customer it applies to.
      </div>

      {editor && (
        <RequirementForm
          key={editor.id ?? 'new'}
          initial={editor.values}
          id={editor.id}
          documentTypes={(types.data ?? []).map((t) => t.name)}
          onCancel={() => setEditor(null)}
          onSaved={() => {
            setEditor(null);
            reload();
          }}
        />
      )}

      <div className="card">
        <div className="grid gap-3 p-4 sm:grid-cols-3">
          <select className="input" value={filters.customerType} onChange={setFilter('customerType')} aria-label="Filter by customer type">
            <option value="">All customer types</option>
            <option>Individual</option>
            <option>Company</option>
          </select>
          <select className="input" value={filters.riskLevel} onChange={setFilter('riskLevel')} aria-label="Filter by risk level">
            <option value="">All risk levels</option>
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
          </select>
          <select className="input" value={filters.isActive} onChange={setFilter('isActive')} aria-label="Filter by active state">
            <option value="">Active and inactive</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </select>
        </div>

        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? (
          <Spinner label="Loading requirements…" />
        ) : (
          <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Customer type</th>
                  <th className="px-4 py-3">Risk level</th>
                  <th className="px-4 py-3">Document</th>
                  <th className="px-4 py-3">Mandatory</th>
                  <th className="px-4 py-3">Effective</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.id} className={r.isActive ? 'hover:bg-slate-50' : 'bg-slate-50/60 text-slate-500'}>
                    <td className="px-4 py-3"><TypeBadge type={r.customerType} /></td>
                    <td className="px-4 py-3"><RiskBadge level={r.riskLevel} /></td>
                    <td className="px-4 py-3 font-medium text-slate-900">{r.documentType}</td>
                    <td className="px-4 py-3">{r.isMandatory ? <span className="font-medium text-slate-800">Mandatory</span> : <span className="text-slate-500">Optional</span>}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">
                      {formatDate(r.effectiveFrom)} → {r.effectiveTo ? formatDate(r.effectiveTo) : 'open-ended'}
                    </td>
                    <td className="px-4 py-3">
                      {!r.isActive ? (
                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600 ring-1 ring-inset ring-slate-500/20">Inactive</span>
                      ) : r.inEffect ? (
                        <span className="inline-flex rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700 ring-1 ring-inset ring-emerald-600/20">In effect</span>
                      ) : (
                        <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">Outside dates</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-right">
                      <button type="button" className="mr-3 font-medium text-brand-700 hover:underline" onClick={() => setEditor({ id: r.id, values: { customerType: r.customerType, riskLevel: r.riskLevel, documentType: r.documentType, isMandatory: r.isMandatory, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo || '', isActive: r.isActive } })}>
                        Edit
                      </button>
                      <button type="button" className="font-medium text-slate-700 hover:underline disabled:opacity-50" disabled={busyId === r.id} onClick={() => toggle(r)}>
                        {r.isActive ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-slate-500">
                      No requirements match. Load the sample rules with <code className="rounded bg-slate-100 px-1.5 py-0.5">npm run generate:kyc</code> or add one.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-slate-100 px-4 py-3 text-xs text-slate-500">{rows.length} requirement{rows.length === 1 ? '' : 's'} shown.</p>
      </div>
    </>
  );
}

/** Add / edit form (shown above the table). The server validates and rejects overlapping active rules. */
function RequirementForm({ initial, id, documentTypes, onCancel, onSaved }) {
  const toast = useToast();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  function validate() {
    const errs = {};
    if (values.documentType.trim().length < 2) errs.documentType = 'Document type is required';
    if (!values.effectiveFrom) errs.effectiveFrom = 'Effective from is required';
    if (values.effectiveTo && values.effectiveFrom && values.effectiveTo < values.effectiveFrom) errs.effectiveTo = 'Effective to must be on or after Effective from';
    return errs;
  }

  async function submit(e) {
    e.preventDefault();
    const errs = validate();
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setSaving(true);
    const body = { ...values, documentType: values.documentType.trim(), effectiveTo: values.effectiveTo || null };
    try {
      if (id) await updateRequirement(id, body);
      else await createRequirement(body);
      toast.success(id ? 'Requirement updated.' : 'Requirement added.');
      onSaved();
    } catch (err) {
      setErrors(err.fields || {});
      setFormError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="card mb-4 space-y-4 p-5">
      <h2 className="text-base font-semibold">{id ? 'Edit requirement' : 'Add requirement'}</h2>
      {formError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {formError.message}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Customer type" required error={errors.customerType}>
          <select className="input" value={values.customerType} onChange={set('customerType')}>
            <option>Individual</option>
            <option>Company</option>
          </select>
        </Field>
        <Field label="Risk level" required error={errors.riskLevel}>
          <select className="input" value={values.riskLevel} onChange={set('riskLevel')}>
            <option>Low</option>
            <option>Medium</option>
            <option>High</option>
          </select>
        </Field>
        <Field label="Document type" required error={errors.documentType} hint="Pick a known type or type a new one">
          <input className={`input ${errors.documentType ? 'input-error' : ''}`} list="requirement-doc-types" value={values.documentType} onChange={set('documentType')} />
          <datalist id="requirement-doc-types">
            {documentTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </Field>
        <Field label="Effective from" required error={errors.effectiveFrom}>
          <input type="date" className={`input ${errors.effectiveFrom ? 'input-error' : ''}`} value={values.effectiveFrom} onChange={set('effectiveFrom')} />
        </Field>
        <Field label="Effective to" error={errors.effectiveTo} hint="Leave blank for no end date">
          <input type="date" className={`input ${errors.effectiveTo ? 'input-error' : ''}`} value={values.effectiveTo} onChange={set('effectiveTo')} />
        </Field>
        <div className="flex flex-col justify-end gap-2 pb-1 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={values.isMandatory} onChange={set('isMandatory')} /> Mandatory (counts toward completeness)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={values.isActive} onChange={set('isActive')} /> Active
          </label>
        </div>
      </div>
      <div className="flex justify-end gap-3">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary min-w-32" disabled={saving}>
          {saving ? 'Saving…' : id ? 'Save changes' : 'Add requirement'}
        </button>
      </div>
    </form>
  );
}
