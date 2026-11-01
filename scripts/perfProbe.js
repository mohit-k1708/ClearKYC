#!/usr/bin/env node
/**
 * Performance probe at the target scale (8,000 customers, 20,000 documents, 3,000 review cases).
 *
 *   npm run perf:probe            needs the full baseline (npm run generate:full -- --reset); copies it to clearkyc_test_perf,
 *                                 starts a separate API on port 4200 against the copy, times the main endpoints, drops the copy
 *
 * The baseline, the development database and the development API are not touched. Each GET is timed 5 times (the first call is
 * reported separately as "cold"); the table shows the median. Results are written to docs/performance-probe.json.
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const SOURCE = process.env.PERF_SOURCE_DB || 'clearkyc_full';
const COPY = 'clearkyc_test_perf';
const PORT = 4200;

function url(database) {
  require('dotenv').config({ path: path.join(ROOT, '.env') });
  const u = new URL(process.env.DEV_DATABASE_URL || process.env.DATABASE_URL);
  u.pathname = `/${database}`;
  u.search = '';
  return u.toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

(async () => {
  const admin = new Client({ connectionString: url('postgres') });
  await admin.connect();
  if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [SOURCE])).rowCount) throw new Error(`${SOURCE} does not exist. Run: npm run generate:full -- --reset`);
  await admin.query(`DROP DATABASE IF EXISTS ${COPY} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${COPY} TEMPLATE ${SOURCE}`);
  await admin.end();

  const api = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'server.js')], { cwd: ROOT, env: { ...process.env, DATABASE_URL: url(COPY), PORT: String(PORT) }, stdio: 'ignore' });
  const results = [];
  try {
    const base = `http://localhost:${PORT}/api`;
    for (let i = 0; i < 60; i += 1) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* starting */ } await sleep(500); }
    const people = (await (await fetch(`${base}/reviewers`)).json()).data;
    const reviewer = people.find((p) => p.role === 'Reviewer');
    const headers = { 'x-reviewer-id': String(reviewer.id) };
    const counts = {
      customers: (await (await fetch(`${base}/customers?pageSize=1`)).json()).pagination.totalItems,
      documents: (await (await fetch(`${base}/documents?pageSize=1`)).json()).pagination.totalItems,
      reviewCases: (await (await fetch(`${base}/review-cases?pageSize=1`)).json()).pagination.totalItems,
    };
    const probes = [
      ['Customer list (page 1)', '/customers?page=1&pageSize=20'], ['Customer list, last page', `/customers?page=${Math.ceil(counts.customers / 20)}&pageSize=20`],
      ['Customer search by name', '/customers?search=Sharma&pageSize=20'], ['Customer filter: companies, High risk', '/customers?customerType=Company&riskLevel=High&pageSize=20'],
      ['Customer profile', '/customers/CUS-004000'], ['Customer KYC completeness', '/customers/CUS-004000/kyc-completeness'],
      ['Dashboard summary', '/dashboard/summary'], ['Overview analytics (last 30 days)', '/analytics/overview'], ['Overview analytics (all time)', '/analytics/overview?range=all'],
      ['Customer analytics', '/analytics/customers?range=all'], ['Document analytics', '/analytics/documents?range=all'], ['Ownership analytics', '/analytics/ownership?range=all'], ['Review case analytics', '/analytics/review-cases?range=all'],
      ['Document list', '/documents?pageSize=20'], ['Document search', '/documents?search=CUS-004000&pageSize=20'],
      ['KYC completeness exceptions', '/kyc/exceptions?pageSize=20'], ['Exceptions list', '/exceptions?pageSize=20'], ['Review cases list', '/review-cases?pageSize=15'], ['Review dashboard', '/review-dashboard/summary'],
      ['Periodic reviews: overdue', '/reviews/overdue?pageSize=20'], ['Alerts: active', '/alerts?status=active&pageSize=12'], ['Alerts summary', '/alerts/summary'],
      ['Audit trail (page 1)', '/audit-events?pageSize=15', headers], ['Audit trail by customer', '/audit-events?customerId=CUS-004000&pageSize=15', headers],
      ['Recent activity', '/activity/recent?limit=8'], ['Ownership overview', '/ownership/overview?pageSize=20'], ['Risk history list', '/risk-assessments?pageSize=20'],
      ['Export: documents CSV', '/exports/documents', headers], ['Export: customers CSV', '/exports/customers', headers],
    ];
    for (const [label, route, h] of probes) {
      const times = [];
      let status = 0;
      let bytes = 0;
      for (let i = 0; i < 5; i += 1) {
        const t0 = process.hrtime.bigint();
        const res = await fetch(base + route, { headers: h });
        const buf = Buffer.from(await res.arrayBuffer());
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
        status = res.status;
        bytes = buf.length;
      }
      results.push({ label, route, status, cold_ms: Math.round(times[0]), median_ms: Math.round(median(times)), bytes });
    }
    // the heavy "run" operations, once each
    for (const [label, method, route] of [['Run data validation (all checks)', 'POST', '/data-validation/run'], ['Run detection for ALL customers', 'POST', '/exceptions/detect']]) {
      const t0 = process.hrtime.bigint();
      const res = await fetch(base + route, { method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({}) });
      await res.arrayBuffer();
      results.push({ label, route: `${method} ${route}`, status: res.status, cold_ms: Math.round(Number(process.hrtime.bigint() - t0) / 1e6), median_ms: null, bytes: null });
    }
    results.counts = counts;
    const out = { database_copy_of: SOURCE, counts, probes: results, note: 'Times are wall-clock milliseconds on the development machine (local PostgreSQL, Node, loopback). The first column is the first call; the second is the median of five.' };
    fs.writeFileSync(path.join(ROOT, 'docs', 'performance-probe.json'), JSON.stringify(out, null, 2));
    console.log(`\nPerformance probe on ${JSON.stringify(counts)}\n`);
    console.log('  endpoint'.padEnd(46), 'status', ' first ms', ' median ms');
    for (const r of results) console.log(`  ${r.label.padEnd(44)} ${String(r.status).padStart(5)} ${String(r.cold_ms).padStart(9)} ${r.median_ms === null ? '        -' : String(r.median_ms).padStart(10)}`);
  } finally {
    spawnSync('taskkill', ['/PID', String(api.pid), '/T', '/F'], { stdio: 'ignore' });
    await sleep(1500);
    const a2 = new Client({ connectionString: url('postgres') });
    await a2.connect();
    await a2.query(`DROP DATABASE IF EXISTS ${COPY} WITH (FORCE)`);
    await a2.end();
  }
})().catch((err) => {
  console.error(`perf probe stopped: ${err.message}`);
  process.exit(1);
});
