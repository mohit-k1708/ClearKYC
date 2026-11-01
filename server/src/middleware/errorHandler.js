/**
 * Central error handling. Every failure leaves the API as:
 *   { error: { code, message, details? } }
 * Stack traces, SQL and identifiers are never sent to the client or logged.
 */
const { Prisma } = require('@prisma/client');
const { AppError } = require('../utils/errors');

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.path} does not exist` } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
  }

  // Malformed JSON in the request body.
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
  }

  // A request the body parser refused (too large, wrong charset ...): the client's mistake, not the server's.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large' } });
  }
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500 && err.expose) {
    return res.status(err.status).json({ error: { code: 'BAD_REQUEST', message: 'The request could not be processed' } });
  }

  // Database unreachable (Prisma connection errors).
  const isDbDown =
    err instanceof Prisma.PrismaClientInitializationError ||
    (err instanceof Prisma.PrismaClientKnownRequestError && ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(err.code));
  if (isDbDown) {
    console.error('[db] connection problem:', err.code || err.name);
    return res.status(503).json({
      error: { code: 'DATABASE_UNAVAILABLE', message: 'The database is currently unavailable. Please try again shortly.' },
    });
  }

  // Log only the error name/code - never the message, which could contain submitted values.
  console.error('[error]', err.name, err.code || '');
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on the server' } });
}

module.exports = { errorHandler, notFoundHandler };
