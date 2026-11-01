/**
 * Scene 3 API calls: beneficial ownership, ownership validation, owner screening, risk assessments.
 * Uses the shared Axios client (which also sends the "Acting as" person in X-Reviewer-Id).
 */
import { http, call } from './api';

export const getOwnershipOptions = () => call(() => http.get('/ownership/options')).then((r) => r.data);
export const getRiskDashboard = () => call(() => http.get('/dashboard/risk-summary')).then((r) => r.data);
export const listOwnershipOverview = (params) => call(() => http.get('/ownership/overview', { params }));

export const listBeneficialOwners = (customerId) => call(() => http.get(`/customers/${customerId}/beneficial-owners`)).then((r) => r.data);
export const createOwner = (customerId, body) => call(() => http.post(`/customers/${customerId}/beneficial-owners`, body)).then((r) => r.data);
export const getOwner = (id) => call(() => http.get(`/beneficial-owners/${id}`)).then((r) => r.data);
export const updateOwner = (id, body) => call(() => http.put(`/beneficial-owners/${id}`, body)).then((r) => r.data);

export const getOwnershipValidation = (customerId) => call(() => http.get(`/customers/${customerId}/ownership-validation`)).then((r) => r.data);
export const recordOwnershipValidation = (customerId) => call(() => http.post(`/customers/${customerId}/ownership-validation`)).then((r) => r.data);

export const listScreenings = (ownerId) => call(() => http.get(`/beneficial-owners/${ownerId}/screening`)).then((r) => r.data);
export const createScreening = (ownerId, body) => call(() => http.post(`/beneficial-owners/${ownerId}/screening`, body)).then((r) => r.data);

export const getRiskSummary = (customerId) => call(() => http.get(`/customers/${customerId}/risk-summary`)).then((r) => r.data);
export const createRiskAssessment = (customerId, body) => call(() => http.post(`/customers/${customerId}/risk-assessments`, body)).then((r) => r.data);
export const listCustomerAssessments = (customerId) => call(() => http.get(`/customers/${customerId}/risk-assessments`)).then((r) => r.data);
export const listRiskAssessments = (params) => call(() => http.get('/risk-assessments', { params }));
