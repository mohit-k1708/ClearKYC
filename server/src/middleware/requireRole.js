/**
 * Scene 5 authorisation: the acting person must be an ACTIVE user with one of the given roles.
 *
 * PROTOTYPE: there is no login, so the person is the one chosen in the sidebar and sent as the X-Reviewer-Id header (see
 * requireActor.js). It can be spoofed by anyone who can call the API; the role rules are real, the identity is a stand-in.
 *
 *   requireRole('Reviewer', 'Admin')(what)   401 when nobody is chosen, 403 when the role is not allowed
 */
const prisma = require('../utils/prisma');
const { AppError } = require('../utils/errors');
const { ROLE_LABELS } = require('../config/reviewRules');

const requireRole = (roles, what) => async (req, res, next) => {
  try {
    const raw = req.get('x-reviewer-id');
    if (!raw || !/^\d{1,9}$/.test(raw)) throw new AppError(401, 'ACTOR_REQUIRED', `Choose who you are acting as (sidebar) to ${what}`);
    const person = await prisma.reviewer.findUnique({ where: { id: Number(raw) } });
    if (!person || !person.isActive) throw new AppError(401, 'ACTOR_INVALID', 'That person does not exist or is not active');
    if (!roles.includes(person.role)) {
      throw new AppError(403, 'NOT_AUTHORISED', `${person.name} (${ROLE_LABELS[person.role] ?? person.role}) cannot ${what}. This needs a ${roles.map((r) => ROLE_LABELS[r] ?? r).join(' or ')}.`);
    }
    req.reviewer = person;
    next();
  } catch (err) {
    next(err);
  }
};

module.exports = requireRole;
