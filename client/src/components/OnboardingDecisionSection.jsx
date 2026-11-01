import { useState } from 'react';
import { Link } from 'react-router-dom';
import { getOnboardingDecisions, recordOnboardingDecision } from '../services/phase6Api';
import useAsync from '../hooks/useAsync';
import useReviewer from '../hooks/useReviewer';
import { useToast } from './Toast';
import { ErrorBanner, Field, Spinner } from './ui';
import { SeverityBadge } from './reviewUi';
import { formatDateTime } from '../utils/format';

const STATUS_STYLES = {
  Approved: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  Rejected: 'bg-red-50 text-red-700 ring-red-600/20',
  'Pending Review': 'bg-sky-50 text-sky-700 ring-sky-600/20',
};

export const DecisionBadge = ({ decision }) => (
  <span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${STATUS_STYLES[decision] || STATUS_STYLES['Pending Review']}`}>{decision}</span>
);

const POLICY_STYLES = {
  Approvable: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  'Needs follow-up': 'border-amber-200 bg-amber-50 text-amber-900',
  'Needs waiver': 'border-red-200 bg-red-50 text-red-900',
  'Blocked by evidence': 'border-slate-300 bg-slate-50 text-slate-800',
};

/**
 * Onboarding decision on the customer profile: the current status, the full history (every decision, who made it, when, why, the follow-up
 * action and any waived exceptions) and, for a Reviewer or Admin, a form to approve or reject.
 *
 * Approval policy: open Critical / High exceptions block approval unless a Reviewer or Admin waives each one with a reason (kept in the
 * audit trail); open Medium / Low exceptions need a follow-up action; missing evidence can never be waived. A final decision is not changed.
 */
export default function OnboardingDecisionSection({ customerId }) {
  const toast = useToast();
  const { current: person } = useReviewer();
  const { data, loading, error, reload } = useAsync(() => getOnboardingDecisions(customerId), [customerId]);
  const [decision, setDecision] = useState('');
  const [reason, setReason] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [waivers, setWaivers] = useState({}); // exception code -> { on, reason }
  const [fieldErrors, setFieldErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);
  const canDecide = Boolean(person?.canDecide);
  const policy = data?.policy;
  const approving = decision === 'Approved';
  const blocking = policy?.blockingExceptions ?? [];
  const nonBlocking = policy?.nonBlockingExceptions ?? [];

  const setWaiver = (code, patch) => setWaivers((w) => ({ ...w, [code]: { on: false, reason: '', ...w[code], ...patch } }));

  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (!decision) errs.decision = 'Choose Approve or Reject.';
    if (!reason.trim()) errs.reason = 'Give a reason for the decision.';
    const chosen = [];
    if (approving) {
      for (const x of blocking) {
        const w = waivers[x.exceptionId];
        if (!w?.on) errs.waivers = errs.waivers || `${x.exceptionId} is an open ${x.severity} exception and blocks approval. Waive it with a reason (Reviewer or Admin), or resolve it first.`;
        else if (!w.reason.trim()) errs.waivers = `Give a reason for waiving ${x.exceptionId}. A waiver without a reason is not accepted.`;
        else chosen.push({ exceptionId: x.exceptionId, reason: w.reason.trim() });
      }
      if (nonBlocking.length > 0 && !followUp.trim()) errs.followUpAction = 'Open Medium or Low exceptions need a follow-up action: say what will be done about them and by when.';
    }
    setFieldErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;
    setSaving(true);
    try {
      const extra = approving ? { ...(followUp.trim() ? { followUpAction: followUp.trim() } : {}), ...(chosen.length ? { waivers: chosen } : {}) } : {};
      const saved = await recordOnboardingDecision(customerId, decision, reason.trim(), extra);
      toast.success(`Onboarding ${saved.status.toLowerCase()}. The decision is final and recorded in the history${chosen.length ? `; ${chosen.length} waiver${chosen.length === 1 ? '' : 's'} recorded in the audit trail` : ''}.`);
      setDecision('');
      setReason('');
      setFollowUp('');
      setWaivers({});
      reload();
    } catch (err) {
      setFieldErrors(err.fields && !err.fields.blockers && !err.fields.blockingExceptions ? err.fields : {});
      setFormError(err);
      reload(); // the exceptions may have changed since the page was loaded
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="card p-5 sm:p-6" aria-labelledby="onboarding-decision-heading" data-testid="onboarding-decision">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <h2 id="onboarding-decision-heading" className="text-base font-semibold">Onboarding decision</h2>
        {data && <DecisionBadge decision={data.status} />}
      </div>
      {loading && !data && <Spinner label="Loading decisions…" />}
      <ErrorBanner error={error} onRetry={reload} />

      {data && (
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="min-w-0 lg:col-span-3">
            <h3 className="mb-2 text-sm font-semibold text-slate-700">Decision history</h3>
            {data.history.length === 0 ? (
              <p className="text-sm text-slate-500" data-testid="decision-history-empty">No decision has been recorded yet. The customer is pending review.</p>
            ) : (
              <ol className="space-y-3" data-testid="decision-history">
                {data.history.map((h) => (
                  <li key={h.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <DecisionBadge decision={h.decision} />
                      <span className="text-slate-700">by <strong>{h.decidedBy?.name ?? 'Unknown'}</strong>{h.decidedBy && <span className="text-slate-500"> ({h.decidedBy.role})</span>}</span>
                      <span className="ml-auto text-xs text-slate-500">{formatDateTime(h.decidedAt)}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap break-words text-slate-600"><span className="text-xs uppercase tracking-wide text-slate-400">Reason </span>{h.reason || '—'}</p>
                    {h.followUpAction && <p className="mt-1 whitespace-pre-wrap break-words text-slate-600" data-testid="history-follow-up"><span className="text-xs uppercase tracking-wide text-slate-400">Follow-up action </span>{h.followUpAction}</p>}
                    {h.exceptionsAtDecision?.length > 0 && (
                      <p className="mt-1 text-xs text-slate-500" data-testid="history-open-exceptions">
                        Open exceptions at the decision: {h.exceptionsAtDecision.map((x) => `${x.exceptionId} (${x.severity}${x.waived ? ', waived' : ''})`).join(', ')}
                      </p>
                    )}
                    {h.waivers?.length > 0 && (
                      <ul className="mt-2 space-y-1 rounded-md bg-amber-50 p-2 text-xs text-amber-900" data-testid="history-waivers">
                        {h.waivers.map((w) => (
                          <li key={w.exceptionId}><strong>Waived {w.exceptionId}</strong> ({w.severity}): {w.reason}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </div>

          <div className="min-w-0 lg:col-span-2">
            {data.isFinal ? (
              <p className="rounded-lg bg-slate-50 p-3 text-sm text-slate-600" data-testid="decision-final">
                This customer was <strong>{data.status.toLowerCase()}</strong>. A final decision is kept as it is and is not changed or overwritten.
              </p>
            ) : (
              <form onSubmit={submit} noValidate className="space-y-3">
                <h3 className="text-sm font-semibold text-slate-700">Record a decision</h3>
                {!person && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">Choose who you are acting as in the sidebar.</p>}
                {person && !canDecide && <p role="alert" className="rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">{person.name} ({person.role}) cannot decide onboarding. Choose a Reviewer or Admin.</p>}

                {policy && (
                  <div className={`rounded-lg border p-2.5 text-xs ${POLICY_STYLES[policy.outcome] || POLICY_STYLES['Blocked by evidence']}`} data-testid="policy-explanation" data-outcome={policy.outcome}>
                    <strong>{policy.outcome === 'Approvable' ? 'Approval is available.' : policy.outcome === 'Needs follow-up' ? 'Approval needs a follow-up action.' : 'Approval is not available as things stand.'}</strong> {policy.explanation}
                  </div>
                )}

                {data.approvalBlockers.length > 0 && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 p-2.5 text-xs text-slate-700" data-testid="approval-blockers">
                    <strong>Mandatory evidence still needed</strong> (this cannot be waived):
                    <ul className="mt-1 list-disc pl-5">{data.approvalBlockers.map((b) => <li key={b}>{b}</li>)}</ul>
                  </div>
                )}

                {blocking.length > 0 && (
                  <div className="rounded-lg border border-red-200 bg-white p-2.5 text-xs" data-testid="blocking-exceptions">
                    <strong className="text-red-800">Blocking exceptions (Critical or High, still open)</strong>
                    <ul className="mt-2 space-y-2">
                      {blocking.map((x) => (
                        <li key={x.exceptionId} data-testid={`blocking-${x.exceptionId}`} className="rounded-md border border-slate-200 p-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <SeverityBadge level={x.severity} />
                            <Link to={`/exceptions?customerId=${customerId}`} className="font-mono font-medium text-brand-700 hover:underline">{x.exceptionId}</Link>
                            <span className="font-medium text-slate-800">{x.typeLabel}</span>
                          </div>
                          <p className="mt-1 break-words text-slate-600">{x.description}</p>
                          {approving && canDecide && data.approvalBlockers.length === 0 && (
                            <div className="mt-2 space-y-1.5">
                              <label className="flex items-start gap-2 text-slate-700">
                                <input type="checkbox" className="mt-0.5" data-testid={`waive-${x.exceptionId}`} checked={Boolean(waivers[x.exceptionId]?.on)} onChange={(e) => setWaiver(x.exceptionId, { on: e.target.checked })} />
                                <span>Waive this exception for this approval. It stays open; the waiver and my reason are kept in the audit trail.</span>
                              </label>
                              {waivers[x.exceptionId]?.on && (
                                <input className="input" maxLength={500} placeholder="Reason for the waiver (required)" aria-label={`Reason for waiving ${x.exceptionId}`} data-testid={`waive-reason-${x.exceptionId}`} value={waivers[x.exceptionId]?.reason ?? ''} onChange={(e) => setWaiver(x.exceptionId, { reason: e.target.value })} />
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    {!approving && <p className="mt-2 text-slate-500">Choose Approve to waive them (Reviewer or Admin). Rejecting is not affected by exceptions.</p>}
                  </div>
                )}

                {nonBlocking.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-white p-2.5 text-xs" data-testid="nonblocking-exceptions">
                    <strong className="text-amber-800">Open Medium or Low exceptions (do not block approval)</strong>
                    <ul className="mt-1 space-y-1">
                      {nonBlocking.map((x) => (
                        <li key={x.exceptionId} className="flex flex-wrap items-center gap-2">
                          <SeverityBadge level={x.severity} />
                          <span className="font-mono text-slate-700">{x.exceptionId}</span>
                          <span className="text-slate-600">{x.typeLabel}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {formError && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-2.5 text-xs text-red-800" data-testid="decision-error">{formError.message}</p>}
                <fieldset disabled={!canDecide || saving} className="min-w-0 space-y-3">
                  <Field label="Decision" required error={fieldErrors.decision}>
                    <select className={`input ${fieldErrors.decision ? 'input-error' : ''}`} value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="Decision">
                      <option value="">Choose…</option>
                      {data.allowedDecisions.includes('Approved') && <option value="Approved">Approve</option>}
                      {data.allowedDecisions.includes('Rejected') && <option value="Rejected">Reject</option>}
                    </select>
                  </Field>
                  <Field label={approving && nonBlocking.length + blocking.length > 0 ? 'Reason (your rationale for approving with open exceptions)' : 'Reason'} required error={fieldErrors.reason}>
                    <textarea rows={3} maxLength={1000} className={`input ${fieldErrors.reason ? 'input-error' : ''}`} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
                  </Field>
                  {approving && (nonBlocking.length > 0 || blocking.length > 0) && (
                    <Field label="Follow-up action" required={nonBlocking.length > 0} error={fieldErrors.followUpAction} hint="What will be done about the open exceptions, and by when.">
                      <textarea rows={2} maxLength={500} className={`input ${fieldErrors.followUpAction ? 'input-error' : ''}`} value={followUp} onChange={(e) => setFollowUp(e.target.value)} aria-label="Follow-up action" data-testid="followup-input" />
                    </Field>
                  )}
                  {fieldErrors.waivers && <p role="alert" className="text-xs text-red-600" data-testid="waiver-error">{fieldErrors.waivers}</p>}
                  <button type="submit" className="btn btn-primary w-full">{saving ? 'Saving…' : 'Record decision'}</button>
                </fieldset>
                <p className="text-xs text-slate-500">Approving needs every mandatory document verified and in date. Open Critical or High exceptions block approval unless a Reviewer or Admin waives them with a reason; open Medium or Low exceptions need a follow-up action. Both decisions are final.</p>
              </form>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
