import { useState } from 'react';
import { Link } from 'react-router-dom';
import useReviewer from '../../hooks/useReviewer';
import { RANGE_PRESETS } from '../../hooks/useOverviewRange';
import { formatDate } from '../../utils/format';

const greeting = (hour) => (hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening');

/** A small abstract "secure check" illustration. Purely decorative. */
function Illustration() {
  return (
    <svg viewBox="0 0 220 120" className="h-24 w-auto" aria-hidden="true">
      <rect x="10" y="30" width="110" height="72" rx="10" fill="#fff" opacity=".14" />
      <rect x="24" y="46" width="52" height="7" rx="3.5" fill="#fff" opacity=".7" />
      <rect x="24" y="60" width="82" height="6" rx="3" fill="#fff" opacity=".35" />
      <rect x="24" y="72" width="70" height="6" rx="3" fill="#fff" opacity=".35" />
      <rect x="24" y="84" width="40" height="6" rx="3" fill="#fff" opacity=".35" />
      <circle cx="160" cy="58" r="38" fill="#fff" opacity=".12" />
      <path d="M160 30l26 9v18c0 17-11 30-26 35-15-5-26-18-26-35V39l26-9z" fill="#16B978" />
      <path d="M149 60l8 8 15-16" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="198" cy="26" r="5" fill="#F5A623" /><circle cx="206" cy="92" r="4" fill="#318CF5" /><circle cx="120" cy="14" r="3" fill="#fff" opacity=".6" />
    </svg>
  );
}

/** Greeting, one-line summary and the full date-range selector (presets and a custom range). */
export default function Welcome({ range, onRange }) {
  const { current } = useReviewer();
  const [custom, setCustom] = useState(range.key === 'custom');
  const first = current ? current.name.replace(/\s*\(demo\)/, '').split(' ')[0] : '';
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="mb-5 overflow-hidden rounded-2xl bg-gradient-to-r from-[#064C4B] to-[#087F78] p-5 text-white shadow-sm sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">{greeting(new Date().getHours())}{first ? `, ${first}` : ''} <span aria-hidden="true">👋</span></h1>
          <p className="mt-1 text-sm text-teal-50/90">Here&apos;s a summary of your KYC operations.</p>
          <div className="mt-4 flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
            {RANGE_PRESETS.map((p) => (
              <button key={p.key} type="button" onClick={() => { setCustom(false); onRange({ range: p.key }); }} aria-pressed={range.key === p.key}
                className={`rounded-full px-3 py-1 text-xs font-medium transition ${range.key === p.key ? 'bg-white text-[#064C4B]' : 'bg-white/15 text-white hover:bg-white/25'}`}>{p.label}</button>
            ))}
            <button type="button" onClick={() => { setCustom(true); if (range.key !== 'custom') onRange({ from: range.from || today, to: range.to || today }); }} aria-pressed={range.key === 'custom'}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${range.key === 'custom' ? 'bg-white text-[#064C4B]' : 'bg-white/15 text-white hover:bg-white/25'}`}>Custom</button>
          </div>
          {custom && (
            <div className="mt-3 flex flex-wrap items-end gap-3 text-xs">
              <label className="flex flex-col gap-1"><span className="text-teal-50/90">From</span>
                <input type="date" max={today} value={range.from || ''} onChange={(e) => e.target.value && onRange({ from: e.target.value, to: range.to && range.to >= e.target.value ? range.to : e.target.value })} className="rounded-lg border-0 bg-white px-2 py-1.5 text-slate-900" /></label>
              <label className="flex flex-col gap-1"><span className="text-teal-50/90">To</span>
                <input type="date" max={today} min={range.from || undefined} value={range.to || ''} onChange={(e) => e.target.value && onRange({ from: range.from || e.target.value, to: e.target.value })} className="rounded-lg border-0 bg-white px-2 py-1.5 text-slate-900" /></label>
            </div>
          )}
          <p className="mt-3 text-xs text-teal-50/80" aria-live="polite">
            Showing: <strong className="font-semibold text-white">{range.label}</strong>{range.from ? ` (${formatDate(range.from)} – ${formatDate(range.to)})` : ''}
          </p>
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          <Link to="/customers/new" className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2 text-sm font-semibold text-[#064C4B] shadow-sm transition hover:bg-teal-50">+ Add New Customer</Link>
          <div className="hidden sm:block"><Illustration /></div>
        </div>
      </div>
    </div>
  );
}
