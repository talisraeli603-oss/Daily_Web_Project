'use strict';

const bcrypt = require('bcrypt');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const bus = require('../utils/eventBus');
const { validateLogin } = require('../utils/validators');

// bcrypt "cost": higher = slower to hash = harder for an attacker to guess passwords. 10 is a common default.
const SALT_ROUNDS = 10;

// Important: a fake hash of a made-up password. If the username doesn't exist we still compare against this,
// so a wrong username takes about the same time as a wrong password (attackers can't tell which usernames exist by timing).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', SALT_ROUNDS);

// Important: simple brute-force protection, kept in memory: max 8 failed logins in 10 minutes per IP + username.
// Trade-off: it resets when the server restarts and isn't shared between several servers (fine for this project).
const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILS = 8;
const fails = new Map(); // key -> [timestamps]

// Returns the failed-attempt times for this key from the last 10 minutes (old ones are dropped and cleaned up).
function recentFails(key) {
  const now = Date.now();
  const list = (fails.get(key) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length) fails.set(key, list);
  else fails.delete(key);
  return list;
}

// Turns a plain password into a bcrypt hash (this is what we store, never the real password).
const hashPassword = (password) => bcrypt.hash(password, SALT_ROUNDS);

/**
 * Checks username + password for login. Returns the safe user object (no password hash) or throws an error.
 * Steps: validate input -> check the rate limit -> find the user -> compare the password -> record success/failure.
 * Important: the same error message ("Incorrect username or password") is used for both cases,
 * so nobody can find out which usernames exist.
 */
async function authenticate(body, ip) {
  const { username, password } = validateLogin(body);
  const key = `${ip}|${username}`;

  if (recentFails(key).length >= MAX_FAILS) {
    throw AppError.tooMany('Too many failed login attempts. Please wait a few minutes and try again.');
  }

  // The passwordHash field is hidden by default in the User model, so we ask for it explicitly here.
  const user = await User.findOne({ username }).select('+passwordHash');
  // Important: dummy bcrypt compare when there is no such user, so the time is the same either way.
  const ok = await bcrypt.compare(password, user ? user.passwordHash : DUMMY_HASH);

  // Failed login: save the time of this attempt, emit an event for logging, and answer 401.
  if (!user || !ok) {
    fails.set(key, [...recentFails(key), Date.now()]);
    bus.emit('auth:login_failed', { username, ip });
    throw new AppError(401, 'Incorrect username or password.');
  }

  // Successful login: forget the earlier failed attempts for this key.
  fails.delete(key);
  bus.emit('auth:login', { userId: String(user._id), role: user.role });
  return user.toSafeJSON();
}

module.exports = { authenticate, hashPassword };
