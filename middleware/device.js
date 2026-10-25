'use strict';

const crypto = require('crypto');
const config = require('../config/env');
const { DEVICE_COOKIE } = require('../config/constants');
const { parseCookies, sign, timingSafeEqualStr } = require('../utils/helpers');

const ONE_YEAR = 365 * 24 * 60 * 60 * 1000;

/**
 * Middleware that gives every browser a "device id" cookie. The server uses it for the
 * per-device comment limit and for remembering which articles a device has viewed.
 * Important: the cookie is signed (HMAC with the secret), so a visitor can't forge someone else's id.
 * Important: it is httpOnly, so JavaScript in the page can't read it.
 * The id ends up on req.deviceId for the next handlers.
 */
module.exports = function device(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  let id = null;

  const raw = cookies[DEVICE_COOKIE];
  // If the browser already has the cookie, check that the signature matches the id.
  // Important: timingSafeEqualStr compares in constant time, so an attacker can't guess the signature by timing.
  if (raw) {
    const [value, signature] = raw.split('.');
    if (value && signature && timingSafeEqualStr(signature, sign(value, config.sessionSecret))) {
      id = value;
    }
  }

  // No cookie, or a fake one: make a new random id and send it (signed) to the browser for one year.
  // secure only in production (needs https); sameSite 'lax' limits sending it from other sites.
  if (!id) {
    id = crypto.randomUUID();
    res.cookie(DEVICE_COOKIE, `${id}.${sign(id, config.sessionSecret)}`, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.isProduction,
      maxAge: ONE_YEAR,
    });
  }

  req.deviceId = id;
  next();
};
