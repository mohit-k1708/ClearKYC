import { useState } from 'react';
import { downloadExport, getExportCatalog } from '../services/reportApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, PageHeader, Spinner } from '../components/ui';

const RISK = ['Low', 'Medium', 'High'];
const SEVERITY = ['Low', 'Medium', 'High', 'Critical'];
const dateFilters = [
  { name: 'from', label: 'From date', type: 'date' },
  { name: 'to', label: 'To date', type: 'date' },
];

// What each report offers. Filters are applied by the server BEFORE the file is created.
const REPORTS = {
  customers: { description: 'Customer register with masked PAN, Aadhaar, e-mail and phone, and the current risk level.', filters: [
    { name: 'customerType', label: 'Customer type', options: ['Individual', 'Company'] }, { name: 'riskLevel', label: 'Risk level', options: RISK }, { name: 'search', label: 'Name or customer ID', type: 'text' }, ...dateFilters] },
  documents: { description: 'Every document with its verification status and expiry state. Document numbers are masked.', filters: [
    { name: 'status', label: 'Verification status', options: ['Pending', 'In Review', 'Verified', 'Rejected', 'Requires Resubmission'] }, { name: 'expiry', label: 'Expiry state', options: ['Valid', 'Expiring Soon', 'Expired', 'No Expiry'] }, { name: 'customerId', label: 'Customer ID', type: 'text', placeholder: 'CUS-000001' },
    { name: 'from', label: 'Submitted from', type: 'date' }, { name: 'to', label: 'Submitted to', type: 'date' }] },
  completeness: { description: 'KYC completeness for each customer, calculated now from documents and requirements.', filters: [
    { name: 'customerType', label: 'Customer type', options: ['Individual', 'Company'] }, { name: 'riskLevel', label: 'Risk level', options: RISK }, { name: 'completeness', label: 'Completeness', options: ['Complete', 'Partially Complete', 'Not Started', 'No Requirements'] },
    { name: 'from', label: 'Onboarded from', type: 'date' }, { name: 'to', label: 'Onboarded to', type: 'date' }] },
  risks: { description: 'The full risk assessment history, including scores, levels and who assessed.', filters: [
    { name: 'riskLevel', label: 'Risk level', options: RISK }, { name: 'assessmentStatus', label: 'Assessment status', options: ['Completed', 'Requires Manual Review'] }, { name: 'customerId', label: 'Customer ID', type: 'text', placeholder: 'CUS-000001' },
    { name: 'from', label: 'Assessed from', type: 'date' }, { name: 'to', label: 'Assessed to', type: 'date' }] },
  ownership: { description: 'Beneficial owners with ownership percentages and the latest screening results (possible matches stay possible).', filters: [
    { name: 'customerId', label: 'Company customer ID', type: 'text', placeholder: 'CUS-000001' }, { name: 'screening', label: 'Screening result', options: ['Potential Match', 'Confirmed', 'No Match', 'Not Screened'] }] },
  'review-cases': { description: 'Review cases with owners, due dates and overdue flags.', filters: [
    { name: 'status', label: 'Status', options: ['active', 'Open', 'Assigned', 'In Progress', 'Pending Customer', 'Escalated', 'Resolved', 'Closed'] }, { name: 'priority', label: 'Priority', options: SEVERITY },
    { name: 'customerId', label: 'Customer ID', type: 'text', placeholder: 'CUS-000001' }, { name: 'from', label: 'Opened from', type: 'date' }, { name: 'to', label: 'Opened to', type: 'date' }] },
  alerts: { description: 'All alerts with their status, source record and resolution.', filters: [
    { name: 'status', label: 'Status', options: ['active', 'all', 'closed', 'New', 'Acknowledged', 'In Progress', 'Resolved', 'Dismissed'] }, { name: 'severity', label: 'Severity', options: SEVERITY }, { name: 'customerId', label: 'Customer ID', type: 'text', placeholder: 'CUS-000001' },
    { name: 'from', label: 'Raised from', type: 'date' }, { name: 'to', label: 'Raised to', type: 'date' }] },
  'audit-events': { description: 'The audit trail: who did what, when and why. Previous and new values are included; sensitive identifiers never are.', filters: [
    { name: 'category', label: 'Category', options: ['Customer', 'Document', 'Ownership', 'Risk', 'Case', 'Alert', 'Reporting'] }, { name: 'customerId', label: 'Customer ID', type: 'text', placeholder: 'CUS-000001' }, ...dateFilters] },
  'seed-data': { description: 'Synthetic records of every table as JSON (seed 20261022). Identifiers are masked; secrets and dates of birth are left out.', filters: [] },
  schema: { description: 'The live database structure as SQL: tables, constraints, indexes, triggers and functions. No data.', filters: [] },
};

function ReportCard({ item, disabledReason }) {
  const def = REPORTS[item.key];
  const [values, setValues] = useState({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const toast = useToast();
  const set = (name, value) => { setValues((v) => ({ ...v, [name]: value })); setDone(null); };
  const rangeBad = values.from && values.to && values.from > values.to;
  const idBad = values.customerId && !/^CUS-\d{6,}$/i.test(values.customerId);

  async function download() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const params = Object.fromEntries(Object.entries(values).filter(([, v]) => v).map(([k, v]) => [k, k === 'customerId' ? v.toUpperCase() : v]));
      const r = await downloadExport(item.key, params);
      setDone(r);
      toast.success(`${item.label} downloaded`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card flex min-w-0 flex-col p-4 ${disabledReason ? 'bg-slate-50' : ''}`} aria-label={item.label} data-export={item.key}>
      <div className="flex items-start justify-between gap-3">
        <h2 className="text-base font-semibold text-slate-900">{item.label}</h2>
        <span className="shrink-0 rounded bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase text-slate-600">{item.format}</span>
      </div>
      <p className="mt-1 text-sm text-slate-600">{def.description}</p>
      {item.sensitive && <p className="mt-1 text-xs text-violet-700">Sensitive report: Compliance Reviewer or Administrator only.</p>}
      {def.filters.length > 0 && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {def.filters.map((f) => (
            <div key={f.name} className="min-w-0">
              <label htmlFor={`${item.key}-${f.name}`} className="mb-1 block text-xs font-medium text-slate-600">{f.label}</label>
              {f.options ? (
                <select id={`${item.key}-${f.name}`} className="input" disabled={Boolean(disabledReason)} value={values[f.name] || ''} onChange={(e) => set(f.name, e.target.value)}>
                  <option value="">Any</option>
                  {f.options.map((o) => <option key={o}>{o}</option>)}
                </select>
              ) : (
                <input id={`${item.key}-${f.name}`} type={f.type} className="input" disabled={Boolean(disabledReason)} placeholder={f.placeholder} value={values[f.name] || ''} onChange={(e) => set(f.name, e.target.value.trim())} />
              )}
            </div>
          ))}
        </div>
      )}
      {rangeBad && <p className="mt-2 text-xs text-red-600">The start date must not be after the end date.</p>}
      {idBad && <p className="mt-2 text-xs text-red-600">Customer ID must look like CUS-000001.</p>}
      <div className="mt-auto pt-4">
        <ErrorBanner error={error} />
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn btn-primary" onClick={download} disabled={busy || Boolean(disabledReason) || rangeBad || idBad} title={disabledReason || undefined}>
            {busy ? 'Preparing…' : `Download ${item.format.toUpperCase()}`}
          </button>
          {disabledReason && <span className="text-xs text-slate-500">{disabledReason}</span>}
          {done && <span className="text-xs text-emerald-700" role="status">{done.filename}{item.format === 'csv' ? ` · ${done.rows} row${done.rows === 1 ? '' : 's'}` : ''}</span>}
        </div>
      </div>
    </article>
  );
}

/** Reports & Exports: choose filters, download. Every export is recorded in the audit trail. */
export default function ReportsPage() {
  const { current: person } = useReviewer();
  const personId = person?.id ?? null;
  const { data, loading, error, reload } = useAsync(getExportCatalog, [personId]);
  return (
    <>
      <PageHeader title="Reports & exports" subtitle="Download CSV, JSON and SQL files built from the current records" />
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
        Files are UTF-8. Full PAN and Aadhaar numbers are never exported: they are masked, as are document numbers, e-mail and phone. Filters are applied before the file is created, and every export is written to the audit trail.
      </div>
      {!person && <p className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">Choose who you are acting as (sidebar) to export reports.</p>}
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data && <Spinner label="Loading reports…" />}
      {data && (
        <div className="grid gap-4 lg:grid-cols-2">
          {data.map((item) => (
            <ReportCard key={`${item.key}-${personId}`} item={item} disabledReason={!person ? 'Choose a person first' : !item.allowed ? 'Your role cannot export this report' : ''} />
          ))}
        </div>
      )}
    </>
  );
}
