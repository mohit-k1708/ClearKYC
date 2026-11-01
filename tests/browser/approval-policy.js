/**
 * Browser test: onboarding approval policy (Critical / High exceptions block, waiver with reason, Medium / Low need a follow-up action).
 * Runs only through `npm run test:browser` (test API + web app on the dedicated test database). All data is synthetic.
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
const NUMBERED = ['PAN', 'Address Proof', 'Business PAN', 'Bank Statement', 'Certificate of Incorporation'];

async function call(path, body, who, method = 'POST') {
  const isForm = body instanceof FormData;
  const res = await fetch(API + path, {
    method,
    headers: { ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...(who ? { 'x-reviewer-id': String(who.id) } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

(async () => {
  const people = (await j('/reviewers')).data;
  const reviewer = people.find((r) => r.role === 'Reviewer');
  const analyst = people.find((r) => r.role === 'Analyst');

  const newPerson = async () => (await call('/customers', { customerType: 'Individual', fullName: 'Approval Browser Person', dateOfBirth: '1988-03-04', email: 'ap.person@example.com', phone: '9812345678', address: '5 Test Lane, Pune', panNumber: `APBP${letter()}${rnd(4)}${letter()}`, aadhaarNumber: `9${rnd(11)}`, occupation: 'Engineer', country: 'IN' })).body.data.customerId;
  const newCompany = async () => (await call('/customers', { customerType: 'Company', legalName: `Approval Browser Co ${rnd(5)} Pvt Ltd`, registrationNumber: `AB-${rnd(10)}`, panNumber: `APBC${letter()}${rnd(4)}${letter()}`, email: 'ops@ap.example.com', phone: '9812345678', address: '1 Test Park', country: 'IN', businessActivity: 'Information Technology', dateOfIncorporation: '2015-05-05' })).body.data.customerId;
  const verifyAll = async (code, over = {}) => {
    const k = (await j(`/customers/${code}/kyc-completeness`)).data;
    for (const r of k.requirements.filter((x) => x.isMandatory)) {
      const form = new FormData();
      const f = { customerId: code, documentType: r.documentType, issueDate: day(-200), submissionDate: day(-5), ...(NUMBERED.includes(r.documentType) ? { documentNumber: `SYN-${rnd(8)}` } : {}), ...(over[r.documentType] || {}) };
      for (const [a, b] of Object.entries(f)) form.append(a, b);
      form.append('file', new Blob(['%PDF-1.4\n% synthetic\n%%EOF'], { type: 'application/pdf' }), 'doc.pdf');
      const d = await call('/documents', form);
      await call(`/documents/${d.body.data.id}/verifications`, { status: 'Verified', remarks: 'synthetic' }, reviewer);
    }
  };
  let seq = 0;
  const addOwner = async (code, pct) => {
    seq += 1;
    const r = await call(`/customers/${code}/beneficial-owners`, { fullName: `Approval Owner ${String.fromCharCode(65 + (seq % 26))}${seq}`, dateOfBirth: `19${60 + (seq % 30)}-0${1 + (seq % 9)}-1${seq % 9}`, countryOfResidence: 'IN', nationality: 'IN', ownershipPercentage: pct, ownershipType: 'Direct', controlType: 'Shareholding', pepStatus: 'No', notes: 'synthetic' }, analyst);
    return r.body.data;
  };
  const detect = (code) => call('/exceptions/detect', { customerId: code }, reviewer);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
  const text = () => page.evaluate(() => document.body.innerText);
  const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await sleep(500); };
  const actAs = async (person) => { await page.select('#acting-as', String(person.id)); await sleep(600); };
  const clickBtn = async (t) => {
    const h = await page.evaluateHandle((t) => [...document.querySelectorAll('button')].find((e) => e.innerText.trim().toLowerCase() === t.toLowerCase()), t);
    const el = h.asElement();
    if (!el) throw new Error(`no button "${t}"`);
    await el.click();
    await sleep(400);
  };
  const clear = async (sel) => { await page.focus(sel); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); };
  const typeInto = async (sel, v) => { await clear(sel); await page.type(sel, v); };
  const waitText = async (re, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { if (re.test(await text())) return true; await sleep(250); } return false; };
  const options = () => page.$$eval('select[aria-label="Decision"] option', (o) => o.map((x) => x.value).join());
  const exists = async (sel) => (await page.$(sel)) !== null;
  const outcome = () => page.$eval('[data-testid=policy-explanation]', (e) => e.dataset.outcome);

  // ============================ 1. HIGH exception: blocked, explained, waived with a reason ============================
  const high = await newCompany();
  await verifyAll(high);
  await addOwner(high, 60);
  await addOwner(high, 60); // 120%: ownership exceeds 100% (High)
  await detect(high);
  await go(`/customers/${high}`);
  await actAs(reviewer);
  const excCode = (await j(`/exceptions?customerId=${high}&status=active`)).data.find((e) => e.severity === 'High').exceptionId;
  check('the screen says approval is not available and why (an open High exception)', (await outcome()) === 'Needs waiver' && /blocked by 1 open Critical or High exception/.test(await text()));
  check('the blocking exception is listed with its ID, severity and description', (await exists(`[data-testid="blocking-${excCode}"]`)) && (await page.$eval(`[data-testid="blocking-${excCode}"]`, (e) => e.innerText)).includes('High') && /exceeds 100%/i.test(await text()));
  check('mandatory evidence is complete: no evidence blocker is shown', !(await exists('[data-testid=approval-blockers]')));
  await page.select('select[aria-label="Decision"]', 'Approved');
  await typeInto('textarea[aria-label="Reason"]', 'Approving with the ownership exception waived');
  await clickBtn('Record decision');
  check('approving without a waiver gives a clear message', /blocks approval\. Waive it with a reason/.test(await text()));
  await page.click(`[data-testid="waive-${excCode}"]`);
  await sleep(300);
  await clickBtn('Record decision');
  check('waiving without a reason is refused with a clear message', /Give a reason for waiving EXC-\d+/.test(await text()));
  check('nothing was recorded by the refused attempts', (await j(`/customers/${high}/onboarding-decisions`)).data.history.length === 0);
  await typeInto(`[data-testid="waive-reason-${excCode}"]`, 'The 120% is a data entry error; registry correction is pending');
  await page.screenshot({ path: out('p7-1-waiver-form.png'), fullPage: true });
  await clickBtn('Record decision');
  check('a reviewer can approve with the waiver and a reason', await waitText(/Onboarding approved/));
  await sleep(700);
  const t1 = await text();
  check('the history shows the waiver, its reason and the open exception', (await exists('[data-testid=history-waivers]')) && t1.includes(`Waived ${excCode}`) && t1.includes('registry correction is pending') && /Open exceptions at the decision:/.test(t1));
  const audit = (await call('/audit-events?actionType=ONBOARDING_EXCEPTION_WAIVED&pageSize=100', undefined, reviewer, 'GET')).body;
  check('the waiver is in the audit trail with the reason', (audit.data || []).some((e) => e.entityRef === excCode && /registry correction/.test(e.reason || '')));
  check('the exception itself is untouched: still open', (await j(`/exceptions?customerId=${high}&status=active`)).data.some((e) => e.exceptionId === excCode && e.status === 'Open'));
  await page.screenshot({ path: out('p7-2-approved-with-waiver.png'), fullPage: true });

  // ============================ 2. an analyst cannot decide or waive ============================
  const high2 = await newCompany();
  await verifyAll(high2);
  await addOwner(high2, 70);
  await addOwner(high2, 70);
  await detect(high2);
  await go(`/customers/${high2}`);
  await actAs(analyst);
  check('an analyst is told they cannot decide and the form is disabled', /cannot decide onboarding/.test(await text()) && await page.evaluate(() => document.querySelector('[data-testid=onboarding-decision] fieldset').disabled));
  check('the API refuses an analyst waiver (403)', (await call(`/customers/${high2}/onboarding-decisions`, { decision: 'Approved', reason: 'x', waivers: [{ exceptionId: 'EXC-000001', reason: 'x' }] }, analyst)).status === 403);

  // ============================ 3. CRITICAL exception ============================
  const crit = await newCompany();
  await verifyAll(crit);
  const o1 = await addOwner(crit, 60);
  await addOwner(crit, 40);
  await call(`/beneficial-owners/${o1.id}/screening`, { screeningType: 'Sanctions', mode: 'manual', screeningResult: 'Potential Match', remarks: 'synthetic potential match' }, reviewer);
  await detect(crit);
  await go(`/customers/${crit}`);
  await actAs(reviewer);
  check('a Critical exception is listed as blocking', (await page.$eval('[data-testid=blocking-exceptions]', (e) => e.innerText)).includes('Critical'));
  await page.select('select[aria-label="Decision"]', 'Approved');
  await typeInto('textarea[aria-label="Reason"]', 'Trying to approve');
  await clickBtn('Record decision');
  check('approving a Critical exception without a waiver is refused', /blocks approval/.test(await text()));
  await page.select('select[aria-label="Decision"]', 'Rejected');
  await typeInto('textarea[aria-label="Reason"]', 'Potential sanctions match could not be cleared');
  await clickBtn('Record decision');
  check('rejecting is not affected by the exception', await waitText(/Onboarding rejected/));

  // ============================ 4. LOW exception: follow-up action required ============================
  const low = await newPerson();
  await verifyAll(low, { 'Address Proof': { issueDate: day(-300), expiryDate: day(20) } });
  await detect(low);
  await go(`/customers/${low}`);
  await actAs(reviewer);
  check('open Medium / Low exceptions are listed as non-blocking', (await outcome()) === 'Needs follow-up' && (await exists('[data-testid=nonblocking-exceptions]')) && !(await exists('[data-testid=blocking-exceptions]')));
  await page.select('select[aria-label="Decision"]', 'Approved');
  await typeInto('textarea[aria-label="Reason"]', 'Evidence complete; only an expiry reminder is open');
  await clickBtn('Record decision');
  check('approving without a follow-up action gives a clear message', /need a follow-up action/.test(await text()));
  check('nothing was recorded', (await j(`/customers/${low}/onboarding-decisions`)).data.history.length === 0);
  await typeInto('[data-testid=followup-input]', 'Request a renewed Address Proof within 14 days');
  await clickBtn('Record decision');
  check('with a follow-up action the approval is recorded', await waitText(/Onboarding approved/));
  await sleep(700);
  check('the history shows the rationale and the follow-up action', (await exists('[data-testid=history-follow-up]')) && (await text()).includes('Request a renewed Address Proof within 14 days'));

  // ============================ 5. evidence is never waivable ============================
  const bare = await newCompany();
  await addOwner(bare, 70);
  await addOwner(bare, 70);
  await detect(bare);
  await go(`/customers/${bare}`);
  await actAs(reviewer);
  check('missing evidence: approval is not offered and the blockers are labelled not waivable', (await options()) === ',Rejected' && /cannot be waived/.test(await page.$eval('[data-testid=approval-blockers]', (e) => e.innerText)));
  check('the explanation says it is blocked by evidence', (await outcome()) === 'Blocked by evidence');

  // ============================ 6. no exception: existing rule ============================
  const clean = await newPerson();
  await verifyAll(clean);
  await detect(clean);
  await go(`/customers/${clean}`);
  await actAs(reviewer);
  check('with no open exception approval is available without follow-up or waiver', (await outcome()) === 'Approvable' && !(await exists('[data-testid=followup-input]')));

  // ============================ 7. layout ============================
  await page.setViewport({ width: 390, height: 844 });
  for (const code of [high, low, bare]) {
    await go(`/customers/${code}`);
    check(`no horizontal page scroll on mobile: ${code}`, !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));
  }
  check('no browser console errors', consoleErrors.filter((e) => !/40[0-9]|409|404/.test(e)).length === 0, consoleErrors.join(' | ').slice(0, 300));
  await browser.close();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
