#!/usr/bin/env node
/**
 * SHA-256 checksums of every file of the packaged dataset.
 *
 *   npm run generate:checksums -- --dir=ClearKYC-Dataset       writes <dir>/checksums.txt
 *   npm run verify:checksums   -- --dir=ClearKYC-Dataset       recomputes every hash and compares it with checksums.txt
 *
 * Format: `sha256sum` style, `<64 hex characters>  <path relative to the folder>`, forward slashes, sorted paths, LF line endings.
 * The hash is of the file bytes (UTF-8 text, LF, no byte-order mark - see exporter/formats.js), so it does not depend on the machine.
 * Three sections keep the operational dataset apart from the answer key:
 *   [1] operational dataset         reproducible: identical for every run with the same seed, scale, reference date and keys
 *   [2] ground truth + measurement  the answer key and the results measured against it (reproducible, kept separate)
 *   [3] documentation + run reports their text or timings can differ per run (dates, durations): integrity check only
 * checksums.txt does not list itself. Temporary and machine-specific files are never listed.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IGNORED = /(^|\/)(node_modules|\.git)(\/|$)|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$|\.(tmp|log|bak|swp)$|~$/i;
const GROUND_TRUTH_SECTION = ['ground_truth.json', 'detection_report.json', 'final_detection_summary.json', 'edge_case_manifest.json'];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function listFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else out.push(path.relative(dir, p).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.filter((f) => f !== 'checksums.txt' && !IGNORED.test(f)).sort();
}

const sectionOf = (file) => {
  if (/^(csv|json|sql)\//.test(file)) return 1;
  if (GROUND_TRUTH_SECTION.includes(file)) return 2;
  return 3;
};

function buildChecksumsText(dir) {
  const files = listFiles(dir);
  const titles = {
    1: '[1] OPERATIONAL DATASET - reproducible: identical for every run with the same seed, scale, reference date and keys',
    2: '[2] GROUND TRUTH AND DETECTION MEASUREMENT - the answer key and results measured against it; reproducible, kept separate from the operational dataset',
    3: '[3] DOCUMENTATION AND RUN REPORTS - contain dates or timings that can differ per run; integrity check only',
  };
  const lines = [
    '# ClearKYC dataset - SHA-256 checksums (sha256sum format: <hash>  <path>)',
    '# Verify with: npm run verify:checksums -- --dir=<this folder>',
    '# Text files are UTF-8 with LF line endings and no byte-order mark. This file does not list itself.',
  ];
  for (const n of [1, 2, 3]) {
    lines.push('', `# ${titles[n]}`);
    for (const f of files.filter((x) => sectionOf(x) === n)) lines.push(`${sha256(path.join(dir, f))}  ${f}`);
  }
  return { text: `${lines.join('\n')}\n`, files };
}

function generateChecksums(dir) {
  const { text, files } = buildChecksumsText(dir);
  fs.writeFileSync(path.join(dir, 'checksums.txt'), text);
  return { file: path.join(dir, 'checksums.txt'), files: files.length };
}

/** Recomputes every listed hash. Reports files that changed, that are missing and that exist but are not listed. */
function verifyChecksums(dir) {
  const file = path.join(dir, 'checksums.txt');
  if (!fs.existsSync(file)) throw new Error(`No checksums.txt in ${dir}`);
  const listed = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (m) listed.set(m[2], m[1]);
  }
  const present = new Set(listFiles(dir));
  const changed = [];
  const missing = [];
  for (const [f, h] of listed) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) missing.push(f);
    else if (sha256(p) !== h) changed.push(f);
  }
  const unlisted = [...present].filter((f) => !listed.has(f));
  return { status: changed.length + missing.length + unlisted.length === 0 ? 'VERIFIED' : 'MISMATCH', files_checked: listed.size, changed, missing, unlisted };
}

function parse(argv) {
  const a = {};
  for (const x of argv) {
    if (!x.startsWith('--')) continue;
    const [k, v] = x.slice(2).split('=');
    a[k] = v === undefined ? true : v;
  }
  return a;
}

if (require.main === module) {
  const a = parse(process.argv.slice(2));
  const dir = path.resolve(a.dir || path.join(__dirname, '..', 'ClearKYC-Dataset'));
  const verify = process.argv[1].includes('verify') || a.verify;
  try {
    if (verify) {
      const r = verifyChecksums(dir);
      console.log(`\nChecksums ${r.status}: ${r.files_checked} files checked in ${dir}`);
      for (const k of ['changed', 'missing', 'unlisted']) if (r[k].length) console.log(`  ${k}: ${r[k].join(', ')}`);
      process.exit(r.status === 'VERIFIED' ? 0 : 1);
    } else {
      const r = generateChecksums(dir);
      console.log(`\nWrote ${r.file} (${r.files} files)\n`);
    }
  } catch (err) {
    console.error(`Checksums stopped: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { generateChecksums, verifyChecksums, buildChecksumsText, listFiles, sha256 };
