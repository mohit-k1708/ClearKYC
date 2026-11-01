/**
 * Scene 5 API calls: audit trail, alerts, analytics, data validation and exports. Uses the shared Axios client, which also
 * sends the "Acting as" person (X-Reviewer-Id) so the server can decide what that person may see and do.
 */
import { http, call, toApiError } from './api';

// Audit trail (compliance reviewers and administrators only)
export const listAuditEvents = (params) => call(() => http.get('/audit-events', { params }));
export const getAuditEvent = (id) => call(() => http.get(`/audit-events/${id}`)).then((r) => r.data);
export const getAuditOptions = () => call(() => http.get('/audit-events/options')).then((r) => r.data);

// Alerts
export const listAlerts = (params) => call(() => http.get('/alerts', { params }));
export const getAlert = (id) => call(() => http.get(`/alerts/${id}`)).then((r) => r.data);
export const getAlertOptions = () => call(() => http.get('/alerts/options')).then((r) => r.data);
export const getAlertSummary = () => call(() => http.get('/alerts/summary')).then((r) => r.data);
export const refreshAlerts = () => call(() => http.post('/alerts/refresh', {})).then((r) => r.data);
export const acknowledgeAlert = (id, remarks) => call(() => http.patch(`/alerts/${id}/acknowledge`, remarks ? { remarks } : {})).then((r) => r.data);
export const changeAlertStatus = (id, status, remarks) => call(() => http.patch(`/alerts/${id}/status`, { status, ...(remarks ? { remarks } : {}) })).then((r) => r.data);
export const resolveAlert = (id, resolutionNotes) => call(() => http.patch(`/alerts/${id}/resolve`, { resolutionNotes })).then((r) => r.data);

// Analytics. `range` is { range: '30d' } or { from, to }.
export const getAnalyticsOverview = (range) => call(() => http.get('/analytics/overview', { params: range })).then((r) => r.data);

// Data quality
export const runValidation = () => call(() => http.post('/data-validation/run', {})).then((r) => r.data);
export const listValidationRuns = (params) => call(() => http.get('/data-validation/runs', { params }));
export const getValidationRun = (id) => call(() => http.get(`/data-validation/runs/${id}`)).then((r) => r.data);
export const listValidationIssues = (params) => call(() => http.get('/data-validation/issues', { params }));
export const getValidationChecks = () => call(() => http.get('/data-validation/checks')).then((r) => r.data);

// Exports
export const getExportCatalog = () => call(() => http.get('/exports')).then((r) => r.data);

/**
 * Downloads one export as a file. The request carries the "Acting as" header, so a plain link cannot be used.
 * Errors come back as a Blob; they are turned into the usual friendly error.
 */
export async function downloadExport(key, params) {
  try {
    const res = await http.get(`/exports/${key}`, { params, responseType: 'blob', timeout: 60000 });
    const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] ?? `clearkyc-${key}.txt`;
    const url = URL.createObjectURL(res.data);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return { filename: name, rows: Number(res.headers['x-export-rows'] ?? 0) };
  } catch (err) {
    if (err.response?.data instanceof Blob) {
      try {
        const body = JSON.parse(await err.response.data.text());
        throw { status: err.response.status, code: body.error?.code, message: body.error?.message ?? 'The export failed', fields: body.error?.details || {} };
      } catch (parsed) {
        if (parsed && parsed.message) throw parsed;
      }
    }
    throw toApiError(err);
  }
}
