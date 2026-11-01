/**
 * Name comparison for the "name on the document" check (pure functions).
 *
 * Strategy (documented in docs/phase6-features.md): the registered legal name of the customer and the name printed on the document are
 * NORMALISED and then compared, so harmless differences do not raise a flag:
 *   - letter case and accents                       "AMIT SHARMA" = "Amit Sharma"
 *   - spaces, punctuation                           "  Amit   Sharma " = "Amit Sharma", "Sharma, Amit" = "Amit Sharma"
 *   - titles (Mr, Mrs, Shri, Dr ...)                "Shri Amit Sharma" = "Amit Sharma"
 *   - company legal-form words (Pvt Ltd = Private Limited)
 *   - initials and a missing middle name            "A. Sharma" = "Amit Kumar Sharma"
 *   - a small spelling difference (similarity >= 0.8)
 * Anything else is a MISMATCH. A mismatch only FLAGS the document for a person to look at: nothing is rejected automatically, because a
 * legitimate change of name (marriage, a company rename) cannot be told from a different person by text alone.
 *
 * This is the application's own implementation. detector/nameMatcher.js (Phase 3, used to find planted errors in the dataset) is
 * deliberately independent code; server/tests/phase6.names.test.js checks that both give the same answer on a shared set of cases.
 *
 * compareNames(registered, onDocument, { isCompany }) -> { match, kind, similarity }
 *   kind: EXACT | NORMALIZED | INITIALS | SIMILAR | MISMATCH
 */
const NAME_RULES = {
  similarityThreshold: 0.8,
  allowInitials: true,
  allowMissingMiddleNames: true,
  allowReordering: true,
  titles: ['mr', 'mrs', 'ms', 'miss', 'shri', 'sri', 'smt', 'dr', 'prof', 'late'],
  companySuffixWords: ['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'corp', 'co'],
};

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
function tokens(name, { isCompany, rules }) {
  const words = String(name ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const drop = new Set(isCompany ? rules.companySuffixWords : rules.titles);
  const kept = words.filter((w) => !drop.has(w));
  return kept.length > 0 ? kept : words;
}

/** Can every word of the shorter list be matched with a different word of the longer one? Returns the kind of match or null. */
function wordsCompatible(a, b, rules) {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (long.length > short.length && !(rules.allowMissingMiddleNames && short.length >= 2)) return null; // extra words are only a missing middle name
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
      else if (rules.allowInitials && ((w.length === 1 && other.startsWith(w)) || (other.length === 1 && w.startsWith(other)))) k = 'INITIALS';
      else if (w.length > 1 && other.length > 1 && similarity(w, other) >= rules.similarityThreshold) k = 'SIMILAR';
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

function compareNames(registered, onDocument, { isCompany = false, rules = NAME_RULES } = {}) {
  if (registered === onDocument) return { match: true, kind: 'EXACT', similarity: 1 };
  const a = tokens(registered, { isCompany, rules });
  const b = tokens(onDocument, { isCompany, rules });
  const sa = a.join(' ');
  const sb = b.join(' ');
  const overall = similarity(sa, sb);
  if (sa === sb) return { match: true, kind: 'NORMALIZED', similarity: 1 };
  if (rules.allowReordering && [...a].sort().join(' ') === [...b].sort().join(' ')) return { match: true, kind: 'NORMALIZED', similarity: 1 };
  const kind = wordsCompatible(a, b, rules);
  if (kind) return { match: true, kind, similarity: overall };
  if (overall >= rules.similarityThreshold) return { match: true, kind: 'SIMILAR', similarity: overall };
  return { match: false, kind: 'MISMATCH', similarity: overall };
}

const KIND_TEXT = {
  EXACT: 'Identical to the registered name.',
  NORMALIZED: 'Same name; only capitals, spacing, punctuation, titles or word order differ.',
  INITIALS: 'Same name written with initials or without a middle name.',
  SIMILAR: 'Very close to the registered name (a small spelling difference).',
};

/**
 * The result shown with a document: { status: 'Match' | 'Mismatch' | 'Not recorded', kind, similarity, registeredName, nameOnDocument, message }.
 * `similarity` is rounded to two decimals. A document with no recorded name is "Not recorded", never a mismatch.
 */
function nameCheck({ registeredName, nameOnDocument, isCompany }) {
  const printed = typeof nameOnDocument === 'string' ? nameOnDocument.trim() : '';
  if (!printed) {
    return { status: 'Not recorded', kind: null, similarity: null, registeredName, nameOnDocument: null, message: 'The name printed on the document has not been recorded, so it cannot be compared.' };
  }
  const r = compareNames(String(registeredName ?? '').trim(), printed, { isCompany });
  return {
    status: r.match ? 'Match' : 'Mismatch',
    kind: r.kind,
    similarity: Math.round(r.similarity * 100) / 100,
    registeredName,
    nameOnDocument: printed,
    message: r.match
      ? KIND_TEXT[r.kind]
      : `The name on the document ("${printed}") differs from the registered name ("${registeredName}"). A reviewer should check it; the document is not rejected automatically.`,
  };
}

module.exports = { NAME_RULES, compareNames, nameCheck, tokens, similarity, levenshtein };
