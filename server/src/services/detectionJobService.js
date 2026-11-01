/**
 * Detection as a background job.
 *
 * Running detection for every customer can take over a minute on a large database (about 78 s for 8,000 customers), longer than a
 * browser should wait for one request. startJob() therefore returns at once with a job ID and the work continues in the background;
 * the screen polls getJob(id) for progress until the job is Completed or Failed.
 *
 * What stays the same: the work itself is exceptionService.detect(), which commits one customer at a time and is safe to repeat, so
 * results, alerts and audit events are written exactly as before (the audit events name the person who started the job). The
 * synchronous POST /exceptions/detect and POST /alerts/refresh keep working.
 *
 * Rules and limits (documented in docs/phase6-features.md):
 *   - ONE job at a time. Starting another while one runs is refused with 409 DETECTION_ALREADY_RUNNING and the running job's ID.
 *   - Jobs live in this server process's memory (the 20 most recent are kept). A restart forgets them. If the server stops during a
 *     job, customers already checked stay committed and running detection again finishes the rest: no data is lost or duplicated.
 *   - A failure marks the job Failed with the error message and the progress reached; earlier customers stay committed.
 *   - Only a single API process is supported (the registry is not shared between processes). The per-customer database locks in
 *     detection still keep data correct if the synchronous endpoint is used at the same time.
 */
const crypto = require('node:crypto');
const prisma = require('../utils/prisma');
const { AppError, notFound } = require('../utils/errors');
const exceptionService = require('./exceptionService');
const audit = require('./auditService');

const KEEP = 20;
const jobs = new Map(); // jobId -> job, insertion order = oldest first
let running = null;

const view = (j) => ({
  jobId: j.jobId,
  status: j.status,
  processed: j.processed,
  total: j.total,
  percent: j.status === 'Completed' ? 100 : j.total === null ? null : j.total === 0 ? 100 : Math.floor((j.processed / j.total) * 100),
  startedAt: j.startedAt,
  finishedAt: j.finishedAt,
  durationMs: (j.finishedAt ?? new Date()) - j.startedAt,
  startedBy: j.startedBy,
  result: j.result,
  error: j.error,
});

function remember(job) {
  jobs.set(job.jobId, job);
  while (jobs.size > KEEP) {
    const oldest = [...jobs.values()].find((j) => j.status !== 'Running');
    if (!oldest) break;
    jobs.delete(oldest.jobId);
  }
}

async function recordFinish(job) {
  try {
    await audit.record(prisma, {
      actionType: 'DETECTION_JOB_FINISHED',
      entityType: 'DetectionJob',
      entityRef: job.jobId,
      newValues: { status: job.status, customersChecked: job.processed, total: job.total, ...(job.result ? { created: job.result.created, resolved: job.result.resolved, alertsCreated: job.result.alertsCreated, alertsResolved: job.result.alertsResolved } : {}), ...(job.error ? { error: job.error } : {}) },
      reason: job.status === 'Completed' ? 'Detection run completed in the background' : 'Detection run failed in the background',
      actor: job.startedBy ? { id: job.startedBy.id, role: job.startedBy.role } : null,
    });
  } catch {
    // bookkeeping must never turn a finished job into a failed one
  }
}

/**
 * Starts a job for all customers. `runner` is a seam for tests: a function ({ onProgress }) -> result.
 * @param {{ id: number, name: string, role: string }} actor
 */
function startJob(actor, { runner = exceptionService.detect } = {}) {
  if (running) {
    throw new AppError(409, 'DETECTION_ALREADY_RUNNING', 'Detection is already running. Wait for it to finish; it shows its progress.', { jobId: running.jobId });
  }
  const job = {
    jobId: `DET-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`,
    status: 'Running',
    processed: 0,
    total: null,
    startedAt: new Date(),
    finishedAt: null,
    startedBy: actor ? { id: actor.id, name: actor.name, role: actor.role } : null,
    result: null,
    error: null,
  };
  running = job;
  remember(job);

  // The work starts after the response is sent. Errors are caught here: a background failure must never crash the server.
  setImmediate(async () => {
    try {
      job.result = await runner({
        onProgress: ({ processed, total }) => {
          job.processed = processed;
          job.total = total;
        },
      });
      job.status = 'Completed';
      if (job.total !== null) job.processed = job.total;
    } catch (err) {
      job.status = 'Failed';
      job.error = String(err?.message ?? err).slice(0, 500);
    } finally {
      job.finishedAt = new Date();
      running = null;
      await recordFinish(job);
    }
  });
  return view(job);
}

function getJob(jobId) {
  const job = jobs.get(String(jobId));
  if (!job) throw notFound(`Detection job ${jobId} was not found (jobs are kept in memory and forgotten when the server restarts)`);
  return view(job);
}

const currentJob = () => (running ? view(running) : null);
const recentJobs = () => [...jobs.values()].reverse().map(view);

/** Waits until nothing is running (used by tests and graceful shutdown). */
async function whenIdle(timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (running && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  return !running;
}

module.exports = { startJob, getJob, currentJob, recentJobs, whenIdle };
