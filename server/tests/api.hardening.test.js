/**
 * Phase 5: API error handling and input robustness. Every failure must be a clean JSON error with the right status code,
 * never an HTML page, a stack trace, a crash or an SQL error message.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const prisma = require('../src/utils/prisma');

let server;
let base;
test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function call(method, url, { body, headers = {}, raw } = {}) {
  const res = await fetch(base + url, { method, headers: { ...(body !== undefined && raw === undefined ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, text, json, type: res.headers.get('content-type') || '' };
}
const cleanError = (r, status) => {
  assert.equal(r.status, status, r.text.slice(0, 300));
  assert.match(r.type, /json/, `an error is JSON, not HTML: ${r.text.slice(0, 120)}`);
  assert.ok(r.json?.error?.code && r.json?.error?.message, 'has an error code and message');
  assert.ok(!/at .*\.js:\d+|node_modules|PrismaClient|prisma\.|SELECT |INSERT |ECONN|stack/i.test(r.text), `no internals leak: ${r.text.slice(0, 200)}`);
};

test('malformed and oversized request bodies give clean 400 / 413 JSON errors', async () => {
  cleanError(await call('POST', '/api/customers', { raw: '{"customerType": "Individual", ', headers: { 'content-type': 'application/json' } }), 400);
  cleanError(await call('POST', '/api/customers', { raw: '[1,2,3]', headers: { 'content-type': 'application/json' } }), 400);
  cleanError(await call('POST', '/api/customers', { raw: 'plain text', headers: { 'content-type': 'text/plain' } }), 400);
  cleanError(await call('POST', '/api/customers', { raw: JSON.stringify({ customerType: 'Individual', fullName: 'x'.repeat(200000) }), headers: { 'content-type': 'application/json' } }), 413);
});

test('unknown routes and unsupported methods give a JSON 404', async () => {
  cleanError(await call('GET', '/api/does-not-exist'), 404);
  cleanError(await call('DELETE', '/api/customers/CUS-000001'), 404);
  cleanError(await call('PUT', '/api/audit-events/1', { body: {} }), 404);
  cleanError(await call('GET', '/not-api'), 404);
});

test('bad identifiers, hostile query strings and extreme pagination never cause a server error', async () => {
  const hostile = ["'; DROP TABLE \"Customer\"; --", '%', '_', '\\', '\u0000', '<script>alert(1)</script>', 'a'.repeat(5000), '../../etc/passwd', '%00', '{"$ne":null}'];
  for (const q of hostile) {
    for (const route of ['/api/customers', '/api/documents', '/api/alerts', '/api/review-cases', '/api/exceptions']) {
      const r = await call('GET', `${route}?search=${encodeURIComponent(q)}&pageSize=5`);
      assert.ok([200, 400].includes(r.status), `${route} search=${q.slice(0, 20)} -> ${r.status} ${r.text.slice(0, 150)}`);
      assert.match(r.type, /json/);
      assert.ok(!/syntax error|SQLSTATE|prisma/i.test(r.text), 'no database error text');
    }
  }
  assert.ok((await call('GET', '/api/customers?pageSize=5')).json.pagination.totalItems >= 0);
  assert.equal(await prisma.customer.count() >= 0, true, 'the table still exists');
  for (const id of ['abc', '-1', '1e9', '0', '99999999999999999999', 'CUS-', "1;DROP TABLE x"]) {
    for (const route of [`/api/documents/${encodeURIComponent(id)}`, `/api/review-cases/${encodeURIComponent(id)}`, `/api/alerts/${encodeURIComponent(id)}`, `/api/beneficial-owners/${encodeURIComponent(id)}`, `/api/exceptions/${encodeURIComponent(id)}`]) {
      const r = await call('GET', route);
      assert.ok([400, 404].includes(r.status), `${route} -> ${r.status} ${r.text.slice(0, 150)}`);
      cleanError(r, r.status);
    }
  }
  const unknownCustomer = await call('GET', '/api/customers/CUS-999999');
  cleanError(unknownCustomer, 404);
  for (const [page, size] of [['0', '10'], ['-5', '10'], ['abc', '10'], ['1', '0'], ['1', '-1'], ['1', '100000'], ['999999999', '10'], ['1.5', '10']]) {
    const r = await call('GET', `/api/customers?page=${page}&pageSize=${size}`);
    assert.ok([200, 400].includes(r.status), `page=${page} size=${size} -> ${r.status}`);
    if (r.status === 200) assert.ok(r.json.data.length <= 100, 'page size is capped');
  }
});

test('acting-as header: missing, malformed, unknown and inactive people are refused cleanly', async () => {
  for (const [value, status] of [[undefined, 401], ['abc', 401], ['-1', 401], ['999999', 401], ['1; DROP', 401], ['', 401]]) {
    const headers = value === undefined ? {} : { 'x-reviewer-id': value };
    const r = await call('POST', '/api/review-cases', { body: { customerId: 'CUS-000001', caseTitle: 'x', caseType: 'Other', priority: 'Low' }, headers });
    cleanError(r, status);
  }
  cleanError(await call('GET', '/api/audit-events'), 401);
});

test('validation errors list the fields and never echo sensitive values', async () => {
  const r = await call('POST', '/api/customers', { body: { customerType: 'Individual', fullName: '', panNumber: 'ABCDE1234F', aadhaarNumber: '123456789012', email: 'not-an-email', phone: '1', address: '', country: 'ZZ', dateOfBirth: '2999-01-01' } });
  cleanError(r, 400);
  assert.ok(Object.keys(r.json.error.details).length >= 4, 'several fields are explained');
  assert.ok(!r.text.includes('123456789012'), 'the Aadhaar number is not echoed back');
  const dup = await call('POST', '/api/customers', { body: { customerType: 'Nonsense' } });
  cleanError(dup, 400);
});

test('responses carry no stack traces or framework banners', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.headers.get('x-powered-by'), null, 'the framework banner is disabled');
  const bad = await call('GET', '/api/customers?riskLevel[]=a&riskLevel[]=b&customerType[$gt]=');
  assert.ok([200, 400].includes(bad.status), bad.text.slice(0, 200));
});
