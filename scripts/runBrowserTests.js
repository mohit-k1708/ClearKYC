#!/usr/bin/env node
/**
 * Browser tests (Puppeteer + Chrome) against a TEST copy of the application:
 *
 *   npm run test:browser                 rebuilds the dedicated test database, starts a test API (port 4100) and a test web app
 *                                        (port 5174) connected to it, runs every script in tests/browser, then stops everything
 *   npm run test:browser -- --keep-data  does not rebuild the test database first
 *   npm run test:browser -- scene1       only scripts whose name contains "scene1"
 *   npm run test:browser -- --serve      only start the test API and web app (for a demo or debugging) and wait; stop with Ctrl+C
 *
 * The development application (ports 4000 / 5173) and the development database are never used. Needs Google Chrome
 * (set CHROME_PATH if it is not at C:/Program Files/Google/Chrome/Application/chrome.exe).
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { ensureTestDatabase, testDatabaseUrl, TEST_DB } = require('./testDatabase');

const ROOT = path.join(__dirname, '..');
const API_PORT = 4100;
const WEB_PORT = 5174;
const SCRIPTS = ['scene1-customers', 'scene2-documents', 'scene3-ownership-risk', 'scene4-review-cases', 'scene5-alerts-audit-reports', 'navigation', 'overview', 'phase6-features', 'approval-policy'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(url, label, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${label} did not start within ${ms / 1000}s`);
}
const kill = (child) => { if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); };

(async () => {
  const args = process.argv.slice(2);
  const keep = args.includes('--keep-data');
  const filter = args.find((a) => !a.startsWith('--'));
  const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  if (!fs.existsSync(chrome)) throw new Error(`Chrome not found at ${chrome}. Set CHROME_PATH.`);

  require('dotenv').config({ path: path.join(ROOT, '.env') });
  console.log(`Preparing the test database ${TEST_DB} ${keep ? '(existing data kept)' : '(rebuilt for a clean, known start)'} ...`);
  await ensureTestDatabase({ recreate: !keep, log: (m) => console.log(`  ${m}`) });

  const env = { ...process.env, DATABASE_URL: testDatabaseUrl(), PORT: String(API_PORT), CORS_ORIGIN: `http://localhost:${WEB_PORT}`, CLEARKYC_BROWSER_TEST_DB: TEST_DB, E2E_WEB: `http://localhost:${WEB_PORT}`, E2E_API_ROOT: `http://localhost:${API_PORT}` };
  const api = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'server.js')], { cwd: ROOT, env, stdio: 'ignore' });
  const web = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--prefix', 'client', 'run', 'dev'], { cwd: ROOT, env: { ...env, VITE_PORT: String(WEB_PORT), API_TARGET: `http://localhost:${API_PORT}` }, stdio: 'ignore', shell: process.platform === 'win32' });
  let failed = [];
  const summary = [];
  try {
    await waitFor(`http://localhost:${API_PORT}/api/health`, 'the test API');
    await waitFor(`http://localhost:${WEB_PORT}/`, 'the test web app');
    const health = await (await fetch(`http://localhost:${API_PORT}/api/customers?pageSize=1`)).json();
    console.log(`Test API on :${API_PORT} and web app on :${WEB_PORT} are up (${health.pagination?.totalItems ?? '?'} customers in ${TEST_DB}).\n`);
    if (args.includes('--serve')) {
      console.log(`Serving the TEST application: web http://localhost:${WEB_PORT}  api http://localhost:${API_PORT}/api  (database ${TEST_DB}). Press Ctrl+C to stop.`);
      await new Promise(() => {});
    }
    for (const name of SCRIPTS.filter((s) => !filter || s.includes(filter))) {
      const t0 = Date.now();
      const res = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'browser', `${name}.js`)], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
      const lines = (res.stdout || '').split('\n');
      const pass = lines.filter((l) => /^PASS /.test(l)).length;
      const fail = lines.filter((l) => /^FAIL /.test(l));
      summary.push({ script: name, pass, fail: fail.length, exit: res.status, seconds: Math.round((Date.now() - t0) / 1000) });
      console.log(`${fail.length === 0 && res.status === 0 ? 'OK  ' : 'FAIL'} ${name.padEnd(30)} ${pass} passed, ${fail.length} failed (${Math.round((Date.now() - t0) / 1000)}s)`);
      for (const f of fail) console.log(`       ${f.trim()}`);
      if (res.status !== 0 && fail.length === 0) console.log(`       script exited with ${res.status}: ${(res.stderr || '').split('\n').slice(0, 4).join(' | ')}`);
      if (fail.length || res.status !== 0) failed.push(name);
    }
  } finally {
    kill(web);
    kill(api);
  }
  const total = summary.reduce((s, x) => s + x.pass, 0);
  const bad = summary.reduce((s, x) => s + x.fail, 0);
  console.log(`\nBrowser tests: ${total} checks passed, ${bad} failed across ${summary.length} scripts (database ${TEST_DB}; development database untouched).`);
  fs.writeFileSync(path.join(ROOT, 'tests', 'browser', 'last-run.json'), JSON.stringify({ database: TEST_DB, scripts: summary, passed: total, failed: bad }, null, 2));
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error(`Browser tests stopped: ${err.message}`);
  process.exit(1);
});
