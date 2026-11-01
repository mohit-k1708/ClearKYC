/**
 * Authorisation for verification decisions.
 *
 * PROTOTYPE: there is no login, so the acting person is identified by an "X-Reviewer-Id" header
 * that the frontend sends after the analyst picks a reviewer in the sidebar. This is a stand-in for
 * real authentication: anyone who can call the API could send any id. The rules that matter are
 * still enforced here and again in the database (a trigger rejects decisions from anyone who is not
 * an active Reviewer or Admin), so the check cannot be skipped by calling the service directly.
 */
const prisma = require('../utils/prisma');
const { AppError } = require('../utils/errors');
const { AUTHORISED_ROLES } = require('../config/kycRules');

async function requireReviewer(req, res, next) {
  try {
    const raw = req.get('x-reviewer-id');
    if (!raw || !/^\d{1,9}$/.test(raw)) {
      throw new AppError(401, 'REVIEWER_REQUIRED', 'Choose the reviewer you are acting as before recording a decision');
    }
    const reviewer = await prisma.reviewer.findUnique({ where: { id: Number(raw) } });
    if (!reviewer || !reviewer.isActive) {
      throw new AppError(401, 'REVIEWER_INVALID', 'That reviewer does not exist or is not active');
    }
    if (!AUTHORISED_ROLES.includes(reviewer.role)) {
      throw new AppError(403, 'NOT_AUTHORISED', `${reviewer.name} (${reviewer.role}) is not authorised to record decisions (document verification, owner screening, risk assessments). Only ${AUTHORISED_ROLES.join(' or ')} users can.`);
    }
    req.reviewer = reviewer;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = requireReviewer;
