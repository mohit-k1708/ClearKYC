/**
 * Shared settings of the browser tests. They drive a real Chrome (puppeteer-core) against a TEST copy of the application:
 * a web server and an API that scripts/runBrowserTests.js starts on their own ports, connected to the dedicated test database.
 * The scripts refuse to run any other way, so they can never be pointed at the development application and database by accident.
 */
const path = require('path');
const fs = require('fs');

if (process.env.CLEARKYC_BROWSER_TEST_DB !== 'clearkyc_test') {
  throw new Error('Browser tests must be started with: npm run test:browser (it starts the test API and web app on the dedicated test database).');
}

const WEB = process.env.E2E_WEB || 'http://localhost:5174';
const API_ROOT = process.env.E2E_API_ROOT || 'http://localhost:4100';
if (/:(4000|5173)$/.test(WEB) || /:4000$/.test(API_ROOT)) throw new Error('Refusing to run browser tests against the development ports (4000 / 5173).');

// tests/browser/screenshots/ is git-ignored, so a fresh checkout does not have it
fs.mkdirSync(path.join(__dirname, 'screenshots'), { recursive: true });

module.exports = {
  BASE: WEB,
  API_ROOT,
  API: `${API_ROOT}/api`,
  CHROME: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  out: (name) => path.join(__dirname, 'screenshots', name),
};
