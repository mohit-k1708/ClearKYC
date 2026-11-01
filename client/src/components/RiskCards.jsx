import { Link } from 'react-router-dom';
import { getRiskDashboard } from '../services/ownershipApi';
import useAsync from '../hooks/useAsync';
import { ErrorBanner } from './ui';

// Dashboard cards for Scene 3. Each card links to the page where the numbers can be investigated.
const CARDS = [
  { label: 'Business customers', key: 'totalBusinessCustomers', accent: 'border-l-violet-500', to: '/ownership' },
  { label: 'Beneficial owners', key: 'totalBeneficialOwners', accent: 'border-l-teal-500', to: '/ownership' },
  { label: 'Ownership issues', key: 'ownershipIssues', accent: 'border-l-amber-500', to: '/ownership', hint: 'Companies whose owners do not reconcile to 100%' },
  { label: 'High-risk customers', key: 'highRiskCustomers', accent: 'border-l-red-500', to: '/risk-history?riskLevel=High' },
  { label: 'Requiring manual review', key: 'customersRequiringManualReview', accent: 'border-l-fuchsia-500', to: '/risk-history?status=Requires%20Manual%20Review' },
];

export default function RiskCards() {
  const { data, error, reload } = useAsync(getRiskDashboard, []);
  return (
    <section className="mt-8" aria-labelledby="risk-cards-heading">
      <h2 id="risk-cards-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Ownership and risk</h2>
      <ErrorBanner error={error} onRetry={reload} />
      {data && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {CARDS.map((c) => (
            <Link key={c.key} to={c.to} className={`card border-l-4 ${c.accent} p-4 transition hover:shadow-md`} title={c.hint}>
              <div className="text-sm text-slate-500">{c.label}</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{data[c.key].toLocaleString('en-IN')}</div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
