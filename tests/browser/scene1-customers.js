const puppeteer = require('puppeteer-core');
const path = require('path');
const { out, BASE, API, CHROME } = require('./config');
const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name, extra]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join('');
const L = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  const text = () => page.evaluate(() => document.body.innerText);
  const clickText = async (sel, t) => {
    const handle = await page.evaluateHandle((s, t) => [...document.querySelectorAll(s)].find((e) => e.innerText.trim().includes(t)), sel, t);
    await handle.asElement().click();
  };
  const type = async (name, v) => { await page.focus('[name="' + name + '"]'); await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control'); await page.keyboard.press('Backspace'); await page.type('[name="' + name + '"]', v); };

  // 1. Dashboard
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  let t = await text();
  check('dashboard shows all six metrics', ['Total Customers', 'Individual Customers', 'Company Customers', 'Low-Risk Customers', 'Medium-Risk Customers', 'High-Risk Customers'].every((x) => t.includes(x)));
  check('sidebar nav present', ['Overview', 'Customers', 'Add Customer'].every((x) => t.includes(x)));
  const summary = await (await fetch(`${API}/dashboard/summary`)).json();
  check('dashboard total matches API', t.includes(String(summary.data.totalCustomers)), `(api=${summary.data.totalCustomers})`);
  await page.screenshot({ path: out('1-dashboard.png') });

  // 2. Add new customer -> type selection
  await clickText('a', '+ Add New Customer');
  await page.waitForSelector('a[href="/customers/new/individual"]');
  t = await text();
  check('type selection shows both cards', t.includes('Individual Customer') && t.includes('Company Customer'));
  await page.screenshot({ path: out('2-type-select.png') });

  // 3. Individual form - validation
  await page.click('a[href="/customers/new/individual"]');
  await page.waitForSelector('[name="fullName"]');
  await clickText('button', 'Register customer');
  await sleep(300);
  t = await text();
  check('empty submit shows required errors', t.includes('Full name is required') && t.includes('Aadhaar number is required') && t.includes('PAN number is required'));
  await type('email', 'bad'); await type('phone', '123'); await type('panNumber', 'abc'); await type('aadhaarNumber', '1234');
  await clickText('button', 'Register customer'); await sleep(300);
  t = await text();
  check('format errors for email/phone/PAN/Aadhaar', t.includes('valid format') && t.includes('Phone number is not valid') && t.includes('PAN format') && t.includes('exactly 12 digits'));
  await page.screenshot({ path: out('3-individual-errors.png'), fullPage: true });

  // 4. Individual form - valid submission
  const pan = `QTEP${L()}${rnd(4)}${L()}`; const aad = `9${rnd(11)}`;
  await type('fullName', 'Browser Test Person'); await type('dateOfBirth', '04031988');
  await type('email', 'browser.test@example.com'); await type('phone', '9812345678');
  await type('address', '12 Test Lane, Pune'); await type('panNumber', pan.toLowerCase()); await type('aadhaarNumber', aad);
  await type('occupation', 'Engineer');
  await clickText('button', 'Register customer');
  await sleep(1500); await page.screenshot({ path: out('debug-after-submit.png'), fullPage: true });
  await page.waitForFunction(() => /\/customers\/CUS-\d+/.test(location.pathname), { timeout: 10000 });
  const indId = location_id(await page.url());
  t = await text();
  check('individual registered, navigated to profile', /CUS-\d{6}/.test(indId), indId);
  check('success notification shows Customer ID', t.includes('Customer registered successfully') && t.includes(indId));
  check('profile shows masked PAN/Aadhaar, not full', t.includes('XXXXXX') && t.includes(`XXXX XXXX ${aad.slice(-4)}`) && !t.includes(pan) && !t.includes(aad));
  check('profile shows risk with reasons + simulated screening labels', t.includes('Initial risk assessment') && t.includes('Customer type') && t.includes('simulated'));
  await page.screenshot({ path: out('4-profile-individual.png'), fullPage: true });

  // 5. Duplicate submission
  await page.goto(`${BASE}/customers/new/individual`, { waitUntil: 'networkidle0' });
  await type('fullName', 'Dup Person'); await type('dateOfBirth', '04031988'); await type('email', 'd@example.com'); await type('phone', '9812345678');
  await type('address', 'x'); await type('panNumber', pan); await type('aadhaarNumber', `9${rnd(11)}`); await type('occupation', 'Teacher');
  await clickText('button', 'Register customer'); await sleep(1200);
  t = await text();
  check('duplicate PAN shows clear error + existing ID', t.includes('already registered') && t.includes(indId));
  await page.screenshot({ path: out('5-duplicate.png'), fullPage: true });

  // 6. Company
  await page.goto(`${BASE}/customers/new/company`, { waitUntil: 'networkidle0' });
  await type('legalName', 'Browser Test Crypto Pvt Ltd'); await type('registrationNumber', `BT-${rnd(8)}`);
  await type('panNumber', `QTEC${L()}${rnd(4)}${L()}`); await type('dateOfIncorporation', '01022020');
  await type('email', 'ops@btcrypto.example.com'); await type('phone', '+14155550123'); await type('address', '1 Test Park');
  await page.select('[name="country"]', 'NG'); await page.select('[name="businessActivity"]', 'Virtual Assets / Crypto');
  await clickText('button', 'Register customer');
  await page.waitForFunction(() => /\/customers\/CUS-\d+/.test(location.pathname), { timeout: 10000 });
  const coId = location_id(await page.url()); await sleep(800); t = await text();
  check('company registered with company fields', /registration number/i.test(t) && t.includes('Virtual Assets / Crypto') && !t.includes('Aadhaar'), coId);
  check('company is High risk (crypto + elevated country)', /High/.test(t));
  await page.screenshot({ path: out('6-profile-company.png'), fullPage: true });

  // 7. Directory: search + filters
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle0' });
  await page.type('input[type="search"]', 'Browser Test'); await sleep(900);
  t = await text();
  check('search by name finds both new customers', t.includes(indId) && t.includes(coId));
  await page.select('select[aria-label="Filter by customer type"]', 'Company'); await sleep(700);
  t = await text();
  check('type filter narrows results', t.includes(coId) && !t.includes(indId));
  await page.select('select[aria-label="Filter by risk level"]', 'Low'); await sleep(700);
  t = await text();
  check('risk filter combined with others', !t.includes(coId) && t.includes('No customers match'));
  await page.screenshot({ path: out('7-directory-filtered.png') });
  await page.goto(`${BASE}/customers?search=${indId}`, { waitUntil: 'networkidle0' });
  t = await text(); check('search by Customer ID', t.includes(indId));
  await page.goto(`${BASE}/customers`, { waitUntil: 'networkidle0' });
  await clickText('button', 'Next'); await sleep(700);
  check('pagination moves to page 2', (await text()).includes('Page 2 of'));
  await page.screenshot({ path: out('8-directory.png') });

  // 8. Mobile + server-down handling
  await page.setViewport({ width: 390, height: 800 });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.screenshot({ path: out('9-mobile.png') });
  check('no horizontal scroll on mobile', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  check('no browser console errors', consoleErrors.filter((e) => !/409/.test(e)).length === 0, consoleErrors.join(' | ').slice(0, 300));
  await browser.close();
  const failed = results.filter((r) => !r[0]).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('E2E crashed:', e); process.exit(2); });

function location_id(url) { return url.split('/').pop(); }
