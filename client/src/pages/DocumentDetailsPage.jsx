import { Link, useParams } from 'react-router-dom';
import { documentFileUrl, getDocument } from '../services/kycApi';
import useAsync from '../hooks/useAsync';
import { ErrorBanner, PageHeader, RiskBadge, Spinner, TypeBadge } from '../components/ui';
import { ExpiryBadge, Fact, NameCheckNotice, StatusBadge, VerificationHistory } from '../components/kycUi';
import { formatDate } from '../utils/format';

function formatBytes(n) {
  return n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Everything about one document: metadata, current status, file, and the full verification history. */
export default function DocumentDetailsPage() {
  const { id } = useParams();
  const { data: d, loading, error, reload } = useAsync(() => getDocument(id), [id]);

  return (
    <>
      <PageHeader title={d ? d.documentType : 'Document'} subtitle={d ? `Document #${d.id} for ${d.customer.name}` : `Document #${id}`}>
        <div className="flex flex-wrap gap-2">
          <Link to="/documents" className="btn btn-secondary">
            ← Documents
          </Link>
          {d && (
            <>
              <Link to={`/documents/${d.id}/edit`} className="btn btn-secondary">
                Edit details
              </Link>
              <Link to={`/documents/${d.id}/review`} className="btn btn-primary">
                Review
              </Link>
            </>
          )}
        </div>
      </PageHeader>

      {loading && <Spinner label="Loading document…" />}
      <ErrorBanner error={error} onRetry={error?.status === 404 ? undefined : reload} />

      {d && (
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <section className="card p-5 sm:p-6">
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold">Document details</h2>
                <StatusBadge status={d.status} />
                {d.effectiveStatus === 'Expired' && d.status !== 'Expired' && <StatusBadge status="Expired" />}
              </div>
              {d.effectiveStatus === 'Expired' && d.status === 'Verified' && (
                <p className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-900">
                  A reviewer verified this document, but it expired on {formatDate(d.expiryDate)}, so it no longer counts as valid for KYC completeness.
                </p>
              )}
              <NameCheckNotice check={d.nameCheck} />
              <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                <Fact label="Document type">{d.documentType}</Fact>
                <Fact label="Name on the document">{d.nameOnDocument}</Fact>
                <Fact label="Document number (masked)" mono>
                  {d.documentNumberMasked}
                </Fact>
                <Fact label="Issue date">{formatDate(d.issueDate)}</Fact>
                <Fact label="Submission date">{formatDate(d.submissionDate)}</Fact>
                <Fact label="Expiry date">
                  <span className="mr-2">{d.expiryDate ? formatDate(d.expiryDate) : '—'}</span>
                  <ExpiryBadge state={d.expiryState} days={d.daysToExpiry} />
                </Fact>
                <Fact label="Counts toward requirement">{d.requirement ? `${d.requirement.documentType} (${d.requirement.isMandatory ? 'mandatory' : 'optional'})` : 'No matching requirement (extra document)'}</Fact>
                <Fact label="Uploaded file">
                  {d.file ? (
                    <span>
                      <a className="font-medium text-brand-700 hover:underline" href={documentFileUrl(d.id)}>
                        {d.file.name}
                      </a>{' '}
                      <span className="text-xs text-slate-500">
                        ({d.file.mimeType}, {formatBytes(d.file.sizeBytes)})
                      </span>
                    </span>
                  ) : (
                    'No file uploaded'
                  )}
                </Fact>
                <Fact label="Notes">{d.notes}</Fact>
                <Fact label="Added">{new Date(d.createdAt).toLocaleString('en-IN')}</Fact>
                <Fact label="Last updated">{new Date(d.updatedAt).toLocaleString('en-IN')}</Fact>
              </dl>
            </section>

            <section className="card p-5 sm:p-6">
              <h2 className="mb-1 text-base font-semibold">Verification history</h2>
              <p className="mb-4 text-xs text-slate-500">Every decision is a separate record. Earlier decisions are never changed or removed.</p>
              <VerificationHistory items={d.verifications} />
            </section>
          </div>

          <aside className="space-y-6">
            <section className="card p-5">
              <h2 className="mb-3 text-base font-semibold">Customer</h2>
              <p className="font-medium text-slate-900">{d.customer.name}</p>
              <p className="font-mono text-xs text-slate-500">{d.customer.customerId}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <TypeBadge type={d.customer.customerType} />
                <RiskBadge level={d.customer.riskLevel} />
              </div>
              <div className="mt-4 flex flex-col gap-2 text-sm">
                <Link to={`/customers/${d.customer.customerId}`} className="font-medium text-brand-700 hover:underline">
                  Open customer profile
                </Link>
                <Link to={`/kyc/${d.customer.customerId}`} className="font-medium text-brand-700 hover:underline">
                  View KYC completeness
                </Link>
                <Link to={`/documents?customerId=${d.customer.customerId}`} className="font-medium text-brand-700 hover:underline">
                  All documents for this customer
                </Link>
              </div>
            </section>
            <p className="rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-500">
              Verification is a simulated manual review inside this prototype. It is not an external government or identity-provider check.
            </p>
          </aside>
        </div>
      )}
    </>
  );
}
