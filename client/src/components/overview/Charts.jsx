import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import Panel, { C } from './Panel';

const fmt = (v) => Number(v).toLocaleString('en-IN');

/**
 * Donut with the total in the centre and a legend of label, count and share. Every legend row can link to the filtered list
 * it explains. `items` is [{ name, value, color, to? }]; `extra` shows a legend row that is NOT part of the donut (and says so).
 */
export function DonutPanel({ id, title, subtitle, tag, action, items, unit, centerLabel, extra, note, loading, error, onRetry }) {
  const total = items.reduce((s, i) => s + i.value, 0);
  const shown = items.filter((i) => i.value > 0);
  return (
    <Panel id={id} title={title} subtitle={subtitle} tag={tag} action={action} loading={loading} error={error} onRetry={onRetry} empty={!loading && total === 0 && !extra?.value} emptyText="No records yet.">
      <div className="flex flex-col items-center gap-4">
        <div className="relative h-40 w-40 shrink-0" role="img" aria-label={`${title}: ${items.map((i) => `${i.name} ${i.value}`).join(', ')}`}>
          <ResponsiveContainer>
            <PieChart>
              <Pie isAnimationActive={false} data={shown.length ? shown : [{ name: 'none', value: 1 }]} dataKey="value" nameKey="name" innerRadius="66%" outerRadius="100%" paddingAngle={shown.length > 1 ? 2 : 0} stroke="none">
                {(shown.length ? shown : [{ name: 'none', color: '#E2E8F0' }]).map((i) => <Cell key={i.name} fill={i.color} />)}
              </Pie>
              <Tooltip formatter={(v, n) => [`${fmt(v)} ${unit}`, n]} />
            </PieChart>
          </ResponsiveContainer>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
            <span className="text-2xl font-semibold tabular-nums text-slate-900">{fmt(total)}</span>
            <span className="text-[11px] text-slate-500">{centerLabel}</span>
          </div>
        </div>
        <ul className="w-full min-w-0 space-y-0.5">
          {items.map((i) => {
            const row = (
              <>
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: i.color }} aria-hidden="true" />
                <span className="min-w-0 flex-1 text-sm text-slate-700">{i.name}</span>
                <span className="text-sm font-semibold tabular-nums text-slate-900">{fmt(i.value)}</span>
                <span className="w-12 text-right text-xs tabular-nums text-slate-500">{total ? `${Math.round((i.value / total) * 1000) / 10}%` : '0%'}</span>
              </>
            );
            return <li key={i.name}>{i.to ? <Link to={i.to} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">{row}</Link> : <div className="flex items-center gap-2 px-2 py-1">{row}</div>}</li>;
          })}
          {extra && (
            <li className="mt-1 border-t border-dashed border-slate-200 pt-1">
              <Link to={extra.to} className="flex items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: extra.color }} aria-hidden="true" />
                <span className="min-w-0 flex-1 text-sm text-slate-700">{extra.name}</span>
                <span className="text-sm font-semibold tabular-nums text-slate-900">{fmt(extra.value)}</span>
              </Link>
              <p className="px-2 text-[11px] leading-snug text-slate-500">{extra.note}</p>
            </li>
          )}
        </ul>
      </div>
      {note && <p className="mt-3 text-[11px] leading-snug text-slate-500">{note}</p>}
    </Panel>
  );
}

const dayLabel = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/** New customers over time: one bar per day for short ranges (up to 45 days), otherwise one per month. Data is the server's series. */
export function OnboardingTrend({ customers, rangeLabel, loading, error, onRetry }) {
  const daily = customers?.dailyOnboarding;
  const series = daily ? daily.map((d) => ({ ...d, label: dayLabel(d.date) })) : (customers?.monthlyOnboarding ?? []).map((m) => ({ ...m, label: monthLabel(m.month) }));
  const empty = !loading && series.every((s) => s.total === 0);
  return (
    <Panel id="trend-heading" title="Customer Onboarding Trend" subtitle={`New customers ${daily ? 'per day' : 'per month'} · ${rangeLabel}`} tag="In period" loading={loading} error={error} onRetry={onRetry} empty={empty} emptyText="No customers were registered in this period.">
      <div className="h-44 w-full sm:h-48" role="img" aria-label={`New customers ${daily ? 'per day' : 'per month'}: ${series.map((s) => `${s.label} ${s.total}`).join(', ')}`}>
        <ResponsiveContainer>
          <BarChart data={series} margin={{ top: 10, right: 8, left: -18, bottom: 0 }}>
            <CartesianGrid stroke="#E2E8F0" strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 11 }} interval={series.length > 12 ? 'preserveStartEnd' : 0} minTickGap={12} />
            <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
            <Tooltip cursor={{ fill: '#F1F5F9' }} formatter={(v, n) => [fmt(v), n]} />
            <Bar isAnimationActive={false} dataKey="individual" name="Individual" stackId="a" fill={C.info} maxBarSize={36} />
            <Bar isAnimationActive={false} dataKey="company" name="Company" stackId="a" fill={C.purple} radius={[4, 4, 0, 0]} maxBarSize={36} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex items-center justify-center gap-4 text-xs text-slate-500">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: C.info }} />Individual</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: C.purple }} />Company</span>
      </div>
    </Panel>
  );
}
