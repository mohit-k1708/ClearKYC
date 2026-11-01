/**
 * Shared Scene 3 UI pieces: ownership status, screening outcome and overall-result badges, the ownership
 * structure bar, and the risk reasons list.
 */
import { RiskBadge } from './ui';
import { formatDateTime } from '../utils/format';

const PILL = 'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset';

// ---- Ownership validation status -----------------------------------------------------------------
const OWNERSHIP = {
  RECONCILED: { label: 'Reconciled', style: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  EXCEEDS_100: { label: 'Exceeds 100%', style: 'bg-red-50 text-red-700 ring-red-600/20' },
  BELOW_100: { label: 'Below 100%', style: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  MISSING_PERCENTAGE: { label: 'Missing percentage', style: 'bg-orange-50 text-orange-700 ring-orange-600/20' },
  NO_OWNERS: { label: 'No owners', style: 'bg-slate-100 text-slate-600 ring-slate-500/30' },
};
export const OWNERSHIP_STATUS_LABELS = Object.fromEntries(Object.entries(OWNERSHIP).map(([k, v]) => [k, v.label]));

export function OwnershipStatusBadge({ status }) {
  const s = OWNERSHIP[status];
  if (!s) return <span className="text-slate-400">—</span>;
  return <span className={`${PILL} ${s.style}`}>{s.label}</span>;
}

// ---- Screening outcome: four distinct states --------------------------------------------------------
const SCREENING = {
  Confirmed: 'bg-red-100 text-red-800 ring-red-700/30',
  'Potential Match': 'bg-amber-50 text-amber-800 ring-amber-600/30',
  'No Match': 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  'Not Screened': 'bg-white text-slate-500 ring-slate-400/50 border border-dashed border-slate-300',
};
export function ScreeningBadge({ outcome, label }) {
  return (
    <span className={`${PILL} ${SCREENING[outcome] || SCREENING['Not Screened']}`} title={outcome === 'Potential Match' ? 'A possible match that needs investigation. It is NOT confirmed.' : undefined}>
      {label ? `${label}: ` : ''}
      {outcome}
    </span>
  );
}

// ---- Overall result: the score band and the manual-review flag are separate ---------------------------
export function OverallResult({ level, status }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <RiskBadge level={level} />
      {status === 'Requires Manual Review' && <span className={`${PILL} bg-violet-50 text-violet-700 ring-violet-600/25`}>Requires manual review</span>}
    </span>
  );
}

/** Previous level -> new level, highlighted when it changed. */
export function LevelChange({ previous, next }) {
  if (!previous) return <span className="inline-flex items-center gap-1.5 text-xs text-slate-500"><RiskBadge level={next} /> first rating</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <RiskBadge level={previous} />
      <span className={previous === next ? 'text-slate-400' : 'font-bold text-slate-700'} aria-label={previous === next ? 'unchanged' : 'changed to'}>→</span>
      <RiskBadge level={next} />
    </span>
  );
}

// ---- Ownership structure bar -----------------------------------------------------------------------------
const SEGMENT_COLORS = ['bg-teal-600', 'bg-sky-600', 'bg-indigo-500', 'bg-emerald-600', 'bg-cyan-700', 'bg-violet-500', 'bg-lime-700', 'bg-blue-700'];

/**
 * Shows each owner's share of the company. The bar always represents max(100%, total): a gap is drawn
 * when the owners add up to less than 100%, and the bar is flagged when they add up to more.
 */
export function OwnershipBar({ owners, total }) {
  const known = owners.filter((o) => o.ownershipPercentage != null);
  const scale = Math.max(100, total);
  const gap = total < 100 ? 100 - total : 0;
  return (
    <div>
      <div className={`flex h-9 w-full overflow-hidden rounded-lg ring-1 ${total > 100 ? 'ring-red-400' : 'ring-slate-200'}`} role="img" aria-label={`Ownership: ${total}% of 100% accounted for`}>
        {known.map((o, i) => (
          <div key={o.id} className={`${SEGMENT_COLORS[i % SEGMENT_COLORS.length]} flex min-w-0 items-center justify-center overflow-hidden border-r border-white/60 px-1 text-[11px] font-medium text-white`} style={{ width: `${(o.ownershipPercentage / scale) * 100}%` }} title={`${o.fullName}: ${o.ownershipPercentage}%`}>
            {o.ownershipPercentage >= 8 ? `${o.ownershipPercentage}%` : ''}
          </div>
        ))}
        {gap > 0 && (
          <div className="flex min-w-0 items-center justify-center text-[11px] font-medium text-slate-600" style={{ width: `${(gap / scale) * 100}%`, backgroundImage: 'repeating-linear-gradient(45deg, #e2e8f0, #e2e8f0 6px, #f8fafc 6px, #f8fafc 12px)' }} title={`${gap}% not accounted for`}>
            {gap >= 8 ? `${gap}% unaccounted` : ''}
          </div>
        )}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600">
        {known.map((o, i) => (
          <li key={o.id} className="flex items-center gap-1.5">
            <span className={`inline-block h-2.5 w-2.5 rounded-sm ${SEGMENT_COLORS[i % SEGMENT_COLORS.length]}`} aria-hidden="true" />
            {o.fullName} <span className="tabular-nums text-slate-500">{o.ownershipPercentage}%</span>
          </li>
        ))}
        {gap > 0 && <li className="flex items-center gap-1.5 text-slate-500"><span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-slate-400" aria-hidden="true" />Unaccounted {gap}%</li>}
      </ul>
      {total > 100 && <p className="mt-2 text-xs font-medium text-red-700">The owners add up to {total}%, which is more than 100%.</p>}
    </div>
  );
}

// ---- Risk reasons ---------------------------------------------------------------------------------------------
const SOURCE_LABEL = { baseline: 'Customer baseline', ownership: 'Beneficial owners', validation: 'Ownership validation', cap: 'Cap' };

export function ReasonsTable({ reasons }) {
  if (!reasons?.length) return <p className="text-sm text-slate-500">No reasons recorded.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="py-2 pr-4">Factor</th>
            <th className="py-2 pr-4">Reason</th>
            <th className="py-2 text-right">Points</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {reasons.map((r, i) => (
            <tr key={i}>
              <td className="py-2 pr-4 align-top font-medium text-slate-900">
                {r.factor}
                {r.simulated && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Simulated</span>}
                {r.source && SOURCE_LABEL[r.source] && <div className="text-[11px] font-normal text-slate-400">{SOURCE_LABEL[r.source]}</div>}
              </td>
              <td className="py-2 pr-4 text-slate-600">{r.description}</td>
              <td className="py-2 text-right tabular-nums">{r.points >= 0 ? '+' : ''}{r.points}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Why an assessment says "Requires Manual Review". A review is not a rejection. */
export function ManualReviewReasons({ items }) {
  if (!items?.length) return null;
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
      <p className="font-medium">Requires manual review. This is not a rejection: the customer stays registered while these points are investigated.</p>
      <ul className="mt-2 list-disc space-y-1 pl-5">
        {items.map((m) => (
          <li key={m.code + m.message}>{m.message}</li>
        ))}
      </ul>
    </div>
  );
}

export function ScoreComponents({ components }) {
  if (!components) return null;
  const rows = [
    ['Customer baseline (Scene 1 rules)', components.baseline],
    ['Beneficial owner risk', components.ownership],
    ['Ownership complexity', components.complexity],
    ['Ownership validation', components.validation],
    ...(components.cap ? [['Score cap', components.cap]] : []),
  ];
  return (
    <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-3 border-b border-dashed border-slate-200 py-1">
          <dt className="text-slate-500">{label}</dt>
          <dd className="font-medium tabular-nums">{value >= 0 ? '+' : ''}{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function AssessedBy({ person, date }) {
  return (
    <span className="text-xs text-slate-500">
      {person?.name || 'System'} {person?.role && person.role !== 'System' ? `(${person.role})` : ''} · {formatDateTime(date)}
    </span>
  );
}
