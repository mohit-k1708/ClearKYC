/**
 * Small presentational components shared by several pages.
 */
import { Link } from 'react-router-dom';
import { RISK_STYLES } from '../utils/format';

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-3 py-12 text-sm text-slate-500" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      {label}
    </div>
  );
}

/** Shows an API error with an optional retry button. */
export function ErrorBanner({ error, onRetry }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      <span>{error.message}</span>
      {onRetry && (
        <button onClick={onRetry} className="btn btn-secondary !py-1">
          Try again
        </button>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, children }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {children}
    </div>
  );
}

export function RiskBadge({ level }) {
  if (!level) return <span className="text-slate-400">—</span>;
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${RISK_STYLES[level]}`}>{level}</span>;
}

export function StatusBadge({ status }) {
  return <span className="inline-flex rounded-full bg-sky-50 px-2.5 py-0.5 text-xs font-medium text-sky-700 ring-1 ring-inset ring-sky-600/20">{status}</span>;
}

export function TypeBadge({ type }) {
  const style = type === 'Company' ? 'bg-violet-50 text-violet-700 ring-violet-600/20' : 'bg-slate-100 text-slate-700 ring-slate-500/20';
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${style}`}>{type}</span>;
}

export function AddCustomerButton({ children = '+ Add New Customer' }) {
  return (
    <Link to="/customers/new" className="btn btn-primary">
      {children}
    </Link>
  );
}

/** Label + input wrapper that shows the validation message under the field. */
export function Field({ label, error, hint, required, children }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-slate-700">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
      {error && (
        <span role="alert" className="mt-1 block text-xs text-red-600">
          {error}
        </span>
      )}
    </label>
  );
}

export function Pagination({ pagination, onPage }) {
  const { page, totalPages, totalItems, pageSize } = pagination;
  const from = totalItems === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, totalItems);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-sm text-slate-600">
      <span>
        Showing {from}–{to} of {totalItems}
      </span>
      <div className="flex items-center gap-2">
        <button className="btn btn-secondary !py-1" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <span>
          Page {page} of {totalPages}
        </span>
        <button className="btn btn-secondary !py-1" disabled={page >= totalPages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </div>
    </div>
  );
}
