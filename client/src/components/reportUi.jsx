/**
 * Shared Scene 5 UI pieces: badges, KPI cards, the date-range filter, a side panel and a key/value viewer.
 */
import { useEffect, useRef } from 'react';
import { formatDateTime } from '../utils/format';

const PILL = 'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset';

const ALERT_STATUS = {
  New: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  Acknowledged: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  'In Progress': 'bg-teal-50 text-teal-700 ring-teal-600/20',
  Resolved: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  Dismissed: 'bg-slate-100 text-slate-600 ring-slate-500/25',
};
export function AlertStatusBadge({ status }) {
  return <span className={`${PILL} ${ALERT_STATUS[status] || ALERT_STATUS.Dismissed}`}>{status}</span>;
}

const OUTCOME = {
  Passed: { cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', icon: '✓' },
  Failed: { cls: 'bg-red-50 text-red-700 ring-red-600/25', icon: '✕' },
  Warning: { cls: 'bg-amber-50 text-amber-800 ring-amber-600/25', icon: '!' },
  Error: { cls: 'bg-red-50 text-red-700 ring-red-600/25', icon: '✕' },
  Open: { cls: 'bg-sky-50 text-sky-700 ring-sky-600/20', icon: '' },
  Resolved: { cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20', icon: '✓' },
};
/** Passed / Failed / Warning (and issue severities). The word is always shown, never colour alone. */
export function OutcomeBadge({ outcome }) {
  const o = OUTCOME[outcome] || OUTCOME.Open;
  return <span className={`${PILL} ${o.cls}`}>{o.icon && <span aria-hidden="true" className="mr-1">{o.icon}</span>}{outcome}</span>;
}

const CATEGORY = {
  Customer: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  Document: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  Ownership: 'bg-teal-50 text-teal-700 ring-teal-600/20',
  Risk: 'bg-orange-50 text-orange-700 ring-orange-600/25',
  Case: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  Alert: 'bg-red-50 text-red-700 ring-red-600/20',
  Reporting: 'bg-slate-100 text-slate-700 ring-slate-500/25',
};
export function CategoryBadge({ category }) {
  return <span className={`${PILL} ${CATEGORY[category] || CATEGORY.Reporting}`}>{category}</span>;
}

/** A number with a label. `to` turns it into a link elsewhere (use <Link> from the caller). */
export function Kpi({ label, value, hint, accent = 'border-l-slate-400', suffix = '' }) {
  return (
    <div className={`card min-w-0 border-l-4 ${accent} p-4`} title={hint}>
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
        {value === null || value === undefined ? '—' : typeof value === 'number' ? value.toLocaleString('en-IN') : value}
        {value !== null && value !== undefined && suffix}
      </div>
      {hint && <div className="mt-0.5 text-[11px] leading-snug text-slate-500">{hint}</div>}
    </div>
  );
}

/**
 * Date-range filter: Last 7 / 30 / 90 days, all time, or a custom range. Reports its choice through onChange as
 * { range } or { from, to } (what the analytics API takes).
 */
const PRESETS = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
  { key: 'all', label: 'All time' },
  { key: 'custom', label: 'Custom range' },
];
export function DateRangeFilter({ value, onChange, max }) {
  const mode = value.from || value.to ? 'custom' : value.range || '30d';
  const today = max || new Date().toISOString().slice(0, 10);
  return (
    <div className="flex flex-wrap items-end gap-3" role="group" aria-label="Date range">
      <div>
        <label htmlFor="range-preset" className="mb-1 block text-xs font-medium text-slate-600">Period</label>
        <select id="range-preset" className="input" value={mode} onChange={(e) => (e.target.value === 'custom' ? onChange({ from: value.from || today, to: value.to || today }) : onChange({ range: e.target.value }))}>
          {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      </div>
      {mode === 'custom' && (
        <>
          <div>
            <label htmlFor="range-from" className="mb-1 block text-xs font-medium text-slate-600">From</label>
            <input id="range-from" type="date" className="input" max={today} value={value.from || ''} onChange={(e) => onChange({ from: e.target.value, to: value.to || today })} />
          </div>
          <div>
            <label htmlFor="range-to" className="mb-1 block text-xs font-medium text-slate-600">To</label>
            <input id="range-to" type="date" className="input" max={today} min={value.from || undefined} value={value.to || ''} onChange={(e) => onChange({ from: value.from || e.target.value, to: e.target.value })} />
          </div>
        </>
      )}
    </div>
  );
}

/** Slide-over panel for details. Closes with the button, a click on the backdrop, or Escape; focus moves into it. */
export function SidePanel({ title, subtitle, onClose, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-slate-900/40" onClick={onClose}>
      <aside ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={title} className="flex h-full w-full max-w-xl flex-col overflow-y-auto bg-white shadow-xl focus:outline-none" onClick={(e) => e.stopPropagation()}>
        <header className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-200 bg-white px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-lg font-semibold text-slate-900">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
          </div>
          <button type="button" className="btn btn-secondary shrink-0 px-3 py-1.5" onClick={onClose}>Close</button>
        </header>
        <div className="min-w-0 flex-1 px-5 py-4">{children}</div>
      </aside>
    </div>
  );
}

/** Label / value rows. */
export function DetailList({ rows }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,9rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {rows.filter((r) => r).map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-slate-500">{label}</dt>
          <dd className="min-w-0 break-words text-slate-900">{value ?? <span className="text-slate-400">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Previous / new values of an audit event as a small table; nothing is shown when there are none. */
export function ValuesTable({ title, values }) {
  const entries = values && typeof values === 'object' ? Object.entries(values) : [];
  return (
    <div>
      <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">Nothing recorded</p>
      ) : (
        <table className="w-full text-left text-sm">
          <tbody className="divide-y divide-slate-100">
            {entries.map(([k, v]) => (
              <tr key={k}>
                <th scope="row" className="w-2/5 py-1.5 pr-3 align-top font-normal text-slate-500">{k}</th>
                <td className="py-1.5 align-top break-words text-slate-900">{v === null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export const when = formatDateTime;
