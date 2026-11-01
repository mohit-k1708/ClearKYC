import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import useAsync from '../../hooks/useAsync';
import useDebounce from '../../hooks/useDebounce';
import useReviewer from '../../hooks/useReviewer';
import { RANGE_PRESETS } from '../../hooks/useOverviewRange';
import { searchEverything } from '../../services/overviewApi';
import { Icon } from '../dashboardUi';
import { ROLE_LABELS } from '../reviewUi';

/** Closes a popup when the user clicks elsewhere or presses Escape. */
function useDismiss(open, close) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => ref.current && !ref.current.contains(e.target) && close();
    const onKey = (e) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, close]);
  return ref;
}

const GROUPS = [['customers', 'Customers'], ['documents', 'Documents'], ['cases', 'Review cases']];

/** One search box for customers, documents and review cases, using each list's existing search. */
function GlobalSearch() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const term = useDebounce(text.trim(), 300);
  const close = () => setOpen(false);
  const ref = useDismiss(open, close);
  const { data, loading, error } = useAsync(() => (term.length >= 2 ? searchEverything(term) : Promise.resolve(null)), [term]);
  const all = data ? GROUPS.flatMap(([k]) => data[k]) : [];
  const typing = text.trim().length >= 2;

  function go(item) {
    setOpen(false);
    setText('');
    navigate(item.to);
  }

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <label htmlFor="global-search" className="sr-only">Search customers, documents and review cases</label>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"><Icon name="search" className="h-4 w-4" /></span>
      <input
        id="global-search" type="search" autoComplete="off" role="combobox" aria-expanded={open && typing} aria-controls="global-search-results"
        className="h-10 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm shadow-sm placeholder:text-slate-400 focus:border-[#087F78] focus:outline-none focus:ring-2 focus:ring-[#087F78]/20"
        placeholder="Search customers, documents, review cases…" value={text}
        onChange={(e) => { setText(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' && all[0]) go(all[0]); }}
      />
      {open && typing && (
        <div id="global-search-results" role="listbox" className="absolute left-0 right-0 top-full z-40 mt-2 max-h-96 overflow-y-auto rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
          {(loading || term !== text.trim()) && <p className="px-3 py-2 text-sm text-slate-500" role="status">Searching…</p>}
          {error && <p className="px-3 py-2 text-sm text-red-700" role="alert">{error.message}</p>}
          {data && term === text.trim() && all.length === 0 && <p className="px-3 py-3 text-sm text-slate-500">Nothing found for “{term}”.</p>}
          {data && term === text.trim() && GROUPS.map(([key, label]) => data[key].length > 0 && (
            <div key={key} className="mb-1">
              <div className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
              {data[key].map((item) => (
                <button key={item.key} type="button" role="option" aria-selected="false" onClick={() => go(item)} className="block w-full rounded-lg px-3 py-2 text-left hover:bg-slate-50 focus:bg-slate-50 focus:outline-none">
                  <span className="block truncate text-sm font-medium text-slate-900">{item.title}</span>
                  <span className="block truncate text-xs text-slate-500">{item.sub}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Compact date filter for the top bar. Picking a preset updates every analytics figure on the page. */
function RangeSelect({ range, onChange }) {
  return (
    <div className="relative">
      <label htmlFor="range-top" className="sr-only">Date range</label>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"><Icon name="calendar" className="h-4 w-4" /></span>
      <select id="range-top" value={range.key === 'custom' ? 'custom' : range.key} onChange={(e) => e.target.value !== 'custom' && onChange({ range: e.target.value })}
        className="h-10 appearance-none rounded-xl border border-slate-200 bg-white pl-9 pr-8 text-sm font-medium text-slate-700 shadow-sm focus:border-[#087F78] focus:outline-none focus:ring-2 focus:ring-[#087F78]/20">
        {RANGE_PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        {range.key === 'custom' && <option value="custom">Custom range</option>}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400"><Icon name="chevron" className="h-4 w-4" /></span>
    </div>
  );
}

const initials = (name) => name.replace(/\(.*\)/, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/** Who is "acting": name, role, and a menu to switch person (the prototype has no login). */
function ProfileMenu() {
  const { current, reviewers, select } = useReviewer();
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} aria-label="Switch person"
        className="flex h-10 items-center gap-2.5 rounded-xl border border-slate-200 bg-white pl-1.5 pr-3 shadow-sm hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-[#087F78]/30">
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[#087F78] text-xs font-semibold text-white">{current ? initials(current.name) : '?'}</span>
        <span className="hidden text-left leading-tight md:block">
          <span className="block max-w-[9rem] truncate text-sm font-medium text-slate-900">{current ? current.name.replace(/\s*\(demo\)/, '') : 'Choose a person'}</span>
          <span className="block text-[11px] text-slate-500">{current ? ROLE_LABELS[current.role] || current.role : 'Not signed in'}</span>
        </span>
        <Icon name="chevron" className="hidden h-4 w-4 text-slate-400 md:block" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-40 mt-2 w-72 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
          <p className="px-3 pb-1 pt-1 text-[11px] leading-snug text-slate-500">Prototype: there is no login. Choose who you are acting as; your role decides what you can do.</p>
          {reviewers.map((r) => (
            <button key={r.id} type="button" role="menuitemradio" aria-checked={current?.id === r.id} onClick={() => { select(String(r.id)); setOpen(false); }}
              className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-slate-50 ${current?.id === r.id ? 'bg-teal-50' : ''}`}>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{initials(r.name)}</span>
              <span className="min-w-0"><span className="block truncate text-sm text-slate-900">{r.name.replace(/\s*\(demo\)/, '')}</span><span className="block text-[11px] text-slate-500">{ROLE_LABELS[r.role] || r.role}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Top bar of the Overview: search, date filter, notifications (new alerts) and profile. */
export default function TopBar({ range, onRange, newAlerts }) {
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <GlobalSearch />
      <div className="flex items-center gap-3">
        <RangeSelect range={range} onChange={onRange} />
        <Link to="/alerts?status=New" aria-label={newAlerts ? `${newAlerts} new alerts` : 'No new alerts'} title="New alerts"
          className="relative flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50">
          <Icon name="bell" />
          {newAlerts > 0 && <span className="absolute -right-1.5 -top-1.5 flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-[#F04444] px-1 text-[11px] font-semibold text-white">{newAlerts > 99 ? '99+' : newAlerts}</span>}
        </Link>
        <ProfileMenu />
      </div>
    </div>
  );
}
