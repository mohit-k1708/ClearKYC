import { Link } from 'react-router-dom';
import { getAlertSummary } from '../services/reportApi';
import useAsync from '../hooks/useAsync';
import { ErrorBanner } from './ui';

// Dashboard cards for Scene 5. Each card links to the list that explains the number.
const CARDS = [
  { label: 'Active alerts', key: 'activeAlerts', accent: 'border-l-red-500', to: '/alerts', hint: 'New, Acknowledged and In Progress' },
  { label: 'New alerts', key: 'newAlerts', accent: 'border-l-sky-500', to: '/alerts?status=New', hint: 'Not yet acknowledged' },
  { label: 'Critical active', key: 'criticalActive', accent: 'border-l-fuchsia-500', to: '/alerts?severity=Critical', hint: 'Critical severity, still active' },
  { label: 'High active', key: 'highActive', accent: 'border-l-orange-500', to: '/alerts?severity=High', hint: 'High severity, still active' },
];

export default function AlertCards() {
  const { data, error, reload } = useAsync(getAlertSummary, []);
  return (
    <section className="mt-8" aria-labelledby="alert-cards-heading">
      <h2 id="alert-cards-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Alerts</h2>
      <ErrorBanner error={error} onRetry={reload} />
      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {CARDS.map((c) => (
              <Link key={c.key} to={c.to} className={`card border-l-4 ${c.accent} p-4 transition hover:shadow-md`} title={c.hint}>
                <div className="text-sm text-slate-500">{c.label}</div>
                <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{data[c.key].toLocaleString('en-IN')}</div>
              </Link>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            <Link to="/alerts" className="font-medium text-brand-700 hover:underline">Alerts &amp; Notifications</Link> · <Link to="/analytics" className="font-medium text-brand-700 hover:underline">Analytics &amp; Reports</Link>
          </p>
        </>
      )}
    </section>
  );
}
