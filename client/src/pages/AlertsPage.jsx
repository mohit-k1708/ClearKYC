import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { runDetectionJob } from '../services/phase6Api';
import { acknowledgeAlert, changeAlertStatus, getAlert, getAlertOptions, listAlerts, resolveAlert } from '../services/reportApi';
import useAsync from '../hooks/useAsync';
import useDebounce from '../hooks/useDebounce';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, PageHeader, Pagination, Spinner } from '../components/ui';
import { SeverityBadge } from '../components/reviewUi';
import { AlertStatusBadge, DetailList, SidePanel } from '../components/reportUi';
import { formatDate, formatDateTime } from '../utils/format';

const PAGE_SIZE = 12;
const SOURCE_LINK = {
  Document: (id) => `/documents/${id}`,
  BeneficialOwner: (id) => `/ownership/owners/${id}`,
  ReviewSchedule: () => '/reviews',
};

/** Remarks form shared by "Resolve" and "Dismiss". */
function RemarksForm({ label, minLength, submitLabel, onSubmit, onCancel, busy, error }) {
  const [text, setText] = useState('');
  const tooShort = text.trim().length < minLength;
  return (
    <form
      className="mt-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
      aria-label={label}
      onSubmit={(e) => { e.preventDefault(); if (!tooShort) onSubmit(text.trim()); }}
    >
      <label htmlFor="alert-remarks" className="block text-sm font-medium text-slate-700">{label}</label>
      <textarea id="alert-remarks" className="input min-h-[80px]" value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} placeholder={`At least ${minLength} characters`} required />
      {error && <p className="text-sm text-red-600" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={busy || tooShort}>{busy ? 'Saving…' : submitLabel}</button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

function AlertPanel({ id, minRemarks, onClose, onChanged }) {
  const { current: person } = useReviewer();
  const personId = person?.id ?? null;
  const { data, loading, error, reload } = useAsync(() => getAlert(id), [id, personId]);
  const toast = useToast();
  const [mode, setMode] = useState(null); // 'resolve' | 'dismiss'
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');

  async function run(fn, message) {
    setBusy(true);
    setActionError('');
    try {
      await fn();
      toast.success(message);
      setMode(null);
      reload();
      onChanged();
    } catch (err) {
      setActionError(err.message || 'The change could not be saved');
    } finally {
      setBusy(false);
    }
  }

  const can = (a) => data?.allowedActions?.includes(a);
  const link = data && SOURCE_LINK[data.relatedEntityType]?.(data.relatedEntityId);

  return (
    <SidePanel title={data ? data.alertId : 'Alert'} subtitle={data?.alertTypeLabel} onClose={onClose}>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data && <Spinner label="Loading alert…" />}
      {data && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <SeverityBadge level={data.severity} />
            <AlertStatusBadge status={data.status} />
            {data.investigationRequired && <span className="rounded bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">Needs investigation: not a confirmed match</span>}
          </div>
          <p className="text-sm text-slate-800">{data.description}</p>
          <DetailList
            rows={[
              ['Customer', <Link to={`/customers/${data.customerId}`} className="font-mono text-xs text-brand-700 hover:underline">{data.customerId}</Link>],
              ['Customer name', data.customerName],
              ['Source record', link ? <Link to={link} className="text-brand-700 hover:underline">{data.relatedEntityType} #{data.relatedEntityId}</Link> : `${data.relatedEntityType}${data.relatedEntityId ? ` #${data.relatedEntityId}` : ''}`],
              ['Created', formatDateTime(data.createdAt)],
              ['Due date', data.dueDate ? formatDate(data.dueDate) : null],
              ['Acknowledged by', data.acknowledgedBy ? <>{data.acknowledgedBy.name} · {formatDateTime(data.acknowledgedAt)}</> : null],
              [data.resolutionType === 'Dismissed manually' ? 'Dismissed by' : 'Resolved by', data.resolvedAt ? (data.resolvedBy ? <>{data.resolvedBy.name} · {formatDateTime(data.resolvedAt)}</> : <>System · {formatDateTime(data.resolvedAt)}</>) : null],
              ['How it closed', data.resolutionType],
              ['Remarks', data.resolutionNotes],
            ]}
          />

          {!person && <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">Choose who you are acting as (sidebar) to work on this alert.</p>}
          {person && data.isActive && data.allowedActions.length === 0 && <p className="text-sm text-slate-500">Your role cannot change this alert.</p>}

          {data.isActive && data.allowedActions.length > 0 && (
            <section aria-label="Actions">
              <div className="flex flex-wrap gap-2">
                {can('acknowledge') && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => acknowledgeAlert(data.id), 'Alert acknowledged')}>Acknowledge</button>}
                {can('in_progress') && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => run(() => changeAlertStatus(data.id, 'In Progress'), 'Marked in progress')}>Mark in progress</button>}
                {can('resolve') && <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setMode('resolve'); setActionError(''); }}>Resolve…</button>}
                {can('dismiss') && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setMode('dismiss'); setActionError(''); }}>Dismiss…</button>}
              </div>
              {actionError && !mode && <p className="mt-2 text-sm text-red-600" role="alert">{actionError}</p>}
              {mode === 'resolve' && (
                <RemarksForm label="Resolution remarks" minLength={minRemarks} submitLabel="Resolve alert" busy={busy} error={actionError} onCancel={() => setMode(null)}
                  onSubmit={(text) => run(() => resolveAlert(data.id, text), 'Alert resolved')} />
              )}
              {mode === 'dismiss' && (
                <RemarksForm label="Why is this alert being dismissed?" minLength={minRemarks} submitLabel="Dismiss alert" busy={busy} error={actionError} onCancel={() => setMode(null)}
                  onSubmit={(text) => run(() => changeAlertStatus(data.id, 'Dismissed', text), 'Alert dismissed')} />
              )}
            </section>
          )}

          <section aria-label="Alert history">
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">History</h3>
            <ol className="space-y-3 border-l-2 border-slate-200 pl-4">
              {data.history.map((h) => (
                <li key={h.id} className="relative">
                  <span className="absolute -left-[21px] top-1.5 h-2.5 w-2.5 rounded-full bg-slate-400" aria-hidden="true" />
                  <div className="text-sm font-medium text-slate-800">{h.action}</div>
                  <div className="text-xs text-slate-500">{h.user.name} ({h.user.role === 'System' ? 'System' : h.user.role}) · {formatDateTime(h.createdAt)}</div>
                  {h.previousValues?.status && h.newValues?.status && <div className="mt-0.5 text-xs text-slate-600">{h.previousValues.status} → {h.newValues.status}</div>}
                  {h.reason && <p className="mt-1 rounded bg-slate-50 px-2 py-1 text-sm text-slate-700">{h.reason}</p>}
                </li>
              ))}
            </ol>
          </section>
        </div>
      )}
    </SidePanel>
  );
}

/** Alerts & Notifications: important KYC events, derived from the records. Filters live in the URL. */
export default function AlertsPage() {
  const [params, setParams] = useSearchParams();
  const { current: person } = useReviewer();
  const toast = useToast();
  const get = (k) => params.get(k) || '';
  const status = params.get('status') || 'active';
  const severity = get('severity');
  const alertType = get('alertType');
  const customerId = get('customerId');
  const urlSearch = get('search');
  const page = Number(params.get('page') || 1);
  const [selected, setSelected] = useState(get('open') || null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [progress, setProgress] = useState(null);

  const [searchText, setSearchText] = useState(urlSearch);
  const debounced = useDebounce(searchText);
  useEffect(() => {
    if (debounced !== urlSearch) update({ search: debounced, page: '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);

  function update(changes) {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  }

  const options = useAsync(getAlertOptions, []);
  const customerValid = !customerId || /^CUS-\d{6,}$/i.test(customerId);
  const { data, loading, error, reload } = useAsync(
    () => listAlerts({ page, pageSize: PAGE_SIZE, search: urlSearch, status, severity, alertType, customerId: customerValid ? customerId.toUpperCase() : undefined }),
    [page, urlSearch, status, severity, alertType, customerId, customerValid]
  );
  const rows = data?.data ?? [];
  const hasFilters = Boolean(urlSearch || severity || alertType || customerId || status !== 'active');

  async function refresh() {
    setRefreshing(true);
    setRefreshError(null);
    try {
      const r = await runDetectionJob(setProgress); // a background job: the page shows its progress instead of waiting on one long request
      toast.success(`Alerts refreshed: ${r.alertsCreated} new, ${r.alertsResolved} resolved automatically`);
      reload();
    } catch (err) {
      setRefreshError(err);
    } finally {
      setRefreshing(false);
      setProgress(null);
    }
  }

  const summary = data?.summary;
  return (
    <>
      <PageHeader title="Alerts & notifications" subtitle="Important KYC events, raised from the customers' real records">
        <button type="button" className="btn btn-secondary" onClick={refresh} disabled={refreshing || !person} title={person ? 'Check every customer again' : 'Choose who you are acting as first'}>
          {refreshing ? (progress?.total ? `Checking… ${progress.processed}/${progress.total} (${progress.percent}%)` : 'Checking…') : 'Refresh alerts'}
        </button>
      </PageHeader>
      <ErrorBanner error={refreshError} />

      <div className="card">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <input className="input lg:col-span-2" type="search" placeholder="Search by customer ID, name, alert ID or title" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search alerts" />
          <select className="input" value={status} onChange={(e) => update({ status: e.target.value === 'active' ? '' : e.target.value, page: '' })} aria-label="Filter by status">
            <option value="active">Active alerts</option>
            <option value="all">All statuses</option>
            <option value="closed">Resolved and dismissed</option>
            {(options.data?.statuses ?? []).map((s) => <option key={s}>{s}</option>)}
            {status.includes(',') && <option value={status}>{status.split(',').join(' + ')}</option>}
          </select>
          <select className="input" value={severity} onChange={(e) => update({ severity: e.target.value, page: '' })} aria-label="Filter by severity">
            <option value="">All severities</option>
            {(options.data?.severities ?? []).map((s) => <option key={s}>{s}</option>)}
            {severity.includes(',') && <option value={severity}>{severity.split(',').join(' + ')}</option>}
          </select>
          <select className="input lg:col-span-2" value={alertType} onChange={(e) => update({ alertType: e.target.value, page: '' })} aria-label="Filter by alert type">
            <option value="">All alert types</option>
            {(options.data?.alertTypes ?? []).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
          </select>
          <div>
            <input className={`input ${customerValid ? '' : 'input-error'}`} placeholder="Customer ID (CUS-000001)" value={customerId} onChange={(e) => update({ customerId: e.target.value.trim(), page: '' })} aria-label="Filter by customer ID" aria-invalid={!customerValid} />
            {!customerValid && <p className="mt-1 text-xs text-red-600">Customer ID must look like CUS-000001</p>}
          </div>
          {hasFilters && <div className="flex items-center"><button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => { setSearchText(''); setParams({}, { replace: true }); }}>Clear filters</button></div>}
        </div>
        {summary && (
          <p className="px-4 pb-3 text-xs text-slate-500" aria-live="polite">
            {summary.total.toLocaleString('en-IN')} alert{summary.total === 1 ? '' : 's'} shown: {['Critical', 'High', 'Medium', 'Low'].map((s) => `${summary.bySeverity[s]} ${s}`).join(' · ')}
          </p>
        )}

        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? (
          <Spinner label="Loading alerts…" />
        ) : (
          <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Alert ID</th>
                  <th className="px-4 py-3">Customer ID</th>
                  <th className="px-4 py-3">Alert type</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Created</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((a) => (
                  <tr key={a.id} className="align-top hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{a.alertId}</td>
                    <td className="px-4 py-3">
                      <Link to={`/customers/${a.customerId}`} className="font-mono text-xs text-brand-700 hover:underline">{a.customerId}</Link>
                      <div className="max-w-[12rem] truncate text-xs text-slate-500">{a.customerName}</div>
                    </td>
                    <td className="px-4 py-3">
                      {a.alertTypeLabel}
                      {a.dueDate && <div className="text-[11px] text-slate-500">due {formatDate(a.dueDate)}</div>}
                    </td>
                    <td className="px-4 py-3"><SeverityBadge level={a.severity} /></td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(a.createdAt)}</td>
                    <td className="px-4 py-3"><AlertStatusBadge status={a.status} /></td>
                    <td className="px-4 py-3 text-right"><button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setSelected(String(a.id))}>{a.isActive ? 'Review' : 'View'}</button></td>
                  </tr>
                ))}
                {!loading && rows.length === 0 && !error && (
                  <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-500">{hasFilters ? 'No alerts match your filters.' : 'No active alerts. Alerts appear when documents expire, ownership is incomplete, a review is due and so on.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pagination.totalItems > 0 && <Pagination pagination={data.pagination} onPage={(p) => update({ page: p > 1 ? String(p) : '' })} />}
      </div>
      <p className="mt-3 text-xs text-slate-500">A potential PEP or sanctions match is only a possible match from simulated screening. It stays a potential match until a compliance reviewer investigates it, and it cannot be dismissed.</p>
      {selected && <AlertPanel id={selected} minRemarks={options.data?.minRemarksLength ?? 10} onClose={() => setSelected(null)} onChanged={reload} />}
    </>
  );
}

