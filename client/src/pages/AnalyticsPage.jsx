import { Link, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { getAnalyticsOverview } from '../services/reportApi';
import useAsync from '../hooks/useAsync';
import { ErrorBanner, PageHeader, Spinner } from '../components/ui';
import { DateRangeFilter, Kpi } from '../components/reportUi';
import { BarCard, ChartCard, COLORS, DonutCard, monthLabel, RISK_COLORS } from '../components/charts';
import { formatDate } from '../utils/format';

// Shared chart pieces and colours live in components/charts.jsx (green = good, orange = needs a look, red = problem, blue = information).
const SEVERITY_COLORS = { Active: COLORS.bad, Closed: COLORS.slate };
const GRID = '#e2e8f0';
const PieCard = DonutCard;
const OWNERSHIP_LABEL = { RECONCILED: 'Add up to 100%', BELOW_100: 'Less than 100%', MISSING_PERCENTAGE: 'A share is missing', EXCEEDS_100: 'More than 100%', NO_OWNERS: 'No owners recorded' };
const OWNERSHIP_COLOR = { 'Add up to 100%': COLORS.good, 'Less than 100%': COLORS.warn, 'A share is missing': COLORS.warn, 'More than 100%': COLORS.bad, 'No owners recorded': COLORS.bad };

function Section({ title, note, children }) {
  return (
    <section className="mt-8" aria-label={title}>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{title}</h2>
      {note && <p className="mb-3 text-xs text-slate-500">{note}</p>}
      {!note && <div className="mb-3" />}
      {children}
    </section>
  );
}

const GRID_4 = 'grid gap-4 sm:grid-cols-2 xl:grid-cols-4';

/** Analytics & Reports: every figure is calculated from the database by the server when this page loads. */
export default function AnalyticsPage() {
  const [params, setParams] = useSearchParams();
  const range = params.get('range') || '';
  const from = params.get('from') || '';
  const to = params.get('to') || '';
  const query = from || to ? { from, to } : { range: range || '30d' };
  const complete = !(from || to) || (from && to && from <= to);
  const { data, loading, error, reload } = useAsync(() => (complete ? getAnalyticsOverview(query) : Promise.resolve(null)), [range, from, to]);

  function setRange(next) {
    const p = new URLSearchParams();
    Object.entries(next).forEach(([k, v]) => v && p.set(k, v));
    setParams(p, { replace: true });
  }

  const d = data;
  const risk = d?.customers.customersByRiskLevel ?? {};
  const kyc = d?.kyc;
  const docs = d?.documents;

  return (
    <>
      <PageHeader title="Analytics & reports" subtitle="Charts and totals about customers, documents, risk, cases and alerts. Every number is calculated from the real records when you open the page.">
        <Link to="/reports" className="btn btn-secondary">Export reports</Link>
      </PageHeader>

      <div className="card p-4">
        <DateRangeFilter value={from || to ? { from, to } : { range: range || '30d' }} onChange={setRange} />
        {d && <p className="mt-3 text-xs text-slate-500" aria-live="polite">Period: <strong>{d.period.label}</strong>{d.period.from ? ` (${formatDate(d.period.from)} to ${formatDate(d.period.to)})` : ''}. It changes the “in this period” figures and the trend charts. Cards marked <em>now</em> describe the current state of the records and do not depend on the period.</p>}
        {!complete && <p className="mt-2 text-xs text-red-600">Choose both a start and an end date.</p>}
      </div>

      <ErrorBanner error={error} onRetry={reload} />
      {loading && !d && <Spinner label="Calculating from the records…" />}

      {d && (
        <div className={loading ? 'opacity-60' : ''}>
          <Section title="Customers">
            <div className={GRID_4}>
              <Kpi label="Total customers" value={d.customers.totalCustomers} hint="now" accent="border-l-slate-400" />
              <Kpi label="Individual customers" value={d.customers.individualCustomers} hint="now" accent="border-l-sky-500" />
              <Kpi label="Company customers" value={d.customers.companyCustomers} hint="now" accent="border-l-violet-500" />
              <Kpi label="Recently onboarded" value={d.customers.recentlyOnboardedCustomers} hint="in this period" accent="border-l-teal-500" />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <PieCard title="Customer risk distribution" note="Current risk level of every customer (now)" colors={RISK_COLORS} data={Object.entries(risk).map(([name, value]) => ({ name, value }))} />
              <ChartCard
                title="Monthly customer onboarding trend" note="Customers registered per month (period)"
                columns={['Month', 'Individual', 'Company', 'Total']} rows={d.customers.monthlyOnboarding.map((m) => [monthLabel(m.month), m.individual, m.company, m.total])}
                empty={d.customers.monthlyOnboarding.every((m) => m.total === 0) ? 'No customers were onboarded in these months' : null}
              >
                <ResponsiveContainer>
                  <BarChart data={d.customers.monthlyOnboarding.map((m) => ({ ...m, label: monthLabel(m.month) }))} margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip cursor={{ fill: '#f1f5f9' }} />
                    <Legend iconType="circle" />
                    <Bar isAnimationActive={false} dataKey="individual" name="Individual" stackId="a" fill={COLORS.info} maxBarSize={48} />
                    <Bar isAnimationActive={false} dataKey="company" name="Company" stackId="a" fill={COLORS.indigo} radius={[4, 4, 0, 0]} maxBarSize={48} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          </Section>

          <Section title="Customer document completion" note="How much of the required paperwork each customer has provided and had verified (technical term: KYC completeness). Now.">
            <div className={GRID_4}>
              <Kpi label="Fully complete" value={kyc.fullyCompleteCustomers} accent="border-l-emerald-500" />
              <Kpi label="Partially complete" value={kyc.partiallyCompleteCustomers + kyc.notStartedCustomers} hint={`${kyc.partiallyCompleteCustomers} partly done, ${kyc.notStartedCustomers} with nothing verified`} accent="border-l-amber-500" />
              <Kpi label="No KYC documents" value={kyc.customersWithNoKycDocuments} hint="Customers with no document submitted" accent="border-l-red-500" />
              <Kpi label="Average completeness" value={kyc.averageCompletenessPercentage} suffix="%" hint={`across ${kyc.customersWithRequirements} customers with requirements`} accent="border-l-teal-500" />
            </div>
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <BarCard title="KYC completeness distribution" note="Customers by completeness status" unit="Customers" colors={{ Complete: '#059669', 'Partially Complete': COLORS.warn, 'Not Started': '#dc2626', 'No Requirements': COLORS.slate }}
                data={Object.entries(kyc.distribution).map(([name, value]) => ({ name, value }))} />
              <BarCard title="Completeness by percentage band" note="Customers with requirements" unit="Customers" color={COLORS.teal} data={Object.entries(kyc.percentageBuckets).map(([name, value]) => ({ name, value }))} />
            </div>
          </Section>

          <Section title="Documents">
            <div className={GRID_4}>
              <Kpi label="Total documents" value={docs.totalDocuments} hint={`${docs.submittedInPeriod.toLocaleString('en-IN')} submitted in this period`} accent="border-l-slate-400" />
              <Kpi label="Verified" value={docs.verifiedDocuments} accent="border-l-emerald-500" />
              <Kpi label="Pending verification" value={docs.pendingVerification} hint="Pending and In Review" accent="border-l-sky-500" />
              <Kpi label="Rejected" value={docs.rejectedDocuments} accent="border-l-red-500" />
              <Kpi label="Expired" value={docs.expiredDocuments} hint="Expiry date has passed" accent="border-l-orange-500" />
              <Kpi label="Expiring within 30 days" value={docs.documentsExpiringWithin30Days} accent="border-l-amber-500" />
              <Kpi label="Require resubmission" value={docs.requiresResubmission} accent="border-l-fuchsia-500" />
            </div>
            <div className="mt-4">
              <BarCard title="Document verification status" note="Latest verification decision of every document (now)" layout="vertical" unit="Documents"
                colors={{ Verified: '#059669', Pending: COLORS.info, 'In Review': COLORS.indigo, Rejected: '#dc2626', 'Requires Resubmission': COLORS.warn }}
                data={Object.entries(docs.statusDistribution).map(([name, value]) => ({ name, value }))} />
            </div>
          </Section>

          <Section title="Customer risk level" note="Potential PEP and sanctions matches come from simulated screening. They are possible matches that need investigation, never confirmed ones.">
            <div className={GRID_4}>
              <Kpi label="Low-risk customers" value={d.risks.lowRiskCustomers} accent="border-l-emerald-500" />
              <Kpi label="Medium-risk customers" value={d.risks.mediumRiskCustomers} accent="border-l-amber-500" />
              <Kpi label="High-risk customers" value={d.risks.highRiskCustomers} accent="border-l-red-500" />
              <Kpi label="Requiring manual review" value={d.risks.customersRequiringManualReview} hint="A review, not a rejection" accent="border-l-violet-500" />
              <Kpi label="Potential PEP matches" value={d.risks.potentialPepMatches} hint="Customers with a possible match" accent="border-l-orange-500" />
              <Kpi label="Potential sanctions matches" value={d.risks.potentialSanctionsMatches} hint="Customers with a possible match" accent="border-l-red-500" />
              <Kpi label="Assessments recorded" value={d.risks.assessmentsInPeriod} hint="in this period" accent="border-l-teal-500" />
            </div>
          </Section>

          <Section title="Review cases">
            <div className={GRID_4}>
              <Kpi label="Total review cases" value={d.reviewCases.totalReviewCases} hint={`${d.reviewCases.casesOpenedInPeriod.toLocaleString('en-IN')} opened in this period`} accent="border-l-slate-400" />
              <Kpi label="Open cases" value={d.reviewCases.openCases} hint="Open and Assigned" accent="border-l-sky-500" />
              <Kpi label="In progress" value={d.reviewCases.inProgressCases} hint="In Progress and Pending Customer" accent="border-l-indigo-500" />
              <Kpi label="Escalated" value={d.reviewCases.escalatedCases} accent="border-l-fuchsia-500" />
              <Kpi label="Resolved" value={d.reviewCases.resolvedCases} hint={`${d.reviewCases.closedCases} more are closed`} accent="border-l-emerald-500" />
              <Kpi label="Overdue" value={d.reviewCases.overdueCases} hint="Active and past the due date" accent="border-l-red-500" />
            </div>
            <div className="mt-4">
              <BarCard title="Review case status distribution" unit="Cases" colors={{ Open: COLORS.info, Assigned: COLORS.indigo, 'In Progress': COLORS.teal, 'Pending Customer': COLORS.warn, Escalated: '#a21caf', Resolved: '#059669', Closed: COLORS.slate }}
                data={Object.entries(d.reviewCases.statusDistribution).map(([name, value]) => ({ name, value }))} />
            </div>
          </Section>

          <Section title="Company ownership" note="People who own or control companies (beneficial owners), and whether their shares add up to 100%. Now.">
            <div className={GRID_4}>
              <Kpi label="Company customers" value={d.ownership.totalBusinessCustomers} accent="border-l-violet-500" />
              <Kpi label="People who own or control companies" value={d.ownership.totalBeneficialOwners} accent="border-l-teal-500" />
              <Kpi label="Companies whose ownership does not add up" value={d.ownership.ownershipValidationIssues} hint={`${d.ownership.companiesExceeding100Percent} above 100%, ${d.ownership.companiesBelow100Percent} below 100%`} accent="border-l-red-500" />
              <Kpi label="Companies with ownership information missing" value={d.ownership.companiesWithMissingOwnershipInformation} hint={`${d.ownership.companiesWithoutOwners} with no owners recorded`} accent="border-l-amber-500" />
            </div>
          <div className="mt-4">
              <BarCard title="Ownership validation status" note="What the owners' shares add up to, company by company" layout="vertical" unit="Companies" colors={OWNERSHIP_COLOR}
                data={Object.entries(d.ownership.validationStatusDistribution).map(([k, value]) => ({ name: OWNERSHIP_LABEL[k], value }))} />
            </div>
          </Section>

          <Section title="Alerts" note="Raised in the selected period, split into still active and closed">
            <div className={GRID_4}>
              <Kpi label="Alerts in this period" value={d.alerts.alertsInPeriod} accent="border-l-slate-400" />
              <Kpi label="Active alerts" value={d.alerts.activeAlerts} hint="now" accent="border-l-red-500" />
              <Kpi label="New, not yet seen" value={d.alerts.newAlerts} hint="now" accent="border-l-sky-500" />
              <Kpi label="High or Critical active" value={d.alerts.highOrCriticalActive} hint="now" accent="border-l-orange-500" />
            </div>
            <div className="mt-4">
              <ChartCard title="Alerts by severity" columns={['Severity', 'Active', 'Closed']} rows={d.alerts.bySeverity.map((s) => [s.severity, s.active, s.closed])} empty={d.alerts.alertsInPeriod === 0 ? 'No alerts were raised in this period' : null}>
                <ResponsiveContainer>
                  <BarChart data={d.alerts.bySeverity} margin={{ top: 16, right: 16, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={GRID} strokeDasharray="3 3" vertical={false} />
                    <XAxis dataKey="severity" tick={{ fontSize: 12 }} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 12 }} />
                    <Tooltip cursor={{ fill: '#f1f5f9' }} />
                    <Legend iconType="circle" />
                    <Bar isAnimationActive={false} dataKey="active" name="Active" stackId="s" fill={SEVERITY_COLORS.Active} maxBarSize={56} />
                    <Bar isAnimationActive={false} dataKey="closed" name="Resolved / dismissed" stackId="s" fill={SEVERITY_COLORS.Closed} radius={[4, 4, 0, 0]} maxBarSize={56} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
            <p className="mt-3 text-xs"><Link to="/alerts" className="font-medium text-brand-700 hover:underline">Open Alerts &amp; Notifications</Link></p>
          </Section>
          <p className="mt-8 text-[11px] text-slate-400">Generated {new Date(d.generatedAt).toLocaleString('en-IN')}</p>
        </div>
      )}
    </>
  );
}
