const puppeteer = require('puppeteer-core');
const path = require('path');
const { out, BASE, API, CHROME } = require('./config');
const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p) => (await fetch(API + p)).json();
const iso = (d) => d.toISOString().slice(0, 10);
const shift = (s, n) => iso(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * 86400000));

(async () => {
  const today = iso(new Date());
  const people = (await j('/reviewers')).data;
  const asha = people.find((p) => p.name.startsWith('Asha'));
  const o30 = (await j(`/analytics/overview?from=${shift(today, -29)}&to=${today}`)).data;
  const o7 = (await j(`/analytics/overview?from=${shift(today, -6)}&to=${today}`)).data;
  const oAll = (await j('/analytics/overview?range=all')).data;
  const cases = (await j('/review-dashboard/summary')).data;
  const kycEx = await j('/kyc/exceptions?type=MISSING_DOCUMENT&pageSize=1');
  const alerts = await j('/alerts?status=active&pageSize=5');
  const aSum = (await j('/alerts/summary')).data;
  const act = (await j('/activity/recent?limit=8')).data;

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  let consoleErrors = [];
  let recording = true;
  page.on('console', (m) => recording && m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => recording && consoleErrors.push(String(e).slice(0, 200)));
  const text = () => page.evaluate(() => document.body.innerText);
  const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await sleep(700); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  const kpi = (t) => page.evaluate((t) => Number(document.querySelector(`[data-kpi="${t}"]`)?.innerText.replace(/[^0-9]/g, '')), t);
  const legend = (id) => page.evaluate((id) => Object.fromEntries([...document.querySelectorAll(`section[aria-labelledby="${id}"] ul li`)].map((li) => { const parts = li.innerText.split('\n').map((x) => x.trim()).filter(Boolean); return [parts[0], Number(parts[1]?.replace(/[^0-9]/g, ''))]; })), id);
  const centre = (id) => page.evaluate((id) => Number(document.querySelector(`section[aria-labelledby="${id}"] [role=img]`).innerText.split('\n')[0].replace(/[^0-9]/g, '')), id);

  // ---- structure and top bar
  await go('/');
  let t = await text();
  check('top bar has search, date filter, notifications and profile', await page.evaluate(() => !!document.querySelector('#global-search') && !!document.querySelector('#range-top') && !!document.querySelector('a[aria-label*="new alerts"]') && !!document.querySelector('button[aria-label="Switch person"]')));
  check('notification badge equals the number of new alerts', await page.evaluate((n) => document.querySelector('a[aria-label*="new alerts"]').innerText.trim() === (n > 99 ? '99+' : String(n)), aSum.newAlerts), `(${aSum.newAlerts})`);
  check('welcome section greets by time of day and summarises', /Good (morning|afternoon|evening)/.test(t) && t.includes("Here's a summary of your KYC operations."));
  check('welcome section has a date range selector and a decorative illustration', (await page.evaluate(() => [...document.querySelectorAll('[aria-label="Date range"] button')].map((b) => b.innerText))).join() === 'Last 7 days,Last 30 days,Last 90 days,This month,All time,Custom' && (await page.evaluate(() => !!document.querySelector('svg[aria-hidden="true"][viewBox="0 0 220 120"]'))));
  check('the sidebar is dark teal and the page background is light blue-grey', await page.evaluate(() => getComputedStyle(document.querySelector('aside')).backgroundColor === 'rgb(6, 76, 75)' && getComputedStyle(document.querySelector('main')).backgroundColor === 'rgb(243, 247, 251)'));

  // ---- KPI cards (default range = last 30 days)
  check('six KPI cards equal the API', (await kpi('Total Customers')) === o30.customers.totalCustomers && (await kpi('Individual Customers')) === o30.customers.individualCustomers && (await kpi('Company Customers')) === o30.customers.companyCustomers && (await kpi('Low-Risk Customers')) === o30.customers.customersByRiskLevel.Low && (await kpi('Medium-Risk Customers')) === o30.customers.customersByRiskLevel.Medium && (await kpi('High-Risk Customers')) === o30.customers.customersByRiskLevel.High);
  const cardText = (title) => page.evaluate((title) => [...document.querySelectorAll('[aria-label="Customer key figures"] a')].find((a) => a.innerText.includes(title))?.innerText.replace(/\s+/g, ' ') ?? '', title);
  const freshCustomers = (await j(`/analytics/overview?from=${shift(today, -29)}&to=${today}`)).data.customers; // read at the moment of the check, not from an earlier snapshot
  const [indCard, totalCard, lowCard] = [await cardText('Individual Customers'), await cardText('Total Customers'), await cardText('Low-Risk Customers')];
  check('KPI cards show a share or comparison and a helper line', indCard.includes(`${Math.round((freshCustomers.individualCustomers / freshCustomers.totalCustomers) * 1000) / 10}%`) && totalCard.includes(`+${freshCustomers.recentlyOnboardedCustomers} new in last 30 days`) && lowCard.includes('Standard monitoring'), JSON.stringify({ indCard, totalCard, lowCard }));
  // ---- charts equal the API
  const type = await legend('type-heading');
  check('type donut: legend and centre equal the API', type.Individual === o30.customers.individualCustomers && type.Company === o30.customers.companyCustomers && (await centre('type-heading')) === o30.customers.totalCustomers);
  const risk = await legend('risk-heading');
  check('risk donut: legend and centre equal the API', risk['Low risk'] === o30.customers.customersByRiskLevel.Low && risk['High risk'] === o30.customers.customersByRiskLevel.High && (await centre('risk-heading')) === o30.customers.totalCustomers);
  const h = oAll.documents.health;
  const docs = await legend('docs-heading');
  check('document donut: Verified, Pending, Rejected, Expired, Missing equal the API', docs.Verified === h.verifiedAndValid && docs.Pending === h.waitingForCheck && docs.Rejected === h.rejectedOrNeedsNewCopy && docs.Expired === h.expired && docs['Missing mandatory documents'] === kycEx.summary.byType.MISSING_DOCUMENT && (await centre('docs-heading')) === oAll.documents.totalDocuments, JSON.stringify(docs));
  const kycL = await legend('kyc-heading');
  check('KYC completeness donut equals the API (from verified, still-valid mandatory documents)', kycL.Complete === oAll.kyc.distribution.Complete && kycL['Partially complete'] === oAll.kyc.distribution['Partially Complete'] && kycL['Not started'] === oAll.kyc.distribution['Not Started'] && (await centre('kyc-heading')) === oAll.kyc.customersEvaluated - oAll.kyc.distribution['No Requirements']);
  const dist = oAll.ownership.validationStatusDistribution;
  const ownL = await legend('ownership-heading');
  check('ownership donut equals the API', ownL['Complete ownership information'] === dist.RECONCILED && ownL['Incomplete ownership information'] === oAll.ownership.totalBusinessCustomers - dist.RECONCILED && (await centre('ownership-heading')) === oAll.ownership.totalBusinessCustomers);
  const charts = await page.evaluate(() => document.querySelectorAll('section svg.recharts-surface').length);
  check('five donuts and the trend chart are drawn', charts >= 6, `(${charts})`);

  // ---- review cases
  const box = (l) => page.evaluate((l) => Number(document.querySelector(`[data-case-metric="${l}"]`)?.innerText), l);
  check('review case boxes equal the API', (await box('Open')) === cases.openCases && (await box('In Progress')) === cases.inProgressCases && (await box('Escalated')) === cases.escalatedCases && (await box('Overdue')) === cases.overdueCases && (await box('High Priority')) === cases.highPriorityCases && (await box('Upcoming Periodic Reviews')) === cases.upcomingPeriodicReviews);

  // ---- alerts
  const alertItems = await page.evaluate(() => [...document.querySelectorAll('section[aria-labelledby="alerts-heading"] ul li')].map((li) => ({ text: li.innerText.replace(/\s+/g, ' '), href: li.querySelector('a[aria-label]')?.getAttribute('href') })));
  check('recent alerts are the real top five, each with title, customer, priority and a View button', alertItems.length === 5 && alertItems.every((a, i) => a.text.includes(alerts.data[i].customerId) && /Urgent|High|Medium|Low/.test(a.text) && a.text.includes('View') && a.href) && alertItems[0].text.includes(alerts.data[0].alertTypeLabel.replace(/ Alert$/, '')));
  // ---- activity
  const actItems = await page.evaluate(() => [...document.querySelectorAll('section[aria-labelledby="activity-heading"] ol li')].map((li) => li.innerText.replace(/\s+/g, ' ')));
  check('recent activities come from the audit records, newest first', actItems.length === act.length && actItems[0].includes(['ReviewCase', 'Alert'].includes(act[0].entityType) ? act[0].entityRef : act[0].customerCode || act[0].entityRef) && actItems.every((x) => /(ago|just now)/.test(x)), actItems[0]);
  await page.screenshot({ path: out('s7-1-overview.png'), fullPage: true });

  // ---- interactions: KPI cards, legends, view-all buttons
  const clickAndCheck = async (selector, expect) => {
    await go('/');
    await page.evaluate((s) => document.querySelector(s).click(), selector);
    await sleep(1000);
    return page.url().includes(expect);
  };
  check('KPI: Individual opens the filtered customer list', await clickAndCheck('a[href="/customers?type=Individual"]', 'type=Individual') && (await text()).includes('Individual'));
  check('KPI: High-risk opens the filtered customer list', await clickAndCheck('a[href="/customers?risk=High"]', 'risk=High'));
  const highRows = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((r) => r.innerText));
  check('the filtered list only shows High-risk customers', highRows.length === o30.customers.customersByRiskLevel.High && highRows.every((r) => r.includes('High')));
  check('legend row: Expired documents opens the filtered document list', await clickAndCheck('section[aria-labelledby="docs-heading"] a[href="/documents?expiry=Expired"]', 'expiry=Expired'));
  check('Review Cases: View All opens the case list', await clickAndCheck('section[aria-labelledby="cases-heading"] a[href="/cases"]', '/cases'));
  check('Review Cases: the Overdue box opens overdue cases', await clickAndCheck('section[aria-labelledby="cases-heading"] a[href="/cases?overdue=true"]', 'overdue=true') && (await page.evaluate(() => [...document.querySelectorAll('tbody tr')].length)) === cases.overdueCases);
  check('Alerts: View All opens the alert list', await clickAndCheck('section[aria-labelledby="alerts-heading"] a[href="/alerts"]', '/alerts'));
  await go('/');
  await page.evaluate(() => document.querySelector('section[aria-labelledby="alerts-heading"] ul li a[aria-label]').click());
  await sleep(1200);
  check('Alerts: View opens the relevant record', page.url() !== BASE + '/' && !(await text()).includes('Page not found'), page.url());
  check('Activities: an activity opens its record', await (async () => { await go('/'); const href = await page.evaluate(() => document.querySelector('section[aria-labelledby="activity-heading"] ol li a')?.getAttribute('href')); if (!href) return false; await page.evaluate(() => document.querySelector('section[aria-labelledby="activity-heading"] ol li a').click()); await sleep(1000); return page.url().endsWith(href) && !(await text()).includes('Page not found'); })());
  check('notifications icon opens new alerts', await clickAndCheck('a[aria-label*="new alerts"]', 'status=New') && (await page.evaluate(() => [...document.querySelectorAll('tbody tr')].length)) > 0);

  // ---- date filters
  await go('/');
  await page.select('#range-top', '7d');
  await sleep(1500);
  t = await text();
  check('the top-bar date filter updates the page, the URL and the analytics', page.url().includes('range=7d') && (await kpi('Total Customers')) === o7.customers.totalCustomers && t.includes(`+${o7.customers.recentlyOnboardedCustomers} new in last 7 days`) && t.includes('Showing: Last 7 days'));
  check('a short range shows a daily trend (7 bars)', t.includes('New customers per day') && (await page.evaluate(() => document.querySelector('section[aria-labelledby="trend-heading"] [role=img]').getAttribute('aria-label').split(',').length)) === 7);
  await page.evaluate(() => [...document.querySelectorAll('[aria-label="Date range"] button')].find((b) => b.innerText === 'All time').click());
  await sleep(1500);
  check('All time shows a monthly trend and no comparison badge', (await text()).includes('New customers per month') && page.url().includes('range=all') && (await kpi('Total Customers')) === oAll.customers.totalCustomers);
  await page.evaluate(() => [...document.querySelectorAll('[aria-label="Date range"] button')].find((b) => b.innerText === 'Custom').click());
  await sleep(600);
  await page.evaluate(() => { const set = (el, v) => { const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; s.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }; const [from, to] = document.querySelectorAll('input[type=date]'); set(from, '2020-01-01'); set(to, '2020-01-31'); });
  await sleep(1500);
  t = await text();
  check('a custom range in the past shows no new customers and an explanatory empty state', page.url().includes('from=') && t.includes('+0 new in custom range') && t.includes('No customers were registered in this period.') && (await kpi('Total Customers')) === oAll.customers.totalCustomers);
  await go('/?range=month');
  check('the filter is restored from the URL (This month)', (await text()).includes('Showing: This month'));
  await go('/');

  // ---- global search
  const search = async (q) => { await page.focus('#global-search'); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); await page.type('#global-search', q); await sleep(1500); return page.evaluate(() => ({ text: document.querySelector('#global-search-results')?.innerText || '', opts: [...document.querySelectorAll('#global-search-results [role=option]')].map((o) => o.innerText.replace(/\s+/g, ' ')) })); };
  let r = await search('Lotus');
  check('search finds customers by name', r.opts.some((o) => o.includes('Lotus Industries LLP') && o.includes('CUS-000050')) && r.text.toLowerCase().includes('customers'));
  await page.evaluate(() => [...document.querySelectorAll('#global-search-results [role=option]')].find((o) => o.innerText.includes('CUS-000050')).click());
  await sleep(1000);
  check('choosing a result opens the record', page.url().endsWith('/customers/CUS-000050'));
  await go('/');
  r = await search('CASE-000002');
  check('search finds review cases', r.opts.some((o) => o.includes('CASE-000002')) && r.text.toLowerCase().includes('review cases'));
  r = await search('PAN');
  check('search finds documents', r.text.toLowerCase().includes('documents') && r.opts.some((o) => o.startsWith('PAN')), JSON.stringify(r.opts.slice(0,6)));
  r = await search('zzqqxx');
  check('search shows a helpful message when nothing matches', r.text.includes('Nothing found'));
  await page.keyboard.press('Escape');
  await sleep(300);
  check('Escape closes the search results', !(await page.evaluate(() => !!document.querySelector('#global-search-results'))));

  // ---- profile
  await page.click('button[aria-label="Switch person"]');
  await sleep(300);
  await page.evaluate((id) => [...document.querySelectorAll('[role=menuitemradio]')].find((b) => b.innerText.includes('Asha')).click(), asha.id);
  await sleep(900);
  t = await text();
  check('choosing a person shows their name and role in the top bar', t.includes('Asha Reviewer') && t.includes('Compliance Reviewer'));
  check('the greeting uses the chosen person', t.includes('Good') && t.includes(', Asha'));

  // ---- loading, error and empty states (the failures below are deliberate: console noise is not counted)
  recording = false;
  await page.setRequestInterception(true);
  let mode = 'fail';
  page.on('request', (req) => {
    const u = req.url();
    if (u.includes('/api/alerts?') && mode === 'fail') return req.abort();
    if (u.includes('/api/alerts?') && mode === 'empty') return req.respond({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ data: [], summary: { total: 0 }, pagination: { page: 1, pageSize: 5, totalItems: 0, totalPages: 1 } }) });
    if (u.includes('/api/activity/recent') && mode === 'slow') return setTimeout(() => req.continue(), 1500);
    return req.continue();
  });
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await sleep(800);
  check('a failed API call shows a clear error inside that card only', await page.evaluate(() => { const s = document.querySelector('section[aria-labelledby="alerts-heading"]'); return !!s.querySelector('[role=alert]') && !!document.querySelector('[data-kpi="Total Customers"]'); }));
  mode = 'empty';
  await page.evaluate(() => [...document.querySelectorAll('section[aria-labelledby="alerts-heading"] button')].find((b) => b.innerText === 'Try again').click());
  await sleep(1000);
  check('"Try again" reloads the card, and an empty list shows a helpful empty state', (await text()).includes('No active alerts. Everything is in order.'));
  mode = 'slow';
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await sleep(500);
  check('loading indicators appear while data is fetched', await page.evaluate(() => !!document.querySelector('[role=status][aria-label^="Loading"]') || !!document.querySelector('.animate-pulse')));
  await sleep(2500);
  mode = 'pass';
  recording = true;

  // ---- responsive
  for (const [w, hgt] of [[1024, 800], [768, 900], [390, 800]]) {
    await page.setViewport({ width: w, height: hgt });
    await go('/');
    check(`no horizontal scroll at ${w}px`, !(await overflow()));
  }
  await page.screenshot({ path: out('s7-2-mobile.png'), fullPage: false });
  await page.click('button[aria-label="Toggle menu"]');
  await sleep(300);
  check('on a phone the sidebar collapses into a menu that opens', (await text()).includes('RISK MANAGEMENT'));
  await page.setViewport({ width: 768, height: 900 });
  await go('/');
  await page.screenshot({ path: out('s7-3-tablet.png'), fullPage: false });
  await page.setViewport({ width: 1366, height: 900 });

  // ---- other pages untouched
  const hrefs = await page.evaluate(() => [...document.querySelectorAll('aside nav a')].map((a) => a.getAttribute('href')));
  const bad = [];
  for (const href of hrefs) { await go(href); const tx = await text(); if (tx.includes('Page not found') || tx.includes('Something went wrong')) bad.push(href); }
  check('every sidebar page still opens', bad.length === 0, bad.join());
  check('no browser console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' || '));
  await browser.close();
  const failed = results.filter(([ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
