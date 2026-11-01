/**
 * API calls used only by the Overview page. Everything else (analytics, alerts, review summary, KYC exceptions) is reused from the
 * existing service modules; nothing here changes how the backend behaves.
 */
import { http, call } from './api';
import { listCustomers } from './api';
import { listDocuments } from './kycApi';
import { listCases } from './reviewApi';

export const getRecentActivity = (limit = 8) => call(() => http.get('/activity/recent', { params: { limit } })).then((r) => r.data);
export const getCustomerAnalytics = (range) => call(() => http.get('/analytics/customers', { params: range })).then((r) => r.data);

/** Global search: customers, documents and review cases, a few of each. Uses the existing list endpoints' own `search`. */
export async function searchEverything(term) {
  const [customers, documents, cases] = await Promise.all([
    listCustomers({ search: term, pageSize: 4, page: 1 }),
    listDocuments({ search: term, pageSize: 4, page: 1 }),
    listCases({ search: term, pageSize: 4, page: 1 }),
  ]);
  return {
    customers: customers.data.map((c) => ({ key: `c${c.id}`, title: c.name, sub: `${c.customerId} · ${c.customerType}`, to: `/customers/${c.customerId}` })),
    documents: documents.data.map((d) => ({ key: `d${d.id}`, title: `${d.documentType} · ${d.customer.name}`, sub: `${d.customer.customerId} · ${d.status}`, to: `/documents/${d.id}` })),
    cases: cases.data.map((k) => ({ key: `k${k.id}`, title: k.caseTitle, sub: `${k.caseId} · ${k.customerId} · ${k.status}`, to: `/cases/${k.id}` })),
  };
}
