import { Link } from 'react-router-dom';
import useAsync from '../hooks/useAsync';
import useMeta from '../hooks/useMeta';
import useOverviewRange from '../hooks/useOverviewRange';
import { getAnalyticsOverview, getAlertSummary, listAlerts } from '../services/reportApi';
import { getReviewDashboard } from '../services/reviewApi';
import { listExceptions } from '../services/kycApi';
import { getCustomerAnalytics, getRecentActivity } from '../services/overviewApi';
import { AddCustomerButton, ErrorBanner } from '../components/ui';
import { C } from '../components/overview/Panel';
import TopBar from '../components/overview/TopBar';
import Welcome from '../components/overview/Welcome';
import KpiCards from '../components/overview/KpiCards';
import { DonutPanel, OnboardingTrend } from '../components/overview/Charts';
import { ActivityPanel, AlertsPanel, ReviewCasesPanel } from '../components/overview/Lists';

/**
 * Overview. Every figure comes from the backend: /analytics (customers, documents, KYC completeness, ownership), the review
 * dashboard summary, the alert list, the KYC exceptions summary and the audit-based activity feed. The date filter changes the
 * "in period" figures (new customers, the onboarding trend); the rest describe the current state and are tagged "Now".
 */
export default function DashboardPage() {
  const { range, previous, setRange } = useOverviewRange();
  const key = JSON.stringify(range.api);
  const overview = useAsync(() => getAnalyticsOverview(range.api), [key]);
  const before = useAsync(() => (previous ? getCustomerAnalytics({ from: previous.from, to: previous.to }) : Promise.resolve(null)), [previous?.from, previous?.to]);
  const cases = useAsync(getReviewDashboard, []);
  const alerts = useAsync(() => listAlerts({ status: 'active', pageSize: 5 }), []);
  const alertSummary = useAsync(getAlertSummary, []);
  const missing = useAsync(() => listExceptions({ type: 'MISSING_DOCUMENT', pageSize: 1 }), []);
  const activity = useAsync(() => getRecentActivity(8), []);
  const meta = useMeta();
  const model = meta?.data?.riskModel;

  const o = overview.data;
  const loading = overview.loading && !o;
  const health = o?.documents.health;
  const kyc = o?.kyc;
  const own = o?.ownership.validationStatusDistribution;
  const totalCustomers = o?.customers.totalCustomers ?? 0;
  const incompleteOwnership = own ? own.BELOW_100 + own.MISSING_PERCENTAGE + own.EXCEEDS_100 + own.NO_OWNERS : 0;
  const retry = overview.reload;

  return (
    <>
      <TopBar range={range} onRange={setRange} newAlerts={alertSummary.data?.newAlerts ?? 0} />
      <Welcome range={range} onRange={setRange} />
      <ErrorBanner error={overview.error} onRetry={overview.reload} />

      {o && totalCustomers === 0 && (
        <div className="mb-5 rounded-2xl border border-slate-200/70 bg-white p-6 text-center text-sm text-slate-600 shadow-sm">
          No customers yet. <Link to="/customers/new" className="font-medium text-[#087F78] underline">Register the first customer</Link>, or load sample data with <code className="rounded bg-slate-100 px-1.5 py-0.5">npm run generate:customers</code>.
          <div className="mt-3"><AddCustomerButton /></div>
        </div>
      )}

      <KpiCards data={o} previous={before.data?.customers} loading={loading} rangeLabel={range.label} />

      {/* Customer analytics */}
      <div className="mb-5 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <DonutPanel id="type-heading" title="Customer Type Distribution" subtitle="Individuals and companies" tag="Now" unit="customers" centerLabel="customers" loading={loading} error={overview.error} onRetry={retry}
          items={o ? [
            { name: 'Individual', value: o.customers.individualCustomers, color: C.info, to: '/customers?type=Individual' },
            { name: 'Company', value: o.customers.companyCustomers, color: C.purple, to: '/customers?type=Company' },
          ] : []} />
        <DonutPanel id="risk-heading" title="Customer Risk Distribution" subtitle="How closely each customer is watched" tag="Now" unit="customers" centerLabel="customers" loading={loading} error={overview.error} onRetry={retry}
          items={o ? ['Low', 'Medium', 'High'].map((l) => ({ name: `${l} risk`, value: o.customers.customersByRiskLevel[l] ?? 0, color: { Low: C.low, Medium: C.medium, High: C.high }[l], to: `/customers?risk=${l}` })) : []}
          note="Customer risk is separate from document completion: a customer can be low risk and still owe documents." />
        <div className="lg:col-span-2 xl:col-span-1"><OnboardingTrend customers={o?.customers} rangeLabel={range.label} loading={loading} error={overview.error} onRetry={retry} /></div>
      </div>

      {/* Document health */}
      <div className="mb-5 grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <DonutPanel id="docs-heading" title="Document Verification Status" subtitle="Every document received, counted once" tag="Now" unit="documents" centerLabel="documents" loading={loading} error={overview.error} onRetry={retry}
          items={health ? [
            { name: 'Verified', value: health.verifiedAndValid, color: C.low, to: '/documents?status=Verified' },
            { name: 'Pending', value: health.waitingForCheck, color: C.info, to: '/documents?status=Pending' },
            { name: 'Rejected', value: health.rejectedOrNeedsNewCopy, color: C.high, to: '/documents?status=Rejected' },
            { name: 'Expired', value: health.expired, color: C.medium, to: '/documents?expiry=Expired' },
          ] : []}
          extra={missing.data ? { name: 'Missing mandatory documents', value: missing.data.summary.byType.MISSING_DOCUMENT, color: C.purple, to: '/kyc', note: 'Required documents customers have not sent yet. They are not in the donut because they are not documents we hold.' } : null} />
        <DonutPanel id="kyc-heading" title="KYC Completeness" subtitle="Customers by how much of their required paperwork is done" tag="Now" unit="customers" centerLabel="customers" loading={loading} error={overview.error} onRetry={retry}
          items={kyc ? [
            { name: 'Complete', value: kyc.distribution.Complete, color: C.low, to: '/kyc' },
            { name: 'Partially complete', value: kyc.distribution['Partially Complete'], color: C.medium, to: '/kyc' },
            { name: 'Not started', value: kyc.distribution['Not Started'], color: C.high, to: '/kyc' },
          ] : []}
          note={`Calculated per customer from the mandatory documents they need that are verified and still valid.${kyc?.distribution['No Requirements'] ? ` ${kyc.distribution['No Requirements']} customer(s) have no requirements defined and are not counted.` : ''}`} />
        <div className="lg:col-span-2 xl:col-span-1">
          <DonutPanel id="ownership-heading" title="Ownership Status" subtitle="Companies and whether we know who owns them" tag="Now" unit="companies" centerLabel="companies" loading={loading} error={overview.error} onRetry={retry}
            items={own ? [
              { name: 'Complete ownership information', value: own.RECONCILED, color: C.low, to: '/ownership?status=RECONCILED' },
              { name: 'Incomplete ownership information', value: incompleteOwnership, color: C.high, to: '/ownership' },
            ] : []}
            note={own ? `Complete means the owners add up to exactly 100%. Incomplete: ${own.NO_OWNERS} with no owners, ${own.BELOW_100 + own.MISSING_PERCENTAGE} below 100%, ${own.EXCEEDS_100} above 100%.` : undefined} />
        </div>
      </div>

      {/* Operations */}
      <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-3">
        <ReviewCasesPanel data={cases.data} loading={cases.loading && !cases.data} error={cases.error} onRetry={cases.reload} />
        <AlertsPanel data={alerts.data} loading={alerts.loading && !alerts.data} error={alerts.error} onRetry={alerts.reload} />
        <div className="lg:col-span-2 xl:col-span-1"><ActivityPanel data={activity.data} loading={activity.loading && !activity.data} error={activity.error} onRetry={activity.reload} /></div>
      </div>

      {model && (
        <p className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
          <strong>Prototype risk model ({model.version}).</strong> Low is below {model.thresholds.mediumFrom}, Medium is {model.thresholds.mediumFrom}–{model.thresholds.highFrom - 1}, High is {model.thresholds.highFrom} and above. {model.disclaimer}
        </p>
      )}
    </>
  );
}
