/**
 * Scene 2 API calls: KYC requirements, documents, verification, completeness, exceptions.
 * Uses the shared Axios client and error conversion from api.js.
 */
import { http, call } from './api';

// Requirements
export const listRequirements = (params) => call(() => http.get('/kyc-requirements', { params })).then((r) => r.data);
export const getDocumentTypes = () => call(() => http.get('/kyc-requirements/document-types')).then((r) => r.data);
export const createRequirement = (body) => call(() => http.post('/kyc-requirements', body)).then((r) => r.data);
export const updateRequirement = (id, body) => call(() => http.put(`/kyc-requirements/${id}`, body)).then((r) => r.data);
export const setRequirementActive = (id, isActive) => call(() => http.patch(`/kyc-requirements/${id}/status`, { isActive })).then((r) => r.data);

// Documents (create/update send multipart form data so an optional file can be included)
export const listDocuments = (params) => call(() => http.get('/documents', { params }));
export const getDocument = (id) => call(() => http.get(`/documents/${id}`)).then((r) => r.data);
export const createDocument = (formData) => call(() => http.post('/documents', formData)).then((r) => r.data);
export const updateDocument = (id, formData) => call(() => http.put(`/documents/${id}`, formData)).then((r) => r.data);
export const listCustomerDocuments = (customerId) => call(() => http.get(`/customers/${customerId}/documents`)).then((r) => r.data);
export const documentFileUrl = (id) => `${http.defaults.baseURL}/documents/${id}/file`;

// Verification
export const listVerifications = (documentId) => call(() => http.get(`/documents/${documentId}/verifications`)).then((r) => r.data);
export const recordVerification = (documentId, body) => call(() => http.post(`/documents/${documentId}/verifications`, body)).then((r) => r.data);

// Completeness, exceptions, reviewers
export const getCompleteness = (customerId) => call(() => http.get(`/customers/${customerId}/kyc-completeness`)).then((r) => r.data);
export const listExceptions = (params) => call(() => http.get('/kyc/exceptions', { params }));
export const listReviewers = () => call(() => http.get('/reviewers')).then((r) => r.data);
