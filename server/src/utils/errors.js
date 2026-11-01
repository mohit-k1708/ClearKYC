/**
 * A single error type for "expected" failures. The error-handling middleware turns it
 * into a JSON response: { error: { code, message, details } }.
 */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details; // e.g. { fieldName: "message" } for validation errors
  }
}

const badRequest = (message, details) => new AppError(400, 'VALIDATION_ERROR', message, details);
const notFound = (message) => new AppError(404, 'NOT_FOUND', message);
const conflict = (code, message, details) => new AppError(409, code, message, details);

module.exports = { AppError, badRequest, notFound, conflict };
