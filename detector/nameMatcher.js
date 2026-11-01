/**
 * Name comparison (pure functions). See detector/config/nameMatching.js for the rules and the reasons.
 * compareNames(registered, onDocument, { isCompany, config }) -> { match: boolean, kind, similarity }
 *   kind: EXACT | NORMALIZED | INITIALS | SIMILAR | MISMATCH
 */
const defaults = require('./config/nameMatching');

function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

const similarity = (a, b) => (a.length === 0 && b.length === 0 ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length));

/** lower case, no accents, punctuation -> spaces, titles (and for companies the legal-form words) removed */
function tokens(name, { isCompany, config }) {
  const words = String(name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const drop = new Set(isCompany ? config.companySuffixWords : config.titles);
  const kept = words.filter((w) => !drop.has(w));
  return kept.length > 0 ? kept : words;
}

/** Can every word of the shorter list be matched with a different word of the longer one? Returns the kind of match or null. */
function wordsCompatible(a, b, config) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length > short.length && !(config.allowMissingMiddleNames && short.length >= 2)) return null; // extra words are only a missing middle name
  const used = new Set();
  let kind = 'NORMALIZED';
  let fullMatches = 0;
  for (const w of short) {
    let best = -1;
    let bestKind = null;
    for (let i = 0; i < long.length; i += 1) {
      if (used.has(i)) continue;
      const other = long[i];
      let k = null;
      if (w === other) k = 'NORMALIZED';
      else if (config.allowInitials && ((w.length === 1 && other.startsWith(w)) || (other.length === 1 && w.startsWith(other)))) k = 'INITIALS';
      else if (w.length > 1 && other.length > 1 && similarity(w, other) >= config.similarityThreshold) k = 'SIMILAR';
      if (k && (bestKind === null || k === 'NORMALIZED')) { best = i; bestKind = k; if (k === 'NORMALIZED') break; }
    }
    if (best < 0) return null;
    used.add(best);
    if (bestKind !== 'INITIALS') fullMatches += 1;
    if (bestKind === 'INITIALS' && kind !== 'SIMILAR') kind = 'INITIALS';
    if (bestKind === 'SIMILAR') kind = 'SIMILAR';
  }
  if (fullMatches === 0) return null; // "A. S." must not match every A... S...
  return kind;
}

function compareNames(registered, onDocument, { isCompany = false, config = defaults } = {}) {
  if (registered === onDocument) return { match: true, kind: 'EXACT', similarity: 1 };
  if (config.mode === 'exact') return { match: false, kind: 'MISMATCH', similarity: similarity(String(registered), String(onDocument)) };
  const a = tokens(registered, { isCompany, config });
  const b = tokens(onDocument, { isCompany, config });
  const sa = a.join(' ');
  const sb = b.join(' ');
  const overall = similarity(sa, sb);
  if (sa === sb) return { match: true, kind: 'NORMALIZED', similarity: 1 };
  if (config.allowReordering && [...a].sort().join(' ') === [...b].sort().join(' ')) return { match: true, kind: 'NORMALIZED', similarity: 1 };
  const kind = wordsCompatible(a, b, config);
  if (kind) return { match: true, kind, similarity: overall };
  if (overall >= config.similarityThreshold) return { match: true, kind: 'SIMILAR', similarity: overall };
  return { match: false, kind: 'MISMATCH', similarity: overall };
}

module.exports = { compareNames, levenshtein, similarity, tokens };
