import { Link, useSearchParams } from 'react-router-dom';
import { useState } from 'react';
import { getValidationRun, listValidationIssues, listValidationRuns, runValidation } from '../services/reportApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from '../components/Toast';
import { ErrorBanner, PageHeader, Pagination, Spinner } from '../components/ui';
import { Kpi, OutcomeBadge } from '../components/reportUi';
import { formatDateTime } from '../utils/format';

const PAGE_SIZE = 10;
const CATEGORIES = ['Primary Keys', 'Foreign Keys', 'Documents', 'Ownership', 'Risk', 'Review Cases', 'Data Consistency'];

/** Where a person goes to look at, and correct, the record behind an issue. Nothing is changed from this page. */
function inspectLink(i) {
  switch (i.entityType) {
    case 'Customer': return { to: `/customers/${i.entityRef}`, label: 'Open customer' };
    case 'Document': return i.entityId ? { to: `/documents/${i.entityId}`, label: 'Open document' } : null;
    case 'BeneficialOwner': return i.customerId ? { to: `/ownership/${i.customerId}`, label: 'Open ownership' } : null;
    case 'ReviewCase': return i.entityId ? { to: `/cases/${i.entityId}`, label: 'Open case' } : null;
    case 'Alert': return { to: `/alerts?status=all&search=${i.entityRef}`, label: 'Open alert' };
    case 'ReviewSchedule': return { to: '/reviews', label: 'Open reviews' };
    case 'RiskRating': return i.customerId ? { to: `/risk/${i.customerId}`, label: 'Open risk history' } : null;
    default: return i.customerId ? { to: `/customers/${i.customerId}`, label: 'Open customer' } : null;
  }
}

/** Data Quality & Validation: run the checks, see Passed / Failed / Warning, inspect the failing records. Read-only. */
export default function DataQualityPage() {
  const [params, setParams] = useSearchParams();
  const { current: person } = useReviewer();
  const toast = useToast();
  const get = (k) => params.get(k) || '';
  const runParam = get('run');
  const severity = get('severity');
  const category = get('category');
  const status = get('status');
  const checkCode = get('checkCode');
  const page = Number(params.get('page') || 1);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState(null);
  const [version, setVersion] = useState(0);

  function update(changes) {
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
    setParams(next, { replace: true });
  }

  const runs = useAsync(() => listValidationRuns({ page: 1, pageSize: 8 }), [version]);
  const latestId = runs.data?.data?.[0]?.id ?? null;
  const runId = runParam || (latestId ? String(latestId) : '');
  const run = useAsync(() => (runId ? getValidationRun(runId) : Promise.resolve(null)), [runId, version]);
  const issues = useAsync(
    () => (runId ? listValidationIssues({ runId, page, pageSize: PAGE_SIZE, severity, category, status, checkCode }) : Promise.resolve(null)),
    [runId, page, severity, category, status, checkCode, version]
  );

  const canRun = person && ['Reviewer', 'Admin'].includes(person.role);

  async function start() {
    setRunning(true);
    setRunError(null);
    try {
      const r = await runValidation();
      toast.success(`Validation finished: ${r.passedChecks} passed, ${r.failedChecks} failed, ${r.warnings} warnings`);
      setParams({}, { replace: true });
      setVersion((v) => v + 1);
    } catch (err) {
      setRunError(err);
    } finally {
      setRunning(false);
    }
  }

  const r = run.data;
  const checksByCategory = r ? CATEGORIES.map((c) => ({ category: c, checks: r.results.filter((x) => x.category === c) })).filter((g) => g.checks.length) : [];
  const rows = issues.data?.data ?? [];
  const hasFilters = Boolean(severity || category || status || checkCode);

  return (
    <>
      <PageHeader title="Data quality & validation" subtitle="Checks that read the records and report problems. Nothing is corrected automatically.">
        <button type="button" className="btn btn-primary" onClick={start} disabled={running || !canRun} title={canRun ? 'Run all checks now' : 'A Compliance Reviewer or Administrator can run the checks'}>
          {running ? 'Running checks…' : 'Run validation'}
        </button>
      </PageHeader>
      {!canRun && <p className="mb-4 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-600">{person ? `${person.name} can view results. Running the checks needs a Compliance Reviewer or Administrator.` : 'Choose who you are acting as (sidebar) to run the checks. Results can be viewed by everyone.'}</p>}
      <ErrorBanner error={runError} />
      <ErrorBanner error={runs.error} onRetry={runs.reload} />
      {runs.loading && !runs.data && <Spinner label="Loading validation runs…" />}

      {runs.data && runs.data.data.length === 0 && (
        <div className="card p-8 text-center text-sm text-slate-600">No validation has been run yet. {canRun ? 'Press “Run validation” to check the records.' : 'A Compliance Reviewer or Administrator can run the first check.'}</div>
      )}

      {r && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <Kpi label="Total checks performed" value={r.totalChecks} accent="border-l-slate-400" />
            <Kpi label="Passed checks" value={r.passedChecks} accent="border-l-emerald-500" />
            <Kpi label="Failed checks" value={r.failedChecks} accent="border-l-red-500" />
            <Kpi label="Warnings" value={r.warnings} accent="border-l-amber-500" />
            <Kpi label="Validation run date" value={formatDateTime(r.validationRunDate)} hint={`${r.runId} · evaluated for ${r.asOf}${r.createdBy ? ` · ${r.createdBy.name}` : ''}`} accent="border-l-teal-500" />
          </div>

          {r.failedRecordIds.length > 0 && (
            <div className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900">
              <strong>Failed record IDs:</strong>{' '}
              <span className="font-mono text-xs">{r.failedRecordIds.slice(0, 20).join(', ')}{r.failedRecordIds.length > 20 ? ` … and ${r.failedRecordIds.length - 20} more` : ''}</span>
            </div>
          )}

          <section className="mt-6" aria-label="Checks">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Checks in this run</h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {checksByCategory.map((g) => (
                <div key={g.category} className="card min-w-0 p-4">
                  <h3 className="mb-2 text-sm font-semibold text-slate-800">{g.category}</h3>
                  <ul className="divide-y divide-slate-100">
                    {g.checks.map((c) => (
                      <li key={c.code} className="flex items-center justify-between gap-3 py-2">
                        <div className="min-w-0">
                          <div className="text-sm text-slate-800">{c.title}</div>
                          <div className="font-mono text-[11px] text-slate-400">{c.code}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {c.issueCount > 0 && (
                            <button type="button" className="text-xs font-medium text-brand-700 hover:underline" onClick={() => update({ run: runParam, checkCode: c.code, page: '' })}>{c.issueCount} record{c.issueCount === 1 ? '' : 's'}</button>
                          )}
                          <OutcomeBadge outcome={c.outcome} />
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <section className="mt-6" aria-label="Issues">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Issues found</h2>
            <div className="card">
              <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
                <select className="input" value={severity} onChange={(e) => update({ severity: e.target.value, page: '' })} aria-label="Filter by severity">
                  <option value="">Failed and warnings</option>
                  <option value="Error">Failed (errors)</option>
                  <option value="Warning">Warnings</option>
                </select>
                <select className="input" value={category} onChange={(e) => update({ category: e.target.value, page: '' })} aria-label="Filter by category">
                  <option value="">All categories</option>
                  {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
                </select>
                <select className="input" value={status} onChange={(e) => update({ status: e.target.value, page: '' })} aria-label="Filter by issue status">
                  <option value="">Open and fixed</option>
                  <option value="Open">Still open</option>
                  <option value="Resolved">Fixed since this run</option>
                </select>
                <div className="flex items-center gap-3 text-sm">
                  {checkCode && <span className="rounded bg-slate-100 px-2 py-1 font-mono text-xs">{checkCode}</span>}
                  {(hasFilters) && <button type="button" className="font-medium text-brand-700 hover:underline" onClick={() => update({ severity: '', category: '', status: '', checkCode: '', page: '' })}>Clear filters</button>}
                </div>
              </div>
              <ErrorBanner error={issues.error} onRetry={issues.reload} />
              {issues.loading && !issues.data ? <Spinner label="Loading issues…" /> : (
                <div className={`overflow-x-auto ${issues.loading ? 'opacity-50' : ''}`}>
                  <table className="w-full min-w-[960px] text-left text-sm">
                    <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-4 py-3">Result</th>
                        <th className="px-4 py-3">Record</th>
                        <th className="px-4 py-3">What is wrong</th>
                        <th className="px-4 py-3">Recommended fix</th>
                        <th className="px-4 py-3 text-right">Inspect</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((i) => {
                        const link = inspectLink(i);
                        return (
                          <tr key={i.id} className="align-top hover:bg-slate-50">
                            <td className="px-4 py-3">
                              <OutcomeBadge outcome={i.severity === 'Error' ? 'Failed' : 'Warning'} />
                              {i.status === 'Resolved' && <div className="mt-1"><OutcomeBadge outcome="Resolved" /></div>}
                            </td>
                            <td className="px-4 py-3">
                              <div className="font-mono text-xs text-slate-800">{i.entityRef || `${i.entityType} #${i.entityId}`}</div>
                              <div className="text-[11px] text-slate-500">{i.entityType} · {i.category}</div>
                            </td>
                            <td className="max-w-md px-4 py-3 text-slate-800">{i.description}</td>
                            <td className="max-w-xs px-4 py-3 text-slate-600">{i.recommendedFix}</td>
                            <td className="px-4 py-3 text-right">{link ? <Link to={link.to} className="whitespace-nowrap font-medium text-brand-700 hover:underline">{link.label}</Link> : <span className="text-slate-400">—</span>}</td>
                          </tr>
                        );
                      })}
                      {!issues.loading && rows.length === 0 && !issues.error && (
                        <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-500">{hasFilters ? 'No issues match your filters.' : 'No issues in this run. Every check passed.'}</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
              {issues.data && issues.data.pagination.totalItems > 0 && <Pagination pagination={issues.data.pagination} onPage={(p) => update({ page: p > 1 ? String(p) : '' })} />}
            </div>
            <p className="mt-2 text-xs text-slate-500">Problems are corrected by people through the normal screens (documents, ownership, cases). Run the validation again afterwards: fixed issues are then shown as fixed.</p>
          </section>
        </>
      )}

      {runs.data && runs.data.data.length > 1 && (
        <section className="mt-6" aria-label="Earlier runs">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Recent runs</h2>
          <div className="card overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-2">Run</th><th className="px-4 py-2">When</th><th className="px-4 py-2">Passed</th><th className="px-4 py-2">Failed</th><th className="px-4 py-2">Warnings</th><th className="px-4 py-2" /></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {runs.data.data.map((x) => (
                  <tr key={x.id} className={String(x.id) === runId ? 'bg-brand-50/50' : ''}>
                    <td className="px-4 py-2 font-mono text-xs">{x.runId}</td>
                    <td className="px-4 py-2 text-slate-600">{formatDateTime(x.startedAt)}</td>
                    <td className="px-4 py-2 tabular-nums">{x.passedChecks}</td>
                    <td className="px-4 py-2 tabular-nums">{x.failedChecks}</td>
                    <td className="px-4 py-2 tabular-nums">{x.warnings}</td>
                    <td className="px-4 py-2 text-right">{String(x.id) === runId ? <span className="text-xs text-slate-500">Shown</span> : <button type="button" className="text-sm font-medium text-brand-700 hover:underline" onClick={() => setParams({ run: String(x.id) }, { replace: true })}>View</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
