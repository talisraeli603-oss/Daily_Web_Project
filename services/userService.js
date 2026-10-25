'use strict';

const User = require('../models/User');
const Article = require('../models/Article');
const AppError = require('../utils/AppError');
const bus = require('../utils/eventBus');
const { assertObjectId, escapeRegex } = require('../utils/helpers');
const { validateUser } = require('../utils/validators');
const { hashPassword } = require('./authService');
const { ROLES } = require('../config/constants');

// User management (editor only): list, get, create, update, delete.
// Lists users with an optional role filter and a search on username/display name, using normal page numbers.
// Important: the search text is escaped before becoming a regex, so users can't inject regex.
// Results go through toSafeJSON() so the password hash is never sent out.
async function list({ q, role, page, limit }) {
  const filter = {};
  if (role) {
    if (!Object.values(ROLES).includes(role)) throw AppError.badRequest('Unknown role.');
    filter.role = role;
  }
  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ username: re }, { displayName: re }];
  }
  const [total, docs] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter).sort({ role: 1, username: 1 }).skip((page - 1) * limit).limit(limit),
  ]);
  return { items: docs.map((d) => d.toSafeJSON()), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

// Gets one user by id (404 if not found). Returns the safe version without the password hash.
async function getById(id) {
  assertObjectId(id, 'user id');
  const doc = await User.findById(id);
  if (!doc) throw AppError.notFound('User not found.');
  return doc.toSafeJSON();
}

// Creates a new user. The input is validated, the password is hashed with bcrypt (we never store the real password),
// then the user is saved. `actor` is the editor doing it (used for the event/log).
async function create(body, actor) {
  const clean = validateUser(body);
  const passwordHash = await hashPassword(clean.password);
  try {
    const doc = await User.create({
      username: clean.username,
      displayName: clean.displayName,
      role: clean.role,
      passwordHash,
    });
    bus.emit('user:created', { userId: String(doc._id), by: actor.id });
    return doc.toSafeJSON();
  } catch (err) {
    // Important: 11000 is MongoDB's "duplicate key" error from the unique index on username.
    // We rely on the database for this check (not a separate "find first"), so two people can't grab the same name at once.
    if (err && err.code === 11000) throw AppError.conflict('That username is already taken.', { username: 'Already taken.' });
    throw err;
  }
}

// Updates a user (partial: only the fields that were sent are changed). Includes two safety rules, see below.
async function update(id, body, actor) {
  assertObjectId(id, 'user id');
  const clean = validateUser(body, { partial: true });
  const doc = await User.findById(id).select('+passwordHash');
  if (!doc) throw AppError.notFound('User not found.');

  // Important: safety rules - you can't demote the last editor (the system would have nobody to approve articles),
  // and you can't change your own role.
  if (clean.role && clean.role !== doc.role && doc.role === ROLES.EDITOR) {
    const editors = await User.countDocuments({ role: ROLES.EDITOR });
    if (editors <= 1) throw AppError.conflict('There must always be at least one editor.');
  }
  if (clean.role && clean.role !== doc.role && id === actor.id) {
    throw AppError.conflict('You cannot change your own role.');
  }

  // Only copy the fields that were actually sent. A new password is hashed before it is saved.
  if (clean.username) doc.username = clean.username;
  if (clean.displayName) doc.displayName = clean.displayName;
  if (clean.role) doc.role = clean.role;
  if (clean.password) doc.passwordHash = await hashPassword(clean.password);

  try {
    await doc.save();
  } catch (err) {
    // Same as in create(): duplicate username (error 11000) becomes a friendly 409.
    if (err && err.code === 11000) throw AppError.conflict('That username is already taken.', { username: 'Already taken.' });
    throw err;
  }
  bus.emit('user:updated', { userId: id, by: actor.id });
  return doc.toSafeJSON();
}

// Deletes a user. It's refused if: it's your own account, it's the last editor, or the user still owns articles
// (so articles are never left without an author).
async function remove(id, actor) {
  assertObjectId(id, 'user id');
  if (id === actor.id) throw AppError.conflict('You cannot delete your own account.');
  const doc = await User.findById(id);
  if (!doc) throw AppError.notFound('User not found.');

  if (doc.role === ROLES.EDITOR) {
    const editors = await User.countDocuments({ role: ROLES.EDITOR });
    if (editors <= 1) throw AppError.conflict('There must always be at least one editor.');
  }
  const articles = await Article.countDocuments({ author: id });
  if (articles > 0) {
    throw AppError.conflict(`This user still owns ${articles} article(s). Delete or reassign them first.`);
  }
  await doc.deleteOne();
  bus.emit('user:deleted', { userId: id, by: actor.id });
}

module.exports = { list, getById, create, update, remove };
