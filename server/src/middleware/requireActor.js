/**
 * Identifies WHO is making a sensitive change (Scene 3).
 *
 * PROTOTYPE: there is no login, so the acting person is the one chosen in the sidebar and sent as the
 * X-Reviewer-Id header (see requireReviewer.js). This is a stand-in for real authentication and can be
 * spoofed by anyone who can call the API.
 *
 *   requireActor    any ACTIVE person (Analyst, Reviewer or Admin): ownership data entry
 *   requireReviewer (existing) only Reviewer or Admin: screening outcomes and risk assessments
 */
const prisma = require('../utils/prisma');
const { AppError } = require('../utils/errors');

async function requireActor(req, res, next) {
  try {
    const raw = req.get('x-reviewer-id');
    if (!raw || !/^\d{1,9}$/.test(raw)) {
      throw new AppError(401, 'ACTOR_REQUIRED', 'Choose who you are acting as (sidebar) before changing ownership information');
    }
    const person = await prisma.reviewer.findUnique({ where: { id: Number(raw) } });
    if (!person || !person.isActive) {
      throw new AppError(401, 'ACTOR_INVALID', 'That person does not exist or is not active');
    }
    req.reviewer = person;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireActor;
