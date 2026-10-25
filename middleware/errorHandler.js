'use strict';

const mongoose = require('mongoose');
const config = require('../config/env');
const logger = require('../utils/logger');
const AppError = require('../utils/AppError');
const { wantsJson } = require('./auth');

/** Converts any thrown error into a safe AppError. Unknown errors become a generic 500.
 *  It maps known errors (validation, version conflict, bad id, duplicate key, bad JSON, too big)
 *  to the right HTTP status. Returns null if the error is not one we know. */
function normalize(err) {
  if (err instanceof AppError) return err;

  if (err instanceof mongoose.Error.ValidationError) {
    const details = Object.fromEntries(Object.entries(err.errors).map(([k, v]) => [k, v.message]));
    return AppError.badRequest('Some of the submitted data is not valid.', details);
  }
  // VersionError comes from optimisticConcurrency: someone else saved the article first -> 409 conflict.
  if (err instanceof mongoose.Error.VersionError) {
    return AppError.conflict('This article was changed by someone else just now. Please reload and try again.');
  }
  // CastError: e.g. a bad id that is not a real ObjectId. 11000 is MongoDB's "duplicate key" code (unique index).
  if (err instanceof mongoose.Error.CastError) return AppError.badRequest(`Invalid value for "${err.path}".`);
  if (err && err.code === 11000) return AppError.conflict('A record with the same unique value already exists.');
  if (err && err.type === 'entity.parse.failed') {
    return AppError.badRequest('The request body is not valid JSON.');
  }
  if (err && err.type === 'entity.too.large') return new AppError(413, 'The request is too large.');
  return null;
}

// The main error middleware (Express knows it is an error handler because it has 4 parameters).
// Every error in the app ends up here. It answers with JSON for the API or an error page for browsers.
// Important: unknown errors only show a generic message to the user; the details go to the log only.
// The stack trace is shown on the page only when not in production.
// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const known = normalize(err);
  const status = known ? known.status : 500;
  const message = known ? known.message : 'Something went wrong on our side. Please try again.';

  if (status >= 500 && !known) {
    // a real bug: keep the full stack trace
    logger.error(`${req.method} ${req.originalUrl} -> ${status}`, err);
  } else if (status >= 500) {
    // an expected failure (e.g. the weather service is unavailable): no stack trace needed
    logger.warn(`${req.method} ${req.originalUrl} -> ${status}: ${message}`);
  } else if (status !== 404) {
    logger.warn(`${req.method} ${req.originalUrl} -> ${status}: ${message}`);
  }

  if (wantsJson(req)) {
    return res.status(status).json({
      error: { status, message, details: known ? known.details : undefined },
    });
  }

  return res.status(status).render('errors/error', {
    title: status === 404 ? 'Page not found' : 'Error',
    status,
    message,
    stack: !config.isProduction && status >= 500 && err ? err.stack : null,
  });
};

// Used when no route matched: it creates a 404 error and passes it on to the error handler above.
module.exports.notFound = function notFound(req, res, next) {
  next(AppError.notFound(wantsJson(req) ? 'Endpoint not found.' : 'The page you are looking for does not exist.'));
};
