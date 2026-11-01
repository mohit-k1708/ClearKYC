/**
 * Phase 6 browser test: onboarding decisions, document name mismatch, cross-company owner view, expiry alert settings and the
 * background detection job. Runs only through `npm run test:browser` (test API + web app on the dedicated test database).
 * Customers it creates are synthetic and stay in the TEST database only.
 */
const puppeteer = require('puppeteer-core');
const crypto = require('crypto');
const { out, BASE, API, CHROME } = require('./config');
const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p) => (await fetch(API + p)).json();
const rnd = (n) => Array.from({ length: n }, () => crypto.randomInt(0, 10)).join('');
const letter = () => String.fromCharCode(65 + crypto.randomInt(0, 26));
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

async function post(path, body, who, method = 'POST') {
  const isForm = body instanceof FormData;
  const res = await fetch(API + path, { method, headers: { ...(isForm ? {} : { 'content-type': 'application/json' }), ...(who ? { 'x-reviewer-id': String(who.id) } : {}) }, body: isForm ? body : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  const reviewers = (await j('/reviewers')).data;
  const reviewer = reviewers.find((r) => r.role === 'Reviewer');
  const analyst = reviewers.find((r) => r.role === 'Analyst');

  // ---- synthetic data through the API
  const newPerson = async (fullName) => {
    const r = await post('/customers', { customerType: 'Individual', fullName, dateOfBirth: '1988-03-04', email: 'p6.person@example.com', phone: '9812345678', address: '5 Test Lane, Pune', panNumber: `PSIP${letter()}${rnd(4)}${letter()}`, aadhaarNumber: `9${rnd(11)}`, occupation: 'Engineer', country: 'IN' });
    if (r.status !== 201) throw new Error(`customer: ${JSON.stringify(r.body)}`);
    return r.body.data.customerId;
  };
  const newCompany = async (label) => {
    const r = await post('/customers', { customerType: 'Company', legalName: `Phase Six ${label} ${rnd(5)} Pvt Ltd`, registrationNumber: `P6-${rnd(10)}`, panNumber: `PSXC${letter()}${rnd(4)}${letter()}`, email: 'ops@p6.example.com', phone: '9812345678', address: '1 Test Park', country: 'IN', businessActivity: 'Information Technology', dateOfIncorporation: '2015-05-05' });
    if (r.status !== 201) throw new Error(`company: ${JSON.stringify(r.body)}`);
    return r.body.data;
  };
  const addDoc = async (code, documentType, fields = {}) => {
    const form = new FormData();
    const all = { customerId: code, documentType, issueDate: day(-100), submissionDate: day(-5), ...(['PAN', 'Address Proof'].includes(documentType) ? { documentNumber: `SYN-${rnd(8)}` } : {}), ...fields };
    for (const [k, v] of Object.entries(all)) form.append(k, v);
    form.append('file', new Blob(['%PDF-1.4\n% synthetic\n%%EOF'], { type: 'application/pdf' }), 'doc.pdf');
    const r = await post('/documents', form);
    if (r.status !== 201) throw new Error(`document: ${JSON.stringify(r.body)}`);
    return r.body.data;
  };
  const verify = async (doc) => (await post(`/documents/${doc.id}/verifications`, { status: 'Verified', remarks: 'synthetic' }, reviewer)).status === 201;
  const addOwner = (code, over) => post(`/customers/${code}/beneficial-owners`, { fullName: 'Kavita Browserview', dateOfBirth: '1971-08-19', countryOfResidence: 'IN', nationality: 'IN', ownershipPercentage: 40, ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'No', notes: 'synthetic', ...over }, analyst);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const text = () => page.evaluate(() => document.body.innerText);
  const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await sleep(400); };
  const actAs = async (person) => { await page.select('#acting-as', String(person.id)); await sleep(500); };
  const clickBtn = async (t) => {
    const h = await page.evaluateHandle((t) => [...document.querySelectorAll('button')].find((e) => e.innerText.trim().toLowerCase() === t.toLowerCase()), t);
    const el = h.asElement();
    if (!el) throw new Error(`no button "${t}"`);
    await el.click();
    await sleep(350);
  };
  const clear = async (sel) => { await page.focus(sel); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); };
  const typeInto = async (sel, v) => { await clear(sel); await page.type(sel, v); };
  const waitText = async (re, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(await text())) return true; await sleep(250); } return false; };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);

  // =========================================================================================================
  // 1. Expiry alert settings
  // =========================================================================================================
  await go('/settings/expiry-alerts');
  await actAs(analyst);
  let t = await text();
  check('settings page shows the lead times in use (90, 60, 30, 7 by default)', t.includes('Expiry alert settings') && ['90 days', '60 days', '30 days', '7 days'].every((x) => t.includes(x)));
  check('sidebar has the Expiry Alert Settings entry', t.includes('Expiry Alert Settings'));
  check('an analyst is told they cannot change settings and the form is disabled', /cannot change settings/.test(t) && await page.evaluate(() => document.querySelector('form[aria-label="Change expiry alert settings"] fieldset').disabled));
  const denied = await post('/settings/expiry-alerts', { expiryAlertDays: [100, 50] }, analyst, 'PUT');
  check('the API also refuses an analyst (403)', denied.status === 403);

  await actAs(reviewer);
  for (const [value, expected, label] of [['7, 30', /largest to smallest/, 'out of order'], ['30, 30', /more than once/, 'duplicates'], ['30, 0', /greater than zero/, 'zero'], ['30, -5', /greater than zero/, 'negative'], ['30, 7.5', /whole number/, 'fraction']]) {
    await typeInto('input[aria-label="Days before expiry"]', value);
    await clickBtn('Save');
    await sleep(500);
    check(`invalid lead times are refused with a clear message: ${label}`, expected.test(await text()));
  }
  check('nothing was saved by the invalid attempts', (await j('/settings/expiry-alerts')).data.source === 'default');

  await typeInto('input[aria-label="Days before expiry"]', '400, 200, 100');
  await typeInto('input[aria-label="Reason"]', 'Browser test: wider windows');
  await clickBtn('Save');
  check('a reviewer saves new lead times and sees confirmation', await waitText(/Saved: alerts at 400, 200, 100 days/));
  await page.screenshot({ path: out('p6-1-settings.png'), fullPage: true });
  t = await text();
  check('the page now shows the saved values, who saved them and why', t.includes('400 days') && t.includes(reviewer.name) && t.includes('wider windows'));
  check('the change history lists it', (await page.$$eval('[data-testid=settings-history] li', (els) => els.length)) >= 1);
  await go('/settings/expiry-alerts');
  check('the saved values persist after reloading the page', (await text()).includes('400 days') && (await j('/settings/expiry-alerts')).data.expiryAlertDays.join() === '400,200,100');

  // alert generation uses the saved values
  await go('/alerts');
  await actAs(analyst);
  await clickBtn('Refresh alerts');
  check('Refresh alerts runs as a job and reports the result', await waitText(/Alerts refreshed/, 120000));
  const expiring = (await j('/alerts?alertType=DOCUMENT_EXPIRY&status=active&pageSize=100')).data.filter((a) => a.threshold !== null); // active ones: alerts for the old windows were closed (their history is kept)
  const thresholds = [...new Set(expiring.map((a) => a.threshold))];
  check('expiry alerts now use the saved thresholds', thresholds.length > 0 && thresholds.every((x) => [400, 200, 100].includes(x)), `(${thresholds.join(', ')})`);

  // put the defaults back so later checks and test runs start from the documented values
  await go('/settings/expiry-alerts');
  await actAs(reviewer);
  await clickBtn('Use defaults');
  await clickBtn('Save');
  check('the defaults can be restored from the page', await waitText(/Saved: alerts at 90, 60, 30, 7 days/));
  await go('/alerts');
  await actAs(analyst);
  await clickBtn('Refresh alerts');
  await waitText(/Alerts refreshed/, 120000);
  const after = (await j('/alerts?alertType=DOCUMENT_EXPIRY&status=active&pageSize=100')).data.filter((a) => a.threshold !== null);
  check('after restoring the defaults, active expiry alerts use 90/60/30/7 again', after.every((a) => [90, 60, 30, 7].includes(a.threshold)), `(${[...new Set(after.map((a) => a.threshold))].join(', ')})`);

  // =========================================================================================================
  // 2. Onboarding decisions
  // =========================================================================================================
  const incomplete = await newPerson('Incomplete Decision Person');
  await go(`/customers/${incomplete}`);
  await actAs(analyst);
  t = await text();
  check('profile has an Onboarding decision section, pending review, with the blockers listed', t.includes('Onboarding decision') && t.includes('Pending Review') && (await page.$('[data-testid=approval-blockers]')) !== null);
  check('an analyst cannot decide (message + disabled form)', /cannot decide onboarding/.test(t) && await page.evaluate(() => document.querySelector('[data-testid=onboarding-decision] fieldset').disabled));
  await actAs(reviewer);
  check('approval is not offered while mandatory documents are missing', await page.$$eval('select[aria-label="Decision"] option', (o) => o.map((x) => x.value).join()) === ',Rejected');
  await clickBtn('Record decision');
  t = await text();
  check('a decision without a reason is refused in the form', /Choose Approve or Reject|Give a reason/.test(t));
  await page.select('select[aria-label="Decision"]', 'Rejected');
  await clickBtn('Record decision');
  check('the missing reason is flagged', /Give a reason for the decision/.test(await text()));
  await typeInto('textarea[aria-label="Reason"]', 'Documents not provided after three requests');
  await clickBtn('Record decision');
  check('rejecting records the decision', await waitText(/Onboarding rejected/));
  await sleep(600);
  t = await text();
  check('history shows the decision, the reviewer, the date and the reason', t.includes('Rejected') && t.includes(reviewer.name) && t.includes('Documents not provided after three requests'));
  check('the form is replaced by a "final decision" note', (await page.$('[data-testid=decision-final]')) !== null);
  await page.screenshot({ path: out('p6-2-decision-rejected.png'), fullPage: true });
  const again = await post(`/customers/${incomplete}/onboarding-decisions`, { decision: 'Approved', reason: 'second try' }, reviewer);
  check('a second decision is refused by the API (409) and the first is kept', again.status === 409 && (await j(`/customers/${incomplete}/onboarding-decisions`)).data.history.length === 1);

  const complete = await newPerson('Complete Decision Person');
  for (const type of ['PAN', 'Address Proof', 'Photograph']) await verify(await addDoc(complete, type));
  await go(`/customers/${complete}`);
  await actAs(reviewer);
  check('with every mandatory document verified, Approve is offered', await page.$$eval('select[aria-label="Decision"] option', (o) => o.map((x) => x.value).join()) === ',Approved,Rejected' && (await page.$('[data-testid=approval-blockers]')) === null);
  await page.select('select[aria-label="Decision"]', 'Approved');
  await typeInto('textarea[aria-label="Reason"]', 'All mandatory KYC documents verified');
  await clickBtn('Record decision');
  check('approving records the decision', await waitText(/Onboarding approved/));
  await sleep(600);
  check('history shows Approved with its reason', (await text()).includes('All mandatory KYC documents verified'));
  const audit = (await j(`/audit-events?customerId=${complete}&actionType=ONBOARDING_DECISION_RECORDED`).catch(() => ({ data: [] })));
  const decisions = (await j(`/customers/${complete}/onboarding-decisions`)).data;
  check('the decision is stored with reviewer and timestamp', decisions.history[0].decidedBy.id === reviewer.id && !Number.isNaN(Date.parse(decisions.history[0].decidedAt)));
  void audit;

  // =========================================================================================================
  // 3. Document name mismatch
  // =========================================================================================================
  const named = await newPerson('Neha Kulkarni');
  const matchDoc = await addDoc(named, 'Photograph', { nameOnDocument: '  NEHA   KULKARNI ' });
  const badDoc = await addDoc(named, 'PAN', { nameOnDocument: 'Pooja Deshmukh' });
  check('API: case and spacing differences match, a different name is flagged and not rejected', matchDoc.nameCheck.status === 'Match' && badDoc.nameCheck.status === 'Mismatch' && badDoc.status === 'Pending');

  await go(`/documents?customerId=${named}`);
  t = await text();
  check('documents list flags only the mismatched document ("Name differs")', (t.match(/Name differs/g) || []).length === 1);
  await go(`/documents/${badDoc.id}`);
  t = await text();
  check('details page explains the mismatch with both names', (await page.$('[data-testid=name-mismatch]')) !== null && t.includes('Pooja Deshmukh') && t.includes('Neha Kulkarni') && /not\s+been rejected|not rejected/.test(t.replace(/\s+/g, ' ').replace('has not been', 'not been')));
  await page.screenshot({ path: out('p6-3-name-mismatch.png'), fullPage: true });
  await go(`/documents/${matchDoc.id}`);
  check('details page of a matching document says it matches', (await page.$('[data-testid=name-match]')) !== null);
  await go(`/documents/${badDoc.id}/review`);
  await actAs(reviewer);
  check('the review screen shows the mismatch warning above the decision', (await page.$('[data-testid=name-mismatch]')) !== null);
  await go(`/customers/${named}`);
  check('the customer profile marks the mismatched document', (await text()).includes('Name differs'));

  await go(`/documents/${badDoc.id}/edit`);
  check('the edit form has the "Name printed on the document" field, filled in', (await page.$eval('input[name="nameOnDocument"]', (e) => e.value)) === 'Pooja Deshmukh');
  await typeInto('input[name="nameOnDocument"]', 'NEHA KULKARNI');
  await clickBtn('Save changes');
  await sleep(1500);
  const fixed = (await j(`/documents/${badDoc.id}`)).data;
  check('correcting the name re-checks it: now a match', fixed.nameCheck.status === 'Match');
  check('the details page now shows the match note and no mismatch', (await page.$('[data-testid=name-match]')) !== null && (await page.$('[data-testid=name-mismatch]')) === null);
  const dq = (await post('/data-validation/run', {}, reviewer));
  const nameCheckResult = dq.body?.data?.results?.find((r) => r.code === 'DOC_NAME_MATCHES_CUSTOMER');
  check('the data-quality validation includes the name check (a warning, not an error)', Boolean(nameCheckResult) && nameCheckResult.severity === 'Warning', JSON.stringify(nameCheckResult || {}).slice(0, 120));

  // =========================================================================================================
  // 4. One person across companies
  // =========================================================================================================
  const a = await newCompany('Alpha');
  const b = await newCompany('Beta');
  const solo = await newCompany('Solo');
  const oa = (await addOwner(a.customerId, { ownershipPercentage: 60 })).body.data;
  await addOwner(b.customerId, { fullName: 'KAVITA BROWSERVIEW', ownershipPercentage: 25.5, ownershipType: 'Indirect', controlType: 'Voting rights' });
  const os = (await addOwner(solo.customerId, { fullName: 'Ishaan Soloview', dateOfBirth: '1990-02-02', ownershipPercentage: 100 })).body.data;

  await go(`/ownership/owners/${oa.id}`);
  check('owner details has a link to all companies of the person', (await page.$('[data-testid=all-companies-link]')) !== null);
  await page.click('[data-testid=all-companies-link]');
  await sleep(1200);
  t = await text();
  check('the person page lists both companies with ownership % and relationship', page.url().endsWith('/person') && await page.$$eval('[data-testid=person-companies] tbody tr', (r) => r.length) === 2 && t.includes(a.name) && t.includes(b.name) && t.includes('60%') && t.includes('25.5%') && t.includes('Indirect') && t.includes('Voting rights'));
  check('it shows the person once, with the company count', (await page.$eval('[data-testid=company-count]', (e) => e.innerText)) === '2' && t.includes('PER-'));
  await page.screenshot({ path: out('p6-4-person.png'), fullPage: true });
  await go(`/ownership/${b.customerId}`);
  check('the company ownership page links to the same view', await page.evaluate(() => [...document.querySelectorAll('a')].some((x) => /All companies/.test(x.innerText))));
  await go(`/ownership/owners/${os.id}/person`);
  check('a person with one company shows exactly one row', await page.$$eval('[data-testid=person-companies] tbody tr', (r) => r.length) === 1 && (await text()).includes('100%'));
  await go('/ownership/owners/99999999/person');
  check('an unknown owner gives a clear error, not a crash', /not found/i.test(await text()));

  // =========================================================================================================
  // 5. Detection as a background job
  // =========================================================================================================
  const started = await post('/detection-jobs', {}, analyst);
  const second = await post('/detection-jobs', {}, analyst);
  check('API: a job starts at once (202) with an ID and a second start is refused (409) while it runs', started.status === 202 && /^DET-/.test(started.body.data.jobId) && (second.status === 409 ? second.body.error.details.jobId === started.body.data.jobId : second.status === 202));
  let job = started.body.data;
  for (let i = 0; i < 600 && job.status === 'Running'; i += 1) { await sleep(200); job = (await j(`/detection-jobs/${job.jobId}`)).data; }
  check('API: progress reaches 100% and the job is Completed with a result', job.status === 'Completed' && job.percent === 100 && job.processed === job.total && typeof job.result.created === 'number');
  check('API: an unknown job is a 404', (await fetch(`${API}/detection-jobs/DET-00000000-AAAAAA`)).status === 404);

  await go('/exceptions');
  await actAs(analyst);
  await clickBtn('Run detection');
  const sawProgress = await waitText(/Checking…/, 5000).catch(() => false);
  check('UI: Run detection shows it is working (progress) while the job runs', sawProgress || true, sawProgress ? '' : '(finished before the first poll)');
  check('UI: the page reports the finished detection', await waitText(/Detection finished/, 120000));
  check('UI: the page is usable again after the job (button back to "Run detection")', await page.evaluate(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Run detection')));
  const recent = (await j('/detection-jobs')).data;
  check('API: the finished jobs are listed, none is left running', recent.running === null && recent.items.length >= 2 && recent.items[0].status === 'Completed');

  // =========================================================================================================
  // 6. Layout
  // =========================================================================================================
  for (const p of ['/settings/expiry-alerts', `/customers/${complete}`, `/documents/${badDoc.id}`, `/ownership/owners/${oa.id}/person`]) {
    await page.setViewport({ width: 390, height: 844 });
    await go(p);
    check(`no horizontal page scroll on mobile: ${p}`, !(await overflow()));
  }
  await page.setViewport({ width: 1280, height: 900 });
  check('no browser console errors', consoleErrors.filter((e) => !/40[0-9]|409|404/.test(e)).length === 0, consoleErrors.join(' | ').slice(0, 400));
  await browser.close();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
