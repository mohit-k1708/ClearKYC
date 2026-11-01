import { useState } from 'react';
import { addCaseNote, assignCase, changeCaseStatus } from '../services/reviewApi';
import { listReviewers } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import { useToast } from './Toast';
import { Field } from './ui';

const PRIORITIES = ['Low', 'Medium', 'High', 'Critical'];
const BUTTON_STYLE = {
  start: 'btn-primary', submit_for_review: 'btn-primary', approve: 'btn-primary', resolve: 'btn-primary',
  reject: 'border border-red-300 bg-white text-red-700 hover:bg-red-50', close: 'btn-secondary', reopen: 'btn-secondary',
};

/**
 * The buttons for the status changes THIS person may make (the server lists them in `allowedActions`), and the small
 * form each one needs. The server still re-checks everything: hiding a button is a convenience, not security.
 */
export function ActionPanel({ c, onChanged }) {
  const toast = useToast();
  const people = useAsync(listReviewers, []);
  const [active, setActive] = useState(null); // the chosen action
  const [values, setValues] = useState({ remarks: '', resolutionNotes: '', reviewerId: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  const reviewers = (people.data ?? []).filter((p) => ['Reviewer', 'Admin'].includes(p.role));
  const set = (k) => (e) => setValues((v) => ({ ...v, [k]: e.target.value }));

  function choose(a) {
    setActive(a);
    setValues({ remarks: '', resolutionNotes: '', reviewerId: '' });
    setErrors({});
    setFormError(null);
  }

  async function submit(e) {
    e.preventDefault();
    const errs = {};
    if (active.needs.includes('remarks') && values.remarks.trim().length < 5) errs.remarks = 'Explain why (at least 5 characters)';
    if ((active.needs.includes('resolutionNotes') || active.needsResolutionNotes) && values.resolutionNotes.trim().length < 10) errs.resolutionNotes = 'Resolution notes are required (at least 10 characters)';
    if (active.needs.includes('reviewer') && !values.reviewerId) errs.reviewerId = 'Choose the compliance reviewer';
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) return;

    setSaving(true);
    try {
      await changeCaseStatus(c.id, {
        action: active.action,
        remarks: values.remarks.trim(),
        resolutionNotes: values.resolutionNotes.trim(),
        reviewerId: values.reviewerId ? Number(values.reviewerId) : undefined,
      });
      toast.success(`${active.label}: done.`);
      setActive(null);
      onChanged();
    } catch (err) {
      setErrors(err.fields || {});
      setFormError(err);
    } finally {
      setSaving(false);
    }
  }

  if (c.allowedActions.length === 0) return null;
  const showReviewer = active?.needs.includes('reviewer');
  const showRemarks = active && (active.needs.includes('remarks') || ['approve', 'close'].includes(active.action) || active.action === 'resolve');
  const showNotes = active && (active.needs.includes('resolutionNotes') || active.needsResolutionNotes);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Case actions">
        {c.allowedActions.map((a) => (
          <button key={a.action} type="button" onClick={() => choose(a)} className={`btn ${BUTTON_STYLE[a.action] || 'btn-secondary'} ${active?.action === a.action ? 'ring-2 ring-brand-600/40' : ''}`}>
            {a.label}
          </button>
        ))}
      </div>

      {active && (
        <form onSubmit={submit} noValidate className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold text-slate-800">{active.label}</h3>
          {active.action === 'submit_for_review' && <p className="text-xs text-slate-600">Your resolution is proposed to the compliance reviewer. The case becomes Escalated until they approve or reject it.</p>}
          {active.action === 'approve' && <p className="text-xs text-slate-600">Approving marks the case Resolved with the analyst's proposed notes.</p>}
          {formError && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-800">{formError.message}</p>}
          {showReviewer && (
            <Field label="Compliance reviewer" required error={errors.reviewerId}>
              <select className={`input ${errors.reviewerId ? 'input-error' : ''}`} value={values.reviewerId} onChange={set('reviewerId')}>
                <option value="">Choose a reviewer</option>
                {reviewers.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </Field>
          )}
          {showNotes && (
            <Field label="Resolution notes" required error={errors.resolutionNotes} hint="What was found and what was done. These notes are kept with the case.">
              <textarea rows={4} maxLength={2000} className={`input ${errors.resolutionNotes ? 'input-error' : ''}`} value={values.resolutionNotes} onChange={set('resolutionNotes')} />
            </Field>
          )}
          {showRemarks && (
            <Field label="Remarks" required={active.needs.includes('remarks')} error={errors.remarks} hint="Shown in the case history">
              <textarea rows={2} maxLength={1000} className={`input ${errors.remarks ? 'input-error' : ''}`} value={values.remarks} onChange={set('remarks')} />
            </Field>
          )}
          <div className="flex gap-2">
            <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : `Confirm: ${active.label}`}</button>
            <button type="button" className="btn btn-secondary" onClick={() => setActive(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

/** Assign the analyst and compliance reviewer, and change the priority, within what this person is allowed to do. */
export function AssignmentPanel({ c, person, onChanged, onClose }) {
  const toast = useToast();
  const people = useAsync(listReviewers, []);
  const [analyst, setAnalyst] = useState(c.assignedAnalyst ? String(c.assignedAnalyst.id) : '');
  const [reviewer, setReviewer] = useState(c.assignedReviewer ? String(c.assignedReviewer.id) : '');
  const [priority, setPriority] = useState(c.priority);
  const [remarks, setRemarks] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  const rights = c.permissions;
  const all = people.data ?? [];
  const analystOptions = rights.assignAnalyst === 'any' ? all.filter((p) => ['Analyst', 'Admin'].includes(p.role)) : all.filter((p) => p.id === person?.id);
  const reviewerOptions = all.filter((p) => ['Reviewer', 'Admin'].includes(p.role));
  const priorityOptions = PRIORITIES.slice(0, PRIORITIES.indexOf(rights.priorityMax) + 1);

  async function save(e) {
    e.preventDefault();
    const body = {};
    if (rights.assignAnalyst !== 'none' && analyst !== (c.assignedAnalyst ? String(c.assignedAnalyst.id) : '')) body.assignedAnalystId = analyst ? Number(analyst) : null;
    if (rights.assignReviewer && reviewer !== (c.assignedReviewer ? String(c.assignedReviewer.id) : '')) body.assignedReviewerId = reviewer ? Number(reviewer) : null;
    if (rights.priorityMax && priority !== c.priority) body.priority = priority;
    if (Object.keys(body).length === 0) return setError({ message: 'Nothing has changed.' });
    if (remarks.trim()) body.remarks = remarks.trim();
    setSaving(true);
    setError(null);
    try {
      await assignCase(c.id, body);
      toast.success('Assignment updated.');
      onChanged();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4" aria-label="Case assignment">
      <h3 className="text-sm font-semibold text-slate-800">Assign case</h3>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-800">{error.message}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        {rights.assignAnalyst !== 'none' && (
          <Field label="Operations analyst" hint={rights.assignAnalyst === 'self' ? 'You can assign the case to yourself' : undefined}>
            <select className="input" value={analyst} onChange={(e) => setAnalyst(e.target.value)}>
              <option value="">Unassigned</option>
              {analystOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {rights.assignReviewer && (
          <Field label="Compliance reviewer">
            <select className="input" value={reviewer} onChange={(e) => setReviewer(e.target.value)}>
              <option value="">None</option>
              {reviewerOptions.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        )}
        {rights.priorityMax && (
          <Field label="Priority" hint={rights.priorityMax !== 'Critical' ? 'Critical needs a compliance reviewer' : undefined}>
            <select className="input" value={priority} onChange={(e) => setPriority(e.target.value)}>
              {priorityOptions.map((p) => <option key={p}>{p}</option>)}
            </select>
          </Field>
        )}
      </div>
      <Field label="Remarks (optional)">
        <input className="input" maxLength={500} value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </Field>
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save assignment'}</button>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}

export function NotePanel({ c, onChanged, onClose }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);

  async function save(e) {
    e.preventDefault();
    if (note.trim().length < 3) return setError({ message: 'Write a note (at least 3 characters).' });
    setSaving(true);
    setError(null);
    try {
      await addCaseNote(c.id, note.trim());
      toast.success('Note added.');
      onChanged();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={save} className="space-y-3 rounded-lg border border-slate-200 bg-slate-50 p-4" aria-label="Add note">
      <h3 className="text-sm font-semibold text-slate-800">Add an internal note</h3>
      {error && <p role="alert" className="rounded-md border border-red-200 bg-red-50 p-2.5 text-sm text-red-800">{error.message}</p>}
      <Field label="Note" required>
        <textarea rows={3} maxLength={2000} className="input" value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <p className="text-xs text-slate-500">Notes are internal and permanent: they cannot be edited or deleted.</p>
      <div className="flex gap-2">
        <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Add note'}</button>
        <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
