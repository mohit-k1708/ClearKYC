/**
 * PostgreSQL text cannot contain the NUL character (U+0000): a search box or JSON field holding one used to reach the database
 * and come back as a 500 error. It is refused here, at the door, with a clear 400.
 */
const NUL = /\u0000/;

function hasNul(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return false;
  if (typeof value === 'string') return NUL.test(value);
  if (Array.isArray(value)) return value.some((v) => hasNul(v, depth + 1));
  if (typeof value === 'object') return Object.entries(value).some(([k, v]) => NUL.test(k) || hasNul(v, depth + 1));
  return false;
}

function rejectNulCharacters(req, res, next) {
  let decodedUrl = req.originalUrl;
  try { decodedUrl = decodeURIComponent(req.originalUrl); } catch { /* an undecodable URL is handled by the route */ }
  if (NUL.test(decodedUrl) || hasNul(req.query) || hasNul(req.body)) {
    return res.status(400).json({ error: { code: 'INVALID_CHARACTERS', message: 'The request contains a character that is not allowed (a NUL / control character).' } });
  }
  return next();
}

module.exports = { rejectNulCharacters, hasNul };
