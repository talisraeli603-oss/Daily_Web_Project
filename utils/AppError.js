'use strict';

/**
 * Our own error type for "expected" problems (bad input, not logged in, not found...).
 * It carries an HTTP status code, and its message is safe to show to the user.
 * The error handler uses `status` to pick the response code.
 */
class AppError extends Error {
  // Saves the HTTP status, the message, and optional per-field details (like which form field is wrong).
  // `expose = true` marks the message as OK to show to the user.
  constructor(status, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
    this.expose = true;
  }

  // Shortcut for a 400 error: the user sent invalid data.
  static badRequest(message, details) {
    return new AppError(400, message, details);
  }
  // Shortcut for a 401 error: the user is not logged in.
  static unauthorized(message = 'Please log in to continue.') {
    return new AppError(401, message);
  }
  // Shortcut for a 403 error: the user is logged in but is not allowed to do this.
  static forbidden(message = 'You do not have permission to do that.') {
    return new AppError(403, message);
  }
  // Shortcut for a 404 error: the thing was not found.
  static notFound(message = 'Not found.') {
    return new AppError(404, message);
  }
  // Shortcut for a 409 error: the action clashes with the current state (for example a duplicate or a wrong workflow step).
  static conflict(message, details) {
    return new AppError(409, message, details);
  }
  // Shortcut for a 429 error: too many requests (rate limit reached).
  static tooMany(message) {
    return new AppError(429, message);
  }
}

module.exports = AppError;
