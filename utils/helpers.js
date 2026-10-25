'use strict';

const crypto = require('crypto');
const AppError = require('./AppError');

/**
 * Wraps an async route handler so that if it fails, the error is passed to the error middleware with next(err).
 * It makes sure an error in an async handler always ends up in the error middleware, no matter which Express version runs.
 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// A MongoDB ObjectId is exactly 24 hex characters (0-9, a-f).
const OBJECT_ID_RE = /^[a-f\d]{24}$/i;

// Returns true only if the value is a string that looks like a valid ObjectId.
function isObjectId(value) {
  return typeof value === 'string' && OBJECT_ID_RE.test(value);
}

/**
 * Throws a 400 error when the value is not a valid ObjectId, otherwise returns it.
 * Important: this blocks bad ids (and objects like {"$ne": ...} used in NoSQL injection) before they reach a MongoDB query.
 */
function assertObjectId(value, label = 'id') {
  if (!isObjectId(value)) throw AppError.badRequest(`Invalid ${label}.`);
  return value;
}

/**
 * Puts a backslash before special regex characters in the user's text.
 * Important: we escape the text so a user can't inject a regex (for example in the search fields) and can't make a very slow pattern.
 */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Returns a trimmed string, or '' for anything that is not a string. */
function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

// Turns a value (like a ?limit= query param) into an integer between min and max. If it isn't a number, returns the fallback.
function parseIntInRange(value, { min, max, fallback }) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Minimal cookie header parser (we avoid the extra cookie-parser dependency).
 * Reads the raw "Cookie" header ("a=1; b=2") and returns an object like { a: '1', b: '2' }.
 */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  // Callback: handles one "name=value" piece of the header.
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  });
  return out;
}

// Creates a signature for the value with HMAC-SHA256 and the secret.
// Important: it is used to sign the device cookie, so we can tell if someone changed the cookie value (they can't make a valid signature without the secret).
function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

// Compares two strings and returns true if they are equal.
// Important: it uses crypto.timingSafeEqual, which always takes the same time, so an attacker can't guess a signature
// by measuring how fast the comparison fails (timing attack). The length check comes first because timingSafeEqual needs equal lengths.
function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/**
 * Pagination cursor helpers. A cursor is a "bookmark" that remembers where the last page ended.
 * Important: keyset pagination (continue after the last item) is used instead of skip(), so it stays fast with thousands of articles.
 */
// Turns the bookmark object into a short url-safe text that we send to the browser.
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

// Turns the cursor text from the browser back into an object. No cursor = null (first page).
// A broken or fake cursor gives a 400 error.
function decodeCursor(text) {
  if (!text) return null;
  try {
    const obj = JSON.parse(Buffer.from(String(text), 'base64url').toString('utf8'));
    return obj && typeof obj === 'object' ? obj : null;
  } catch {
    throw AppError.badRequest('Invalid cursor.');
  }
}

/** Serializes async work per key, so check-then-write sequences cannot interleave. */
// Map of key -> the last job waiting in line for that key (the "queue" for each key).
const locks = new Map();
// Runs fn only after earlier jobs with the same key have finished. Jobs with different keys don't wait for each other.
// Important: this works as a lock, so two parallel requests can't both pass a check (like a rate limit) before either one saves.
// It only protects a single server process (the Map is in memory).
async function withLock(key, fn) {
  // The job that is currently last in line for this key (or an already-finished promise if nobody is waiting).
  const previous = locks.get(key) || Promise.resolve();
  let release;
  // Our own turn: it finishes when we call release().
  const current = new Promise((resolve) => (release = resolve));
  const tail = previous.then(() => current);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    // Always let the next job go, even if fn threw an error. Clean the Map if nobody queued after us.
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

module.exports = {
  asyncHandler,
  isObjectId,
  assertObjectId,
  escapeRegex,
  str,
  parseIntInRange,
  parseCookies,
  sign,
  timingSafeEqualStr,
  encodeCursor,
  decodeCursor,
  withLock,
};
