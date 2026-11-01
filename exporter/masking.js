/**
 * Sensitive columns are never exported as stored. Everything in the database is synthetic, but identifiers keep the shape of real
 * ones, so they are masked or replaced the same way the application masks them:
 *
 *   PAN, Aadhaar, document numbers   encrypted in the database -> masked (only the last four characters survive)
 *   keyed hashes (pan_hash ...)      a keyed HMAC of the identifier -> replaced by a SHA-256 fingerprint of the hash: equality is
 *                                    kept (two records with the same number still have the same fingerprint, so duplicates and
 *                                    document reuse stay detectable) but the keyed value is not published
 *   owner date of birth              encrypted -> birth YEAR only
 *
 * The column names are unchanged, so the exported SQL loads into the exported schema.
 */
const crypto = require('crypto');
const { maskPan, maskAadhaar, maskDocumentNumber } = require('../server/src/utils/mask');

function decryptOrNull(value) {
  if (value === null || value === undefined) return null;
  try {
    return require('../server/src/utils/crypto').decrypt(value);
  } catch {
    return null; // other keys: the value cannot be read, so it is replaced by a generic mask
  }
}

const fingerprint = (hash) => (hash === null || hash === undefined ? null : crypto.createHash('sha256').update(String(hash)).digest('hex').slice(0, 24));
const masked = (value, fn, generic) => (value === null || value === undefined ? null : fn(decryptOrNull(value) ?? generic) ?? generic);

/** table -> column -> function(value, row) */
const MASKS = {
  Customer: {
    pan_number: (v) => masked(v, maskPan, 'XXXXXXXXXX'),
    aadhaar_number: (v) => masked(v, maskAadhaar, 'XXXX XXXX XXXX'),
    pan_hash: fingerprint,
    aadhaar_hash: fingerprint,
  },
  Document: {
    document_number: (v) => masked(v, maskDocumentNumber, 'XXXXXXXXXXXX'),
    document_number_hash: fingerprint,
  },
  BeneficialOwner: {
    date_of_birth: (v) => {
      const plain = decryptOrNull(v);
      return v === null ? null : plain ? String(plain).slice(0, 4) : 'XXXX';
    },
    identity_hash: fingerprint,
  },
};

function maskRow(table, row) {
  const rules = MASKS[table];
  if (!rules) return row;
  const out = { ...row };
  for (const [column, fn] of Object.entries(rules)) if (column in out) out[column] = fn(out[column], row);
  return out;
}

const maskedColumns = (table) => Object.keys(MASKS[table] || {});

module.exports = { maskRow, maskedColumns, fingerprint, MASKS };
