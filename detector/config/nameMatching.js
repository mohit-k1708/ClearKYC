/**
 * Configurable name comparison used by the DOCUMENT_NAME_MISMATCH rule.
 *
 *   mode 'exact'       the two names must be identical letter for letter (strictest; every variant is a "mismatch")
 *   mode 'normalized'  the names are compared after normalisation: capitals, punctuation, titles (Mr, Shri ...), company suffixes
 *                      (Pvt Ltd = Private Limited), word order, initials (A. Sharma = Amit Sharma), a missing middle name and a
 *                      small spelling difference are all treated as the SAME name
 *
 * A mismatch is only a POTENTIAL mismatch for manual review: nothing here declares fraud. A legitimate change of name
 * (marriage, a company rename) cannot be told apart from a different person by text alone, so it is flagged for review too.
 */
module.exports = {
  mode: 'normalized',
  // minimum similarity (1 - edit distance / length) for two words, or two whole names, to count as a spelling variant
  similarityThreshold: 0.8,
  allowInitials: true,
  allowMissingMiddleNames: true,
  allowReordering: true,
  titles: ['mr', 'mrs', 'ms', 'miss', 'shri', 'sri', 'smt', 'dr', 'prof', 'late'],
  // words that only describe the legal form of a company; two company names with the same core are the same company
  companySuffixWords: ['pvt', 'private', 'ltd', 'limited', 'llp', 'inc', 'corp', 'co'],
};
