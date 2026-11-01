/**
 * Reference lists used by validation, risk scoring and the frontend dropdowns.
 * The frontend loads these from GET /api/meta so there is a single source of truth.
 */

// ISO 3166-1 alpha-2 code -> display name. (A short list is enough for the prototype.)
const COUNTRIES = {
  IN: 'India',
  US: 'United States',
  GB: 'United Kingdom',
  CA: 'Canada',
  AU: 'Australia',
  SG: 'Singapore',
  AE: 'United Arab Emirates',
  DE: 'Germany',
  FR: 'France',
  JP: 'Japan',
  CH: 'Switzerland',
  NL: 'Netherlands',
  LK: 'Sri Lanka',
  NP: 'Nepal',
  BD: 'Bangladesh',
  PK: 'Pakistan',
  AF: 'Afghanistan',
  NG: 'Nigeria',
  ZA: 'South Africa',
  VE: 'Venezuela',
  YE: 'Yemen',
  SY: 'Syria',
  IR: 'Iran',
  KP: 'North Korea',
  MM: 'Myanmar',
};

// Business activities (companies). The `RISK_RULES.businessActivity` table is keyed by these.
const BUSINESS_ACTIVITIES = [
  'Information Technology',
  'Manufacturing',
  'Retail',
  'Healthcare',
  'Education',
  'Agriculture',
  'Construction',
  'Financial Services',
  'Real Estate',
  'Jewellery & Precious Metals',
  'Import / Export Trading',
  'Casinos & Gaming',
  'Virtual Assets / Crypto',
  'Money Services / Remittance',
  'Non-profit / NGO',
  'Other',
];

// Suggested occupations (individuals). The field is free text; this list only feeds a datalist.
const OCCUPATIONS = [
  'Salaried Employee',
  'Self-employed',
  'Business Owner',
  'Doctor',
  'Engineer',
  'Teacher',
  'Farmer',
  'Student',
  'Retired',
  'Homemaker',
  'Government Official',
  'Politician / Elected Representative',
  'Jeweller',
  'Real Estate Agent',
];

module.exports = { COUNTRIES, BUSINESS_ACTIVITIES, OCCUPATIONS };
