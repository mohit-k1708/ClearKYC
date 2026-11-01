/**
 * Masking helpers. API responses and logs must only ever contain masked identifiers.
 */

/** ABCDE1234F -> XXXXXX234F (only the last 4 characters are shown) */
function maskPan(pan) {
  if (!pan) return null;
  return `${'X'.repeat(Math.max(pan.length - 4, 0))}${pan.slice(-4)}`;
}

/** 123456789012 -> XXXX XXXX 9012 */
function maskAadhaar(aadhaar) {
  if (!aadhaar) return null;
  return `XXXX XXXX ${aadhaar.slice(-4)}`;
}

/** SYN-PAN-483920 -> XXXXXXXXXXX3920 (only the last 4 characters are shown) */
function maskDocumentNumber(value) {
  if (!value) return null;
  return `${'X'.repeat(Math.max(value.length - 4, 0))}${value.slice(-4)}`;
}

module.exports = { maskPan, maskAadhaar, maskDocumentNumber };
