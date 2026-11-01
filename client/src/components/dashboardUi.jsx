/**
 * Building blocks for the Overview dashboard: icons, section headings, stat tiles, the "i" explanation tip, progress rows and
 * the plain-language wording used for alerts. Colours: green = good, orange = needs a look, red = problem, blue = information.
 */
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';

const PATHS = {
  users: 'M17 20h5v-2a4 4 0 00-3-3.9M9 20H4v-2a4 4 0 014-4h2a4 4 0 014 4v2zM12 7a3 3 0 11-6 0 3 3 0 016 0zM17 4.1a3 3 0 010 5.8',
  user: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  building: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6',
  plus: 'M12 5v14M5 12h14',
  doc: 'M9 12h6m-6 4h6m2 4H7a2 2 0 01-2-2V6a2 2 0 012-2h7l5 5v9a2 2 0 01-2 2z',
  check: 'M9 12l2 2 4-4m5.6-1.4a9 9 0 11-17.2 0A9 9 0 0120.6 10.6z',
  clock: 'M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  x: 'M10 14l4-4m0 4l-4-4m11 2a9 9 0 11-18 0 9 9 0 0118 0z',
  calendar: 'M8 7V3m8 4V3M4 11h16M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
  warn: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  bell: 'M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0',
  shield: 'M12 3l8 3v6c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V6l8-3zM9 12l2 2 4-4',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  case: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 14l2 2 4-4',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zm10 3a3 3 0 100-6 3 3 0 000 6z',
  arrow: 'M5 12h14m-6-6l6 6-6 6',
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
  search: 'M21 21l-4.35-4.35M11 19a8 8 0 100-16 8 8 0 000 16z',
  chevron: 'M6 9l6 6 6-6',
  trend: 'M3 17l6-6 4 4 8-8M14 7h7v7',
  activity: 'M3 12h4l3-8 4 16 3-8h4',
  userPlus: 'M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM19 8v6M22 11h-6',
  swap: 'M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4',
  upload: 'M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 3v12m0-12l-4 4m4-4l4 4',
};

export function Icon({ name, className = 'h-5 w-5' }) {
  return (
    <svg className={`${className} shrink-0`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] || PATHS.info} />
    </svg>
  );
}

const TONES = {
  neutral: { chip: 'bg-slate-100 text-slate-600', bar: 'bg-slate-400', text: 'text-slate-900', ring: 'border-slate-200' },
  info: { chip: 'bg-sky-50 text-sky-700', bar: 'bg-sky-500', text: 'text-sky-900', ring: 'border-sky-200' },
  good: { chip: 'bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500', text: 'text-emerald-900', ring: 'border-emerald-200' },
  warn: { chip: 'bg-amber-50 text-amber-700', bar: 'bg-amber-500', text: 'text-amber-900', ring: 'border-amber-200' },
  bad: { chip: 'bg-red-50 text-red-700', bar: 'bg-red-500', text: 'text-red-900', ring: 'border-red-200' },
};
export const tone = (name) => TONES[name] || TONES.neutral;

/** The small "i": explains in plain words what a number means and how it is calculated. Opens on hover, focus or click. */
export function InfoTip({ text, technical }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <span className="relative inline-flex" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" aria-label="What does this mean?" aria-describedby={open ? id : undefined} aria-expanded={open}
        className="rounded-full text-slate-400 hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-brand-600/40"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}>
        <Icon name="info" className="h-4 w-4" />
      </button>
      {open && (
        <span id={id} role="tooltip" className="absolute left-1/2 top-full z-30 mt-1.5 w-60 -translate-x-1/2 rounded-lg bg-slate-900 px-3 py-2 text-left text-xs font-normal normal-case leading-snug tracking-normal text-white shadow-lg">
          {text}
          {technical && <span className="mt-1 block text-slate-300">Technical term: {technical}</span>}
        </span>
      )}
    </span>
  );
}

/** A dashboard section: icon, plain heading, one-line explanation, then the content. */
export function Section({ id, icon, title, description, action, children }) {
  return (
    <section className="mt-10" aria-labelledby={id}>
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-700"><Icon name={icon} /></span>
          <div>
            <h2 id={id} className="text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
            {description && <p className="text-sm text-slate-500">{description}</p>}
          </div>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A number with an icon, a plain label, an optional helper line, an explanation tip and an optional link. */
export function StatTile({ icon, label, value, helper, tip, technical, tone: t = 'neutral', to, suffix = '' }) {
  const c = tone(t);
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className={`flex h-9 w-9 items-center justify-center rounded-lg ${c.chip}`}><Icon name={icon} /></span>
        {tip && <InfoTip text={tip} technical={technical} />}
      </div>
      <div className="mt-3 text-3xl font-semibold tabular-nums text-slate-900">
        {value === null || value === undefined ? '—' : typeof value === 'number' ? value.toLocaleString('en-IN') : value}{value !== null && value !== undefined ? suffix : ''}
      </div>
      <div className="mt-0.5 text-sm font-medium text-slate-700">{label}</div>
      {helper && <div className="mt-0.5 text-xs leading-snug text-slate-500">{helper}</div>}
    </>
  );
  const cls = 'card flex min-w-0 flex-col p-4 transition';
  return to ? <Link to={to} className={`${cls} hover:shadow-md`}>{body}</Link> : <div className={cls}>{body}</div>;
}

/** A labelled horizontal bar: `value` out of `total`, with a status word so colour is never the only signal. */
export function ProgressRow({ label, help, value, total, tone: t = 'neutral', status, to }) {
  const c = tone(t);
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  const content = (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-sm font-medium text-slate-800">{label}</span>
        <span className="text-sm tabular-nums text-slate-600"><strong className="text-slate-900">{value}</strong> of {total} ({pct}%)</span>
      </div>
      <div className="mt-1.5 h-2.5 overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={total} aria-label={label}>
        <div className={`h-full rounded-full ${c.bar}`} style={{ width: `${pct}%` }} />
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        {status && <span className={`rounded px-1.5 py-0.5 font-medium ${c.chip}`}>{status}</span>}
        {help && <span>{help}</span>}
      </div>
    </>
  );
  return to ? <Link to={to} className="block rounded-lg p-2 transition hover:bg-slate-50">{content}</Link> : <div className="p-2">{content}</div>;
}

// ---- Plain-language wording for alerts ---------------------------------------------------------------------------------------
export const PRIORITY_LABEL = { Critical: 'Urgent', High: 'High', Medium: 'Medium', Low: 'Low' };
export const PRIORITY_TONE = { Critical: 'bad', High: 'bad', Medium: 'warn', Low: 'info' };

// For every alert type: why it matters, and what the employee should do. The facts (customer, what happened) come from the alert itself.
export const ALERT_COPY = {
  DOCUMENT_EXPIRY: { why: 'The document will stop being valid soon, which would leave the customer file incomplete.', action: 'Ask the customer for a renewed document.', button: 'Open document' },
  DOCUMENT_EXPIRED: { why: 'An expired document no longer counts as proof, so the customer file is out of date.', action: 'Request an updated document from the customer.', button: 'Open document' },
  MISSING_MANDATORY_DOCUMENT: { why: 'The customer file is missing a document we are required to hold.', action: 'Ask the customer to send it, then add it to their file.', button: 'Open customer file' },
  VERIFICATION_PENDING: { why: 'A document was received but nobody has checked it yet.', action: 'Check the document and record a decision.', button: 'Open document' },
  HIGH_RISK_CUSTOMER: { why: 'Higher-risk customers need closer attention and more frequent checks.', action: 'Look at the risk reasons and make sure the extra checks are done.', button: 'See risk level' },
  OWNERSHIP_ISSUE: { why: 'We must know who owns or controls each company, and their shares must add up to 100%.', action: 'Open the company and correct or complete the list of owners.', button: 'Open ownership' },
  PERIODIC_REVIEW_DUE: { why: 'Customer details have to be re-checked regularly, and this review is coming up.', action: 'Plan and complete the customer review before the due date.', button: 'Open reviews' },
  PERIODIC_REVIEW_OVERDUE: { why: 'The regular re-check of this customer is late.', action: 'Complete the customer review as soon as possible.', button: 'Open reviews' },
  POTENTIAL_PEP_MATCH: { why: 'The name looks similar to a politically exposed person. This is only a possible match, not a confirmed one.', action: 'A compliance reviewer should investigate and record the outcome.', button: 'Open alert' },
  POTENTIAL_SANCTIONS_MATCH: { why: 'The name looks similar to someone on a sanctions list. This is only a possible match, not a confirmed one.', action: 'A compliance reviewer should investigate before anything else happens.', button: 'Open alert' },
};

/** Where "Open" should take the employee for an alert. */
export function alertTarget(a) {
  if (a.relatedEntityType === 'Document' && a.relatedEntityId) return `/documents/${a.relatedEntityId}`;
  if (a.relatedEntityType === 'BeneficialOwner' && a.relatedEntityId) return `/ownership/owners/${a.relatedEntityId}`;
  switch (a.alertType) {
    case 'MISSING_MANDATORY_DOCUMENT': return `/kyc/${a.customerId}`;
    case 'HIGH_RISK_CUSTOMER': return `/risk/${a.customerId}`;
    case 'OWNERSHIP_ISSUE': return `/ownership/${a.customerId}`;
    case 'PERIODIC_REVIEW_DUE':
    case 'PERIODIC_REVIEW_OVERDUE': return '/reviews';
    default: return `/alerts?status=all&open=${a.id}`;
  }
}
