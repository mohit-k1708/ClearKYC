import { lazy, Suspense } from 'react';
import { Link, Route, Routes } from 'react-router-dom';
import Layout from './components/Layout';
import CustomerDirectoryPage from './pages/CustomerDirectoryPage';
import CustomerTypeSelectionPage from './pages/CustomerTypeSelectionPage';
import IndividualFormPage from './pages/IndividualFormPage';
import CompanyFormPage from './pages/CompanyFormPage';
import CustomerProfilePage from './pages/CustomerProfilePage';
import KycRequirementsPage from './pages/KycRequirementsPage';
import DocumentsPage from './pages/DocumentsPage';
import DocumentFormPage from './pages/DocumentFormPage';
import DocumentDetailsPage from './pages/DocumentDetailsPage';
import DocumentReviewPage from './pages/DocumentReviewPage';
import VerificationQueuePage from './pages/VerificationQueuePage';
import KycCompletenessPage from './pages/KycCompletenessPage';
import CustomerKycPage from './pages/CustomerKycPage';
import OwnershipManagementPage from './pages/OwnershipManagementPage';
import CompanyOwnershipPage from './pages/CompanyOwnershipPage';
import BeneficialOwnerFormPage from './pages/BeneficialOwnerFormPage';
import BeneficialOwnerDetailsPage from './pages/BeneficialOwnerDetailsPage';
import PersonOwnershipPage from './pages/PersonOwnershipPage';
import ExpirySettingsPage from './pages/ExpirySettingsPage';
import CustomerRiskPage from './pages/CustomerRiskPage';
import RiskHistoryPage from './pages/RiskHistoryPage';
import ExceptionsPage from './pages/ExceptionsPage';
import ReviewCasesPage from './pages/ReviewCasesPage';
import CaseFormPage from './pages/CaseFormPage';
import CaseDetailsPage from './pages/CaseDetailsPage';
import PeriodicReviewsPage from './pages/PeriodicReviewsPage';
import AlertsPage from './pages/AlertsPage';
import AuditTrailPage from './pages/AuditTrailPage';
import DataQualityPage from './pages/DataQualityPage';
import ReportsPage from './pages/ReportsPage';

// The charts library is large, so the Analytics page is loaded only when it is opened.
const AnalyticsPage = lazy(() => import('./pages/AnalyticsPage'));
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const Loading = ({ label }) => <div className="py-20 text-center text-sm text-slate-500">{label}</div>;

function NotFound() {
  return (
    <div className="py-20 text-center">
      <h1 className="text-xl font-semibold">Page not found</h1>
      <Link to="/" className="mt-3 inline-block text-brand-700 underline">Go to overview</Link>
    </div>
  );
}

// Route table. "/customers/new..." is listed before "/customers/:id" so "new" is never read as an ID.
export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Suspense fallback={<Loading label="Loading your dashboard…" />}><DashboardPage /></Suspense>} />
        <Route path="customers" element={<CustomerDirectoryPage />} />
        <Route path="customers/new" element={<CustomerTypeSelectionPage />} />
        <Route path="customers/new/individual" element={<IndividualFormPage />} />
        <Route path="customers/new/company" element={<CompanyFormPage />} />
        <Route path="customers/:id" element={<CustomerProfilePage />} />

        {/* Scene 2: documents, verification, requirements, completeness. "documents/new" comes before "documents/:id". */}
        <Route path="documents" element={<DocumentsPage />} />
        <Route path="documents/new" element={<DocumentFormPage />} />
        <Route path="documents/:id" element={<DocumentDetailsPage />} />
        <Route path="documents/:id/edit" element={<DocumentFormPage />} />
        <Route path="documents/:id/review" element={<DocumentReviewPage />} />
        <Route path="verification" element={<VerificationQueuePage />} />
        <Route path="kyc-requirements" element={<KycRequirementsPage />} />
        <Route path="kyc" element={<KycCompletenessPage />} />
        <Route path="kyc/:customerId" element={<CustomerKycPage />} />

        {/* Scene 3: ownership and risk. "ownership/owners/..." comes before "ownership/:customerId". */}
        <Route path="ownership" element={<OwnershipManagementPage />} />
        <Route path="ownership/owners/new" element={<BeneficialOwnerFormPage />} />
        <Route path="ownership/owners/:id" element={<BeneficialOwnerDetailsPage />} />
        <Route path="ownership/owners/:id/edit" element={<BeneficialOwnerFormPage />} />
        <Route path="ownership/owners/:id/person" element={<PersonOwnershipPage />} />
        <Route path="ownership/:customerId" element={<CompanyOwnershipPage />} />
        <Route path="risk/:customerId" element={<CustomerRiskPage />} />
        <Route path="risk-history" element={<RiskHistoryPage />} />

        {/* Scene 4: exceptions, review cases, periodic reviews. "cases/new" comes before "cases/:id". */}
        <Route path="exceptions" element={<ExceptionsPage />} />
        <Route path="cases" element={<ReviewCasesPage />} />
        <Route path="cases/new" element={<CaseFormPage />} />
        <Route path="cases/:id" element={<CaseDetailsPage />} />
        <Route path="reviews" element={<PeriodicReviewsPage />} />

        {/* Scene 5: alerts, audit trail, analytics, data quality, exports */}
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="audit" element={<AuditTrailPage />} />
        <Route path="analytics" element={<Suspense fallback={<Loading label="Loading analytics…" />}><AnalyticsPage /></Suspense>} />
        <Route path="data-quality" element={<DataQualityPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="settings/expiry-alerts" element={<ExpirySettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
