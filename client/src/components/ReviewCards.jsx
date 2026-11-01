import { Link } from 'react-router-dom';
import { getReviewDashboard } from '../services/reviewApi';
import useAsync from '../hooks/useAsync';
import { ErrorBanner } from './ui';

// Dashboard cards for Scene 4. Each card links to the list that explains the number.
const CARDS = [
  { label: 'Open cases', key: 'openCases', accent: 'border-l-sky-500', to: '/cases?status=Open,Assigned', hint: 'Open and Assigned' },
  { label: 'In progress', key: 'inProgressCases', accent: 'border-l-indigo-500', to: '/cases?status=In%20Progress,Pending%20Customer', hint: 'In Progress and Pending Customer' },
  { label: 'Escalated', key: 'escalatedCases', accent: 'border-l-fuchsia-500', to: '/cases?status=Escalated' },
  { label: 'Overdue cases', key: 'overdueCases', accent: 'border-l-red-500', to: '/cases?overdue=true' },
  { label: 'High priority', key: 'highPriorityCases', accent: 'border-l-amber-500', to: '/cases?priority=High,Critical', hint: 'High and Critical, still active' },
  { label: 'Upcoming periodic reviews', key: 'upcomingPeriodicReviews', accent: 'border-l-teal-500', to: '/reviews?tab=upcoming', hint: 'Due in the next 30 days' },
];

export default function ReviewCards() {
  const { data, error, reload } = useAsync(getReviewDashboard, []);
  return (
    <section className="mt-8" aria-labelledby="review-cards-heading">
      <h2 id="review-cards-heading" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Review cases and exceptions</h2>
      <ErrorBanner error={error} onRetry={reload} />
      {data && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
            {CARDS.map((c) => (
              <Link key={c.key} to={c.to} className={`card border-l-4 ${c.accent} p-4 transition hover:shadow-md`} title={c.hint}>
                <div className="text-sm text-slate-500">{c.label}</div>
                <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{data[c.key].toLocaleString('en-IN')}</div>
              </Link>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {data.overduePeriodicReviews > 0 && <><Link to="/reviews" className="font-medium text-red-700 hover:underline">{data.overduePeriodicReviews} periodic review{data.overduePeriodicReviews === 1 ? ' is' : 's are'} overdue</Link> · </>}
            <Link to="/exceptions" className="font-medium text-brand-700 hover:underline">Exceptions &amp; Issues</Link>
          </p>
        </>
      )}
    </section>
  );
}
