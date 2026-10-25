'use strict';

const User = require('../models/User');
const AppError = require('../utils/AppError');
const bus = require('../utils/eventBus');
const logger = require('../utils/logger');

/**
 * Runs on every request. Finds who is logged in using the SERVER-SIDE session, and puts the
 * user on req.user (and res.locals.user so the EJS pages can use it). If nobody is logged in, user is null.
 * Important: the role is loaded from the database on every request, never trusted from the browser,
 * so deleting a user or changing a role takes effect immediately.
 */
async function attachUser(req, res, next) {
  req.user = null;
  res.locals.user = null;
  const userId = req.session && req.session.userId;
  if (!userId) return next();
  try {
    // .lean() gives a plain object (faster than a full Mongoose document). The password hash is not
    // included because the field is select:false in the model.
    const user = await User.findById(userId).lean();
    if (user) {
      req.user = { id: String(user._id), username: user.username, displayName: user.displayName, role: user.role };
      res.locals.user = req.user;
    } else {
      // The account no longer exists: drop the session.
      req.session.userId = undefined;
    }
  } catch (err) {
    logger.error('attachUser failed', err);
  }
  next();
}

// Helper: checks if the request is from the API / AJAX (so we answer with JSON) or from a normal
// page visit (so we answer with a page or redirect).
const wantsJson = (req) => req.originalUrl.startsWith('/api/') || req.xhr || (req.get('accept') || '').includes('application/json');

/** Requires a logged-in user. API calls get 401 JSON, page requests are redirected to /login. */
function requireAuth(req, res, next) {
  if (req.user) return next();
  if (wantsJson(req)) return next(AppError.unauthorized());
  return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
}

/** Requires one of the given roles. Enforced on the SERVER, whatever the UI shows.
 *  Important: hiding a button in the page is not security, so this check runs on the server.
 *  It returns a middleware function, so it can be used like requireRole('editor'). */
function requireRole(...roles) {
  // The real middleware: not logged in -> same as requireAuth; wrong role -> log the attempt and send 403.
  return (req, res, next) => {
    if (!req.user) return requireAuth(req, res, next);
    if (!roles.includes(req.user.role)) {
      // Tell the rest of the app (event bus) that someone tried something they are not allowed to do.
      bus.emit('permission:denied', { userId: req.user.id, role: req.user.role, url: req.originalUrl, method: req.method });
      return next(AppError.forbidden());
    }
    return next();
  };
}

module.exports = { attachUser, requireAuth, requireRole, wantsJson };
