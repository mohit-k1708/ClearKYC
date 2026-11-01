/**
 * The name that appears ON a document. Real documents rarely repeat a registered name letter for letter, so the baseline
 * contains LEGITIMATE variants (capitals, a title, initials, reversed order, a middle initial, a one-letter typo, "Pvt Ltd" written
 * out ...). The detector must NOT flag these; only a genuinely different name is a potential mismatch (see detector/config).
 */
const TITLES = ['Mr', 'Ms', 'Mrs', 'Shri', 'Smt', 'Dr'];
const MIDDLE = ['K', 'R', 'S', 'M', 'P'];

/** Repeats one letter of a long word: "Sharma" -> "Sharmaa". One edit, never a different name. Short words are left alone. */
function typo(text, r, which = 'last') {
  const words = text.split(' ');
  const i = which === 'last' ? words.length - 1 : 0;
  const word = words[i];
  if (word.length < 6) return text;
  const at = r.int(1, word.length - 1);
  words[i] = word.slice(0, at) + word[at] + word.slice(at);
  return words.join(' ');
}

function personName(full, r) {
  const [first, ...rest] = full.split(' ');
  const last = rest.join(' ');
  const kind = r.weighted([['exact', 72], ['upper', 5], ['title', 5], ['initial', 5], ['reversed', 4], ['spacing', 3], ['typo', 4], ['middle', 2]]);
  switch (kind) {
    case 'upper': return full.toUpperCase();
    case 'title': return `${r.pick(TITLES)}. ${full}`;
    case 'initial': return `${first[0]}. ${last}`;
    case 'reversed': return `${last} ${first}`;
    case 'spacing': return `${first}  ${last}`;
    case 'typo': return typo(full, r, 'last');
    case 'middle': return `${first} ${r.pick(MIDDLE)} ${last}`;
    default: return full;
  }
}

function companyName(full, r) {
  const m = full.match(/^(.*) (Pvt Ltd|Ltd|LLP)$/);
  const core = m ? m[1] : full;
  const suffix = m ? m[2] : '';
  const kind = r.weighted([['exact', 74], ['long', 12], ['dots', 8], ['upper', 3], ['typo', 3]]);
  switch (kind) {
    case 'long': return `${core} ${{ 'Pvt Ltd': 'Private Limited', Ltd: 'Limited', LLP: 'LLP' }[suffix] ?? suffix}`.trim();
    case 'dots': return `${core} ${{ 'Pvt Ltd': 'Pvt. Ltd.', Ltd: 'Ltd.', LLP: 'LLP' }[suffix] ?? suffix}`.trim();
    case 'upper': return full.toUpperCase();
    case 'typo': return typo(full, r, 'first');
    default: return full;
  }
}

/** The name written on a document of this customer (a legitimate variant of the registered name). */
function nameOnDocument(customer, r) {
  return customer.isCompany ? companyName(customer.fullName, r) : personName(customer.fullName, r);
}

module.exports = { nameOnDocument, personName, companyName };
