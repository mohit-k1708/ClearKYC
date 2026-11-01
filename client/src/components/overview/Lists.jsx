import { Link } from 'react-router-dom';
import { ALERT_COPY, alertTarget, Icon } from '../dashboardUi';
import { formatDateTime } from '../../utils/format';
import Panel, { C } from './Panel';

// ---- Review cases: six small boxes ---------------------------------------------------------------------------------------------
const CASE_BOXES = [
  { key: 'openCases', label: 'Open', icon: 'case', color: C.info, to: '/cases?status=Open,Assigned' },
  { key: 'inProgressCases', label: 'In Progress', icon: 'clock', color: C.teal, to: '/cases?status=In%20Progress,Pending%20Customer' },
  { key: 'escalatedCases', label: 'Escalated', icon: 'shield', color: C.purple, to: '/cases?status=Escalated' },
  { key: 'overdueCases', label: 'Overdue', icon: 'warn', color: C.high, to: '/cases?overdue=true' },
  { key: 'highPriorityCases', label: 'High Priority', icon: 'bell', color: C.medium, to: '/cases?priority=High,Critical' },
  { key: 'upcomingPeriodicReviews', label: 'Upcoming Periodic Reviews', icon: 'calendar', color: C.low, to: '/reviews?tab=upcoming' },
];

export function ReviewCasesPanel({ data, loading, error, onRetry }) {
  return (
    <Panel id="cases-heading" title="Review Cases" subtitle="Tasks to look into a problem with a customer" tag="Now" action={{ to: '/cases', label: 'View All' }} loading={loading} error={error} onRetry={onRetry}>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {data && CASE_BOXES.map((b) => (
          <Link key={b.key} to={b.to} className="rounded-xl border border-slate-100 p-3 transition hover:shadow-md focus:outline-none focus:ring-2 focus:ring-[#087F78]/40" style={{ backgroundColor: `${b.color}0F` }}>
            <span className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ backgroundColor: `${b.color}26`, color: b.color }}><Icon name={b.icon} className="h-4 w-4" /></span>
            <div className="mt-2 text-2xl font-semibold tabular-nums text-slate-900" data-case-metric={b.label}>{data[b.key].toLocaleString('en-IN')}</div>
            <div className="text-xs font-medium text-slate-600">{b.label}</div>
          </Link>
        ))}
      </div>
    </Panel>
  );
}

// ---- Recent alerts -------------------------------------------------------------------------------------------------------------
const PRIORITY = {
  Critical: { label: 'Urgent', cls: 'bg-red-50 text-red-700 ring-red-600/20', icon: C.high },
  High: { label: 'High', cls: 'bg-orange-50 text-orange-700 ring-orange-600/20', icon: C.high },
  Medium: { label: 'Medium', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20', icon: C.medium },
  Low: { label: 'Low', cls: 'bg-sky-50 text-sky-700 ring-sky-600/20', icon: C.info },
};

export function AlertsPanel({ data, loading, error, onRetry }) {
  const items = data?.data ?? [];
  return (
    <Panel id="alerts-heading" title="Recent Alerts — Action Required" subtitle="Raised from real problems in customer files" tag={data ? `${data.pagination.totalItems} active` : undefined}
      action={{ to: '/alerts', label: 'View All' }} loading={loading} error={error} onRetry={onRetry} empty={!loading && items.length === 0} emptyText="No active alerts. Everything is in order.">
      <ul className="divide-y divide-slate-100">
        {items.map((a) => {
          const p = PRIORITY[a.severity] || PRIORITY.Low;
          const copy = ALERT_COPY[a.alertType];
          return (
            <li key={a.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ backgroundColor: `${p.icon}1A`, color: p.icon }}><Icon name="warn" className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="text-sm font-semibold text-slate-900">{a.alertTypeLabel.replace(/ Alert$/, '')}</span>
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${p.cls}`}>{p.label}</span>
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-slate-600">{a.description}</p>
                <p className="mt-0.5 text-[11px] text-slate-500">Customer <Link to={`/customers/${a.customerId}`} className="font-mono text-[#087F78] hover:underline">{a.customerId}</Link></p>
              </div>
              <Link to={alertTarget(a)} className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50" aria-label={`${copy?.button || 'View'}: ${a.alertTypeLabel} for ${a.customerId}`}>View</Link>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

// ---- Recent activity (from the audit records) ----------------------------------------------------------------------------------
const ACTIVITY = {
  CUSTOMER_CREATED: { title: 'Customer registered', icon: 'userPlus', color: C.teal },
  DOCUMENT_SUBMITTED: { title: 'Document submitted', icon: 'upload', color: C.info },
  DOCUMENT_VERIFIED: { title: 'Document verified', icon: 'check', color: C.low },
  DOCUMENT_REJECTED: { title: 'Document rejected', icon: 'x', color: C.high },
  DOCUMENT_RESUBMISSION_REQUESTED: { title: 'Document resubmission requested', icon: 'doc', color: C.medium },
  RISK_CLASSIFICATION_CHANGED: { title: 'Risk level changed', icon: 'swap', color: C.medium },
  OWNER_ADDED: { title: 'Beneficial owner added', icon: 'userPlus', color: C.purple },
  OWNERSHIP_PERCENTAGE_CHANGED: { title: 'Ownership percentage changed', icon: 'chart', color: C.purple },
  SCREENING_RECORDED: { title: 'Screening result recorded', icon: 'eye', color: C.medium },
  CASE_CREATED: { title: 'Review case created', icon: 'case', color: C.info },
  CASE_ASSIGNED: { title: 'Review case assigned', icon: 'case', color: C.info },
  CASE_ESCALATED: { title: 'Review case escalated', icon: 'shield', color: C.purple },
  CASE_RESOLVED: { title: 'Review case resolved', icon: 'check', color: C.low },
  CASE_CLOSED: { title: 'Review case closed', icon: 'check', color: C.slate },
  CASE_REOPENED: { title: 'Review case reopened', icon: 'case', color: C.medium },
  PERIODIC_REVIEW_COMPLETED: { title: 'Periodic review completed', icon: 'calendar', color: C.low },
  ALERT_ACKNOWLEDGED: { title: 'Alert acknowledged', icon: 'bell', color: C.info },
  ALERT_RESOLVED: { title: 'Alert resolved', icon: 'check', color: C.low },
  ALERT_DISMISSED: { title: 'Alert dismissed', icon: 'bell', color: C.slate },
};

/** Where an activity leads: the customer, case, document or alert it is about. */
function activityTarget(a) {
  if (a.entityType === 'ReviewCase' && a.entityId) return `/cases/${a.entityId}`;
  if (a.entityType === 'Alert' && a.entityId) return `/alerts?status=all&open=${a.entityId}`;
  if (a.entityType === 'Document' && a.entityId) return `/documents/${a.entityId}`;
  if (a.entityType === 'BeneficialOwner' && a.entityId) return `/ownership/owners/${a.entityId}`;
  return a.customerCode ? `/customers/${a.customerCode}` : null;
}

function ago(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function ActivityPanel({ data, loading, error, onRetry }) {
  return (
    <Panel id="activity-heading" title="Recent Activities" subtitle="What people did most recently, from the audit records" action={{ to: '/audit', label: 'Audit trail' }}
      loading={loading} error={error} onRetry={onRetry} empty={!loading && (data ?? []).length === 0} emptyText="No activity has been recorded yet.">
      <ol className="relative">
        {(data ?? []).map((a, i, list) => {
          const m = ACTIVITY[a.actionType] || { title: a.actionLabel, icon: 'activity', color: C.slate };
          const to = activityTarget(a);
          const ref = a.entityType === 'ReviewCase' || a.entityType === 'Alert' ? a.entityRef : a.customerCode || a.entityRef;
          const body = (
            <>
              <span className="text-sm font-medium text-slate-900">{m.title}</span>
              <span className="block break-words text-xs text-slate-500"><span className="font-mono">{ref}</span> · by {a.user.name.replace(/\s*\(demo\)/, '')}</span>
            </>
          );
          return (
            <li key={a.id} className="relative flex gap-3 pb-4 last:pb-0">
              {i < list.length - 1 && <span className="absolute left-[17px] top-9 h-[calc(100%-1.5rem)] w-px bg-slate-200" aria-hidden="true" />}
              <span className="z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full" style={{ backgroundColor: `${m.color}1F`, color: m.color }}><Icon name={m.icon} className="h-4 w-4" /></span>
              <div className="min-w-0 flex-1">{to ? <Link to={to} className="block rounded-md hover:bg-slate-50">{body}</Link> : <div>{body}</div>}</div>
              <time dateTime={a.createdAt} title={formatDateTime(a.createdAt)} className="shrink-0 pt-0.5 text-[11px] text-slate-400">{ago(a.createdAt)}</time>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
