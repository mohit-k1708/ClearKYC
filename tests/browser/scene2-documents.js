const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');
const { out, BASE, API, CHROME } = require('./config');
const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const pdfPath = out('synthetic-address-proof.pdf');
  fs.writeFileSync(pdfPath, '%PDF-1.4\n% synthetic test document\n%%EOF');

  const reviewers = (await (await fetch(`${API}/reviewers`)).json()).data;
  const reviewer = reviewers.find((r) => r.canDecide);
  const analyst = reviewers.find((r) => !r.canDecide);

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const text = () => page.evaluate(() => document.body.innerText);
  const clickText = async (sel, t) => {
    const h = await page.evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((e) => e.innerText.trim().includes(t)), sel, t);
    await h.asElement().click();
  };
  const clear = async (sel) => { await page.focus(sel); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); };
  const typeInto = async (sel, v) => { await clear(sel); await page.type(sel, v); };
  const pick = async (code) => { await page.waitForFunction((c) => [...document.querySelectorAll('[role=option] button')].some((b) => b.innerText.includes(c)), {timeout: 8000}, code); const h = await page.evaluateHandle((c) => [...document.querySelectorAll('[role=option] button')].find((b) => b.innerText.includes(c)), code); await h.asElement().click(); };
const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await sleep(300); };

  // 1. Customer profile shows the Documents & KYC section (Scene 1 page extended)
  await go('/customers/CUS-000001');
  let t = await text();
  check('profile still shows Scene 1 details + risk', t.includes('Initial risk assessment') && t.includes('Customer details'));
  check('profile has Documents & KYC section with percentage', t.includes('Documents & KYC') && /KYC COMPLETENESS/i.test(t) && /\d+(\.\d)?%/.test(t));
  check('profile lists required documents and submitted documents', /Required document/i.test(t) && /Submitted documents/i.test(t));
  await page.screenshot({ path: out('s2-1-profile.png'), fullPage: true });

  // 2. Sidebar has the new items and each page loads
  t = await text();
  check('sidebar shows Scene 2 navigation', ['documents', 'verification review', 'kyc requirements', 'kyc completeness', 'acting as'].every((x) => t.toLowerCase().includes(x)));
  for (const [p, needle] of [['/documents', 'Every document customers have sent us'], ['/verification', 'Open a document'], ['/kyc-requirements', 'configurable sample business rules'], ['/kyc', 'Check one customer']]) {
    await go(p);
    check(`page loads: ${p}`, (await text()).includes(needle));
  }

  // 3. KYC Requirements: filter, add, edit, deactivate
  await go('/kyc-requirements');
  await page.select('select[aria-label="Filter by customer type"]', 'Individual');
  await page.select('select[aria-label="Filter by risk level"]', 'High');
  await sleep(600);
  let rows = await page.$$eval('tbody tr', (trs) => trs.map((tr) => tr.innerText));
  check('requirements filter Individual + High shows the 5 sample documents', rows.length === 5 && rows.some((r) => r.includes('Bank Statement')) && rows.some((r) => r.includes('Additional Evidence')), `(${rows.length} rows)`);
  await page.screenshot({ path: out('s2-2-requirements.png') });

  await page.select('select[aria-label="Filter by customer type"]', '');
  await page.select('select[aria-label="Filter by risk level"]', '');
  await clickText('button', '+ Add Requirement');
  await page.waitForSelector('#requirement-doc-types');
  await clickText('button', 'Add requirement'); // submit empty -> validation
  await sleep(300);
  check('requirement form shows validation error', (await text()).includes('Document type is required'));
  const docInput = await page.$('input[list="requirement-doc-types"]');
  await docInput.type('QK E2E Licence');
  await page.evaluate(() => { const s = [...document.querySelectorAll('form select')]; s[0].value = 'Company'; s[0].dispatchEvent(new Event('change', { bubbles: true })); s[1].value = 'High'; s[1].dispatchEvent(new Event('change', { bubbles: true })); });
  await clickText('button', 'Add requirement');
  await sleep(1000);
  await page.select('select[aria-label="Filter by customer type"]', 'Company');
  await page.select('select[aria-label="Filter by risk level"]', 'High');
  await sleep(600);
  t = await text();
  check('new requirement is added and listed', t.includes('QK E2E Licence') && t.includes('Requirement added'));
  // Deactivate it
  const rowHandle = await page.evaluateHandle(() => [...document.querySelectorAll('tbody tr')].find((tr) => tr.innerText.includes('QK E2E Licence')));
  await (await rowHandle.asElement().$$('button'))[1].click();
  await sleep(900);
  t = await text();
  check('requirement can be deactivated', t.includes('Requirement deactivated') && /Inactive/.test(t));
  // Edit it
  const rowHandle2 = await page.evaluateHandle(() => [...document.querySelectorAll('tbody tr')].find((tr) => tr.innerText.includes('QK E2E Licence')));
  await (await rowHandle2.asElement().$$('button'))[0].click();
  await page.waitForSelector('input[list="requirement-doc-types"]');
  await page.evaluate(() => { const cb = [...document.querySelectorAll('form input[type=checkbox]')][0]; cb.click(); });
  await clickText('button', 'Save changes');
  await sleep(900);
  t = await text();
  check('requirement can be edited (made optional)', t.includes('Requirement updated') && /Optional/.test(t));

  // 4. Add a document through the UI (with a file)
  await go('/documents/new');
  await page.waitForSelector('#customer-picker');
  await clickText('button', 'Add document');
  await sleep(300);
  t = await text();
  check('document form shows required-field errors', t.includes('Choose an existing customer') && t.includes('Document type is required') && t.includes('Issue date is required'));
  await page.click('#customer-picker');
  await page.type('#customer-picker', 'CUS-000010');
  await pick('CUS-000010');
  await page.select('select[name="documentType"]', 'Address Proof');
  await typeInto('input[name="documentNumber"]', 'SYN-ADDR-998877');
  await typeInto('input[name="issueDate"]', '01012026');
  await typeInto('input[name="expiryDate"]', '01012028');
  const fileInput = await page.$('input[type=file]');
  await fileInput.uploadFile(pdfPath);
  await typeInto('textarea[name="notes"]', 'E2E synthetic document');
  await page.screenshot({ path: out('s2-3-document-form.png'), fullPage: true });
  await clickText('button', 'Add document');
  await page.waitForFunction(() => /\/documents\/\d+$/.test(location.pathname), { timeout: 10000 });
  const docId = page.url().split('/').pop();
  await sleep(700);
  t = await text();
  check('document added: details page shows Pending, masked number, file, customer', t.includes('Pending') && t.includes('XXXXXXXXXXX8877') && t.includes('synthetic-address-proof.pdf') && t.includes('CUS-000010'));
  check('new document starts with a single system "Pending" history record', /Recorded by the system/.test(t));
  check('success message says it is Pending until verified', t.includes('Pending until a reviewer verifies it'));
  await page.screenshot({ path: out('s2-4-document-details.png'), fullPage: true });

  // 5. Review: authorisation behaviour
  await go(`/documents/${docId}/review`);
  t = await text();
  check('review page asks to choose who you are acting as', /Choose who you are acting as/i.test(t));
  check('decision controls disabled without a reviewer', await page.$eval('button[type=submit]', (b) => b.disabled));
  await page.select('#acting-as', String(analyst.id));
  await sleep(300);
  t = await text();
  check('an Analyst cannot record decisions (clear message, disabled)', /cannot record verification decisions/i.test(t) && (await page.$eval('button[type=submit]', (b) => b.disabled)));
  await page.select('#acting-as', String(reviewer.id));
  await sleep(300);
  check('a Reviewer can record decisions', !(await page.$eval('button[type=submit]', (b) => b.disabled)));
  await page.screenshot({ path: out('s2-5-review.png'), fullPage: true });

  // remarks required for Rejected
  await page.click('input[value="Rejected"]');
  await clickText('button', 'Record decision');
  await sleep(300);
  check('Rejected without remarks is refused with a message', (await text()).includes('Remarks are required when the decision is Rejected'));
  await page.type('textarea', 'Image is cropped, please resend');
  await clickText('button', 'Record decision');
  await sleep(1200);
  t = await text();
  check('Rejected decision recorded with reviewer and remarks', t.includes('Decision recorded: Rejected') && t.includes(reviewer.name) && t.includes('Image is cropped'));
  // Then verify it
  await page.click('input[value="Verified"]');
  await clickText('button', 'Record decision');
  await sleep(1200);
  t = await text();
  check('Verified decision recorded; history keeps all earlier records', t.includes('Decision recorded: Verified') && (t.match(/Recorded by the system/g) || []).length === 1 && t.includes('Rejected') && t.includes('Current'));
  await page.screenshot({ path: out('s2-6-review-history.png'), fullPage: true });

  // 6. Edit metadata resets to Pending, history preserved
  await go(`/documents/${docId}/edit`);
  await page.waitForSelector('input[name="expiryDate"]');
  await sleep(500);
  t = await text();
  check('edit form warns that changes re-open verification', /goes back to .*Pending/s.test(t));
  await typeInto('input[name="expiryDate"]', '01012029');
  await clickText('button', 'Save changes');
  await page.waitForFunction(() => /\/documents\/\d+$/.test(location.pathname), { timeout: 10000 });
  await sleep(800);
  t = await text();
  check('changing the expiry date returned the document to Pending and kept history', t.includes('Re-verification required') && t.includes('Verified') && t.includes('Rejected'));

  // 7. Documents list filters
  await go('/documents');
  await page.type('input[type="search"]', 'CUS-000010');
  await sleep(900);
  t = await text();
  check('documents search by customer ID finds the new document', t.includes('Address Proof') && t.includes('CUS-000010'));
  await page.select('select[aria-label="Filter by verification status"]', 'Pending');
  await sleep(700);
  rows = await page.$$eval('tbody tr', (trs) => trs.map((tr) => tr.innerText));
  check('status filter narrows the list', rows.length >= 1 && rows.every((r) => r.includes('Pending')));
  await page.screenshot({ path: out('s2-7-documents.png') });

  // 8. KYC completeness: tiles, filter, customer lookup, customer page
  await go('/kyc');
  t = await text();
  check('KYC completeness shows six exception tiles', ['Missing', 'Pending verification', 'Rejected', 'Requires resubmission', 'Expired', 'Expiring soon'].every((x) => t.includes(x)));
  await clickText('button[aria-pressed]', 'Expired');
  await sleep(800);
  rows = await page.$$eval('tbody tr', (trs) => trs.map((tr) => tr.innerText));
  check('clicking the Expired tile filters the exceptions', rows.length >= 1 && rows.every((r) => /Expired/.test(r)), `(${rows.length})`);
  await page.screenshot({ path: out('s2-8-kyc-overview.png') });
  await go('/kyc');
  await page.click('#kyc-customer');
  await page.type('#kyc-customer', 'CUS-000010');
  await pick('CUS-000010');
  await page.waitForFunction(() => /\/kyc\/CUS-000010/.test(location.pathname), { timeout: 8000 });
  await sleep(800);
  t = await text();
  check('customer KYC page shows counters and requirement states', /Mandatory documents/i.test(t) && /Verified/.test(t) && /Missing|Pending Verification|Expired|Rejected/.test(t));
  await page.screenshot({ path: out('s2-9-customer-kyc.png'), fullPage: true });

  // 9. Mobile layout
  await page.setViewport({ width: 390, height: 844 });
  for (const p of ['/documents', `/documents/${docId}/review`, '/kyc-requirements', '/kyc/CUS-000010']) {
    await go(p);
    check(`no horizontal page scroll on mobile: ${p}`, await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  }
  await go(`/documents/${docId}/review`);
  await page.screenshot({ path: out('s2-10-mobile-review.png'), fullPage: true });

  check('no browser console errors', consoleErrors.filter((e) => !/40[0-9]|409/.test(e)).length === 0, consoleErrors.join(' | ').slice(0, 400));
  await browser.close();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });
