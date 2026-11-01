import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import useReviewer from '../hooks/useReviewer';

// Sidebar, in groups an ordinary employee can follow. `hint` is a plain-language explanation shown as a tooltip, next to the
// technical term the page itself uses. "Customers" also stays highlighted on a customer profile, but not while adding a customer.
const NAV_GROUPS = [
  {
    heading: 'Customers',
    items: [
      { to: '/', label: 'Overview', hint: 'The big picture: what needs attention today', isActive: (p) => p === '/', icon: 'M3 12l9-9 9 9M5 10v10h5v-6h4v6h5V10' },
      {
        to: '/customers', label: 'Customers', hint: 'Everyone who has registered with you',
        isActive: (p) => p.startsWith('/customers') && !p.startsWith('/customers/new'),
        icon: 'M17 20h5v-2a4 4 0 00-3-3.9M9 20H4v-2a4 4 0 014-4h2a4 4 0 014 4v2zM12 7a3 3 0 11-6 0 3 3 0 016 0zM17 4.1a3 3 0 010 5.8',
      },
      { to: '/customers/new', label: 'Add Customer', hint: 'Register a new person or company', isActive: (p) => p.startsWith('/customers/new'), icon: 'M12 5v14M5 12h14' },
    ],
  },
  {
    heading: 'Documents',
    items: [
      {
        to: '/documents', label: 'Documents', hint: 'Papers customers have sent us',
        isActive: (p) => p.startsWith('/documents') && !/\/documents\/\d+\/review/.test(p),
        icon: 'M9 12h6m-6 4h6m2 4H7a2 2 0 01-2-2V6a2 2 0 012-2h7l5 5v9a2 2 0 01-2 2z',
      },
      {
        to: '/verification', label: 'Verification Review', hint: 'Check documents and record a decision',
        isActive: (p) => p.startsWith('/verification') || /\/documents\/\d+\/review/.test(p),
        icon: 'M9 12l2 2 4-4m5.6-1.4a9 9 0 11-17.2 0A9 9 0 0120.6 10.6z',
      },
      { to: '/kyc-requirements', label: 'KYC Requirements', hint: 'Which documents each kind of customer must provide', isActive: (p) => p.startsWith('/kyc-requirements'), icon: 'M4 6h16M4 12h16M4 18h10' },
      {
        to: '/kyc', label: 'KYC Completeness', hint: 'Customer document completion: who still owes us documents',
        isActive: (p) => p === '/kyc' || p.startsWith('/kyc/'),
        icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
      },
    ],
  },
  {
    heading: 'Risk Management',
    items: [
      { to: '/ownership', label: 'Ownership Management', hint: 'People who own or control companies', isActive: (p) => p.startsWith('/ownership'), icon: 'M3 21h18M5 21V8l7-5 7 5v13M9 21v-6h6v6' },
      {
        to: '/risk-history', label: 'Risk Assessment', hint: "Each customer's risk level, and how and why it changed over time",
        isActive: (p) => p.startsWith('/risk'),
        icon: 'M12 3l8 3v6c0 4.5-3.2 8.3-8 9-4.8-.7-8-4.5-8-9V6l8-3z',
      },
    ],
  },
  {
    heading: 'Operations',
    items: [
      { to: '/exceptions', label: 'Exceptions & Issues', hint: 'Problems found in customer files', isActive: (p) => p.startsWith('/exceptions'), icon: 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
      {
        to: '/cases', label: 'Review Cases', hint: 'Tasks to look into a problem with a customer', isActive: (p) => p.startsWith('/cases'),
        icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 14l2 2 4-4',
      },
      {
        to: '/reviews', label: 'Periodic Reviews', hint: 'Regular re-checks of each customer', isActive: (p) => p.startsWith('/reviews'),
        icon: 'M8 7V3m8 4V3M4 11h16M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z',
      },
    ],
  },
  {
    heading: 'Monitoring',
    items: [
      { to: '/alerts', label: 'Alerts & Notifications', hint: 'Things that need action, raised from the real records', isActive: (p) => p.startsWith('/alerts'), icon: 'M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2a2 2 0 01-.6 1.4L4 17h5m6 0a3 3 0 11-6 0' },
      { to: '/audit', label: 'Audit Trail', hint: 'A permanent record of who did what, and when', isActive: (p) => p.startsWith('/audit'), icon: 'M12 8v4l3 3M3 12a9 9 0 109-9 9 9 0 00-7.5 4M3 4v4h4' },
    ],
  },
  {
    heading: 'Reporting',
    items: [
      { to: '/analytics', label: 'Analytics & Reports', hint: 'Charts you can filter by date', isActive: (p) => p.startsWith('/analytics'), icon: 'M4 20V10m6 10V4m6 16v-7m4 7H2' },
      { to: '/data-quality', label: 'Data Quality', hint: 'Checks that look for mistakes in the records', isActive: (p) => p.startsWith('/data-quality'), icon: 'M5 13l4 4L19 7M4 4h16' },
      { to: '/settings/expiry-alerts', label: 'Expiry Alert Settings', hint: 'How many days before expiry a document raises an alert', isActive: (p) => p.startsWith('/settings'), icon: 'M12 6V4m0 16v-2m6-6h2M4 12h2m10.9-5.9l1.4-1.4M5.7 18.3l1.4-1.4m0-9.8L5.7 5.7m12.6 12.6l-1.4-1.4M12 15a3 3 0 100-6 3 3 0 000 6z' },
      { to: '/reports', label: 'Exports', hint: 'Download reports as files', isActive: (p) => p.startsWith('/reports'), icon: 'M12 3v12m0 0l-4-4m4 4l4-4M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2' },
    ],
  },
];

function NavIcon({ d }) {
  return (
    <svg className="h-5 w-5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** App shell: fixed sidebar on desktop, slide-over menu on phones. */
export default function Layout() {
  const [open, setOpen] = useState(false);

  const { pathname } = useLocation();
  const reviewer = useReviewer();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);

  const groups = NAV_GROUPS.map((group) => (
    <div key={group.heading} className="mt-5 first:mt-0">
      <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-brand-100/60">{group.heading}</div>
      <div className="flex flex-col gap-0.5">
        {group.items.map((item) => {
          const active = item.isActive(pathname);
          return (
            <Link
              key={item.to}
              to={item.to}
              title={item.hint}
              aria-current={active ? 'page' : undefined}
              onClick={() => setOpen(false)}
              className={`flex items-center gap-3 rounded-lg border-l-2 px-3 py-2 text-sm font-medium transition ${
                active ? 'border-brand-500 bg-white/15 text-white' : 'border-transparent text-brand-100 hover:bg-white/10 hover:text-white'
              }`}
            >
              <NavIcon d={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  ));

  return (
    <div className="min-h-screen lg:flex">
      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex items-center justify-between bg-brand-900 px-4 py-3 text-white lg:hidden">
        <span className="font-semibold tracking-tight">ClearKYC</span>
        <button onClick={() => setOpen(!open)} aria-label="Toggle menu" aria-expanded={open} className="rounded-md p-1.5 hover:bg-white/10">
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
            <path strokeLinecap="round" d={open ? 'M6 6l12 12M18 6L6 18' : 'M4 7h16M4 12h16M4 17h16'} />
          </svg>
        </button>
      </header>

      {/* Sidebar */}
      <aside className={`${open ? 'block' : 'hidden'} fixed inset-x-0 top-[52px] z-20 max-h-[calc(100vh-52px)] overflow-y-auto bg-brand-900 p-4 lg:sticky lg:top-0 lg:block lg:h-screen lg:max-h-none lg:w-64 lg:shrink-0`}>
        <div className="hidden items-center gap-2 px-3 pb-5 pt-2 lg:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-500 font-bold text-white">✓</div>
          <div>
            <div className="font-semibold leading-tight text-white">ClearKYC</div>
            <div className="text-xs text-brand-100/80">Customer checks, made clear</div>
          </div>
        </div>
        <nav aria-label="Main">{groups}</nav>

        {/* Prototype stand-in for login: who the employee is acting as when recording decisions. */}
        <div className="mt-6 rounded-lg bg-white/10 p-3">
          <label htmlFor="acting-as" className="mb-1 block text-xs font-medium uppercase tracking-wide text-brand-100">
            Acting as
          </label>
          <select
            id="acting-as"
            value={reviewer?.current?.id ?? ''}
            onChange={(e) => reviewer.select(e.target.value)}
            className="w-full rounded-md border border-white/20 bg-brand-900 px-2 py-1.5 text-sm text-white focus:outline-none focus:ring-2 focus:ring-brand-500"
          >
            <option value="">Choose a person</option>
            {(reviewer?.reviewers ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} · {r.role}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] leading-snug text-brand-100/70">
            {reviewer?.current && !reviewer.current.canDecide
              ? 'This role cannot record decisions (verification, screening, risk assessments).'
              : 'Prototype only: there is no login yet. Only Reviewer and Admin can record decisions.'}
          </p>
        </div>
        <p className="mt-6 hidden px-3 text-xs leading-relaxed text-brand-100/60 lg:block">
          Prototype with synthetic data. Risk rules are assumptions and screening is simulated.
        </p>
      </aside>

      <main className={`min-w-0 flex-1 p-4 sm:p-6 lg:p-8 ${pathname === '/' ? 'bg-[#F3F7FB]' : ''}`}>
        <div className={`mx-auto ${pathname === '/' ? 'max-w-7xl' : 'max-w-6xl'}`}>
          <Outlet />
        </div>
      </main>
    </div>
  );
}
