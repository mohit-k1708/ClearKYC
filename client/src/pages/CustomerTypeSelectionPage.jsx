import { Link } from 'react-router-dom';
import { PageHeader } from '../components/ui';

const TYPES = [
  {
    to: '/customers/new/individual',
    title: 'Individual Customer',
    text: 'A natural person. Collects identity details, PAN and Aadhaar, and occupation.',
    icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  },
  {
    to: '/customers/new/company',
    title: 'Company Customer',
    text: 'A registered business. Collects legal name, registration number, business PAN and activity.',
    icon: 'M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1M9 13h1m4 0h1M9 17h1m4 0h1',
  },
];

// Step 2 of the onboarding workflow: the analyst picks which kind of customer to register.
export default function CustomerTypeSelectionPage() {
  return (
    <>
      <PageHeader title="Add New Customer" subtitle="Choose the type of customer to register" />
      <div className="grid gap-5 md:grid-cols-2">
        {TYPES.map((t) => (
          <Link key={t.to} to={t.to} className="card group p-6 transition hover:border-brand-500 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-brand-600/40">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-brand-50 text-brand-700 transition group-hover:bg-brand-100">
              <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d={t.icon} />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-slate-900">{t.title}</h2>
            <p className="mt-1 text-sm text-slate-500">{t.text}</p>
            <span className="mt-4 inline-block text-sm font-medium text-brand-700">Select →</span>
          </Link>
        ))}
      </div>
    </>
  );
}
