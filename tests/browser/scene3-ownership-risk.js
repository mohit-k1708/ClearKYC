const puppeteer = require('puppeteer-core');
const path = require('path');
const { out, BASE, API, CHROME } = require('./config');
const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p) => (await fetch(API + p)).json();

(async () => {
  const reviewers = (await j('/reviewers')).data;
  const reviewer = reviewers.find((r) => r.role === 'Reviewer');
  const analyst = reviewers.find((r) => r.role === 'Analyst');
  const company = (await j('/ownership/overview?status=NO_OWNERS&pageSize=1')).data[0];
  const individual = (await j('/customers?type=Individual&pageSize=1')).data[0];
  const CODE = company.customerId;
  console.log(`using company ${CODE} (${company.name}), individual ${individual.customerId}`);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const text = () => page.evaluate(() => document.body.innerText);
  const lower = async () => (await text()).toLowerCase();
  const clickText = async (sel, t) => {
    const h = await page.evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((e) => e.innerText.trim().includes(t)), sel, t);
    await h.asElement().click();
  };
  const clear = async (sel) => { await page.focus(sel); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); };
  const typeInto = async (sel, v) => { await clear(sel); await page.type(sel, v); };
  const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await sleep(400); };
  const actAs = async (person) => { await page.select('#acting-as', String(person.id)); await sleep(300); };
  const pick = async (code) => { await page.waitForFunction((c) => [...document.querySelectorAll('[role=option] button')].some((b) => b.innerText.includes(c)), { timeout: 8000 }, code); const h = await page.evaluateHandle((c) => [...document.querySelectorAll('[role=option] button')].find((b) => b.innerText.includes(c)), code); await h.asElement().click(); };

  // 1. Dashboard cards
  await go('/');
  let t = await text();
  const dash = (await j('/dashboard/risk-summary')).data;
  check('dashboard shows the five Scene 3 cards', ['Ownership Status', 'Complete ownership information', 'Incomplete ownership information', 'High-Risk Customers', 'Customer Risk Distribution'].every((x) => t.includes(x)));
  check('dashboard card numbers match the API', t.includes(String(dash.totalBusinessCustomers)) && t.includes(String(dash.totalBusinessCustomers - dash.ownershipIssues)));
  check('Scene 1 cards still present', t.includes('Total Customers') && t.includes('Low-Risk Customers'));
  await page.screenshot({ path: out('s3-1-dashboard.png'), fullPage: true });

  // 2. Navigation + Ownership Management
  t = (await text()).toLowerCase();
  check('sidebar has Ownership Management and Risk Assessment History', t.includes('ownership management') && t.includes('risk assessment'));
  await go('/ownership');
  t = await text();
  check('ownership management lists companies with status badges', /Reconciled|Exceeds 100%|Below 100%|No owners/.test(t) && t.includes('own or control each company'));
  const someOwner = (await j('/ownership/overview?pageSize=100')).data.find((c) => c.ownerCount > 0);
  const ownerOfSome = (await j(`/customers/${someOwner.customerId}/beneficial-owners`)).data.owners[0];
  await page.type('input[type="search"]', ownerOfSome.fullName.split(' ')[0] + ' ' + ownerOfSome.fullName.split(' ')[1]);
  await sleep(1000);
  t = await text();
  check('search by owner name finds the owner\'s company', t.includes(someOwner.customerId));
  await clear('input[type="search"]');
  await page.select('select[aria-label="Filter by ownership status"]', 'EXCEEDS_100');
  await sleep(800);
  const rows = await page.$$eval('tbody tr', (trs) => trs.map((tr) => tr.innerText));
  check('status filter narrows the list', rows.length >= 1 && rows.every((r) => /Exceeds 100%/.test(r)), `(${rows.length})`);
  await page.screenshot({ path: out('s3-2-ownership-list.png') });

  // 3. Companies only in the picker
  await go('/ownership/owners/new');
  await page.waitForSelector('#customer-picker');
  await page.click('#customer-picker');
  await page.type('#customer-picker', individual.customerId);
  await sleep(1200);
  t = await text();
  check('the owner form does not offer individual customers', /No customers found/.test(t));
  await clear('#customer-picker');
  await page.type('#customer-picker', CODE);
  await pick(CODE);
  check('a company can be picked', true);

  // 4. Validation on the form
  await actAs(analyst);
  await typeInto('input[name="ownershipPercentage"]', '101');
  await clickText('button', 'Add owner');
  await sleep(400);
  t = await text();
  check('form shows validation errors (name required, percentage above 100)', t.includes('Owner full name is required') && t.includes('cannot be more than 100'));

  // 5. Add owners through the UI: 60 -> below 100, +50 -> exceeds, edit to 40 -> reconciled
  await typeInto('input[name="fullName"]', 'E2E Owner One');
  await typeInto('input[name="ownershipPercentage"]', '60');
  await clickText('button', 'Add owner');
  await page.waitForFunction((c) => location.pathname === `/ownership/${c}`, { timeout: 10000 }, CODE);
  await sleep(900);
  t = await text();
  check('after adding 60% the company shows Below 100% with an investigation (not wrongdoing) message', t.includes('Below 100%') && /not proof of wrongdoing/i.test(t) && /40% unaccounted/i.test(t));
  await page.screenshot({ path: out('s3-3-below100.png'), fullPage: true });

  await go(`/ownership/owners/new?customer=${CODE}`);
  await page.waitForSelector('input[name="fullName"]');
  await typeInto('input[name="fullName"]', 'Darius Demo Volkov');
  await typeInto('input[name="ownershipPercentage"]', '50');
  await clickText('button', 'Add owner');
  await page.waitForFunction((c) => location.pathname === `/ownership/${c}`, { timeout: 10000 }, CODE);
  await sleep(900);
  t = await text();
  check('60% + 50% = 110% is shown as an invalid total', t.includes('Exceeds 100%') && /Invalid ownership total/.test(t) && t.includes('110%'));
  await page.screenshot({ path: out('s3-4-exceeds100.png'), fullPage: true });

  // duplicate protection through the UI
  await go(`/ownership/owners/new?customer=${CODE}`);
  await page.waitForSelector('input[name="fullName"]');
  await typeInto('input[name="fullName"]', 'e2e owner one');
  await typeInto('input[name="ownershipPercentage"]', '5');
  await clickText('button', 'Add owner');
  await sleep(1200);
  t = await text();
  check('a duplicate owner is refused with a clear message', /already recorded/i.test(t));

  // edit second owner to 40
  await go(`/ownership/${CODE}`);
  const editHandle = await page.evaluateHandle(() => [...document.querySelectorAll('tbody tr')].find((tr) => tr.innerText.includes('Darius Demo Volkov')).querySelector('a[href$="/edit"]'));
  await editHandle.asElement().click();
  await page.waitForSelector('input[name="ownershipPercentage"]');
  await sleep(500);
  await typeInto('input[name="ownershipPercentage"]', '40');
  await clickText('button', 'Save changes');
  await page.waitForFunction(() => /\/ownership\/owners\/\d+$/.test(location.pathname), { timeout: 10000 });
  const darius = page.url().split('/').pop();
  await go(`/ownership/${CODE}`);
  t = await text();
  check('after correcting to 40% the ownership is Reconciled', t.includes('Reconciled') && /exactly 100%/i.test(t));
  await clickText('button', 'Record ownership check');
  await sleep(1000);
  t = await text();
  check('a recorded ownership check appears in the history', /Ownership check recorded/.test(t) && /Recorded ownership checks/.test(t));

  // 6. Owner details: risk + screening authorisation
  await go(`/ownership/owners/${darius}`);
  t = await text();
  check('owner details show Owner risk assessment with indicators and points', /Owner risk assessment/i.test(t) && t.includes('PEP status') && t.includes('Country exposure') && t.includes('Sanctions screening') && t.includes('Owner information'));
  check('before screening the owner is Not screened', (t.match(/Not Screened/g) || []).length >= 2);
  // analyst may not screen
  await clickText('button', 'Record screening');
  await sleep(500);
  t = await text();
  check('an Analyst cannot record screening (clear message)', /cannot record screening outcomes/i.test(t));
  await actAs(reviewer);
  await clickText('button', 'Record screening');
  await sleep(1200);
  t = await text();
  check('simulated sanctions screening gives a POTENTIAL match, not confirmed', t.includes('Sanctions screening recorded: Potential Match') && /NOT a confirmed match/.test(t) && !/Sanctions: Confirmed/.test(t));
  check('the owner is flagged for review, not rejected', /Needs review \(not a rejection\)/.test(t));
  await page.screenshot({ path: out('s3-5-owner-details.png'), fullPage: true });
  // manual Confirmed needs remarks
  await page.evaluate(() => { const r = [...document.querySelectorAll('input[type=radio]')].find((x) => x.name === 'mode' && !x.checked); r.click(); });
  await sleep(200);
  await page.evaluate(() => { const s = [...document.querySelectorAll('form select')]; const res = s[s.length - 1]; res.value = 'Confirmed'; res.dispatchEvent(new Event('change', { bubbles: true })); });
  await clickText('button', 'Record screening');
  await sleep(400);
  check('a manual Confirmed result requires remarks', /Remarks are required when the result is Confirmed/.test(await text()));

  // 7. Customer risk summary + assessment
  await go(`/risk/${CODE}`);
  t = await text();
  check('risk summary shows three separate measures', /1\. Customer risk/i.test(t) && /2\. Ownership validation/i.test(t) && /3\. KYC completeness/i.test(t) && /three separate measures/i.test(t));
  check('reassessment is recommended after the ownership changes', /Reassessment recommended/.test(t));
  await clickText('button', 'Run assessment');
  await sleep(1500);
  t = await text();
  check('assessment recorded with an RSK id and Requires manual review', /Assessment RSK-\d{6} recorded: Requires Manual Review/.test(t) || (/RSK-\d{6}/.test(t) && /Requires manual review/i.test(t)));
  check('manual review is explained as not a rejection with the potential-match reason', /not a rejection/i.test(t) && /not a confirmed match/i.test(t));
  check('reasons and score components are shown', /Beneficial owner risk/.test(t) && /How the score was built/i.test(t));
  await page.screenshot({ path: out('s3-6-risk-summary.png'), fullPage: true });
  await clickText('button', 'Run assessment');
  await sleep(1000);
  check('running again with no changes explains nothing changed and offers to record anyway', /Nothing has changed since RSK-\d+/.test(await text()) && /Record it anyway/.test(await text()));

  // 8. Risk history
  await go(`/risk-history?customerId=${CODE}`);
  t = await text();
  const codes = t.match(/RSK-\d{6}/g) || [];
  check('history shows the onboarding rating and the new assessment', new Set(codes).size >= 2 && /System \(onboarding\)/.test(t));
  await clickText('button', 'Reasons');
  await sleep(300);
  check('reasons expand in the history', /Customer type/.test(await text()) && /How the score was built/i.test(await text()));
  await page.screenshot({ path: out('s3-7-risk-history.png'), fullPage: false });
  await go('/risk-history');
  await page.select('select[aria-label="Filter by assessment status"]', 'Requires Manual Review');
  await sleep(800);
  let rows2 = await page.$$eval('tbody tr', (trs) => trs.filter((tr) => /RSK-/.test(tr.innerText)).map((tr) => tr.innerText));
  check('history filter by status works', rows2.length >= 1 && rows2.every((r) => /Requires manual review/i.test(r)), `(${rows2.length})`);

  // 9. Customer profile (Scene 1 page) shows the new sections
  await go(`/customers/${CODE}`);
  t = await text();
  check('profile still shows Scene 1 content', t.includes('Customer details') && t.includes('Initial risk assessment'));
  check('profile has Beneficial ownership and Risk sections with previous assessments', t.includes('Beneficial ownership') && /Risk and ownership assessment/.test(t) && /Previous assessments/.test(t) && /Owner screening outcomes/.test(t));
  check('profile keeps the Scene 2 Documents & KYC section', t.includes('Documents & KYC'));
  await page.screenshot({ path: out('s3-8-profile.png'), fullPage: true });
  // an individual has a Risk section but no ownership section
  await go(`/customers/${individual.customerId}`);
  t = await text();
  check('an individual profile has no ownership section', !t.includes('Beneficial ownership') && /Risk and ownership assessment/.test(t));

  // 10. Scene 2 / Scene 1 pages still work
  await go(`/kyc/${CODE}`);
  check('Scene 2 KYC page still works', /Mandatory documents/i.test(await text()));
  await go('/customers');
  check('Scene 1 directory still works', /Customer ID/i.test(await text()) && /Registration status|Registered/i.test(await text()));

  // 11. Mobile
  await page.setViewport({ width: 390, height: 844 });
  for (const p of ['/ownership', `/ownership/${CODE}`, `/ownership/owners/${darius}`, `/risk/${CODE}`, '/risk-history', '/']) {
    await go(p);
    check(`no horizontal page scroll on mobile: ${p}`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  }
  await go(`/ownership/${CODE}`);
  await page.screenshot({ path: out('s3-9-mobile.png'), fullPage: true });

  check('no browser console errors', consoleErrors.filter((e) => !/40[0-9]|409/.test(e)).length === 0, consoleErrors.join(' | ').slice(0, 400));
  await browser.close();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
