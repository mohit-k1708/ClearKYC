/**
 * ONE central configuration for the synthetic data generator. Every entity count comes from the chosen scale, so changing
 * `scale` adjusts all dependent records. There are no separate per-table scaling options.
 *
 *   npm run generate:starter | generate:medium | generate:full
 *   node generator/index.js --scale=full --seed=20261022 --reference-date=2026-10-31 --batch-size=1000
 */

// The EXACT counts of the four entities the challenge fixes. Everything else is derived from them (see RATIOS).
const SCALES = {
  starter: { customers: 50, companies: 17, documents: 152, reviewCases: 15 },
  medium: { customers: 1000, companies: 125, documents: 2500, reviewCases: 300 },
  full: { customers: 8000, companies: 1000, documents: 20000, reviewCases: 3000 },
};

const GENERATOR_CONFIG = {
  seed: 20261022,
  scale: 'full',
  // Every date and timestamp is generated relative to this day, never the machine clock, so a run is reproducible.
  referenceDate: '2026-10-31',
  batchSize: 1000,
  resetBeforeGeneration: false,
  // Empty = clearkyc_<scale>, a separate database, so existing development data is never touched.
  databaseName: '',
};

// Business-rule ratios that shape the dependent records. They are proportions, so they scale with the counts above.
const RATIOS = {
  onboardingWindowDays: 1095, // customers were onboarded over the 36 months before the reference date
  recentBias: 1.35, // > 1 puts more customers in the recent months
  ownersPerCompany: [[1, 0.25], [2, 0.4], [3, 0.25], [4, 0.1]], // [owners, probability]
  sharedPersonRate: 0.12, // share of ownership slots filled by a person who already owns another company
  maxCompaniesPerPerson: 3,
  replacementDocumentRate: 0.07, // share of all documents that replace an earlier rejected / expired / unusable one
  documentOutcomes: [ // share of submitted documents by outcome (all derived to real dates and decisions later)
    ['verified', 0.64], ['expiring', 0.05], ['expired', 0.06], ['pending', 0.07], ['in_review', 0.06], ['rejected', 0.06], ['resubmit', 0.06],
  ],
  expiryBoost: 2.5, // documents that can expire (address proof, bank statement ...) are ~40% of all documents, so their expiring / expired weights are scaled up to reach the overall shares above
  fileAttachedRate: 0.4,
  completedReviewRate: 0.88, // share of due periodic reviews that were completed (the rest are overdue)
  historicalCaseShare: 0.2, // share of review cases that are Resolved / Closed (from issues that really cleared)
  alertAcknowledgedRate: 0.11,
  alertInProgressRate: 0.07,
  pepPotentialRate: 0.025,
  sanctionsPotentialRate: 0.004,
};

// Version of the generator + edge-case + detector + exporter toolchain that produced a dataset (recorded in the source manifest).
const GENERATOR_VERSION = '4.0.0';

const ADMIN_DATABASE = 'postgres';
const MAIN_DATABASE = 'clearkyc';

function parseArgs(argv) {
  const args = {};
  for (const a of argv) {
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    args[k] = v === undefined ? true : v;
  }
  return args;
}

/** Defaults < command line. Unknown scales and malformed values stop the run with a clear message. */
function resolveConfig(argv = process.argv.slice(2), env = {}) {
  const args = parseArgs(argv);
  const scale = args.scale || env.scale || GENERATOR_CONFIG.scale;
  if (!SCALES[scale]) throw new Error(`Unknown scale "${scale}". Use one of: ${Object.keys(SCALES).join(', ')}`);
  const seed = Number(args.seed ?? GENERATOR_CONFIG.seed);
  if (!Number.isInteger(seed)) throw new Error('--seed must be a whole number');
  const referenceDate = args['reference-date'] || GENERATOR_CONFIG.referenceDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(referenceDate) || Number.isNaN(Date.parse(referenceDate))) throw new Error('--reference-date must look like 2026-10-31');
  const batchSize = Number(args['batch-size'] ?? GENERATOR_CONFIG.batchSize);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 2000) throw new Error('--batch-size must be a whole number from 1 to 2000');
  const counts = { ...SCALES[scale] };
  if (counts.companies >= counts.customers) throw new Error('companies must be fewer than customers');
  return {
    seed,
    scale,
    referenceDate,
    batchSize,
    counts: { ...counts, individuals: counts.customers - counts.companies },
    resetBeforeGeneration: Boolean(args.reset ?? GENERATOR_CONFIG.resetBeforeGeneration),
    confirmResetMain: Boolean(args['confirm-reset-main-database']),
    skipValidation: Boolean(args['skip-validation']),
    databaseName: args.database || GENERATOR_CONFIG.databaseName || `clearkyc_${scale}`,
    ratios: RATIOS,
    reportDir: args['report-dir'] || null,
  };
}

module.exports = { GENERATOR_CONFIG, SCALES, RATIOS, GENERATOR_VERSION, ADMIN_DATABASE, MAIN_DATABASE, resolveConfig, parseArgs };
