import { Link, useParams } from 'react-router-dom';
import { getPersonOfOwner } from '../services/phase6Api';
import useAsync from '../hooks/useAsync';
import { ErrorBanner, PageHeader, RiskBadge, Spinner } from '../components/ui';
import { Fact } from '../components/kycUi';
import { formatDate } from '../utils/format';

/**
 * One beneficial owner across ALL the companies they are linked to: who the person is, and for every company the ownership
 * percentage and the kind of relationship. Read from the existing ownership records, nothing is copied.
 */
export default function PersonOwnershipPage() {
  const { id } = useParams(); // an owner record of the person
  const { data, loading, error, reload } = useAsync(() => getPersonOfOwner(id), [id]);
  const p = data?.person;

  return (
    <>
      <PageHeader title={p ? `${p.name}: all companies` : 'Beneficial owner: all companies'} subtitle={p ? `Person reference ${p.personRef}` : `Owner #${id}`}>
        <Link to={`/ownership/owners/${id}`} className="btn btn-secondary">← Owner details</Link>
      </PageHeader>

      {loading && !data && <Spinner label="Loading person…" />}
      <ErrorBanner error={error} onRetry={error?.status === 404 ? undefined : reload} />

      {data && (
        <div className="space-y-6">
          <section className="card p-5 sm:p-6" data-testid="person-identity">
            <h2 className="mb-4 text-base font-semibold">Person</h2>
            <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-4">
              <Fact label="Name">{p.name}</Fact>
              <Fact label="Year of birth">{p.birthYear ?? <span className="text-orange-700">not recorded</span>}</Fact>
              <Fact label="Nationality">{p.nationalityName}</Fact>
              <Fact label="Country of residence">{p.countryOfResidenceName}</Fact>
              <Fact label="PEP status (declared)">{p.declaredPep ? 'Yes, in at least one company' : 'No'}</Fact>
              <Fact label="Companies linked now"><span data-testid="company-count">{data.summary.companyCount}</span></Fact>
              <Fact label="Highest owner risk">{data.summary.highestOwnerRisk ? <RiskBadge level={data.summary.highestOwnerRisk} /> : '—'}</Fact>
              {p.namesRecorded.length > 1 && <Fact label="Name as recorded">{p.namesRecorded.join(' · ')}</Fact>}
            </dl>
            <p className="mt-4 text-xs text-slate-500">{data.note}</p>
          </section>

          <section className="card" aria-labelledby="person-companies-heading">
            <div className="p-5 pb-3 sm:px-6"><h2 id="person-companies-heading" className="text-base font-semibold">Companies ({data.companies.length})</h2></div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm" data-testid="person-companies">
                <thead className="border-y border-slate-200 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5">Company</th>
                    <th className="px-4 py-2.5 text-right">Ownership</th>
                    <th className="px-4 py-2.5">Relationship</th>
                    <th className="px-4 py-2.5">Company risk</th>
                    <th className="px-4 py-2.5">Since</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {data.companies.map((c) => (
                    <tr key={c.ownerId} className={String(c.ownerId) === String(id) ? 'bg-brand-50/40' : ''}>
                      <td className="px-4 py-2.5">
                        <Link to={`/customers/${c.company.customerId}`} className="font-mono text-xs font-medium text-brand-700 hover:underline">{c.company.customerId}</Link>
                        <div className="text-slate-900">{c.company.name}</div>
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{c.ownershipPercentage == null ? <span className="text-orange-700">missing</span> : `${c.ownershipPercentage}%`}</td>
                      <td className="px-4 py-2.5 text-slate-700">{c.ownershipType} · {c.controlType}</td>
                      <td className="px-4 py-2.5"><RiskBadge level={c.company.riskLevel} /></td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-slate-600">{formatDate(c.effectiveFrom)}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        <Link to={`/ownership/${c.company.customerId}`} className="mr-3 font-medium text-brand-700 hover:underline">Ownership</Link>
                        <Link to={`/ownership/owners/${c.ownerId}`} className="font-medium text-brand-700 hover:underline">Owner record</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {data.formerCompanies.length > 0 && (
            <section className="card p-5 sm:p-6">
              <h2 className="mb-3 text-base font-semibold">Earlier relationships ({data.formerCompanies.length})</h2>
              <ul className="divide-y divide-slate-100 text-sm">
                {data.formerCompanies.map((c, i) => (
                  <li key={`${c.ownerId}-${i}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                    <Link to={`/customers/${c.company.customerId}`} className="font-medium text-brand-700 hover:underline">{c.company.name}</Link>
                    <span className="tabular-nums text-slate-600">{c.ownershipPercentage == null ? '—' : `${c.ownershipPercentage}%`}</span>
                    <span className="text-slate-500">{formatDate(c.effectiveFrom)} – {formatDate(c.effectiveTo)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </>
  );
}
