const puppeteer = require('puppeteer-core');
const path = require('path');
const { out, BASE, API, CHROME } = require('./config');
const results = [];
const check = (name, ok, extra = '') => { results.push([ok, name]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${extra}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (p) => (await fetch(API + p)).json();

(async () => {
  const today = new Date().toISOString().slice(0, 10);
  const o = (await j(`/analytics/overview?from=${today.slice(0, 8)}01&to=${today}`)).data;
  const cases = (await j('/review-dashboard/summary')).data;
  const kycEx = await j('/kyc/exceptions?pageSize=100');
  const alerts = await j('/alerts?status=active&pageSize=6');

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 200)));
  page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 200)));
  const text = () => page.evaluate(() => document.body.innerText);
  const go = async (p) => { await page.goto(BASE + p, { waitUntil: 'networkidle0' }); await sleep(700); };
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  // value of the stat tile with this label (the big number above the label)
  const tile = (label) => page.evaluate((label) => {
    const el = [...document.querySelectorAll('main .card, main a.card')].find((c) => [...c.querySelectorAll('div')].some((d) => d.children.length === 0 && d.innerText.trim() === label));
    if (!el) return null;
    const big = [...el.querySelectorAll('div')].find((d) => /^[0-9,.]+%?$/.test(d.innerText.trim()) && d.className.includes('text-3xl'));
    return big ? Number(big.innerText.replace(/[^0-9.]/g, '')) : null;
  }, label);

  // ---- navigation
  await go('/');
  let t = await text();
  const nav = await page.evaluate(() => ({
    headings: [...document.querySelectorAll('aside nav > div > div:first-child')].map((e) => e.innerText.trim()),
    links: [...document.querySelectorAll('aside nav a')].map((a) => a.innerText.trim()),
    current: document.querySelector('aside nav a[aria-current="page"]')?.innerText.trim(),
  }));
  check('sidebar has the six groups in order', nav.headings.join('|') === 'CUSTOMERS|DOCUMENTS|RISK MANAGEMENT|OPERATIONS|MONITORING|REPORTING', nav.headings.join('|'));
  check('sidebar lists every page', ['Overview', 'Customers', 'Add Customer', 'Documents', 'Verification Review', 'KYC Requirements', 'KYC Completeness', 'Ownership Management', 'Risk Assessment', 'Exceptions & Issues', 'Review Cases', 'Periodic Reviews', 'Alerts & Notifications', 'Audit Trail', 'Analytics & Reports', 'Data Quality', 'Exports'].every((l) => nav.links.includes(l)), nav.links.length + ' links');
  check('the current page is highlighted', nav.current === 'Overview');
  check('navigation items explain themselves in a tooltip', await page.evaluate(() => [...document.querySelectorAll('aside nav a')].every((a) => (a.title || '').length > 10)));
  await page.screenshot({ path: out('s6-1-dashboard.png'), fullPage: true });

  // The Overview page was redesigned after this test was written; its content, numbers, links and responsiveness are tested in overview.js.

  await browser.close();
  const failed = results.filter(([ok]) => !ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
