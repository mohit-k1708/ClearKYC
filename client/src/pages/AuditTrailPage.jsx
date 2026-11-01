import { Link, useSearchParams } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { getAuditEvent, getAuditOptions, listAuditEvents } from '../services/reportApi';
import useAsync from '../hooks/useAsync';
import useDebounce from '../hooks/useDebounce';
import useReviewer from '../hooks/useReviewer';
import { ErrorBanner, PageHeader, Pagination, Spinner } from '../components/ui';
import { CategoryBadge, DetailList, SidePanel, ValuesTable } from '../components/reportUi';
import { ROLE_LABELS } from '../components/reviewUi';
import { formatDateTime } from '../utils/format';

const PAGE_SIZE = 15;

function EventDetails({ id, onClose }) {
  const { data, loading, error, reload } = useAsync(() => getAuditEvent(id), [id]);
  return (
    <SidePanel title={data ? data.eventId : 'Audit event'} subtitle={data?.actionLabel} onClose={onClose}>
      <ErrorBanner error={error} onRetry={reload} />
      {loading && !data && <Spinner label="Loading event…" />}
      {data && (
        <div className="space-y-6">
          <DetailList
            rows={[
              ['Event ID', <span className="font-mono text-xs">{data.eventId}</span>],
              ['When', formatDateTime(data.createdAt)],
              ['User', `${data.user.name} (${ROLE_LABELS[data.userRole] || data.userRole})`],
              ['Action', <span className="inline-flex items-center gap-2">{data.actionLabel}<CategoryBadge category={data.category} /></span>],
              ['Entity', `${data.entityType}${data.entityRef ? ` · ${data.entityRef}` : ''}`],
              ['Entity ID', data.entityId],
              ['Customer', data.customerCode ? <Link to={`/customers/${data.customerCode}`} className="font-mono text-xs text-brand-700 hover:underline">{data.customerCode}</Link> : null],
              ['Reason / remarks', data.reason],
              ['IP address', data.ipAddress],
            ]}
          />
          <div className="grid gap-6 sm:grid-cols-2">
            <ValuesTable title="Previous values" values={data.previousValues} />
            <ValuesTable title="New values" values={data.newValues} />
          </div>
          <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">Audit events are written by the server in the same transaction as the change they describe. They cannot be edited or deleted. Sensitive identifiers (PAN, Aadhaar, document numbers, dates of birth) are never stored here.</p>
        </div>
      )}
    </SidePanel>
  );
}

/** Audit Trail: every important action, who did it, what changed and why. Compliance reviewers and administrators only. */
export default function AuditTrailPage() {
  const [params, setParams] = useSearchParams();
  const { current: person } = useReviewer();
  const get = (k) => params.get(k) || '';
  const category = get('category');
  const actionType = get('actionType');
  const entityType = get('entityType');
  const userId = get('userId');
  const customerId = get('customerId');
  const from = get('from');
  const to = get('to');
  const urlSearch = get('search');
  const page = Number(params.get('page') || 1);
  const [selected, setSelected] = useState(null);

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

  // Only a Compliance Reviewer or Administrator can read the audit trail, so nobody else makes the request at all.
  const canView = Boolean(person && ['Reviewer', 'Admin'].includes(person.role));
  const personId = canView ? person.id : null;
  const customerValid = !customerId || /^CUS-\d{6,}$/i.test(customerId);
  const options = useAsync(() => (personId ? getAuditOptions() : Promise.resolve(null)), [personId]);
  const { data, loading, error, reload } = useAsync(
    () => (personId ? listAuditEvents({ page, pageSize: PAGE_SIZE, search: urlSearch, category, actionType, entityType, userId, customerId: customerValid ? customerId.toUpperCase() : undefined, from, to }) : Promise.resolve(null)),
    [personId, page, urlSearch, category, actionType, entityType, userId, customerId, customerValid, from, to]
  );
  const rows = data?.data ?? [];
  const hasFilters = Boolean(urlSearch || category || actionType || entityType || userId || customerId || from || to);
  const actions = (options.data?.actions ?? []).filter((a) => !category || a.category === category);

  return (
    <>
      <PageHeader title="Audit trail" subtitle="Who did what, to which record, when and why. Entries cannot be edited or deleted." />

      {!person && <div className="card p-6 text-sm text-slate-600">Choose who you are acting as in the sidebar. The audit trail can be read by a Compliance Reviewer or an Administrator.</div>}

      {person && !canView && <div className="card p-6 text-sm text-slate-600">{person.name} ({ROLE_LABELS[person.role] || person.role}) cannot view the audit trail. It can be read by a Compliance Reviewer or an Administrator.</div>}

      {canView && (
        <div className="card">
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
            <input className="input lg:col-span-2" type="search" placeholder="Search event ID, record reference, customer ID or reason" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search audit events" />
            <select className="input" value={category} onChange={(e) => update({ category: e.target.value, actionType: '', page: '' })} aria-label="Filter by category">
              <option value="">All categories</option>
              {(options.data?.categories ?? []).map((c) => <option key={c}>{c}</option>)}
            </select>
            <select className="input" value={actionType} onChange={(e) => update({ actionType: e.target.value, page: '' })} aria-label="Filter by action">
              <option value="">All actions</option>
              {actions.map((a) => <option key={a.code} value={a.code}>{a.label}</option>)}
            </select>
            <select className="input" value={entityType} onChange={(e) => update({ entityType: e.target.value, page: '' })} aria-label="Filter by entity type">
              <option value="">All entities</option>
              {(options.data?.entityTypes ?? []).map((t) => <option key={t}>{t}</option>)}
            </select>
            <select className="input" value={userId} onChange={(e) => update({ userId: e.target.value, page: '' })} aria-label="Filter by user">
              <option value="">Any user</option>
              <option value="0">System</option>
              {(options.data?.users ?? []).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <div>
              <input className={`input ${customerValid ? '' : 'input-error'}`} placeholder="Customer ID (CUS-000001)" value={customerId} onChange={(e) => update({ customerId: e.target.value.trim(), page: '' })} aria-label="Filter by customer ID" aria-invalid={!customerValid} />
              {!customerValid && <p className="mt-1 text-xs text-red-600">Customer ID must look like CUS-000001</p>}
            </div>
            <div className="flex items-center gap-2">
              <input type="date" className="input" value={from} max={to || undefined} onChange={(e) => update({ from: e.target.value, page: '' })} aria-label="From date" />
              <span className="text-slate-400">–</span>
              <input type="date" className="input" value={to} min={from || undefined} onChange={(e) => update({ to: e.target.value, page: '' })} aria-label="To date" />
            </div>
            {hasFilters && <div className="flex items-center"><button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => { setSearchText(''); setParams({}, { replace: true }); }}>Clear filters</button></div>}
          </div>

          <ErrorBanner error={error} onRetry={reload} />
          {loading && !data ? (
            <Spinner label="Loading audit events…" />
          ) : (
            <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Event ID</th>
                    <th className="px-4 py-3">User</th>
                    <th className="px-4 py-3">Action</th>
                    <th className="px-4 py-3">Entity</th>
                    <th className="px-4 py-3">Entity ID</th>
                    <th className="px-4 py-3">Date and time</th>
                    <th className="px-4 py-3 text-right">Details</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {rows.map((e) => (
                    <tr key={e.id} className="align-top hover:bg-slate-50">
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">{e.eventId}</td>
                      <td className="px-4 py-3">
                        <span className="text-slate-900">{e.user.name}</span>
                        <span className="block text-[11px] text-slate-500">{ROLE_LABELS[e.userRole] || e.userRole}</span>
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-slate-900">{e.actionLabel}</span>
                        <span className="mt-0.5 block"><CategoryBadge category={e.category} /></span>
                      </td>
                      <td className="px-4 py-3 text-slate-700">{e.entityType}</td>
                      <td className="max-w-[14rem] px-4 py-3">
                        <span className="block truncate font-mono text-xs text-slate-700" title={e.entityRef || String(e.entityId ?? '')}>{e.entityRef || e.entityId || '—'}</span>
                        {e.customerCode && <Link to={`/customers/${e.customerCode}`} className="font-mono text-[11px] text-brand-700 hover:underline">{e.customerCode}</Link>}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDateTime(e.createdAt)}</td>
                      <td className="px-4 py-3 text-right"><button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => setSelected(e.id)}>View details</button></td>
                    </tr>
                  ))}
                  {!loading && rows.length === 0 && !error && (
                    <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-500">{hasFilters ? 'No audit events match your filters.' : 'No audit events yet.'}</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
          {data && data.pagination.totalItems > 0 && <Pagination pagination={data.pagination} onPage={(p) => update({ page: p > 1 ? String(p) : '' })} />}
        </div>
      )}
      {selected && <EventDetails id={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
