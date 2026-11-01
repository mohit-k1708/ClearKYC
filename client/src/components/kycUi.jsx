/**
 * Shared Scene 2 UI pieces: status badges, customer picker, verification history.
 */
import { useEffect, useRef, useState } from 'react';
import { listCustomers } from '../services/api';
import useDebounce from '../hooks/useDebounce';
import { formatDate, formatDateTime } from '../utils/format';

// ---- Badges --------------------------------------------------------------------------------
const BADGE = 'inline-flex items-center whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset';

const STATUS_STYLES = {
  Verified: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  Pending: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  'Pending Verification': 'bg-sky-50 text-sky-700 ring-sky-600/20',
  'In Review': 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  Rejected: 'bg-red-50 text-red-700 ring-red-600/20',
  'Requires Resubmission': 'bg-orange-50 text-orange-700 ring-orange-600/20',
  Expired: 'bg-rose-100 text-rose-800 ring-rose-700/30',
  Missing: 'bg-slate-100 text-slate-600 ring-slate-500/30',
  'Expiring Soon': 'bg-amber-50 text-amber-700 ring-amber-600/20',
  Valid: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  'No Expiry': 'bg-slate-100 text-slate-600 ring-slate-500/20',
};

/** Verification status or requirement state ("Verified", "Pending", "Missing", "Expired"...). */
export function StatusBadge({ status }) {
  if (!status) return <span className="text-slate-400">—</span>;
  return <span className={`${BADGE} ${STATUS_STYLES[status] || STATUS_STYLES['No Expiry']}`}>{status}</span>;
}

/** Expiry state computed by the server from the document's dates. */
export function ExpiryBadge({ state, days }) {
  if (!state || state === 'No Expiry') return <span className="text-xs text-slate-400">No expiry</span>;
  const detail = state === 'Expired' ? `${Math.abs(days)}d ago` : state === 'Expiring Soon' ? `in ${days}d` : null;
  return (
    <span className={`${BADGE} ${STATUS_STYLES[state]}`}>
      {state}
      {detail && <span className="ml-1 font-normal opacity-80">({detail})</span>}
    </span>
  );
}

export const EXCEPTION_LABELS = {
  MISSING_DOCUMENT: 'Missing',
  PENDING_VERIFICATION: 'Pending verification',
  REJECTED: 'Rejected',
  REQUIRES_RESUBMISSION: 'Requires resubmission',
  EXPIRED: 'Expired',
  EXPIRING_SOON: 'Expiring soon',
};
const EXCEPTION_STYLES = {
  MISSING_DOCUMENT: STATUS_STYLES.Missing,
  PENDING_VERIFICATION: STATUS_STYLES.Pending,
  REJECTED: STATUS_STYLES.Rejected,
  REQUIRES_RESUBMISSION: STATUS_STYLES['Requires Resubmission'],
  EXPIRED: STATUS_STYLES.Expired,
  EXPIRING_SOON: STATUS_STYLES['Expiring Soon'],
};
export function ExceptionBadge({ type }) {
  return <span className={`${BADGE} ${EXCEPTION_STYLES[type]}`}>{EXCEPTION_LABELS[type] || type}</span>;
}

export function CompletenessBadge({ status }) {
  const style =
    status === 'Complete'
      ? STATUS_STYLES.Verified
      : status === 'Partially Complete'
        ? STATUS_STYLES['Expiring Soon']
        : STATUS_STYLES.Missing;
  return <span className={`${BADGE} ${style}`}>{status}</span>;
}

// ---- Customer picker ---------------------------------------------------------------------------
/**
 * Search-as-you-type picker for an EXISTING customer. `value` is the Customer ID (CUS-000001).
 * Typing runs a debounced search against the customers API; choosing a result calls onChange(code).
 */
export function CustomerPicker({ value, onChange, disabled, invalid, id = 'customer-picker', onPick, type }) {
  const [text, setText] = useState(value || '');
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState(value || '');
  const debounced = useDebounce(text, 300);
  const box = useRef(null);

  // Keep the text in sync when the parent sets a value (for example from ?customer=CUS-000001).
  useEffect(() => {
    if (value && value !== picked) {
      setText(value);
      setPicked(value);
    }
  }, [value, picked]);

  useEffect(() => {
    if (!open || disabled) return undefined;
    let cancelled = false;
    setSearching(true);
    listCustomers({ search: debounced.trim(), pageSize: 8, page: 1, ...(type ? { type } : {}) }) // `type` limits the list (e.g. Company only)
      .then((res) => !cancelled && setOptions(res.data))
      .catch(() => !cancelled && setOptions([]))
      .finally(() => !cancelled && setSearching(false));
    return () => {
      cancelled = true;
    };
  }, [debounced, open, disabled, type]);

  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  function choose(c) {
    setPicked(c.customerId);
    setText(`${c.customerId} · ${c.name}`);
    setOpen(false);
    onChange(c.customerId);
    onPick?.(c);
  }

  return (
    <div className="relative" ref={box}>
      <input
        id={id}
        className={`input ${invalid ? 'input-error' : ''}`}
        value={text}
        disabled={disabled}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        placeholder="Search by customer name or ID (CUS-000001)"
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          if (picked) {
            setPicked(''); // typing again clears the previous choice until a new one is made
            onChange('');
          }
        }}
      />
      {open && !disabled && (
        <ul id={`${id}-list`} role="listbox" className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {searching && <li className="px-3 py-2 text-slate-500">Searching…</li>}
          {!searching && options.length === 0 && <li className="px-3 py-2 text-slate-500">No customers found</li>}
          {options.map((c) => (
            <li key={c.id} role="option" aria-selected={c.customerId === picked}>
              <button type="button" className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-slate-50" onClick={() => choose(c)}>
                <span>
                  <span className="font-mono text-xs text-brand-700">{c.customerId}</span> <span className="font-medium text-slate-900">{c.name}</span>
                </span>
                <span className="text-xs text-slate-500">
                  {c.customerType} · {c.riskLevel || 'no risk'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- Verification history -------------------------------------------------------------------------
/** Newest first. Rows are never edited: each decision is its own record. */
export function VerificationHistory({ items }) {
  if (!items?.length) return <p className="text-sm text-slate-500">No verification records yet.</p>;
  return (
    <ol className="space-y-0">
      {items.map((v, i) => (
        <li key={v.id} className="relative pb-5 pl-7 last:pb-0">
          {i < items.length - 1 && <span className="absolute left-[7px] top-4 h-full w-px bg-slate-200" aria-hidden="true" />}
          <span className={`absolute left-0 top-1.5 h-[15px] w-[15px] rounded-full border-2 border-white ring-2 ${i === 0 ? 'bg-brand-600 ring-brand-600/30' : 'bg-slate-300 ring-slate-200'}`} aria-hidden="true" />
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={v.status} />
            {i === 0 && <span className="text-xs font-medium text-brand-700">Current</span>}
            <span className="text-xs text-slate-500">{formatDateTime(v.verificationDate)}</span>
          </div>
          <p className="mt-1 text-sm text-slate-600">
            {v.reviewer ? (
              <>
                by <span className="font-medium text-slate-800">{v.reviewer.name}</span> <span className="text-slate-400">({v.reviewer.role})</span>
              </>
            ) : (
              <span className="text-slate-500">Recorded by the system</span>
            )}
          </p>
          {v.remarks && <p className="mt-1 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700">{v.remarks}</p>}
        </li>
      ))}
    </ol>
  );
}

/**
 * Small flag for a document whose printed name differs from the customer's registered name. Shows nothing for a match or when the
 * name was not recorded. It only informs a reviewer: the document is never rejected because of it.
 */
export function NameMismatchBadge({ check }) {
  if (check?.status !== 'Mismatch') return null;
  return <span className={`${BADGE} bg-amber-50 text-amber-800 ring-amber-600/30`} title={check.message}>Name differs</span>;
}

/** The name check in words, for the document details and review screens. */
export function NameCheckNotice({ check }) {
  if (!check) return null;
  if (check.status === 'Mismatch') {
    return (
      <div role="alert" data-testid="name-mismatch" className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <strong>The name on this document differs from the registered name.</strong>
        <dl className="mt-2 grid gap-x-6 gap-y-1 sm:grid-cols-2">
          <div><dt className="text-xs uppercase tracking-wide text-amber-800/80">Registered name</dt><dd className="font-medium">{check.registeredName}</dd></div>
          <div><dt className="text-xs uppercase tracking-wide text-amber-800/80">Name on the document</dt><dd className="font-medium">{check.nameOnDocument}</dd></div>
        </dl>
        <p className="mt-2 text-xs">Check it with the customer. A changed name (for example after marriage) is legitimate: note it in the remarks when you decide. The document has <strong>not</strong> been rejected automatically.</p>
      </div>
    );
  }
  if (check.status === 'Match') {
    return <p data-testid="name-match" className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">The name on the document matches the registered name{check.kind === 'EXACT' ? '.' : ` (${check.message.replace(/.$/, '').toLowerCase()}).`}</p>;
  }
  return <p data-testid="name-not-recorded" className="mb-4 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">The name printed on the document was not recorded, so it was not compared with the registered name.</p>;
}

/** Label/value row used on detail pages. */
export function Fact({ label, children, mono }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className={`mt-0.5 break-words text-sm text-slate-900 ${mono ? 'font-mono' : ''}`}>{children || '—'}</dd>
    </div>
  );
}

export { formatDate };
