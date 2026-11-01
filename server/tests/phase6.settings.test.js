/**
 * Phase 6, item 4: expiry alert configuration.
 * Runs against the dedicated TEST database (npm test). Saved settings and their audit events are removed afterwards (both tables are
 * insert-only, so cleanup uses the explicit maintenance switch SET LOCAL app.allow_history_delete).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const app = require('../src/app');
const prisma = require('../src/utils/prisma');
const { validateExpiryAlertDays, leadTimeFor, EXPIRY_ALERT_CONFIG } = require('../src/config/expiryRules');
const { detectConditions } = require('../src/services/exceptionEngine');
const { loadContexts } = require('../src/services/exceptionService');
const { getExpiryAlertConfig } = require('../src/services/settingsService');
const { todayIso } = require('../src/utils/dates');

let server;
let base;
let reviewer;
let analyst;
let firstSettingId;

test.before(async () => {
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api`;
  const people = (await (await fetch(`${base}/reviewers`)).json()).data;
  reviewer = people.find((p) => p.role === 'Reviewer');
  analyst = people.find((p) => p.role === 'Analyst');
  assert.ok(reviewer && analyst);
  firstSettingId = (await prisma.systemSetting.findFirst({ orderBy: { id: 'desc' } }))?.id ?? 0;
});

test.after(async () => {
  await prisma.$transaction([
    prisma.$executeRaw`SET LOCAL app.allow_history_delete = 'on'`,
    prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE action_type = 'SETTING_CHANGED' AND entity_id > ${firstSettingId}`,
    prisma.$executeRaw`DELETE FROM "SystemSetting" WHERE id > ${firstSettingId}`,
  ]);
  await new Promise((resolve) => server.close(resolve));
  await prisma.$disconnect();
});

async function api(method, url, body, who) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(who ? { 'x-reviewer-id': String(who.id) } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

test('validation: positive, whole, unique, largest to smallest', () => {
  assert.deepEqual(validateExpiryAlertDays([90, 60, 30, 7]).days, [90, 60, 30, 7]);
  assert.equal(validateExpiryAlertDays([45]).ok, true);
  for (const [bad, fragment] of [
    [[], 'at least one'], [[90, 0], 'greater than zero'], [[90, -5], 'greater than zero'], [[30, 30], 'more than once'],
    [[7, 30], 'largest to smallest'], [[90, 30.5], 'whole number'], [['abc'], 'must be a number'], [[5000], 'at most 3650'],
    [[9, 8, 7, 6, 5, 4, 3, 2, 1], 'at most 8'], ['90,60', 'list of numbers'], [null, 'list of numbers'], [[null], 'must be a number'],
  ]) {
    const r = validateExpiryAlertDays(bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.problems.join(' ').includes(fragment), `${JSON.stringify(bad)} -> ${r.problems.join(' | ')}`);
  }
});

test('GET shows the thresholds in use (defaults 90/60/30/7 when nothing is saved)', async () => {
  const r = await api('GET', '/settings/expiry-alerts');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body.data.expiryAlertDays));
  assert.deepEqual(r.body.data.defaults, [90, 60, 30, 7]);
  if (r.body.data.source === 'default') assert.deepEqual(r.body.data.expiryAlertDays, [90, 60, 30, 7]);
});

test('authorisation: missing identity 401, analyst 403, invalid values 400 and nothing is saved', async () => {
  assert.equal((await api('PUT', '/settings/expiry-alerts', { expiryAlertDays: [100, 50] })).status, 401);
  const denied = await api('PUT', '/settings/expiry-alerts', { expiryAlertDays: [100, 50] }, analyst);
  assert.equal(denied.status, 403);
  for (const bad of [[7, 30], [30, 30], [30, 0], [], 'x']) {
    const r = await api('PUT', '/settings/expiry-alerts', { expiryAlertDays: bad }, reviewer);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.equal(r.body.error.code, 'VALIDATION_ERROR');
  }
  assert.equal((await api('PUT', '/settings/expiry-alerts', {}, reviewer)).status, 400);
  assert.equal((await prisma.systemSetting.count({ where: { id: { gt: firstSettingId } } })), 0);
});

test('a reviewer saves new thresholds: persisted, audited, history kept, unchanged list refused', async () => {
  const saved = await api('PUT', '/settings/expiry-alerts', { expiryAlertDays: [120, 45, 10], reason: 'Phase 6 test' }, reviewer);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.data.expiryAlertDays, [120, 45, 10]);
  assert.equal(saved.body.data.source, 'saved');
  assert.equal(saved.body.data.updatedBy.id, reviewer.id);
  assert.equal(saved.body.data.reason, 'Phase 6 test');

  assert.deepEqual((await api('GET', '/settings/expiry-alerts')).body.data.expiryAlertDays, [120, 45, 10], 'persisted');
  assert.equal((await api('PUT', '/settings/expiry-alerts', { expiryAlertDays: [120, 45, 10] }, reviewer)).status, 400, 'unchanged');

  await api('PUT', '/settings/expiry-alerts', { expiryAlertDays: [100, 50, 20] }, reviewer);
  const history = (await api('GET', '/settings/expiry-alerts')).body.data.history;
  assert.deepEqual(history.slice(0, 2).map((h) => h.expiryAlertDays), [[100, 50, 20], [120, 45, 10]], 'older value is kept, newest first');

  const events = await prisma.auditEvent.findMany({ where: { actionType: 'SETTING_CHANGED', entityId: { gt: firstSettingId } }, orderBy: { id: 'asc' } });
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].newValues, { expiryAlertDays: [120, 45, 10] });
  assert.deepEqual(events[1].previousValues, { expiryAlertDays: [120, 45, 10] });
  assert.equal(events[0].userId, reviewer.id);

  // history cannot be rewritten
  await assert.rejects(prisma.$executeRaw`UPDATE "SystemSetting" SET value = '[1]'::jsonb WHERE id > ${firstSettingId}`, /immutable/i);
  // the database refuses an invalid or unauthorised row even when the API is bypassed
  await assert.rejects(prisma.systemSetting.create({ data: { key: 'expiry_alert_days', value: [7, 30], changedById: reviewer.id } }));
  await assert.rejects(prisma.systemSetting.create({ data: { key: 'expiry_alert_days', value: [30, 7], changedById: analyst.id } }));
});

test('detection uses the saved thresholds, not the hard-coded ones', async () => {
  await api('PUT', '/settings/expiry-alerts', { expiryAlertDays: [400, 200, 100], reason: 'detection check' }, reviewer);
  assert.deepEqual((await getExpiryAlertConfig()).expiryAlertDays, [400, 200, 100]);

  const contexts = await loadContexts(prisma, { asOf: todayIso() });
  assert.deepEqual(contexts[0].expiryConfig.expiryAlertDays, [400, 200, 100]);
  const thresholds = new Set();
  for (const ctx of contexts) {
    for (const c of detectConditions({ ...ctx, unresolvedClosedCases: [], asOf: todayIso() })) {
      if (c.type === 'DOCUMENT_EXPIRING_SOON' && c.threshold) thresholds.add(c.threshold);
    }
  }
  assert.ok(thresholds.size > 0, 'the test database has documents inside the saved windows');
  for (const t of thresholds) assert.ok([400, 200, 100].includes(t), `threshold ${t} comes from the saved list`);
  assert.ok(![90, 60, 30, 7].some((t) => thresholds.has(t)), 'hard-coded defaults are not used any more');

  // the engine is a pure function of the configuration
  assert.equal(leadTimeFor(150, { enabled: true, expiryAlertDays: [400, 200, 100] }), 200);
  assert.equal(leadTimeFor(150), null);
  assert.deepEqual(EXPIRY_ALERT_CONFIG.expiryAlertDays, [90, 60, 30, 7], 'the file defaults are untouched');
});

test('regression: the generator reset lists every table that references Reviewer (SystemSetting broke it in Phase 6)', async () => {
  const { BUSINESS_TABLES } = require('../../generator/utils/database');
  const referencing = (await prisma.$queryRaw`
    SELECT DISTINCT c.relname AS tbl FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
     WHERE k.contype = 'f' AND k.confrelid = '"Reviewer"'::regclass AND c.relname <> 'Reviewer'`).map((r) => r.tbl);
  assert.ok(referencing.includes('SystemSetting'));
  const missing = referencing.filter((t) => !BUSINESS_TABLES.includes(t));
  assert.deepEqual(missing, [], `the generator reset must also truncate: ${missing.join(', ')}`);
});
