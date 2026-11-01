/**
 * Reads WHO is acting (the X-Reviewer-Id header) without requiring it. Used on read endpoints so the response can
 * say which actions this person may take. A missing or invalid header simply means "nobody": the request continues.
 * (Changes are protected by requireActor / requireReviewer, which do require a valid person.)
 */
const prisma = require('../utils/prisma');

async function optionalActor(req, res, next) {
  try {
    const raw = req.get('x-reviewer-id');
    if (raw && /^\d{1,9}$/.test(raw)) {
      const person = await prisma.reviewer.findUnique({ where: { id: Number(raw) } });
      if (person && person.isActive) req.reviewer = person;
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = optionalActor;
