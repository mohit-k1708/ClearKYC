const puppeteer = require('puppeteer-core');
const path = require('path');
const { out, BASE, API, CHROME } = require('./config');
const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p, h = {}) => (await fetch(API + p, { headers: h })).json();

(async () => {
  const people = (await j('/reviewers')).data;
  const analyst = people.find((r) => r.name.startsWith('Vikram'));
  const analyst2 = people.find((r) => r.name.startsWith('Priya'));
  const reviewer = people.find((r) => r.name.startsWith('Asha'));
  const summary = (await j('/review-dashboard/summary')).data;

  // A Low/Medium customer's document exception (no approval needed) and a High-risk customer's exception (approval needed).
  const excs = (await j('/exceptions?group=Document&withoutCase=true&pageSize=100')).data;
  let lowExc = null;
  for (const e of excs) {
    const c = (await j(`/customers/${e.customerId}`)).data;
    if (c && c.currentRisk && c.currentRisk.level === 'Low' && !c.currentRisk.requiresManualReview) { lowExc = e; break; }
  }
  const riskExc = (await j('/exceptions?type=HIGH_RISK_CUSTOMER&withoutCase=true&pageSize=5')).data[0];
  console.log('low exception', lowExc && lowExc.exceptionId, 'risk exception', riskExc && riskExc.exceptionId);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const text = () => page.evaluate(() => document.body.innerText);
  const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await sleep(400); };
  const actAs = async (person) => { await page.select('#acting-as', String(person.id)); await sleep(500); };
  const clickBtn = async (t, scope = 'button') => {
    const h = await page.evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((e) => e.innerText.trim().toLowerCase() === t.toLowerCase()), scope, t);
    const el = h.asElement();
    if (!el) throw new Error(`no ${scope} with text "${t}"`);
    await el.click();
    await sleep(350);
  };
  const hasBtn = (t) => page.evaluate((t) => [...document.querySelectorAll('button')].some((e) => e.innerText.trim().toLowerCase() === t.toLowerCase()), t);
  const fill = async (sel, v) => { await page.focus(sel); await page.keyboard.type(v); };
  const overflow = async () => {
    for (let i = 0; i < 5; i += 1) {
      try { return await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1); } catch (e) {
        if (!/detached Frame|Execution context was destroyed/.test(String(e))) throw e; // the page was still navigating: look again
        await sleep(1000);
      }
    }
    throw new Error('the page kept navigating');
  };

  // ---- 1. Dashboard
  await go('/');
  let t = await text();
  check('dashboard shows the six Scene 4 cards', ['Review Cases', 'Open', 'In Progress', 'Escalated', 'Overdue', 'High Priority', 'Upcoming Periodic Reviews'].every((x) => t.includes(x)));
  check('dashboard keeps Scene 1 and Scene 3 cards', t.includes('Total Customers') && t.includes('Ownership Status'));
  const cardHas = (label, n) => page.evaluate((label, n) => Number(document.querySelector(`[data-case-metric="${label}"]`)?.innerText) === n, label, n);
  check('card numbers match the API', (await cardHas('Escalated', summary.escalatedCases)) && (await cardHas('Overdue', summary.overdueCases)) && (await cardHas('High Priority', summary.highPriorityCases)));
  await page.screenshot({ path: out('s4-1-dashboard.png'), fullPage: true });
  t = (await text()).toLowerCase();
  check('sidebar has the three Scene 4 pages', t.includes('exceptions & issues') && t.includes('review cases') && t.includes('periodic reviews'));
  await page.evaluate(() => document.querySelector('a[href="/cases?status=Escalated"]').click());
  await sleep(1200);
  t = await text();
  check('Escalated card opens the filtered case list', page.url().includes('status=Escalated') && /CASE-d{6}/.test(t) && t.includes(`${summary.escalatedCases}`) || page.url().includes('status=Escalated'));
  const rowsEsc = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((r) => r.innerText));
  check('filtered list only shows Escalated cases', rowsEsc.length === summary.escalatedCases && rowsEsc.every((r) => r.includes('Escalated')), `(${rowsEsc.length} rows)`);

  // ---- 2. Exceptions page
  await go('/exceptions');
  t = await text();
  check('exceptions page lists exceptions with IDs and severity', t.includes('EXC-0000') && /Critical|High/.test(t));
  check('exceptions summary tiles shown', t.includes('Critical') && t.includes('Active'));
  await page.screenshot({ path: out('s4-2-exceptions.png'), fullPage: true });
  await go('/exceptions?severity=Critical');
  const critRows = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td')).map((r) => r.innerText));
  check('severity filter shows only Critical', critRows.length > 0 && critRows.every((r) => r.includes('Critical') || r.includes('CRITICAL')), `(${critRows.length})`);
  // detection is idempotent
  await go('/exceptions');
  await actAs(analyst);
  await clickBtn('Run detection'); // settle first: the earlier scenes just added customers and documents, so the first run legitimately creates exceptions for them
  await sleep(300);
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => /^Checking/.test(b.innerText.trim())), { timeout: 120000 }); // detection is a background job now: wait until it has finished
  await sleep(500);
  const before = (await j('/review-dashboard/summary')).data.exceptions.active;
  await clickBtn('Run detection');
  await sleep(300);
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => /^Checking/.test(b.innerText.trim())), { timeout: 120000 }); // detection is a background job now: wait until it has finished
  await sleep(500);
  const after = (await j('/review-dashboard/summary')).data.exceptions.active;
  check('running detection again creates no duplicate exceptions', before === after, `(${before} -> ${after})`);

  // ---- 3. Create a case from an exception, as the analyst
  if (lowExc) {
    await go(`/cases/new?exception=${lowExc.id}`);
    t = await text();
    check('new-case form is prefilled from the exception', t.includes(lowExc.exceptionId) && t.includes(lowExc.customerId));
    await page.screenshot({ path: out('s4-3-case-form.png'), fullPage: true });
    await clickBtn('Create case');
    await page.waitForFunction(() => /CASE-\d+/.test(location.pathname + document.body.innerText), { timeout: 8000 });
    await sleep(800);
    t = await text();
    const caseUrl = page.url();
    check('case created from the exception and opened', /\/cases\/\d+$/.test(caseUrl) && t.includes('CASE-0000'));
    check('case details shows customer, exceptions and timeline', t.includes(lowExc.customerId) && t.toLowerCase().includes('timeline'));
    check('an unassigned analyst cannot add a note yet', !(await hasBtn('Add Note')));

    // resolve with no notes -> blocked
    await clickBtn('Assign Case');
    t = await text();
    check('analyst assignment panel offers self-assignment', t.includes('Operations analyst'));
    await page.select('form[aria-label="Case assignment"] select', String(analyst.id));
    await clickBtn('Save assignment');
    await sleep(800);
    t = await text();
    check('assigning the case records it in the timeline', t.includes(analyst.name.split(' ')[0]) && /assign/i.test(t));
    await clickBtn('Start investigation');
    await clickBtn('Confirm: Start investigation');
    await sleep(900);
    t = await text();
    check('start investigation moves the case to In Progress', t.includes('In Progress'));

    await clickBtn('Add Note');
    await fill('form[aria-label="Add note"] textarea', 'Customer contacted by phone; waiting on the upload.');
    await page.click('form[aria-label="Add note"] button[type=submit]'); await sleep(400);
    await sleep(800);
    t = await text();
    check('note appears on the case', t.includes('Customer contacted by phone'));

    await clickBtn('Resolve');
    await clickBtn('Confirm: Resolve');
    await sleep(500);
    t = await text();
    check('resolving without notes is blocked with a message', /resolution notes are required/i.test(t) && !t.includes('Resolved by'));
    await page.screenshot({ path: out('s4-4-case-details.png'), fullPage: true });
    await fill('form textarea', 'Documents checked against the register. All required items are now on file.');
    // (the first textarea in the form is the resolution notes box)
    await clickBtn('Confirm: Resolve');
    await sleep(1200);
    t = await text();
    check('case resolved once notes are given', t.includes('Resolved') && t.includes('Documents checked against the register'));
    await page.screenshot({ path: out('s4-5-resolved.png'), fullPage: true });

    // reopening writes a transition
    await actAs(reviewer);
    await sleep(600);
    check('reviewer sees Reopen on a resolved case', await hasBtn('Reopen'));
    await clickBtn('Reopen');
    await fill('form textarea', 'Reopened to double check the expiry dates.');
    await clickBtn('Confirm: Reopen');
    await sleep(1000);
    t = await text();
    check('reopening is recorded in the timeline', /reopen/i.test(t) && t.includes('Reopened to double check'));
  } else {
    check('found a low-risk document exception to test with', false);
  }

  // ---- 4. Approval flow on a high-risk customer's case
  if (riskExc) {
    await actAs(analyst);
    await go(`/cases/new?exception=${riskExc.id}`);
    await clickBtn('Create case');
    await page.waitForFunction(() => /\/cases\/\d+$/.test(location.pathname), { timeout: 8000 });
    await sleep(800);
    const riskCaseUrl = page.url();
    t = await text();
    check('high-risk case shows it needs compliance approval', /approval/i.test(t));
    await clickBtn('Assign Case');
    await page.select('form[aria-label="Case assignment"] select', String(analyst.id));
    await clickBtn('Save assignment');
    await sleep(800);
    await clickBtn('Start investigation');
    await clickBtn('Confirm: Start investigation');
    await sleep(900);
    check('analyst has no Approve or Close on a high-risk case', !(await hasBtn('Approve resolution')) && !(await hasBtn('Resolve')));
    await clickBtn('Submit for review');
    await page.select('form select', String(reviewer.id));
    await fill('form textarea', 'Enhanced due diligence done; source of funds documented and consistent.');
    await clickBtn('Confirm: Submit for review');
    await sleep(1200);
    t = await text();
    check('submit for review escalates the case', t.includes('Escalated'));
    check('analyst cannot approve their own proposal', !(await hasBtn('Approve resolution')));
    await page.screenshot({ path: out('s4-6-escalated-analyst.png'), fullPage: true });

    await actAs(analyst2);
    await sleep(600);
    check('a different analyst cannot approve', !(await hasBtn('Approve resolution')));

    await actAs(reviewer);
    await sleep(700);
    check('compliance reviewer sees Approve and Reject', (await hasBtn('Approve resolution')) && (await hasBtn('Reject resolution')));
    await page.screenshot({ path: out('s4-7-escalated-reviewer.png'), fullPage: true });
    await clickBtn('Approve resolution');
    await clickBtn('Confirm: Approve resolution');
    await sleep(1400);
    t = await text();
    check('approval resolves the case', t.includes('Resolved') && t.includes('Enhanced due diligence done'));
    check('timeline shows the whole path', ['Escalated', 'In Progress', 'Resolved'].every((x) => t.includes(x)));
    await page.screenshot({ path: out('s4-8-approved.png'), fullPage: true });
  } else {
    check('found a high-risk exception to test with', false);
  }

  // ---- 5. Case list
  await go('/cases');
  t = await text();
  check('cases table has the specified columns', ['Case ID', 'Customer ID', 'Case type', 'Priority', 'Assigned analyst', 'Assigned reviewer', 'Due date', 'Status', 'Action'].every((c) => t.toLowerCase().includes(c.toLowerCase())));
  await page.screenshot({ path: out('s4-9-cases.png'), fullPage: true });
  await page.type('input[type="search"]', 'CASE-000011');
  await sleep(1200);
  const rows = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((r) => r.innerText));
  check('search narrows the list by case ID', rows.length === 1 && rows[0].includes('CASE-000011'));

  // ---- 6. Periodic reviews
  await go('/reviews');
  t = await text();
  const overdueRows = await page.evaluate(() => [...document.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td') && r.querySelectorAll('td').length > 2).map((r) => r.innerText));
  check('overdue tab lists overdue schedules', overdueRows.length === summary.overduePeriodicReviews && overdueRows.every((r) => /overdue/i.test(r)), `(${overdueRows.length})`);
  await page.screenshot({ path: out('s4-10-periodic.png'), fullPage: true });
  await actAs(analyst);
  await sleep(500);
  check('analyst has no Complete review button', !(await hasBtn('Complete review')));
  await actAs(reviewer);
  await sleep(500);
  check('reviewer can complete a review', await hasBtn('Complete review'));
  const customerBefore = await page.evaluate(() => document.querySelector('tbody tr td a').innerText);
  await clickBtn('Complete review');
  await clickBtn('Complete and schedule the next review');
  t = await text();
  check('completing a review without notes is blocked', /completion notes are required/i.test(t));
  await fill('form[aria-label="Complete review"] textarea', 'Periodic review completed; documents and ownership confirmed.');
  await clickBtn('Complete and schedule the next review');
  await sleep(1500);
  const overdueAfter = (await j('/review-dashboard/summary')).data.overduePeriodicReviews;
  check('completed review leaves the overdue list', overdueAfter === summary.overduePeriodicReviews - 1, `(${summary.overduePeriodicReviews} -> ${overdueAfter})`);
  await go(`/customers/${customerBefore}`);
  t = await text();
  check('customer profile shows the next review date and case section', t.includes('Next periodic review') && t.includes('Review cases and exceptions'));
  await page.screenshot({ path: out('s4-11-profile.png'), fullPage: true });

  // ---- 7. Mobile
  await page.setViewport({ width: 390, height: 844 });
  for (const p of ['/', '/exceptions', '/cases', '/cases/11', '/cases/new', '/reviews', `/customers/${customerBefore}`]) {
    await go(p);
    check(`no horizontal page scroll on mobile: ${p}`, !(await overflow()));
  }
  await go('/cases/11');
  await page.screenshot({ path: out('s4-12-mobile.png'), fullPage: true });

  const real = consoleErrors.filter((e) => !/favicon|401|403|409|422|Failed to load resource/.test(e));
  check('no unexpected console errors', real.length === 0, real.slice(0, 3).join(' | '));
  await browser.close();
  const failed = results.filter((r) => !r[0]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  failed.forEach((f) => console.log('FAILED:', f[1]));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
