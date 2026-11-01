import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getCase } from '../services/reviewApi';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { ErrorBanner, PageHeader, RiskBadge, Spinner, TypeBadge } from '../components/ui';
import { Fact, StatusBadge } from '../components/kycUi';
import { OverallResult, OwnershipStatusBadge, ScreeningBadge } from '../components/riskUi';
import { ActionPanel, AssignmentPanel, NotePanel } from '../components/CaseActionPanels';
import { CaseStatusBadge, CaseTimeline, DueDate, ExceptionStatusBadge, Person, SeverityBadge } from '../components/reviewUi';
import { formatDate, formatDateTime } from '../utils/format';

/**
 * Case details: customer, related exceptions and documents, ownership and risk, assignments, notes, status history and
 * resolution. The buttons shown are the ones the server says THIS person may use.
 */
export default function CaseDetailsPage() {
  const { id } = useParams();
  const { current: person } = useReviewer();
  // Reload when the person changes, because the allowed actions depend on who is asking.
  const { data: c, loading, error, reload } = useAsync(() => getCase(id), [id, person?.id]);
  const [panel, setPanel] = useState(null); // null | 'assign' | 'note'

  const canAssign = c && (c.permissions.assignAnalyst !== 'none' || c.permissions.assignReviewer || c.permissions.priorityMax);

  return (
    <>
      <PageHeader title={c ? c.caseTitle : 'Review case'} subtitle={c ? `${c.caseId} · ${c.caseType}` : id}>
        <Link to="/cases" className="btn btn-secondary">← Review cases</Link>
      </PageHeader>

      {loading && !c && <Spinner label="Loading case…" />}
      <ErrorBanner error={error} onRetry={error?.status === 404 ? undefined : reload} />

      {c && (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2">
            <CaseStatusBadge status={c.status} />
            <SeverityBadge level={c.priority} />
            {c.isOverdue && <span className="rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">{c.daysOverdue} day{c.daysOverdue === 1 ? '' : 's'} overdue</span>}
            {c.requiresApproval && <span className="rounded bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">Needs compliance approval</span>}
          </div>

          {c.proposalPending && (
            <div role="status" className="rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900">
              <strong>A resolution has been proposed</strong> by {c.proposedBy?.name} and is waiting for {c.assignedReviewer?.name || 'a compliance reviewer'} to approve or reject it.
            </div>
          )}

          {/* Actions */}
          <section className="card p-5 sm:p-6" aria-labelledby="actions-heading">
            <h2 id="actions-heading" className="mb-3 text-base font-semibold">Actions</h2>
            {!person && <p role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Choose who you are acting as in the sidebar to see the actions you can take on this case.</p>}
            {person && c.allowedActions.length === 0 && !canAssign && !c.permissions.addNote && <p className="mb-3 text-sm text-slate-500">{person.name} ({person.roleLabel || person.role}) has no actions available on this case right now.</p>}
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                {canAssign && <button type="button" className="btn btn-secondary" onClick={() => setPanel(panel === 'assign' ? null : 'assign')}>Assign Case</button>}
                {c.permissions.addNote && <button type="button" className="btn btn-secondary" onClick={() => setPanel(panel === 'note' ? null : 'note')}>Add Note</button>}
              </div>
              {panel === 'assign' && canAssign && <AssignmentPanel c={c} person={person} onChanged={reload} onClose={() => setPanel(null)} />}
              {panel === 'note' && c.permissions.addNote && <NotePanel c={c} onChanged={reload} onClose={() => setPanel(null)} />}
              <ActionPanel key={`${c.status}-${person?.id}`} c={c} onChanged={reload} />
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-3">
            <div className="min-w-0 space-y-6 lg:col-span-2">
              <section className="card p-5 sm:p-6">
                <h2 className="mb-4 text-base font-semibold">Case information</h2>
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  <Fact label="Case ID" mono>{c.caseId}</Fact>
                  <Fact label="Case type">{c.caseType}</Fact>
                  <Fact label="Priority"><SeverityBadge level={c.priority} /></Fact>
                  <Fact label="Due date"><DueDate date={c.dueDate} overdue={c.isOverdue} days={c.daysOverdue} /></Fact>
                  <Fact label="Created">{formatDateTime(c.createdAt)} by {c.createdBy.name}</Fact>
                  <Fact label="Last updated">{formatDateTime(c.updatedAt)}</Fact>
                  <div className="sm:col-span-2"><Fact label="Description">{c.description}</Fact></div>
                  {c.periodicReview && <Fact label="Periodic review">Cycle {c.periodicReview.cycle}, due {formatDate(c.periodicReview.nextReviewDate)}</Fact>}
                </dl>
              </section>

              <section className="card p-5 sm:p-6" aria-labelledby="timeline-heading">
                <h2 id="timeline-heading" className="mb-1 text-base font-semibold">Case timeline</h2>
                <p className="mb-4 text-xs text-slate-500">Every status change, assignment and note, newest first. Entries are never edited or deleted.</p>
                <CaseTimeline items={c.timeline} />
              </section>

              <section className="card p-5 sm:p-6">
                <h2 className="mb-3 text-base font-semibold">Resolution</h2>
                {c.resolutionNotes ? (
                  <>
                    <p className="whitespace-pre-wrap rounded-md bg-slate-50 p-3 text-sm text-slate-800">{c.resolutionNotes}</p>
                    <p className="mt-2 text-xs text-slate-500">
                      {c.proposalPending ? 'Proposed by ' + c.proposedBy?.name + ', waiting for approval. ' : ''}
                      {c.resolvedAt ? `Resolved ${formatDateTime(c.resolvedAt)}. ` : ''}
                      {c.closedAt ? `Closed ${formatDateTime(c.closedAt)}.` : ''}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-slate-500">No resolution recorded yet. A case cannot be resolved or closed without resolution notes.</p>
                )}
              </section>
            </div>

            <aside className="min-w-0 space-y-6">
              <section className="card p-5">
                <h2 className="mb-3 text-base font-semibold">Assigned to</h2>
                <dl className="space-y-3 text-sm">
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Operations analyst</dt><dd className="mt-0.5"><Person person={c.assignedAnalyst} /></dd></div>
                  <div><dt className="text-xs uppercase tracking-wide text-slate-500">Compliance reviewer</dt><dd className="mt-0.5"><Person person={c.assignedReviewer} empty="None" /></dd></div>
                </dl>
              </section>

              <section className="card p-5">
                <h2 className="mb-3 text-base font-semibold">Customer</h2>
                <p className="font-medium text-slate-900">{c.customer.name}</p>
                <p className="font-mono text-xs text-slate-500">{c.customer.customerId}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2"><TypeBadge type={c.customer.customerType} /><span className="text-xs text-slate-500">{c.customer.country}</span></div>
                <div className="mt-3 flex flex-col gap-1.5 text-sm">
                  <Link to={`/customers/${c.customer.customerId}`} className="font-medium text-brand-700 hover:underline">Customer profile</Link>
                  <Link to={`/kyc/${c.customer.customerId}`} className="font-medium text-brand-700 hover:underline">KYC completeness{c.kyc && c.kyc.percentage !== null ? ` (${c.kyc.percentage}%)` : ''}</Link>
                  <Link to={`/cases?customerId=${c.customer.customerId}&status=all`} className="font-medium text-brand-700 hover:underline">All cases for this customer</Link>
                </div>
              </section>

              <section className="card p-5">
                <h2 className="mb-3 text-base font-semibold">Risk assessment</h2>
                {c.risk ? (
                  <>
                    <div className="flex items-center gap-3"><span className="text-3xl font-semibold tabular-nums">{c.risk.riskScore}</span><OverallResult level={c.risk.riskLevel} status={c.risk.status} /></div>
                    <p className="mt-1 text-xs text-slate-500">{c.risk.assessmentId} · {formatDate(c.risk.assessmentDate)}</p>
                    <ul className="mt-2 space-y-1 text-xs text-slate-600">
                      {c.risk.reasons.slice(0, 4).map((r, i) => <li key={i}>{r.factor}: {r.description} (+{r.points})</li>)}
                    </ul>
                    <Link to={`/risk/${c.customer.customerId}`} className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">Risk summary</Link>
                  </>
                ) : <p className="text-sm text-slate-500">No assessment.</p>}
              </section>
            </aside>
          </div>

          <section className="card p-5 sm:p-6">
            <h2 className="mb-3 text-base font-semibold">Related exceptions</h2>
            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-2.5">Exception</th><th className="px-4 py-2.5">Issue</th><th className="px-4 py-2.5">Severity</th><th className="px-4 py-2.5">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {c.exceptions.map((e) => (
                    <tr key={e.id} className={e.isLinked ? 'bg-brand-50/50' : ''}>
                      <td className="px-4 py-2.5 font-mono text-xs">{e.exceptionId}{e.isLinked && <span className="ml-2 rounded bg-brand-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-brand-700">This case</span>}</td>
                      <td className="px-4 py-2.5"><div className="font-medium text-slate-900">{e.typeLabel}</div><div className="text-xs text-slate-500">{e.description}</div></td>
                      <td className="px-4 py-2.5"><SeverityBadge level={e.severity} /></td>
                      <td className="px-4 py-2.5"><ExceptionStatusBadge status={e.status} /></td>
                    </tr>
                  ))}
                  {c.exceptions.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-500">No active exceptions for this customer.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="card min-w-0 p-5 sm:p-6">
              <h2 className="mb-3 text-base font-semibold">Related documents</h2>
              <ul className="divide-y divide-slate-100 text-sm">
                {c.documents.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <Link to={`/documents/${d.id}`} className="font-medium text-brand-700 hover:underline">{d.documentType}</Link>
                    <span className="flex items-center gap-2 text-xs text-slate-500">{d.expiryDate ? `expires ${formatDate(d.expiryDate)}` : 'no expiry'}<StatusBadge status={d.status} /></span>
                  </li>
                ))}
                {c.documents.length === 0 && <li className="py-4 text-center text-slate-500">No documents submitted.</li>}
              </ul>
            </section>

            {c.ownership && (
              <section className="card min-w-0 p-5 sm:p-6">
                <div className="mb-3 flex flex-wrap items-center gap-2"><h2 className="text-base font-semibold">Beneficial ownership</h2><OwnershipStatusBadge status={c.ownership.status} /></div>
                <p className="mb-2 text-xs text-slate-600">{c.ownership.message}</p>
                <ul className="divide-y divide-slate-100 text-sm">
                  {c.ownership.owners.map((o) => (
                    <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                      <Link to={`/ownership/owners/${o.id}`} className="font-medium text-brand-700 hover:underline">{o.fullName}</Link>
                      <span className="tabular-nums text-slate-500">{o.ownershipPercentage == null ? 'no %' : `${o.ownershipPercentage}%`}</span>
                      <RiskBadge level={o.riskLevel} />
                      <ScreeningBadge label="PEP" outcome={o.screening.pep} /><ScreeningBadge label="Sanctions" outcome={o.screening.sanctions} />
                    </li>
                  ))}
                  {c.ownership.owners.length === 0 && <li className="py-4 text-center text-slate-500">No beneficial owners recorded.</li>}
                </ul>
                <Link to={`/ownership/${c.customer.customerId}`} className="mt-2 inline-block text-sm font-medium text-brand-700 hover:underline">Manage ownership</Link>
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}
