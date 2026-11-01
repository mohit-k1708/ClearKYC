/**
 * Shared chart pieces (Recharts) used by the Overview dashboard and the Analytics page. Every chart is fed real data by its page,
 * has a "Show data" table so nothing depends on colour or hovering, and uses a small, consistent palette:
 * green = good, orange = needs a look, red = problem, blue/teal = neutral information.
 */
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

export const COLORS = {
  good: '#059669', // green
  warn: '#d97706', // orange
  bad: '#dc2626', // red
  info: '#0284c7', // blue
  teal: '#0f766e',
  indigo: '#4f46e5',
  violet: '#7c3aed',
  slate: '#94a3b8',
};
export const RISK_COLORS = { Low: COLORS.good, Medium: COLORS.warn, High: COLORS.bad, Unrated: COLORS.slate };
const GRID = '#e2e8f0';

export const fmt = (v) => Number(v).toLocaleString('en-IN');
export const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' });

/** A titled chart with its numbers available as a table. `height` is the chart area in pixels. */
export function ChartCard({ title, note, columns, rows, children, empty, height = 256, className = '' }) {
  return (
    <figure className={`card min-w-0 p-4 ${className}`} aria-label={title}>
      <figcaption className="mb-1">
        <div className="text-sm font-semibold text-slate-800">{title}</div>
        {note && <div className="text-xs text-slate-500">{note}</div>}
      </figcaption>
      {empty ? <p className="py-16 text-center text-sm text-slate-500">{empty}</p> : <div className="w-full" style={{ height }}>{children}</div>}
      <details className="mt-2 text-xs text-slate-600">
        <summary className="cursor-pointer select-none text-slate-500 hover:text-slate-800">Show data</summary>
        <table className="mt-2 w-full text-left">
          <thead><tr>{columns.map((c) => <th key={c} className="pb-1 pr-3 font-medium text-slate-500">{c}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{r.map((v, j) => <td key={j} className="py-1 pr-3 tabular-nums">{v}</td>)}</tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

/** Donut: `data` is [{ name, value }], `colors` maps a name to a colour. The centre shows the total. */
export function DonutCard({ title, note, data, colors, unit = 'Customers', centerLabel = 'in total', height = 256, className }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const shown = data.filter((d) => d.value > 0);
  return (
    <ChartCard title={title} note={note} className={className} height={height} columns={['Group', unit]} rows={data.map((d) => [d.name, fmt(d.value)])} empty={total === 0 ? 'No data yet' : null}>
      <div className="relative h-full">
        <ResponsiveContainer>
          <PieChart>
            <Pie isAnimationActive={false} data={shown} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="86%" paddingAngle={2}>
              {shown.map((d) => <Cell key={d.name} fill={colors[d.name] || COLORS.slate} />)}
            </Pie>
            <Tooltip formatter={(v, n) => [fmt(v), n]} />
            <Legend verticalAlign="bottom" iconType="circle" formatter={(name) => <span className="text-sm text-slate-700">{name}: {fmt(data.find((d) => d.name === name)?.value ?? 0)}</span>} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute left-1/2 top-[38%] -translate-x-1/2 -translate-y-1/2 text-center">
          <div className="text-2xl font-semibold tabular-nums text-slate-900">{fmt(total)}</div>
          <div className="text-[11px] text-slate-500">{centerLabel}</div>
        </div>
      </div>
    </ChartCard>
  );
}

/** Bars: `data` is [{ name, value }]. `layout="vertical"` draws horizontal bars with the names on the left. */
export function BarCard({ title, note, data, color = COLORS.teal, layout = 'horizontal', unit = 'Count', colors, height = 256, className }) {
  const total = data.reduce((s, d) => s + d.value, 0);
  const vertical = layout === 'vertical';
  return (
    <ChartCard title={title} note={note} className={className} height={height} columns={['Group', unit]} rows={data.map((d) => [d.name, fmt(d.value)])} empty={total === 0 ? 'No data yet' : null}>
      <ResponsiveContainer>
        <BarChart data={data} layout={vertical ? 'vertical' : 'horizontal'} margin={{ top: 16, right: 24, left: vertical ? 24 : 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" horizontal={!vertical} vertical={vertical} />
          {vertical ? <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} /> : <XAxis dataKey="name" tick={{ fontSize: 12 }} interval={0} />}
          {vertical ? <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 12 }} /> : <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />}
          <Tooltip formatter={(v) => [fmt(v), unit]} cursor={{ fill: '#f1f5f9' }} />
          <Bar isAnimationActive={false} dataKey="value" radius={vertical ? [0, 4, 4, 0] : [4, 4, 0, 0]} maxBarSize={48}>
            {data.map((d) => <Cell key={d.name} fill={colors?.[d.name] || color} />)}
            <LabelList dataKey="value" position={vertical ? 'right' : 'top'} style={{ fontSize: 12, fill: '#334155' }} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

/** Stacked monthly bars for the onboarding trend: [{ month: '2026-10', individual, company, total }]. */
export function GrowthCard({ title, note, months, height = 256, className }) {
  const data = months.map((m) => ({ ...m, label: monthLabel(m.month) }));
  return (
    <ChartCard title={title} note={note} className={className} height={height} columns={['Month', 'Individual', 'Company', 'Total']} rows={data.map((m) => [m.label, m.individual, m.company, m.total])} empty={data.every((m) => m.total === 0) ? 'No customers were registered in these months' : null}>
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={{ fontSize: 12 }} interval={0} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} />
          <Legend iconType="circle" />
          <Bar isAnimationActive={false} dataKey="individual" name="Individual" stackId="a" fill={COLORS.info} maxBarSize={48} />
          <Bar isAnimationActive={false} dataKey="company" name="Company" stackId="a" fill={COLORS.indigo} radius={[4, 4, 0, 0]} maxBarSize={48} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
