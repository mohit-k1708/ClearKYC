/**
 * All HTTP calls to the backend live here, so pages never build URLs themselves.
 * In development Vite proxies /api to http://localhost:4000 (see vite.config.js).
 */
import axios from 'axios';

export const http = axios.create({ baseURL: import.meta.env.VITE_API_URL || '/api', timeout: 15000 });

// Scene 2: the reviewer the analyst is "acting as" (prototype stand-in for login) is sent with every request.
let actingReviewerId = null;
export function setActingReviewer(id) {
  actingReviewerId = id;
}
http.interceptors.request.use((config) => {
  if (actingReviewerId) config.headers['X-Reviewer-Id'] = String(actingReviewerId);
  return config;
});

/**
 * Converts any axios failure into { message, code, fields, status } with a friendly message.
 * `fields` holds per-field validation messages from the server ({ email: "..." }).
 */
export function toApiError(err) {
  const body = err.response?.data?.error;
  if (body) {
    return { status: err.response.status, code: body.code, message: body.message, fields: body.details || {} };
  }
  if (err.code === 'ECONNABORTED') {
    return { status: 0, code: 'TIMEOUT', message: 'The server took too long to respond. Please try again.', fields: {} };
  }
  return {
    status: 0,
    code: 'NETWORK_ERROR',
    message: 'Cannot reach the server. Check that the API is running and try again.',
    fields: {},
  };
}

// Wraps a call so callers always receive either data or a thrown, already-friendly error.
export async function call(request) {
  try {
    return (await request()).data;
  } catch (err) {
    throw toApiError(err);
  }
}

export const getMeta = () => call(() => http.get('/meta')).then((r) => r.data);
export const getDashboardSummary = () => call(() => http.get('/dashboard/summary')).then((r) => r.data);
export const listCustomers = (params) => call(() => http.get('/customers', { params }));
export const getCustomer = (id) => call(() => http.get(`/customers/${id}`)).then((r) => r.data);
export const createCustomer = (payload) => call(() => http.post('/customers', payload)).then((r) => r.data);
