import { Fragment, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getReviewOptions, listExceptions } from '../services/reviewApi';
import { runDetectionJob } from '../services/phase6Api';
import useAsync from '../hooks/useAsync';
import useDebounce from '../hooks/useDebounce';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, PageHeader, Pagination, Spinner } from '../components/ui';
import { CaseStatusBadge, ExceptionStatusBadge, SeverityBadge } from '../components/reviewUi';
import { formatDate, formatDateTime } from '../utils/format';

const PAGE_SIZE = 10;
const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];

/** Where the record that caused an exception lives. */
function sourceLink(e) {
  switch (e.sourceEntityType) {
    case 'Document': return { to: `/documents/${e.sourceEntityId}`, label: `Document #${e.sourceEntityId}` };
    case 'BeneficialOwner': return { to: `/ownership/owners/${e.sourceEntityId}`, label: `Owner #${e.sourceEntityId}` };
    case 'KYCRequirement': return { to: `/kyc/${e.customerId}`, label: 'KYC requirement' };
    case 'ReviewSchedule': return { to: '/reviews', label: `Review #${e.sourceEntityId}` };
    case 'ReviewCase': return { to: `/cases/${e.sourceEntityId}`, label: `Case #${e.sourceEntityId}` };
    default: return { to: `/customers/${e.customerId}`, label: 'Customer' };
  }
}

/**
 * Exceptions & Issues: conditions DETECTED from the real records (documents, ownership, risk, reviews).
 * Running detection never creates a duplicate of an exception that is already active.
 */
export default function ExceptionsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { current: person } = useReviewer();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') || 'active';
  const severity = params.get('severity') || '';
  const type = params.get('type') || '';
  const group = params.get('group') || '';
  const withoutCase = params.get('withoutCase') || '';
  const customerId = params.get('customerId') || '';
  const page = Number(params.get('page') || 1);
  const urlSearch = params.get('search') || '';

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

  const options = useAsync(getReviewOptions, []);
  const { data, loading, error, reload } = useAsync(
    () => listExceptions({ page, pageSize: PAGE_SIZE, search: urlSearch, status, severity, type, group, customerId, withoutCase }),
    [page, urlSearch, status, severity, type, group, customerId, withoutCase]
  );
  const rows = data?.data ?? [];
  const summary = data?.summary;
  const [open, setOpen] = useState(null);
  const [detecting, setDetecting] = useState(false);
  const [progress, setProgress] = useState(null);

  async function runDetection() {
    setDetecting(true);
    try {
      const r = await runDetectionJob(setProgress); // background job with progress
      toast.success(`Detection finished: ${r.created} new, ${r.resolved} resolved, ${r.unchanged} unchanged. No duplicates are created for exceptions that are already active.`);
      reload();
    } catch (err) {
      toast.error(err.status === 401 ? 'Choose who you are acting as in the sidebar first.' : err.message);
    } finally {
      setDetecting(false);
      setProgress(null);
    }
  }

  const hasFilters = Boolean(urlSearch || severity || type || group || withoutCase || customerId || status !== 'active');

  return (
    <>
      <PageHeader title="Exceptions & issues" subtitle="Problems found in customer files that need someone to act. They are found by checking the real records.">
        <button type="button" className="btn btn-primary" onClick={runDetection} disabled={detecting}>
          {detecting ? (progress?.total ? `Checking… ${progress.processed}/${progress.total} (${progress.percent}%)` : 'Checking…') : 'Run detection'}
        </button>
      </PageHeader>
      {!person && <p className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Choose who you are acting as (sidebar) to run detection or create cases.</p>}

      {summary && (
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <button type="button" onClick={() => update({ severity: '', status: 'active', page: '' })} className={`card p-4 text-left transition hover:shadow-md ${!severity && status === 'active' ? 'ring-2 ring-brand-600' : ''}`}>
            <div className="text-sm text-slate-500">Active exceptions</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{summary.active}</div>
          </button>
          {SEVERITIES.map((s) => (
            <button key={s} type="button" onClick={() => update({ severity: severity === s ? '' : s, status: 'active', page: '' })} className={`card p-4 text-left transition hover:shadow-md ${severity === s ? 'ring-2 ring-brand-600' : ''}`} aria-pressed={severity === s}>
              <div className="flex items-center gap-2 text-sm text-slate-500"><SeverityBadge level={s} /></div>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-slate-900">{summary.bySeverity[s]}</div>
            </button>
          ))}
        </div>
      )}

      <div className="card">
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <input className="input lg:col-span-2" type="search" placeholder="Search by customer ID, name, exception ID or text" value={searchText} onChange={(e) => setSearchText(e.target.value)} aria-label="Search exceptions" />
          <select className="input" value={status} onChange={(e) => update({ status: e.target.value === 'active' ? '' : e.target.value, page: '' })} aria-label="Filter by status">
            <option value="active">Active (open and in review)</option>
            <option value="Open">Open</option>
            <option value="In Review">In Review</option>
            <option value="Resolved">Resolved (history)</option>
            <option value="all">All</option>
          </select>
          <select className="input" value={group} onChange={(e) => update({ group: e.target.value, type: '', page: '' })} aria-label="Filter by area">
            <option value="">All areas</option>
            <option>Document</option><option>Ownership</option><option>Risk</option><option>Review</option>
          </select>
          <select className="input lg:col-span-2" value={type} onChange={(e) => update({ type: e.target.value, page: '' })} aria-label="Filter by exception type">
            <option value="">All exception types</option>
            {(options.data?.exceptionTypes ?? []).filter((t) => !group || t.group === group).map((t) => <option key={t.code} value={t.code}>{t.label}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={Boolean(withoutCase)} onChange={(e) => update({ withoutCase: e.target.checked ? 'true' : '', page: '' })} /> Without a case
          </label>
          {hasFilters && <button type="button" className="btn btn-secondary" onClick={() => { setSearchText(''); setParams({}, { replace: true }); }}>Clear filters</button>}
        </div>
        {customerId && <p className="px-4 pb-3 text-sm text-slate-600">Showing exceptions for <span className="font-mono">{customerId}</span>.</p>}

        <ErrorBanner error={error} onRetry={reload} />
        {loading && !data ? (
          <Spinner label="Loading exceptions…" />
        ) : (
          <div className={`overflow-x-auto ${loading ? 'opacity-50' : ''}`}>
            <table className="w-full min-w-[980px] text-left text-sm">
              <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Exception</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Issue</th>
                  <th className="px-4 py-3">Severity</th>
                  <th className="px-4 py-3">Detected</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Source</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((e) => {
                  const src = sourceLink(e);
                  return (
                    <Fragment key={e.id}>
                      <tr className="align-top hover:bg-slate-50">
                        <td className="whitespace-nowrap px-4 py-3 font-mono text-xs font-medium text-slate-800">{e.exceptionId}</td>
                        <td className="px-4 py-3">
                          <Link to={`/customers/${e.customerId}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">{e.customerId}</Link>
                          <div className="text-slate-900">{e.customerName}</div>
                        </td>
                        <td className="max-w-sm px-4 py-3">
                          <div className="font-medium text-slate-900">{e.typeLabel}</div>
                          <div className="text-xs text-slate-500">{e.description}</div>
                        </td>
                        <td className="px-4 py-3"><SeverityBadge level={e.severity} /></td>
                        <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatDate(e.detectionDate)}</td>
                        <td className="px-4 py-3"><ExceptionStatusBadge status={e.status} /></td>
                        <td className="px-4 py-3"><Link to={src.to} className="text-xs font-medium text-brand-700 hover:underline">{src.label}</Link></td>
                        <td className="px-4 py-3 text-right">
                          {e.status === 'Resolved' ? (
                            <button type="button" className="font-medium text-brand-700 hover:underline" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                              {open === e.id ? 'Hide' : 'Resolution'}
                            </button>
                          ) : e.activeCase ? (
                            <Link to={`/cases/${e.activeCase.id}`} className="inline-flex flex-col items-end gap-1 text-xs font-medium text-brand-700 hover:underline">
                              {e.activeCase.caseCode}
                              <CaseStatusBadge status={e.activeCase.status} />
                            </Link>
                          ) : (
                            <button type="button" className="btn btn-secondary !py-1" onClick={() => navigate(`/cases/new?exception=${e.id}`)}>Create case</button>
                          )}
                        </td>
                      </tr>
                      {open === e.id && (
                        <tr className="bg-slate-50/70">
                          <td colSpan={8} className="px-4 py-3 text-sm text-slate-700">
                            <strong>{e.resolutionType}</strong> on {formatDateTime(e.resolvedAt)}{e.resolvedBy ? ` by ${e.resolvedBy.name}` : ''}. {e.resolutionNotes}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
                {!loading && rows.length === 0 && !error && (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-slate-500">{hasFilters ? 'No exceptions match your filters.' : 'No active exceptions. Run detection to check the records.'}</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {data && data.pagination.totalItems > 0 && <Pagination pagination={data.pagination} onPage={(p) => update({ page: p > 1 ? String(p) : '' })} />}
      </div>
      <p className="mt-3 text-xs text-slate-500">Exceptions are linked to the record that caused them. When the problem is fixed the exception is resolved automatically with a recorded reason, and kept as history.</p>
    </>
  );
}
