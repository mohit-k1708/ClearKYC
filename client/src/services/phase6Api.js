/**
 * Phase 6 API calls: expiry alert settings, onboarding decisions, the cross-company person view and background detection jobs.
 * Uses the shared Axios client, which sends the "Acting as" person (X-Reviewer-Id).
 */
import { http, call } from './api';

// Expiry alert configuration
export const getExpirySettings = () => call(() => http.get('/settings/expiry-alerts')).then((r) => r.data);
export const saveExpirySettings = (expiryAlertDays, reason) => call(() => http.put('/settings/expiry-alerts', { expiryAlertDays, reason })).then((r) => r.data);

// Onboarding decisions
export const getOnboardingDecisions = (customerId) => call(() => http.get(`/customers/${customerId}/onboarding-decisions`)).then((r) => r.data);
// extra (approval policy): { followUpAction, waivers: [{ exceptionId, reason }] }
export const recordOnboardingDecision = (customerId, decision, reason, extra = {}) => call(() => http.post(`/customers/${customerId}/onboarding-decisions`, { decision, reason, ...extra })).then((r) => r.data);

// One person across companies
export const getPersonOfOwner = (ownerId) => call(() => http.get(`/beneficial-owners/${ownerId}/person`)).then((r) => r.data);
export const getPerson = (personRef) => call(() => http.get(`/people/${personRef}`)).then((r) => r.data);

// Detection as a background job
export const startDetectionJob = () => call(() => http.post('/detection-jobs', {})).then((r) => r.data);
export const getDetectionJob = (jobId) => call(() => http.get(`/detection-jobs/${jobId}`)).then((r) => r.data);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Runs detection for every customer as a background job and waits for it, reporting progress.
 * If a job is already running (409) this joins that job instead of failing, so two people pressing the button see the same run.
 * Resolves with the job's result ({ customersChecked, created, resolved, ... }); rejects with the failure message if the job fails.
 * @param {(job: object) => void} [onProgress]  called with every status update ({ status, processed, total, percent })
 */
export async function runDetectionJob(onProgress, { intervalMs = 700 } = {}) {
  let job;
  try {
    job = await startDetectionJob();
  } catch (err) {
    if (err.code !== 'DETECTION_ALREADY_RUNNING' || !err.fields?.jobId) throw err;
    job = await getDetectionJob(err.fields.jobId);
  }
  if (onProgress) onProgress(job);
  while (job.status === 'Running') {
    await wait(intervalMs);
    job = await getDetectionJob(job.jobId);
    if (onProgress) onProgress(job);
  }
  if (job.status === 'Failed') throw { status: 500, code: 'DETECTION_FAILED', message: `Detection stopped after ${job.processed} of ${job.total ?? '?'} customers: ${job.error}. Customers already checked are saved; run detection again to finish.`, fields: {} };
  return job.result;
}
