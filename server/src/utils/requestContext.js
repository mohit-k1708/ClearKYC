/**
 * Per-request context (AsyncLocalStorage) so the audit trail can learn WHO acted and from WHICH IP address without
 * every service function having to pass the request around. The store holds the Express request; the acting person is
 * read from `req.reviewer` (set by requireActor / requireReviewer / optionalActor) or, if no such middleware ran, from the
 * X-Reviewer-Id header (prototype stand-in for login, see middleware/requireActor.js).
 *
 * Code that runs outside a request (the seed scripts) has no context, so its audit events are attributed to the
 * person passed explicitly, or to "System".
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

/** Express middleware: everything this request does afterwards can see the request context. */
function requestContext(req, res, next) {
  const store = { req, actor: undefined };
  req.auditContext = store;
  storage.run(store, next);
}

/** Re-attaches the context after a library (multer) called `next` from a stream callback that lost it. */
function bindRequestContext(req) {
  if (req.auditContext) storage.enterWith(req.auditContext);
}

const currentContext = () => storage.getStore() ?? null;

/** Client IP as seen by Express (no proxy headers are trusted), without the IPv4-mapped IPv6 prefix. */
function clientIp(req) {
  const raw = req?.ip || req?.socket?.remoteAddress || null;
  return raw ? String(raw).replace(/^::ffff:/, '').slice(0, 64) : null;
}

module.exports = { requestContext, bindRequestContext, currentContext, clientIp };
