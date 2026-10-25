'use strict';

const authService = require('../services/authService');
const bus = require('../utils/eventBus');
const { asyncHandler, str } = require('../utils/helpers');
const { ROLES } = require('../config/constants');

/** Only allow redirects to local paths (prevents open-redirect attacks).
 *  Important: the "next" address comes from the user, so we only accept paths that start with a single "/"
 *  (not "//other-site.com"). Otherwise we use the fallback. */
const safeNext = (value, fallback) => (typeof value === 'string' && /^\/(?!\/)[^\\]*$/.test(value) ? value : fallback);

// Where to send a user after login: editors go to /editor, reporters go to /workspace.
const homeFor = (user) => (user.role === ROLES.EDITOR ? '/editor' : '/workspace');

/** Replaces the session id on login (prevents session fixation) and stores ONLY the user id.
 *  Important: regenerate gives a brand new session id at login, so an old id an attacker may know is useless.
 *  The role is NOT stored in the session; it is loaded from the database on each request.
 *  It is wrapped in a Promise so we can use await with the callback-style session functions. */
function startSession(req, user) {
  return new Promise((resolve, reject) => {
    // Callback: runs when the new session is ready; then we save the user id and wait for the save to finish.
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = user.id;
      req.session.save((saveErr) => (saveErr ? reject(saveErr) : resolve()));
    });
  });
}

// GET /login - shows the login form. If the user is already logged in, send them to their home page.
exports.loginPage = (req, res) => {
  if (req.user) return res.redirect(homeFor(req.user));
  return res.render('pages/login', { title: 'Staff login', error: null, username: '', next: safeNext(req.query.next, '') });
};

// Classic form POST (works without JavaScript)
// Checks the username/password in the service (bcrypt compare + failed-attempt limit), starts the session
// and redirects. If the login fails with a message meant for the user, the login page is shown again with that error.
exports.loginSubmit = asyncHandler(async (req, res) => {
  try {
    const user = await authService.authenticate(req.body, req.ip);
    await startSession(req, user);
    return res.redirect(safeNext(req.body.next, homeFor(user)) || homeFor(user));
  } catch (err) {
    // Only errors marked "expose" are safe to show. Anything else is a real problem and goes to the error handler.
    if (!err.expose) throw err;
    return res.status(err.status).render('pages/login', {
      title: 'Staff login',
      error: err.message,
      username: str(req.body && req.body.username),
      next: safeNext(req.body && req.body.next, ''),
    });
  }
});

// Logs out: destroys the session on the server, deletes the session cookie, and tells the app (event bus).
// Answers JSON for the API, or redirects to the home page for a normal form.
exports.logout = asyncHandler(async (req, res) => {
  const userId = req.user && req.user.id;
  await new Promise((resolve) => req.session.destroy(() => resolve()));
  res.clearCookie('dw.sid');
  if (userId) bus.emit('auth:logout', { userId });
  if (req.originalUrl.startsWith('/api/')) return res.json({ ok: true });
  return res.redirect('/');
});

/* ---- JSON API ---- */
// POST /api/v1/auth/login - same login check as the form, but answers with JSON (user + where to go next).
exports.apiLogin = asyncHandler(async (req, res) => {
  const user = await authService.authenticate(req.body, req.ip);
  await startSession(req, user);
  res.json({ user, redirect: homeFor(user) });
});

// GET /api/v1/auth/me - returns the current user (or null if not logged in), taken from req.user.
exports.apiMe = (req, res) => res.json({ user: req.user });
