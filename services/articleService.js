'use strict';

/**
 * Article business logic: the public feed, the staff lists, and every change to an article
 * (create, edit, submit, approve, return, delete).
 * Controllers stay thin and call into here; the workflow rules themselves live in workflowService.
 */
const Article = require('../models/Article');
const Comment = require('../models/Comment');
const ViewStat = require('../models/ViewStat');
const ViewedLog = require('../models/ViewedLog');
const AppError = require('../utils/AppError');
const bus = require('../utils/eventBus');
const { CATEGORIES, STATUS, ROLES } = require('../config/constants');
const { escapeRegex, isObjectId, encodeCursor, decodeCursor, assertObjectId } = require('../utils/helpers');
const { validateDraft, validateForSubmit, CONTENT_FIELDS } = require('../utils/validators');
const { diffWords } = require('../utils/diff');
const workflow = require('./workflowService');
const viewService = require('./viewService');

// Important: "published" means the article has a live version with a real publish date.
// Readers only ever get articles that match this filter.
const PUBLISHED_FILTER = { 'live.publishedAt': { $type: 'date' } };

/* ----------------------------- serializers ----------------------------- */

// Small helper: turns the author field into { id, displayName }. Falls back to "Unknown" if the author was not populated.
const authorOf = (doc) =>
  doc.author && doc.author.displayName ? { id: String(doc.author._id), displayName: doc.author.displayName } : { id: String(doc.author || ''), displayName: 'Unknown' };

// Copies only the content fields (title, summary, etc.) from a version. Missing fields become empty strings.
function pickContent(source) {
  const out = {};
  CONTENT_FIELDS.forEach((f) => (out[f] = (source && source[f]) || ''));
  return out;
}

// Shapes an article for the public feed list. Uses the LIVE version only, and has no full content (keeps the list light).
function toFeedItem(doc) {
  return {
    id: String(doc._id),
    title: doc.live.title,
    summary: doc.live.summary,
    image: doc.live.image,
    category: doc.live.category,
    author: authorOf(doc),
    publishedAt: doc.live.publishedAt,
    viewCount: doc.viewCount || 0,
  };
}

// Shapes one article for the public article page: the feed item plus the full live content.
function toPublicArticle(doc) {
  return { ...toFeedItem(doc), content: doc.live.content };
}

// The status of an article right now. If there is a working copy (revision), its status counts.
// If there is no revision, the article is simply published (the status is not stored for the live version).
const effectiveStatus = (doc) => (doc.revision ? doc.revision.status : STATUS.PUBLISHED);

// Shapes an article for the staff lists (reporter/editor). Shows the working copy if there is one, else the live version.
function toManageItem(doc) {
  const current = doc.revision || doc.live || {};
  return {
    id: String(doc._id),
    title: current.title || '(untitled)',
    category: current.category || '',
    status: effectiveStatus(doc),
    hasLiveVersion: !!doc.live,
    publishedAt: doc.live ? doc.live.publishedAt : null,
    viewCount: doc.viewCount || 0,
    author: authorOf(doc),
    updatedAt: doc.updatedAt,
    editorNote: doc.revision ? doc.revision.editorNote || '' : '',
  };
}

// Shapes the full article for staff: live version, working copy, history, and (if both exist) a word-by-word diff.
function toManageDetail(doc) {
  const live = doc.live ? { ...pickContent(doc.live), publishedAt: doc.live.publishedAt } : null;
  const revision = doc.revision
    ? { ...pickContent(doc.revision), status: doc.revision.status, editorNote: doc.revision.editorNote || '', updatedAt: doc.revision.updatedAt }
    : null;

  const detail = {
    id: String(doc._id),
    status: effectiveStatus(doc),
    author: authorOf(doc),
    viewCount: doc.viewCount || 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    live,
    revision,
    // What the editor/reporter edits: the working copy if there is one, else the live version.
    current: revision || live,
    publishHistory: (doc.publishHistory || []).map((e) => ({ at: e.at, kind: e.kind })),
    // The full back-and-forth between reporter and editor (not only the latest note), oldest first.
    reviewHistory: (doc.reviewHistory || []).map((e) => ({ at: e.at, action: e.action, role: e.role, byName: e.byName || '', note: e.note || '' })),
    diff: null,
  };

  // For an update to a published article: word-level diff of every text field.
  if (live && revision) {
    detail.diff = {};
    // Inner function: runs once per text field and stores "did it change?" plus the word-level differences.
    ['title', 'summary', 'content', 'category', 'image'].forEach((f) => {
      detail.diff[f] = { changed: live[f] !== revision[f], ops: diffWords(live[f], revision[f]) };
    });
  }
  return detail;
}

/* ------------------------------ public feed ----------------------------- */

/**
 * Gets one page of the public feed, with search, category filter, viewed/unviewed filter and sorting.
 * Important: keyset pagination (a cursor) instead of skip(), so page 50 is as fast as page 1
 * and the list doesn't jump around when new articles are published.
 * Each filter is added to the `and` list, and everything is sent to MongoDB in one query.
 */
async function getFeed({ q, category, viewed, sort, cursor, limit, deviceId }) {
  const and = [PUBLISHED_FILTER];

  if (category) {
    if (!CATEGORIES.includes(category)) throw AppError.badRequest('Unknown category.');
    and.push({ 'live.category': category });
  }

  if (q) {
    // Important: we escape the search text before turning it into a regex, so users can't inject regex.
    // 'i' = ignore upper/lower case. Searches the title and the summary.
    const re = new RegExp(escapeRegex(q), 'i');
    and.push({ $or: [{ 'live.title': re }, { 'live.summary': re }] });
  }

  // "Viewed" filter: we look up which articles this device (browser) has opened, then include or exclude them.
  if (viewed === 'viewed' || viewed === 'unviewed') {
    await viewService.flush(); // make sure this device's latest views are in the database
    const ids = await ViewedLog.distinct('article', { deviceId: deviceId || '__none__' });
    and.push({ _id: viewed === 'viewed' ? { $in: ids } : { $nin: ids } });
  } else if (viewed && viewed !== 'all') {
    throw AppError.badRequest('Invalid "viewed" filter.');
  }

  const popular = sort === 'popular';
  if (sort && !['date', 'popular'].includes(sort)) throw AppError.badRequest('Invalid sort.');
  const sortKey = popular ? 'viewCount' : 'live.publishedAt';

  // The cursor remembers the last item of the previous page (its sort value + its id).
  // We validate it, because it comes from the user and could be fake.
  const c = decodeCursor(cursor);
  if (c) {
    const value = popular ? Number(c.v) : new Date(c.v);
    if ((popular && !Number.isFinite(value)) || (!popular && Number.isNaN(value.getTime())) || !isObjectId(c.id)) {
      throw AppError.badRequest('Invalid cursor.');
    }
    // "Give me items after the cursor": either a smaller sort value, or the same value with a smaller _id (tie-breaker).
    and.push({ $or: [{ [sortKey]: { $lt: value } }, { [sortKey]: value, _id: { $lt: c.id } }] });
  }

  // Performance: we leave out the big fields (full content, revision, history) because the list doesn't need them.
  // _id is the second sort key so the order is always the same, even when two articles have the same date/views.
  // We ask for limit + 1 items: the extra one only tells us if there is a next page.
  const docs = await Article.find({ $and: and })
    .select({ 'live.content': 0, revision: 0, publishHistory: 0 })
    .sort({ [sortKey]: -1, _id: -1 })
    .limit(limit + 1)
    .populate('author', 'displayName')
    .lean();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const last = page[page.length - 1];
  // The next cursor is built from the last item on this page. No more pages = null.
  const nextCursor =
    hasMore && last ? encodeCursor({ v: popular ? last.viewCount || 0 : last.live.publishedAt.toISOString(), id: String(last._id) }) : null;

  return { items: page.map(toFeedItem), nextCursor };
}

// Gets one article for a reader. Only works if it is published, otherwise it's a 404 (drafts stay hidden).
async function getPublishedArticle(id) {
  assertObjectId(id, 'article id');
  const doc = await Article.findOne({ _id: id, ...PUBLISHED_FILTER }).populate('author', 'displayName').lean();
  if (!doc) throw AppError.notFound('This article does not exist or has not been published.');
  return toPublicArticle(doc);
}

/* ------------------------------ staff lists ----------------------------- */

// Staff list (reporter/editor) with a status filter, title search and normal page numbers.
// Important: a reporter only ever sees their own articles (the author filter is forced here); an editor sees all.
async function listManage(user, { status, q, page, limit }) {
  const filter = {};
  if (user.role === ROLES.REPORTER) filter.author = user.id;

  // "published" = live and no pending working copy (revision: null).
  if (status === STATUS.PUBLISHED) {
    Object.assign(filter, { revision: null, ...PUBLISHED_FILTER });
  } else if (status === 'live') {
    // anything readers can currently see (used by Impact Analytics), even if an update is pending
    Object.assign(filter, PUBLISHED_FILTER);
  } else if ([STATUS.IN_PREPARATION, STATUS.PENDING, STATUS.RETURNED].includes(status)) {
    filter['revision.status'] = status;
  } else if (status && status !== 'all') {
    throw AppError.badRequest('Unknown status filter.');
  }

  if (q) {
    const re = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ 'revision.title': re }, { 'live.title': re }];
  }

  // The count and the page of results run at the same time (Promise.all), so it's faster than doing them one after the other.
  // Here we use skip/limit (simple page numbers) because staff lists are small, unlike the public feed.
  const [total, docs] = await Promise.all([
    Article.countDocuments(filter),
    Article.find(filter)
      .select({ 'live.content': 0, 'revision.content': 0, publishHistory: 0 })
      .sort({ updatedAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('author', 'displayName')
      .lean(),
  ]);

  return { items: docs.map(toManageItem), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

// Loads an article for a staff member and checks permission.
// Important: a reporter who doesn't own the article gets 403 (and we emit an event so it can be logged).
// Editors can open any article. Returns the full mongoose document (so it can be saved later) and whether the user owns it.
async function loadForStaff(user, id) {
  assertObjectId(id, 'article id');
  const doc = await Article.findById(id).populate('author', 'displayName');
  if (!doc) throw AppError.notFound('Article not found.');
  const isOwner = String(doc.author._id || doc.author) === user.id;
  if (user.role === ROLES.REPORTER && !isOwner) {
    bus.emit('permission:denied', { userId: user.id, articleId: id, reason: 'not owner' });
    throw AppError.forbidden('You can only access your own articles.');
  }
  return { doc, isOwner };
}

// Gets the full article for the staff page (after the permission check in loadForStaff).
async function getManageArticle(user, id) {
  const { doc } = await loadForStaff(user, id);
  return toManageDetail(doc);
}

/* ------------------------------- mutations ------------------------------ */

// Creates a new article. Only reporters can. It starts as a working copy ("revision") in_preparation,
// and has no live version yet, so readers can't see it.
async function createArticle(user, body) {
  if (user.role !== ROLES.REPORTER) throw AppError.forbidden('Only reporters create articles.');
  const clean = validateDraft(body || {});
  const doc = await Article.create({
    author: user.id,
    revision: { ...clean, status: STATUS.IN_PREPARATION, updatedAt: new Date() },
  });
  bus.emit('article:created', { articleId: String(doc._id), userId: user.id });
  await doc.populate('author', 'displayName');
  return toManageDetail(doc);
}

/**
 * Autosave / edit. Saves the text into the working copy. It never changes the status
 * (except when editing a published article: then a new working copy is created).
 * Important: the article keeps two versions - 'live' (what readers see) and 'revision' (the working copy) -
 * so editing a published article never hides it.
 * Important: doc.save() uses optimistic concurrency (set in the Article model), so if two people save at the
 * same time one of them gets a 409 error instead of overwriting the other.
 */
async function saveRevision(user, id, body) {
  const clean = validateDraft(body);
  const { doc, isOwner } = await loadForStaff(user, id);
  const actor = { role: user.role, isOwner };

  // Ask the workflow rules if this user may edit the article in its current state.
  const rule = workflow.canEditContent(effectiveStatus(doc), actor);
  if (!rule.allowed) throw new AppError(rule.httpStatus, rule.reason);

  if (rule.createsRevision) {
    // The public keeps seeing doc.live; the changes go into a separate working copy.
    doc.revision = { ...pickContent(doc.live), status: STATUS.IN_PREPARATION, editorNote: '' };
    bus.emit('article:revision_started', { articleId: String(doc._id), userId: user.id });
  }

  Object.assign(doc.revision, clean);
  doc.revision.updatedAt = new Date();
  await doc.save();
  return toManageDetail(doc);
}

// Adds one entry to the article's review history (who did what, when, and the note if there is one).
// Only the newest 200 entries are kept, so an article can never grow without limit.
function logReview(doc, user, action, note) {
  doc.reviewHistory.push({ at: new Date(), by: user.id, byName: user.displayName || user.username || '', role: user.role, action, note: note || '' });
  if (doc.reviewHistory.length > 200) doc.reviewHistory = doc.reviewHistory.slice(-200);
}

// Checks with workflowService if the action (submit/approve/return) is allowed right now.
// If it isn't, we emit an event and throw an error (403/409). If it is, we return the new status.
// Note: this function only checks; the caller changes the document.
function applyTransition(doc, action, user, isOwner) {
  const result = workflow.transition(effectiveStatus(doc), action, { role: user.role, isOwner, hasLive: !!doc.live });
  if (!result.ok) {
    bus.emit('workflow:invalid_transition', { articleId: String(doc._id), action, userId: user.id, from: effectiveStatus(doc) });
    throw new AppError(result.httpStatus, result.reason);
  }
  return result.to;
}

// Reporter sends the article to the editor: in_preparation/returned -> pending_approval.
// The content is checked more strictly here than for a simple draft save (all fields must be filled in).
// It also clears the old editor note.
async function submitArticle(user, id) {
  const { doc, isOwner } = await loadForStaff(user, id);
  applyTransition(doc, workflow.ACTIONS.SUBMIT, user, isOwner);
  validateForSubmit(pickContent(doc.revision));
  doc.revision.status = STATUS.PENDING;
  doc.revision.editorNote = '';
  doc.revision.updatedAt = new Date();
  logReview(doc, user, 'submitted');
  await doc.save();
  bus.emit('article:submitted', { articleId: String(doc._id), userId: user.id });
  return toManageDetail(doc);
}

/**
 * Editor approves: the working copy becomes the new live version (readers now see it),
 * and the working copy is removed. Works for a first publish and for an update of a published article.
 * Important: the history records every approval ('initial' or 'update'), but publishedAt stays the first publish date.
 */
async function approveArticle(user, id) {
  const { doc, isOwner } = await loadForStaff(user, id);
  applyTransition(doc, workflow.ACTIONS.APPROVE, user, isOwner);
  const content = pickContent(doc.revision);
  validateForSubmit(content);

  const now = new Date();
  const kind = doc.live ? 'update' : 'initial';
  doc.live = { ...content, publishedAt: kind === 'initial' ? now : doc.live.publishedAt };
  // publishedAt = first publication time (the date readers see); the history keeps every approval.
  doc.publishHistory.push({ at: now, by: user.id, kind });
  logReview(doc, user, 'approved');
  doc.revision = undefined;
  await doc.save();
  bus.emit('article:published', { articleId: String(doc._id), editorId: user.id, kind });
  return toManageDetail(doc);
}

// Editor sends the article back to the reporter with a required note (max 1000 characters): pending_approval -> returned.
// If it was an update of a published article, the live version stays visible to readers.
async function returnArticle(user, id, note) {
  const text = typeof note === 'string' ? note.trim() : '';
  if (!text) throw AppError.badRequest('Please explain which corrections are needed.', { note: 'A note is required.' });
  if (text.length > 1000) throw AppError.badRequest('The note is too long.', { note: 'Limited to 1000 characters.' });

  const { doc, isOwner } = await loadForStaff(user, id);
  applyTransition(doc, workflow.ACTIONS.RETURN, user, isOwner);
  doc.revision.status = STATUS.RETURNED;
  doc.revision.editorNote = text;
  doc.revision.updatedAt = new Date();
  logReview(doc, user, 'returned', text);
  await doc.save();
  bus.emit('article:returned', { articleId: String(doc._id), editorId: user.id });
  return toManageDetail(doc);
}

// Editor deletes an article and everything linked to it (comments, view counters, viewed log).
// Only editors can. We flush the pending view counts first so no stray counters appear after the delete.
async function deleteArticle(user, id) {
  if (!workflow.canDelete({ role: user.role })) throw AppError.forbidden('Only an editor can delete articles.');
  assertObjectId(id, 'article id');
  await viewService.flush(); // avoid orphan counters arriving after the delete
  const doc = await Article.findByIdAndDelete(id);
  if (!doc) throw AppError.notFound('Article not found.');
  await Promise.all([
    Comment.deleteMany({ article: id }),
    ViewStat.deleteMany({ article: id }),
    ViewedLog.deleteMany({ article: id }),
  ]);
  bus.emit('article:deleted', { articleId: id, editorId: user.id });
}

module.exports = {
  getFeed,
  getPublishedArticle,
  listManage,
  getManageArticle,
  createArticle,
  saveRevision,
  submitArticle,
  approveArticle,
  returnArticle,
  deleteArticle,
};
