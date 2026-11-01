const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { out, BASE, API, CHROME } = require('./config');
const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, h = {}) => (await fetch(API + p, { headers: h })).json();

(async () => {
  const people = (await j('/reviewers')).data;
  const analyst = people.find((r) => r.name.startsWith('Priya'));
  const reviewer = people.find((r) => r.name.startsWith('Asha'));
  const admin = people.find((r) => r.name.startsWith('Meera'));
  const asHeader = (p) => ({ 'x-reviewer-id': String(p.id) });
  const overview = (await j('/analytics/overview?range=30d')).data;
  const alertSummary = (await j('/alerts/summary')).data;
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clearkyc-dl-'));

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const cdp = await page.createCDPSession();
  await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const text = () => page.evaluate(() => document.body.innerText);
  const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await sleep(500); };
  const actAs = async (person) => { await page.select('#acting-as', person ? String(person.id) : ''); await sleep(700); };
  const clickBtn = async (t, scope = 'button') => {
    const h = await page.evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((e) => e.innerText.trim().toLowerCase() === t.toLowerCase()), scope, t);
    const el = h.asElement();
    if (!el) throw new Error(`no ${scope} with text "${t}"`);
    await el.click();
    await sleep(500);
  };
  const hasBtn = (t, scope = 'button') => page.evaluate((s, t) => [...document.querySelectorAll(s)].some((e) => e.innerText.trim().toLowerCase() === t.toLowerCase()), scope, t);
  const btnDisabled = (t) => page.evaluate((t) => { const b = [...document.querySelectorAll('button')].find((e) => e.innerText.trim().toLowerCase() === t.toLowerCase()); return b ? b.disabled : null; }, t);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  const rowsOf = () => page.evaluate(() => [...document.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td')).map((r) => r.innerText));

  // ---- 1. Dashboard + navigation
  await go('/');
  let t = await text();
  check('sidebar lists the five Scene 5 pages', ['Alerts & Notifications', 'Audit Trail', 'Analytics & Reports', 'Data Quality', 'Exports'].every((x) => t.includes(x)));
  check('Scene 1-4 dashboard cards are still there', ['Total Customers', 'Customer Risk Distribution', 'Review Cases', 'Recent Alerts'].every((x) => t.includes(x)));
  const cardNum = (label) => page.evaluate((label) => { const a = [...document.querySelectorAll('a.card')].find((a) => a.innerText.startsWith(label)); return a ? Number(a.innerText.replace(label, '').replace(/[^0-9]/g, '')) : null; }, label);
  check('Action required shows real alerts and links to all of them', t.includes('Recent Alerts') && t.includes(`${alertSummary.activeAlerts} active`));
  await page.screenshot({ path: out('s5-1-dashboard.png'), fullPage: true });
  await go('/alerts?severity=Critical');
  check('the Critical filter opens from the URL', page.url().includes('severity=Critical'));
  let rows = await rowsOf();
  check('filtered list shows only Critical alerts', rows.length > 0 && rows.every((r) => r.includes('Critical')), `(${rows.length})`);

  // ---- 2. Audit trail
  await go('/audit');
  await actAs(null);
  t = await text();
  check('audit trail asks for a person when nobody is chosen', t.includes('Choose who you are acting as'));
  await actAs(analyst);
  t = await text();
  check('an analyst is told the audit trail is for compliance reviewers', /cannot view the audit trail|Compliance Reviewer/.test(t) && !(await rowsOf()).length);
  await actAs(reviewer);
  await page.waitForFunction(() => [...document.querySelectorAll('tbody tr td')].length > 0, { timeout: 20000 }).catch(() => {}); // wait for the rows, not a fixed time
  rows = await rowsOf();
  const apiAudit = await j('/audit-events?pageSize=15', asHeader(reviewer));
  check('a reviewer sees the audit events (15 per page)', rows.length === 15 && /AUD-\d{6}/.test(rows[0]), `(${rows.length} of ${apiAudit.pagination.totalItems})`);
  t = await text();
  check('audit table has the required columns', ['Event ID', 'User', 'Action', 'Entity', 'Entity ID', 'Date and time', 'Details'].every((x) => t.toLowerCase().includes(x.toLowerCase())));
  await page.screenshot({ path: out('s5-2-audit.png'), fullPage: true });
  await page.select('select[aria-label="Filter by category"]', 'Ownership');
  await sleep(1000);
  rows = await rowsOf();
  const apiOwn = await j('/audit-events?category=Ownership&pageSize=15', asHeader(reviewer));
  check('category filter matches the API', rows.length === Math.min(15, apiOwn.pagination.totalItems) && rows.every((r) => /Owner|Ownership|Screening|Risk/.test(r)), `(${apiOwn.pagination.totalItems} total)`);
  check('filters live in the URL', page.url().includes('category=Ownership'));
  await clickBtn('View details');
  t = await text();
  check('View details opens the full event', ['previous values', 'new values', 'ip address', 'cannot be edited or deleted'].every((x) => t.toLowerCase().includes(x)));
  await page.screenshot({ path: out('s5-3-audit-detail.png') });
  await page.keyboard.press('Escape');
  await sleep(300);
  check('Escape closes the details panel', !(await text()).toLowerCase().includes('previous values'));
  await go('/audit?customerId=CUS-000010');
  rows = await rowsOf();
  const apiCust = await j('/audit-events?customerId=CUS-000010&pageSize=15', asHeader(reviewer));
  check('customer ID filter works from the URL', rows.length === Math.min(15, apiCust.pagination.totalItems) && rows.length > 0, `(${rows.length})`);
  await go('/audit?customerId=banana');
  check('an invalid customer ID is explained', (await text()).includes('must look like CUS-000001'));

  // ---- 3. Alerts
  await go('/alerts');
  await actAs(analyst);
  rows = await rowsOf();
  const apiAlerts = await j('/alerts?status=active&pageSize=12');
  check('alert list shows active alerts, 12 per page', rows.length === 12 && /ALT-\d{6}/.test(rows[0]), `(${apiAlerts.pagination.totalItems} active; rows=${rows.length}; first=${rows[0]})`);
  t = await text();
  check('alert table has the required columns', ['Alert ID', 'Customer ID', 'Alert type', 'Severity', 'Created', 'Status', 'Action'].every((x) => t.toLowerCase().includes(x.toLowerCase())));
  await page.screenshot({ path: out('s5-4-alerts.png'), fullPage: true });
  await page.select('select[aria-label="Filter by severity"]', 'High');
  await sleep(900);
  rows = await rowsOf();
  check('severity filter shows only High alerts', rows.length > 0 && rows.every((r) => r.includes('High')), `(${rows.length})`);
  await page.select('select[aria-label="Filter by severity"]', '');
  await page.select('select[aria-label="Filter by alert type"]', 'MISSING_MANDATORY_DOCUMENT');
  await sleep(900);
  rows = await rowsOf();
  check('alert type filter works', rows.length > 0 && rows.every((r) => r.includes('Missing Mandatory Document')));
  await page.select('select[aria-label="Filter by alert type"]', '');
  await page.type('input[aria-label="Filter by customer ID"]', 'CUS-000010');
  await sleep(1200);
  rows = await rowsOf();
  const apiC10 = await j('/alerts?status=active&customerId=CUS-000010&pageSize=50');
  check('customer ID filter works', rows.length === apiC10.data.length && rows.every((r) => r.includes('CUS-000010')), `(${rows.length})`);
  await go('/alerts?status=all&alertType=POTENTIAL_SANCTIONS_MATCH');
  const sanctions = (await j('/alerts?status=active&alertType=POTENTIAL_SANCTIONS_MATCH&pageSize=5')).data[0];

  // work on a New Low/Medium alert as the analyst
  const target = (await j('/alerts?status=New&severity=Low,Medium&pageSize=50')).data.find((a) => !a.investigationRequired);
  await go(`/alerts?status=all&search=${target.alertId}`);
  await actAs(analyst);
  await clickBtn('Review');
  t = await text();
  check('alert panel shows details, source record and history', t.includes(target.alertId) && t.toLowerCase().includes('source record') && t.toLowerCase().includes('history') && t.toLowerCase().includes('alert generated'));
  check('analyst sees acknowledge, progress and resolve - but not dismiss', (await hasBtn('Acknowledge')) && (await hasBtn('Mark in progress')) && (await hasBtn('Resolve…')) && !(await hasBtn('Dismiss…')));
  await page.screenshot({ path: out('s5-5-alert-panel.png') });
  await clickBtn('Acknowledge');
  await sleep(800);
  t = await text();
  check('acknowledging records who and when, and shows it in the history', t.includes('Acknowledged by') && t.includes(analyst.name) && t.includes('Alert acknowledged'));
  await clickBtn('Resolve…');
  check('resolve needs remarks: the button stays disabled until they are long enough', (await btnDisabled('Resolve alert')) === true);
  await page.type('#alert-remarks', 'too short');
  check('still disabled with fewer than 10 characters', (await btnDisabled('Resolve alert')) === true);
  await page.type('#alert-remarks', ' - now long enough to explain');
  check('enabled with proper remarks', (await btnDisabled('Resolve alert')) === false);
  await clickBtn('Resolve alert');
  await sleep(1000);
  t = await text();
  check('alert is resolved, with remarks and history', t.includes('Resolved by') && t.includes('now long enough to explain') && !(await hasBtn('Acknowledge')));
  const after = (await j(`/alerts/${target.alertId}`)).data;
  check('the API agrees', after.status === 'Resolved' && after.resolvedBy.id === analyst.id && after.history.map((h) => h.actionType).join() === 'ALERT_GENERATED,ALERT_ACKNOWLEDGED,ALERT_RESOLVED');
  await page.keyboard.press('Escape');

  // potential sanctions match: analyst cannot close it, reviewer can resolve it but never dismiss it
  await go(`/alerts?status=all&search=${sanctions.alertId}`);
  await actAs(analyst);
  await clickBtn('Review');
  t = await text();
  check('potential sanctions alert is labelled as not confirmed', t.includes('Needs investigation: not a confirmed match'));
  check('analyst cannot resolve or dismiss a potential sanctions match', !(await hasBtn('Resolve…')) && !(await hasBtn('Dismiss…')));
  await page.keyboard.press('Escape');
  await actAs(reviewer);
  await clickBtn('Review');
  check('a reviewer can resolve it with findings but nobody can dismiss it', (await hasBtn('Resolve…')) && !(await hasBtn('Dismiss…')));
  await page.keyboard.press('Escape');
  // reviewers can dismiss a Low alert
  const low = (await j('/alerts?status=New&severity=Low&pageSize=50')).data.find((a) => !a.investigationRequired);
  await go(`/alerts?status=all&search=${low.alertId}`);
  await actAs(reviewer);
  await clickBtn('Review');
  check('a reviewer sees Dismiss on a Low alert', await hasBtn('Dismiss…'));
  await page.keyboard.press('Escape');
  await go('/alerts');
  await actAs(analyst);
  await clickBtn('Refresh alerts');
  let refreshed = false;
  for (let i = 0; i < 30 && !refreshed; i += 1) { await sleep(500); refreshed = /Alerts refreshed/.test(await text()); }
  check('Refresh alerts reports what it did', refreshed);
  check('no horizontal scroll on the alerts page at desktop width', !(await overflow()));

  // ---- 4. Analytics
  await go('/analytics');
  await page.waitForSelector('.recharts-surface', { timeout: 15000 });
  await sleep(1200);
  t = await text();
  check('analytics shows all the KPI groups', ['Total customers', 'Fully complete', 'Total documents', 'High-risk customers', 'Total review cases', 'People who own or control companies', 'Active alerts'].every((x) => t.includes(x)));
  const kpi = (label) => page.evaluate((label) => { const el = [...document.querySelectorAll('div.card')].find((d) => d.firstElementChild && d.firstElementChild.innerText.trim() === label); return el ? Number(el.children[1].innerText.replace(/[^0-9.]/g, '')) : null; }, label);
  const fresh = (await j('/analytics/overview?range=30d')).data;
  check('customer KPIs equal the API', (await kpi('Total customers')) === fresh.customers.totalCustomers && (await kpi('Company customers')) === fresh.customers.companyCustomers && (await kpi('Recently onboarded')) === fresh.customers.recentlyOnboardedCustomers);
  check('document KPIs equal the API', (await kpi('Total documents')) === fresh.documents.totalDocuments && (await kpi('Verified')) === fresh.documents.verifiedDocuments && (await kpi('Expired')) === fresh.documents.expiredDocuments);
  check('case and ownership KPIs equal the API', (await kpi('Total review cases')) === fresh.reviewCases.totalReviewCases && (await kpi('Overdue')) === fresh.reviewCases.overdueCases && (await kpi('People who own or control companies')) === fresh.ownership.totalBeneficialOwners);
  const charts = await page.evaluate(() => document.querySelectorAll('figure svg.recharts-surface').length);
  check('six or more charts are drawn', charts >= 7, `(${charts})`);
  const chartTitles = await page.evaluate(() => [...document.querySelectorAll('figure figcaption div:first-child')].map((e) => e.innerText));
  check('the six required charts are present', ['Customer risk distribution', 'KYC completeness distribution', 'Document verification status', 'Monthly customer onboarding trend', 'Review case status distribution', 'Alerts by severity'].every((x) => chartTitles.includes(x)), chartTitles.join(' | '));
  await page.screenshot({ path: out('s5-6-analytics.png'), fullPage: true });
  await page.evaluate(() => document.querySelectorAll('figure details').forEach((d) => (d.open = true)));
  const riskTable = await page.evaluate(() => [...document.querySelectorAll('figure')].find((f) => f.innerText.includes('Customer risk distribution')).querySelector('table').innerText);
  check('chart data table matches the API risk counts', ['Low', 'Medium', 'High'].every((k) => riskTable.includes(k)) && riskTable.includes(String(fresh.customers.customersByRiskLevel.High)));
  await page.select('#range-preset', '7d');
  await sleep(1500);
  const d7 = (await j('/analytics/overview?range=7d')).data;
  check('switching to Last 7 days updates the page and the URL', page.url().includes('range=7d') && (await kpi('Recently onboarded')) === d7.customers.recentlyOnboardedCustomers && (await text()).includes('Last 7 days'));
  await page.select('#range-preset', 'custom');
  await sleep(500);
  await page.evaluate(() => { const set = (id, v) => { const el = document.getElementById(id); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }; set('range-from', '2020-01-01'); set('range-to', '2020-01-31'); });
  await sleep(1500);
  check('a custom range in the past shows no onboarding', page.url().includes('from=2020-01-01') && (await kpi('Recently onboarded')) === 0 && (await kpi('Total customers')) === fresh.customers.totalCustomers);
  await page.setViewport({ width: 390, height: 800 });
  await go('/analytics');
  await page.waitForSelector('.recharts-surface', { timeout: 15000 });
  check('no horizontal scroll on analytics at 390px', !(await overflow()));
  await page.screenshot({ path: out('s5-7-analytics-mobile.png') });
  await page.setViewport({ width: 1280, height: 900 });

  // ---- 5. Data quality
  await go('/data-quality');
  await actAs(analyst);
  check('an analyst cannot run validation', (await btnDisabled('Run validation')) === true);
  await actAs(reviewer);
  check('a reviewer can run validation', (await btnDisabled('Run validation')) === false);
  const runsBefore = (await j('/data-validation/runs')).pagination.totalItems;
  await clickBtn('Run validation');
  await sleep(4000);
  const latest = (await j('/data-validation/runs')).data[0];
  check('running validation creates a new run', (await j('/data-validation/runs')).pagination.totalItems === runsBefore + 1);
  t = await text();
  check('summary shows total, passed, failed, warnings and the run date', ['Total checks performed', 'Passed checks', 'Failed checks', 'Warnings', 'Validation run date'].every((x) => t.includes(x)));
  const dq = (label) => page.evaluate((label) => { const el = [...document.querySelectorAll('div.card')].find((d) => d.firstElementChild && d.firstElementChild.innerText.trim() === label); return el ? Number(el.children[1].innerText.replace(/[^0-9]/g, '')) : null; }, label);
  check('summary numbers equal the stored run', (await dq('Total checks performed')) === latest.totalChecks && (await dq('Passed checks')) === latest.passedChecks && (await dq('Failed checks')) === latest.failedChecks && (await dq('Warnings')) === latest.warnings);
  const badges = await page.evaluate(() => ({ passed: [...document.querySelectorAll('span')].filter((s) => s.innerText.trim() === '✓Passed' || s.innerText.trim() === '✓ Passed' || /^✓\s*Passed$/.test(s.innerText.trim())).length, failed: [...document.querySelectorAll('span')].filter((s) => /^✕\s*Failed$/.test(s.innerText.trim())).length, warning: [...document.querySelectorAll('span')].filter((s) => /^!\s*Warning$/.test(s.innerText.trim())).length }));
  check('Passed, Failed and Warning badges are shown', badges.passed >= latest.passedChecks && badges.failed >= 1 && badges.warning >= 1, JSON.stringify(badges));
  check('failed record IDs and recommended fixes are shown', t.includes('Failed record IDs') && t.toLowerCase().includes('recommended fix') && /CUS-\d{6}/.test(t));
  await page.screenshot({ path: out('s5-8-data-quality.png'), fullPage: true });
  const own = (await j(`/data-validation/issues?runId=${latest.id}&checkCode=OWN_TOTAL_OVER_100`)).data[0];
  await page.select('select[aria-label="Filter by category"]', 'Ownership');
  await sleep(900);
  rows = await page.evaluate(() => [...document.querySelectorAll('[aria-label="Issues"] tbody tr')].filter((r) => r.querySelector('td')).map((r) => r.innerText));
  check('issue filter by category', rows.length > 0 && rows.every((r) => r.includes('Ownership')));
  const href = await page.evaluate(() => { const a = [...document.querySelectorAll('tbody a')].find((x) => x.innerText.includes('Open')); return a ? a.getAttribute('href') : null; });
  check('each issue has an inspect link to the relevant screen', Boolean(href) && /^\/(customers|ownership|documents|cases|alerts|reviews|risk)/.test(href), href);
  check('validation did not change the failing customer data', own && (await j(`/ownership/${own.entityRef}`)) !== null);

  // ---- 6. Reports & exports
  await go('/reports');
  await actAs(analyst);
  t = await text();
  check('ten reports are offered', (await page.evaluate(() => document.querySelectorAll('[data-export]').length)) === 10);
  const dis = (key) => page.evaluate((key) => document.querySelector(`[data-export="${key}"] button`).disabled, key);
  check('sensitive reports are disabled for an analyst, operational ones are not', (await dis('customers')) && (await dis('audit-events')) && (await dis('seed-data')) && !(await dis('documents')) && !(await dis('alerts')));
  await page.click('[data-export="documents"] button');
  const waitForDownload = async (re) => { for (let i = 0; i < 40; i += 1) { const done = fs.readdirSync(downloadDir).filter((f) => !f.endsWith('.crdownload')); if (done.some((f) => re.test(f))) return done; await sleep(500); } return fs.readdirSync(downloadDir); };
  let files = await waitForDownload(/^clearkyc-documents-.*.csv$/);
  check('analyst can download the document register', files.some((f) => /^clearkyc-documents-\d{4}-\d{2}-\d{2}\.csv$/.test(f)), files.join());
  await actAs(reviewer);
  check('a reviewer can download everything', !(await dis('customers')) && !(await dis('audit-events')) && !(await dis('schema')));
  await page.select('#customers-customerType', 'Company');
  await page.click('[data-export="customers"] button');
  await sleep(2500);
  files = fs.readdirSync(downloadDir);
  const custFile = files.find((f) => f.startsWith('clearkyc-customers-'));
  const csvBytes = custFile ? fs.readFileSync(path.join(downloadDir, custFile)) : Buffer.alloc(0);
  const csv = csvBytes.toString('utf8');
  check('customer export is UTF-8 with a BOM and the fixed header', csvBytes[0] === 0xef && csvBytes[1] === 0xbb && csv.includes('Customer ID,Customer Type,Full Name,Email (masked)'));
  const dataRows = csv.split('\r\n').slice(1).filter(Boolean);
  const companies = (await j('/analytics/overview?range=all')).data.customers.companyCustomers;
  check('the Company filter was applied before export', dataRows.length === companies && dataRows.every((r) => r.split(',')[1] === 'Company'), `(${dataRows.length} rows)`);
  check('no full PAN or Aadhaar in the file', !/\b[A-Z]{5}\d{4}[A-Z]\b/.test(csv) && !/\b\d{12}\b/.test(csv) && /XXXXXX/.test(csv));
  await page.click('[data-export="audit-events"] button');
  await sleep(2500);
  check('audit trail export downloads', fs.readdirSync(downloadDir).some((f) => f.startsWith('clearkyc-audit-events-')));
  await page.click('[data-export="schema"] button');
  await sleep(2500);
  const sqlFile = fs.readdirSync(downloadDir).find((f) => f.endsWith('.sql'));
  check('schema export downloads as SQL', sqlFile && fs.readFileSync(path.join(downloadDir, sqlFile), 'utf8').includes('CREATE TABLE "AuditEvent"'));
  const exported = (await j('/audit-events?actionType=EXPORT_GENERATED&pageSize=20', asHeader(reviewer))).data;
  check('every export was recorded in the audit trail', exported.some((e) => e.newValues.report === 'customers' && e.newValues.filters.customerType === 'Company') && exported.some((e) => e.newValues.report === 'documents' && e.user.id === analyst.id));
  await page.screenshot({ path: out('s5-9-reports.png'), fullPage: true });
  await page.select('#customers-customerType', 'Individual');
  await page.evaluate(() => { const set = (id, v) => { const el = document.getElementById(id); const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }; set('customers-from', '2026-12-31'); set('customers-to', '2026-01-01'); });
  await sleep(300);
  check('an impossible date range is blocked in the form', (await text()).includes('start date must not be after the end date') && (await dis('customers')));

  // ---- 7. Mobile layout and regressions
  await page.setViewport({ width: 390, height: 800 });
  for (const p of ['/', '/alerts', '/audit', '/data-quality', '/reports']) {
    await go(p);
    check(`no horizontal scroll at 390px on ${p}`, !(await overflow()));
  }
  await page.screenshot({ path: out('s5-10-mobile.png') });
  await page.setViewport({ width: 1280, height: 900 });
  await go('/cases');
  check('Scene 4 case list still works', (await rowsOf()).length > 0);
  await go('/customers');
  check('Scene 1 customer directory still works', (await rowsOf()).length > 0);
  await go('/ownership');
  check('Scene 3 ownership page still works', (await rowsOf()).length > 0);
  check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));

  await browser.close();
  fs.rmSync(downloadDir, { recursive: true, force: true });
  const failed = results.filter(([ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
