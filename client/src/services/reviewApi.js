/**
 * Scene 4 API calls: exceptions, review cases, periodic reviews. Uses the shared Axios client, which also sends the
 * "Acting as" person (X-Reviewer-Id) so the server can decide what that person may do.
 */
import { http, call } from './api';

export const getReviewOptions = () => call(() => http.get('/review-options')).then((r) => r.data);
export const getReviewDashboard = () => call(() => http.get('/review-dashboard/summary')).then((r) => r.data);

// Exceptions
export const listExceptions = (params) => call(() => http.get('/exceptions', { params }));
export const getException = (id) => call(() => http.get(`/exceptions/${id}`)).then((r) => r.data);
export const detectExceptions = (customerId) => call(() => http.post('/exceptions/detect', customerId ? { customerId } : {})).then((r) => r.data);
export const resolveException = (id, resolutionNotes) => call(() => http.patch(`/exceptions/${id}/resolve`, { resolutionNotes })).then((r) => r.data);

// Review cases
export const listCases = (params) => call(() => http.get('/review-cases', { params }));
export const createCase = (body) => call(() => http.post('/review-cases', body)).then((r) => r.data);
export const getCase = (id) => call(() => http.get(`/review-cases/${id}`)).then((r) => r.data);
export const assignCase = (id, body) => call(() => http.patch(`/review-cases/${id}/assign`, body)).then((r) => r.data);
export const changeCaseStatus = (id, body) => call(() => http.patch(`/review-cases/${id}/status`, body)).then((r) => r.data);
export const addCaseNote = (id, note) => call(() => http.post(`/review-cases/${id}/notes`, { note })).then((r) => r.data);
export const getCaseHistory = (id) => call(() => http.get(`/review-cases/${id}/history`)).then((r) => r.data);

// Periodic reviews
export const listSchedules = (params) => call(() => http.get('/review-schedules', { params }));
export const listUpcomingReviews = (params) => call(() => http.get('/reviews/upcoming', { params }));
export const listOverdueReviews = (params) => call(() => http.get('/reviews/overdue', { params }));
export const createSchedule = (body) => call(() => http.post('/review-schedules', body)).then((r) => r.data);
export const completeSchedule = (id, body) => call(() => http.post(`/review-schedules/${id}/complete`, body)).then((r) => r.data);
