'use strict';

/**
 * Server-side input validation. Every function either returns clean data or throws a 400 AppError
 * with per-field messages. (The client validates too, but the server never trusts it.)
 */
const { CATEGORIES, LIMITS } = require('../config/constants');
const AppError = require('./AppError');

// The article fields a reporter can edit (they are copied into the draft / revision).
const CONTENT_FIELDS = ['title', 'summary', 'content', 'image', 'category'];

// True if the text is a valid web address that starts with http: or https:.
// Important: other schemes like javascript: are rejected, so nobody can sneak a script in as an image address.
const isHttpUrl = (value) => {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Images may be an http(s) URL or a site-relative path such as /placeholder/...
 * The regex only allows a leading "/" followed by safe path characters (letters, digits and a few symbols).
 */
const isValidImage = (value) => isHttpUrl(value) || /^\/[A-Za-z0-9/_\-.?=&%]*$/.test(value);

// If the errors object has at least one field problem, throw a 400 error that carries all the field messages.
// This way we collect all problems first and report them together.
function fail(errors) {
  if (Object.keys(errors).length) throw AppError.badRequest('Some of the submitted data is not valid.', errors);
}

// Makes sure the request body is a normal object (not missing, not an array, not a string). Otherwise a 400 error.
function requireObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw AppError.badRequest('A JSON object body is required.');
  }
  return body;
}

/**
 * Autosave / draft validation: only the fields that are present are checked,
 * and empty values are allowed (the reporter is still writing).
 */
function validateDraft(body) {
  requireObject(body);
  const errors = {};
  const clean = {};

  // Callback: for each article field that was sent, check it is text and trim the spaces.
  // Important: only the known fields are copied into `clean`, so extra fields a user adds are ignored.
  CONTENT_FIELDS.forEach((field) => {
    if (body[field] === undefined) return;
    if (typeof body[field] !== 'string') {
      errors[field] = `${field} must be text.`;
      return;
    }
    clean[field] = body[field].trim();
  });

  if (clean.title !== undefined && clean.title.length > LIMITS.TITLE) errors.title = `Title is limited to ${LIMITS.TITLE} characters.`;
  if (clean.summary !== undefined && clean.summary.length > LIMITS.SUMMARY) errors.summary = `Summary is limited to ${LIMITS.SUMMARY} characters.`;
  if (clean.content !== undefined && clean.content.length > LIMITS.CONTENT) errors.content = `Content is limited to ${LIMITS.CONTENT} characters.`;
  if (clean.image) {
    if (clean.image.length > LIMITS.IMAGE) errors.image = 'Image address is too long.';
    else if (!isValidImage(clean.image)) errors.image = 'Image must be an http(s) address.';
  }
  if (clean.category && !CATEGORIES.includes(clean.category)) errors.category = 'Unknown category.';

  fail(errors);
  return clean;
}

/** Stricter check used when the reporter submits the article for approval. */
function validateForSubmit(content) {
  const errors = {};
  if (!content.title) errors.title = 'A title is required.';
  if (!content.summary) errors.summary = 'A summary is required.';
  if (!content.content || content.content.length < 20) errors.content = 'The article content must be at least 20 characters.';
  if (!content.category) errors.category = 'Choose a category.';
  if (!content.image) errors.image = 'A main image address is required.';
  if (Object.keys(errors).length) {
    throw AppError.badRequest('The article is not complete yet.', errors);
  }
}

// Checks a new public comment: name and text must exist and not be too long. Returns the trimmed values.
function validateComment(body) {
  requireObject(body);
  const errors = {};
  const authorName = typeof body.authorName === 'string' ? body.authorName.trim() : '';
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!authorName) errors.authorName = 'Please enter your name.';
  else if (authorName.length > LIMITS.COMMENT_NAME) errors.authorName = `Name is limited to ${LIMITS.COMMENT_NAME} characters.`;
  if (!text) errors.text = 'Please write a comment.';
  else if (text.length > LIMITS.COMMENT) errors.text = `Comment is limited to ${LIMITS.COMMENT} characters.`;
  fail(errors);
  return { authorName, text };
}

// Checks an edited comment: only the text can change, and it must not be empty or too long.
function validateCommentUpdate(body) {
  requireObject(body);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (!text) throw AppError.badRequest('Comment text is required.', { text: 'Please write a comment.' });
  if (text.length > LIMITS.COMMENT) throw AppError.badRequest('Comment is too long.', { text: `Limited to ${LIMITS.COMMENT} characters.` });
  return { text };
}

// Checks the login form. The username is lowercased and trimmed, the password is kept exactly as typed.
// Important: the length limits stop huge inputs, and the check only accepts strings (not objects), which helps against NoSQL injection.
// The error message is generic on purpose, it doesn't say which part was wrong.
function validateLogin(body) {
  requireObject(body);
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!username || !password) throw AppError.badRequest('Please enter a username and a password.');
  if (username.length > 100 || password.length > 200) throw AppError.badRequest('Invalid credentials.');
  return { username, password };
}

// Checks the data when a user account is created or edited (username, display name, role, password).
// When partial is true (editing an existing user), only the fields that were sent are checked,
// and an empty password means "keep the old password".
function validateUser(body, { partial = false } = {}) {
  requireObject(body);
  const errors = {};
  const clean = {};

  if (!partial || body.username !== undefined) {
    const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
    // Regex: username may only have lowercase letters, digits, dot, underscore and dash.
    if (!/^[a-z0-9._-]+$/.test(username) || username.length < LIMITS.USERNAME_MIN || username.length > LIMITS.USERNAME_MAX) {
      errors.username = `Username: ${LIMITS.USERNAME_MIN}-${LIMITS.USERNAME_MAX} characters (letters, digits, . _ -).`;
    } else clean.username = username;
  }
  if (!partial || body.displayName !== undefined) {
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!displayName || displayName.length > 60) errors.displayName = 'Display name is required (max 60 characters).';
    else clean.displayName = displayName;
  }
  if (!partial || body.role !== undefined) {
    if (!['reporter', 'editor'].includes(body.role)) errors.role = 'Role must be reporter or editor.';
    else clean.role = body.role;
  }
  if (!partial || (body.password !== undefined && body.password !== '')) {
    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < LIMITS.PASSWORD_MIN || password.length > LIMITS.PASSWORD_MAX) {
      errors.password = `Password must be ${LIMITS.PASSWORD_MIN}-${LIMITS.PASSWORD_MAX} characters.`;
    } else clean.password = password;
  }

  fail(errors);
  return clean;
}

module.exports = {
  CONTENT_FIELDS,
  validateDraft,
  validateForSubmit,
  validateComment,
  validateCommentUpdate,
  validateLogin,
  validateUser,
  isValidImage,
};
