import { Link } from 'react-router-dom';
import { Icon } from '../dashboardUi';
import { C, Skeleton } from './Panel';

const pct = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

/** The "+N vs previous period" badge. Shown only when there is a previous period to compare with. */
function Delta({ now, before }) {
  if (before === null || before === undefined) return null;
  const diff = now - before;
  const up = diff > 0;
  const same = diff === 0;
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${same ? 'bg-slate-100 text-slate-500' : up ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}
      title="New customers in this period compared with the period just before it">
      {same ? 'no change' : `${up ? '▲' : '▼'} ${Math.abs(diff).toLocaleString('en-IN')}`}
    </span>
  );
}

function Kpi({ icon, color, title, value, badge, helper, to }) {
  return (
    <Link to={to} className="group flex min-w-0 flex-col rounded-2xl border border-slate-200/70 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[#087F78]/40">
      <div className="flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: `${color}1F`, color }}><Icon name={icon} /></span>
        <span className="text-sm font-medium text-slate-600">{title}</span>
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-3xl font-semibold tabular-nums text-slate-900" data-kpi={title}>{value.toLocaleString('en-IN')}</span>
        {badge}
      </div>
      <p className="mt-1 text-xs leading-snug text-slate-500">{helper}</p>
    </Link>
  );
}

/**
 * The six customer KPI cards. All figures come from /api/analytics (customers by type and by current risk level); percentages are
 * shares of the total. The total card also compares new customers with the previous period of the same length.
 */
export default function KpiCards({ data, previous, loading, rangeLabel }) {
  if (loading || !data) {
    return <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 min-[1500px]:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-32" />)}</div>;
  }
  const c = data.customers;
  const t = c.totalCustomers;
  const r = c.customersByRiskLevel;
  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 min-[1500px]:grid-cols-6" aria-label="Customer key figures">
      <Kpi icon="users" color={C.teal} title="Total Customers" value={t} to="/customers"
        badge={<Delta now={c.recentlyOnboardedCustomers} before={previous?.recentlyOnboardedCustomers} />} helper={`+${c.recentlyOnboardedCustomers.toLocaleString('en-IN')} new in ${rangeLabel.toLowerCase()}`} />
      <Kpi icon="user" color={C.info} title="Individual Customers" value={c.individualCustomers} to="/customers?type=Individual"
        badge={<span className="text-xs font-semibold text-slate-500">{pct(c.individualCustomers, t)}%</span>} helper="People registered for themselves" />
      <Kpi icon="building" color={C.purple} title="Company Customers" value={c.companyCustomers} to="/customers?type=Company"
        badge={<span className="text-xs font-semibold text-slate-500">{pct(c.companyCustomers, t)}%</span>} helper="Businesses and organisations" />
      <Kpi icon="shield" color={C.low} title="Low-Risk Customers" value={r.Low ?? 0} to="/customers?risk=Low"
        badge={<span className="text-xs font-semibold text-slate-500">{pct(r.Low ?? 0, t)}%</span>} helper="Standard monitoring" />
      <Kpi icon="warn" color={C.medium} title="Medium-Risk Customers" value={r.Medium ?? 0} to="/customers?risk=Medium"
        badge={<span className="text-xs font-semibold text-slate-500">{pct(r.Medium ?? 0, t)}%</span>} helper="Additional checks may be needed" />
      <Kpi icon="warn" color={C.high} title="High-Risk Customers" value={r.High ?? 0} to="/customers?risk=High"
        badge={<span className="text-xs font-semibold text-slate-500">{pct(r.High ?? 0, t)}%</span>} helper="Requires closer review" />
    </div>
  );
}
