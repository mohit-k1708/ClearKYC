/**
 * Unit tests (no database needed).   npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
require('../src/config/env');
const { individualSchema, companySchema, flattenZodError } = require('../src/utils/validation');
const { assessRisk, levelForScore } = require('../src/services/riskService');
const { encrypt, decrypt, blindIndex } = require('../src/utils/crypto');
const { maskPan, maskAadhaar } = require('../src/utils/mask');

const goodIndividual = {
  fullName: 'Asha Demo',
  dateOfBirth: '1990-01-15',
  email: 'Asha@Example.com',
  phone: '98765 43210',
  address: '1 Demo Street',
  panNumber: 'abcpd1234e',
  aadhaarNumber: '2345 6789 0123',
  occupation: 'Engineer',
  country: 'in',
};
const goodCompany = {
  legalName: 'Demo Traders Pvt Ltd',
  registrationNumber: 'u12345mh2015ptc123456',
  panNumber: 'ABCCD1234E',
  email: 'info@demo.example.com',
  phone: '+14155550123',
  address: '10 Business Park',
  country: 'IN',
  businessActivity: 'Retail',
  dateOfIncorporation: '2015-06-01',
};

const errorsFor = (schema, input) => {
  const r = schema.safeParse(input);
  return r.success ? null : flattenZodError(r.error);
};

test('individual: valid input is normalised', () => {
  const r = individualSchema.parse(goodIndividual);
  assert.equal(r.panNumber, 'ABCPD1234E');
  assert.equal(r.aadhaarNumber, '234567890123');
  assert.equal(r.phone, '+919876543210');
  assert.equal(r.email, 'asha@example.com');
  assert.equal(r.country, 'IN');
});

test('individual: each rule rejects bad input', () => {
  const cases = {
    fullName: '   ',
    email: 'not-an-email',
    phone: '12345',
    panNumber: 'ABCDE12345', // wrong shape
    aadhaarNumber: '12345678901', // 11 digits
    address: '',
    occupation: '',
    dateOfBirth: '2999-01-01',
  };
  for (const [field, value] of Object.entries(cases)) {
    const errors = errorsFor(individualSchema, { ...goodIndividual, [field]: value });
    assert.ok(errors?.[field], `expected an error for ${field}`);
  }
});

test('individual: PAN holder type must be P, Aadhaar must be exactly 12 digits, minors rejected', () => {
  assert.ok(errorsFor(individualSchema, { ...goodIndividual, panNumber: 'ABCCD1234E' }).panNumber);
  assert.ok(errorsFor(individualSchema, { ...goodIndividual, aadhaarNumber: '1234567890123' }).aadhaarNumber);
  assert.ok(errorsFor(individualSchema, { ...goodIndividual, aadhaarNumber: '12345678901A' }).aadhaarNumber);
  const minor = new Date();
  minor.setUTCFullYear(minor.getUTCFullYear() - 10);
  assert.ok(errorsFor(individualSchema, { ...goodIndividual, dateOfBirth: minor.toISOString().slice(0, 10) }).dateOfBirth);
});

test('individual: impossible dates such as 31 February are rejected', () => {
  assert.ok(errorsFor(individualSchema, { ...goodIndividual, dateOfBirth: '1990-02-31' }).dateOfBirth);
});

test('company: valid input passes and missing fields are all reported', () => {
  const r = companySchema.parse(goodCompany);
  assert.equal(r.registrationNumber, 'U12345MH2015PTC123456');
  assert.equal(r.phone, '+14155550123');
  const errors = errorsFor(companySchema, {});
  for (const f of ['legalName', 'registrationNumber', 'panNumber', 'email', 'phone', 'address', 'country', 'businessActivity', 'dateOfIncorporation']) {
    assert.ok(errors[f], `expected a required error for ${f}`);
  }
});

test('company: a personal "P" PAN is not accepted as a business PAN', () => {
  assert.ok(errorsFor(companySchema, { ...goodCompany, panNumber: 'ABCPD1234E' }).panNumber);
  assert.ok(errorsFor(companySchema, { ...goodCompany, businessActivity: 'Made up' }).businessActivity);
});

test('risk: thresholds map scores to levels', () => {
  assert.equal(levelForScore(0), 'Low');
  assert.equal(levelForScore(29), 'Low');
  assert.equal(levelForScore(30), 'Medium');
  assert.equal(levelForScore(59), 'Medium');
  assert.equal(levelForScore(60), 'High');
});

test('risk: ordinary domestic individual is Low with recorded reasons', () => {
  const r = assessRisk({ customerType: 'Individual', fullName: 'Asha Demo', country: 'IN', occupation: 'Engineer', dateOfBirth: new Date('1990-01-01') });
  assert.equal(r.level, 'Low');
  assert.equal(r.score, 5);
  assert.ok(r.reasons.length >= 2);
  assert.equal(r.screening.simulated, true);
  assert.equal(r.requiresManualReview, false);
});

test('risk: company in a risky activity and elevated jurisdiction is High', () => {
  const r = assessRisk(
    { customerType: 'Company', fullName: 'Coin Demo Ltd', country: 'NG', businessActivity: 'Virtual Assets / Crypto', dateOfIncorporation: new Date('2010-01-01') },
    new Date('2026-01-01')
  );
  assert.equal(r.level, 'High'); // 15 + 25 + 30
  assert.equal(r.score, 70);
});

test('risk: simulated PEP and sanctions matches add points and flag review, but never reject', () => {
  const pep = assessRisk({ customerType: 'Individual', fullName: 'Anyone', country: 'IN', occupation: 'Politician / Elected Representative' });
  assert.equal(pep.screening.pep.potentialMatch, true);
  assert.equal(pep.requiresManualReview, true);
  assert.ok(pep.reasons.some((x) => x.simulated && /PEP/.test(x.factor)));

  const sanctions = assessRisk({ customerType: 'Company', fullName: 'Northstar Trading Demo LLC', country: 'IN', businessActivity: 'Retail', dateOfIncorporation: new Date('2000-01-01') });
  assert.equal(sanctions.screening.sanctions.potentialMatch, true);
  assert.equal(sanctions.requiresManualReview, true);
  assert.ok(sanctions.score > 0 && sanctions.level);
});

test('risk: score is capped at 100 and is deterministic', () => {
  const profile = { customerType: 'Company', fullName: 'Blackwater Demo Holdings', country: 'IR', businessActivity: 'Casinos & Gaming', dateOfIncorporation: new Date('2026-06-01') };
  const a = assessRisk(profile, new Date('2026-10-22'));
  const b = assessRisk(profile, new Date('2026-10-22'));
  assert.equal(a.score, 100);
  assert.deepEqual(a, b);
});

test('crypto: encrypt/decrypt round-trips and ciphertext is not plaintext or repeatable', () => {
  const a = encrypt('ABCPD1234E');
  const b = encrypt('ABCPD1234E');
  assert.notEqual(a, b);
  assert.ok(!a.includes('ABCPD1234E'));
  assert.equal(decrypt(a), 'ABCPD1234E');
  // Flip one bit of the ciphertext: the GCM authentication tag must reject it.
  const [iv, tag, data] = a.split('.');
  const bytes = Buffer.from(data, 'base64');
  bytes[0] ^= 1;
  assert.throws(() => decrypt([iv, tag, bytes.toString('base64')].join('.')));
});

test('crypto: blind index is deterministic and scoped', () => {
  assert.equal(blindIndex('PAN', 'X'), blindIndex('PAN', 'X'));
  assert.notEqual(blindIndex('PAN', 'X'), blindIndex('AADHAAR', 'X'));
});

test('mask: only the last four characters are shown', () => {
  assert.equal(maskPan('ABCPD1234E'), 'XXXXXX234E');
  assert.equal(maskAadhaar('234567890123'), 'XXXX XXXX 0123');
  assert.equal(maskPan(null), null);
});
