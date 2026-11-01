import { Link } from 'react-router-dom';

// Overview palette (from the design brief). Status colours are used the same way everywhere on the page.
export const C = {
  sidebar: '#064C4B',
  teal: '#087F78',
  page: '#F3F7FB',
  low: '#16B978',
  medium: '#F5A623',
  high: '#F04444',
  info: '#318CF5',
  purple: '#7C5CE0',
  slate: '#94A3B8',
};

export function Skeleton({ className = 'h-24' }) {
  return <div className={`animate-pulse rounded-lg bg-slate-100 ${className}`} aria-hidden="true" />;
}

/**
 * A white dashboard card with a title, an optional "now / in period" tag, a "View all" link and built-in loading, error and
 * empty states, so every section of the Overview behaves the same way when data is slow, missing or the API fails.
 */
export default function Panel({ title, subtitle, tag, action, loading, error, onRetry, empty, emptyText = 'Nothing to show yet.', children, className = '', id }) {
  return (
    <section className={`flex min-w-0 flex-col rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm sm:p-5 ${className}`} aria-labelledby={id}>
      <header className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 id={id} className="text-[15px] font-semibold text-slate-900">{title}</h2>
          {subtitle && <p className="text-xs text-slate-500">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {tag && <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">{tag}</span>}
          {action && <Link to={action.to} className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-[#087F78] transition hover:bg-slate-50">{action.label}</Link>}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        {error ? (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
            <span>{error.message || 'This section could not be loaded.'}</span>
            {onRetry && <button type="button" onClick={onRetry} className="rounded-md border border-red-200 bg-white px-2.5 py-1 text-xs font-medium hover:bg-red-100">Try again</button>}
          </div>
        ) : loading ? (
          <div className="space-y-2" role="status" aria-label={`Loading ${title}`}><Skeleton className="h-4 w-1/3" /><Skeleton className="h-28" /></div>
        ) : empty ? (
          <p className="py-8 text-center text-sm text-slate-500">{emptyText}</p>
        ) : children}
      </div>
    </section>
  );
}
