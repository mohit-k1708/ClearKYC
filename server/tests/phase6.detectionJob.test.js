/**
 * Phase 6, item 5: detection as a background job (job ID at once, status and progress, one run at a time, failures reported).
 * Runs against the dedicated TEST database (npm test). The audit events of the jobs it starts are removed afterwards (the audit
 * table is insert-only, so cleanup uses the explicit maintenance switch SET LOCAL app.allow_history_delete).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const prisma = require('../src/utils/prisma');
const jobs = require('../src/services/detectionJobService');
const exceptionService = require('../src/services/exceptionService');

let server;
let base;
let analyst;
let firstAuditId;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  analyst = (await (await fetch(`${base}/reviewers`)).json()).data.find((p) => p.role === 'Analyst');
  firstAuditId = (await prisma.auditEvent.findFirst({ orderBy: { id: 'desc' } }))?.id ?? 0;
});

test.after(async () => {
  await jobs.whenIdle();
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE action_type = 'DETECTION_JOB_FINISHED' AND id > ${firstAuditId}`,
  ]);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function api(method, url, body, who) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(who ? { 'x-reviewer-id': String(who.id) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

test('API: start answers at once with a job ID, progress is reported, the job completes with the detection result', async () => {
  assert.equal((await api('POST', '/detection-jobs', {})).status, 401, 'an identified person is needed');

  const started = await api('POST', '/detection-jobs', {}, analyst);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  const job = started.body.data;
  assert.match(job.jobId, /^DET-\d{8}-[0-9A-F]{6}$/);
  assert.equal(job.status, 'Running');
  assert.equal(job.startedBy.id, analyst.id);

  // a second start while it runs is refused and points at the running job
  const second = await api('POST', '/detection-jobs', {}, analyst);
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'DETECTION_ALREADY_RUNNING');
  assert.equal(second.body.error.details.jobId, job.jobId);
  assert.equal((await api('GET', '/detection-jobs')).body.data.running.jobId, job.jobId);

  let seen;
  const percents = [];
  for (let i = 0; i < 600; i += 1) {
    seen = (await api('GET', `/detection-jobs/${job.jobId}`)).body.data;
    if (seen.total !== null) percents.push(seen.percent);
    if (seen.status !== 'Running') break;
    await sleep(100);
  }
  assert.equal(seen.status, 'Completed', JSON.stringify(seen));
  assert.equal(seen.processed, seen.total);
  assert.equal(seen.percent, 100);
  assert.ok(seen.total > 0);
  assert.ok(percents.every((p, i) => i === 0 || p >= percents[i - 1]), 'progress never goes backwards');
  assert.equal(seen.result.customersChecked, seen.total);
  for (const key of ['created', 'resolved', 'unchanged', 'alertsCreated', 'alertsResolved', 'casesCreated']) assert.equal(typeof seen.result[key], 'number', key);
  assert.ok(seen.finishedAt && seen.durationMs >= 0);

  // listed, audited, and a new job can start again
  const list = (await api('GET', '/detection-jobs')).body.data;
  assert.equal(list.running, null);
  assert.equal(list.items[0].jobId, job.jobId);
  const events = await prisma.auditEvent.findMany({ where: { actionType: 'DETECTION_JOB_FINISHED', entityRef: job.jobId } });
  assert.equal(events.length, 1);
  assert.equal(events[0].userId, analyst.id);
  assert.equal(events[0].newValues.status, 'Completed');

  // results are the same as the synchronous run: nothing left to create, nothing duplicated
  const again = await exceptionService.detect({});
  assert.equal(again.created, 0);
  assert.equal(again.alertsCreated, 0);

  assert.equal((await api('GET', '/detection-jobs/DET-00000000-AAAAAA')).status, 404);
});

test('service: progress is visible while running, then Completed', async () => {
  const g = gate();
  const job = jobs.startJob(analyst, {
    runner: async ({ onProgress }) => {
      onProgress({ processed: 0, total: 10 });
      onProgress({ processed: 4, total: 10 });
      await g.p;
      onProgress({ processed: 10, total: 10 });
      return { customersChecked: 10, created: 1, updated: 0, resolved: 0, unchanged: 9, casesCreated: 0, alertsCreated: 0, alertsResolved: 0 };
    },
  });
  await sleep(50);
  const mid = jobs.getJob(job.jobId);
  assert.deepEqual([mid.status, mid.processed, mid.total, mid.percent], ['Running', 4, 10, 40]);
  assert.throws(() => jobs.startJob(analyst, { runner: async () => ({}) }), (e) => e.status === 409 && e.details.jobId === job.jobId);
  g.open();
  assert.equal(await jobs.whenIdle(), true);
  const done = jobs.getJob(job.jobId);
  assert.deepEqual([done.status, done.processed, done.percent, done.result.created, done.error], ['Completed', 10, 100, 1, null]);
});

test('service: a failure is reported with the progress reached, and the next job can start', async () => {
  const job = jobs.startJob(analyst, {
    runner: async ({ onProgress }) => {
      onProgress({ processed: 0, total: 8 });
      onProgress({ processed: 3, total: 8 });
      throw new Error('simulated database failure');
    },
  });
  assert.equal(await jobs.whenIdle(), true);
  const failed = jobs.getJob(job.jobId);
  assert.equal(failed.status, 'Failed');
  assert.equal(failed.error, 'simulated database failure');
  assert.deepEqual([failed.processed, failed.total], [3, 8], 'the progress reached is kept');
  assert.equal(failed.result, null);
  const events = await prisma.auditEvent.findMany({ where: { actionType: 'DETECTION_JOB_FINISHED', entityRef: job.jobId } });
  assert.equal(events.length, 1);
  assert.equal(events[0].newValues.status, 'Failed');

  const next = jobs.startJob(analyst, { runner: async () => ({ customersChecked: 0, created: 0, updated: 0, resolved: 0, unchanged: 0, casesCreated: 0, alertsCreated: 0, alertsResolved: 0 }) });
  await jobs.whenIdle();
  assert.equal(jobs.getJob(next.jobId).status, 'Completed');
  assert.equal(jobs.getJob(next.jobId).percent, 100, 'an empty run is complete');
});

test('service: only the 20 most recent jobs are remembered', async () => {
  const ids = [];
  for (let i = 0; i < 22; i += 1) {
    ids.push(jobs.startJob(analyst, { runner: async () => ({ customersChecked: 0 }) }).jobId);
    await jobs.whenIdle();
  }
  assert.ok(jobs.recentJobs().length <= 20);
  assert.throws(() => jobs.getJob(ids[0]), (e) => e.status === 404);
  assert.equal(jobs.getJob(ids[21]).status, 'Completed');
});
