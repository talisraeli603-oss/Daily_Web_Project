'use strict';

const Comment = require('../models/Comment');
const Article = require('../models/Article');
const AppError = require('../utils/AppError');
const bus = require('../utils/eventBus');
const { COMMENT_RATE, COMMENTS_PAGE_SIZE } = require('../config/constants');
const { assertObjectId, withLock, escapeRegex, encodeCursor, decodeCursor, isObjectId } = require('../utils/helpers');
const { validateComment, validateCommentUpdate } = require('../utils/validators');

// Query piece: "published" means the live version has a real publish date. Comments are only allowed on these.
const PUBLISHED = { 'live.publishedAt': { $type: 'date' } };

// Gets one page of comments for an article, newest first.
// Important: it uses a "cursor" (the date + id of the last comment seen) instead of page numbers,
// so the list stays correct and fast even when new comments arrive while the reader scrolls.
async function listForArticle(articleId, { cursor, limit = COMMENTS_PAGE_SIZE } = {}) {
  assertObjectId(articleId, 'article id');
  const filter = { article: articleId };
  const c = decodeCursor(cursor);
  if (c) {
    const at = new Date(c.v);
    if (Number.isNaN(at.getTime()) || !isObjectId(c.id)) throw AppError.badRequest('Invalid cursor.');
    // "older than the cursor", and if two comments have the same time, use the id to break the tie
    filter.$or = [{ createdAt: { $lt: at } }, { createdAt: at, _id: { $lt: c.id } }];
  }
  // Ask for one extra comment: if we get it, we know there is a next page.
  const docs = await Comment.find(filter).sort({ createdAt: -1, _id: -1 }).limit(limit + 1);
  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const last = page[page.length - 1];
  return {
    items: page.map((d) => d.toPublicJSON()),
    nextCursor: hasMore && last ? encodeCursor({ v: last.createdAt.toISOString(), id: String(last._id) }) : null,
  };
}

/**
 * Adds a new comment to a published article.
 * Important: the anti-spam limit (3 comments per minute per device, using a signed cookie) is checked
 * on the SERVER, not in the browser. There is also a higher limit per IP address, in case someone
 * deletes the cookie to cheat. The check and the insert run inside a lock, so two requests sent at
 * the same moment can't both pass the check.
 */
async function create(articleId, body, { deviceId, ip }) {
  assertObjectId(articleId, 'article id');
  const data = validateComment(body);

  // Can't comment on an article that is missing or not published yet.
  const exists = await Article.exists({ _id: articleId, ...PUBLISHED });
  if (!exists) throw AppError.notFound('This article does not exist or has not been published.');

  // Only comments newer than this time count toward the limit (the last minute).
  const since = new Date(Date.now() - COMMENT_RATE.WINDOW_MS);

  // Two locks, one for the device and one for the IP. The function inside runs for one request at a time per key.
  return withLock(`comment-device:${deviceId}`, () => withLock(`comment-ip:${ip}`, async () => {
    // Count this device's and this IP's comments from the last minute (both counts run together).
    const [byDevice, byIp] = await Promise.all([
      Comment.countDocuments({ deviceId, createdAt: { $gte: since } }),
      Comment.countDocuments({ ip, createdAt: { $gte: since } }),
    ]);
    // Over the limit: tell the rest of the app (event bus, used for logging) and answer with "too many requests".
    if (byDevice >= COMMENT_RATE.PER_DEVICE || byIp >= COMMENT_RATE.PER_IP) {
      bus.emit('comment:rate_limited', { articleId, deviceId, ip });
      throw AppError.tooMany(`You can post at most ${COMMENT_RATE.PER_DEVICE} comments per minute. Please wait a moment and try again.`);
    }
    const doc = await Comment.create({ article: articleId, ...data, deviceId, ip });
    bus.emit('comment:created', { commentId: String(doc._id), articleId });
    return doc.toPublicJSON();
  }));
}

/** Editor tools: list / search all comments. */
// Lists comments for the editor, with optional filters (one article, or a search word) and page numbers.
// Important: the search word goes through escapeRegex first, so special characters typed by the user
// are treated as plain text and can't break the search.
async function search({ q, article, page, limit }) {
  const filter = {};
  if (article) filter.article = assertObjectId(article, 'article id');
  // Search word is matched (ignoring upper/lower case) in the comment text or in the author name.
  if (q) filter.$or = [{ text: new RegExp(escapeRegex(q), 'i') }, { authorName: new RegExp(escapeRegex(q), 'i') }];
  // Get the total count and the current page together.
  const [total, docs] = await Promise.all([
    Comment.countDocuments(filter),
    Comment.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: 'article', select: 'live.title revision.title' }),
  ]);
  return {
    // Each comment also gets its article id and article title, so the editor can see where it was written.
    items: docs.map((d) => ({
      ...d.toPublicJSON(),
      article: String(d.article && d.article._id ? d.article._id : d.article),
      articleTitle: d.article && (d.article.live?.title || d.article.revision?.title) ? d.article.live?.title || d.article.revision?.title : '(deleted article)',
    })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// Lets an editor change the text of a comment (the text is validated first).
async function update(id, body) {
  assertObjectId(id, 'comment id');
  const { text } = validateCommentUpdate(body);
  const doc = await Comment.findByIdAndUpdate(id, { text }, { returnDocument: 'after', runValidators: true });
  if (!doc) throw AppError.notFound('Comment not found.');
  return doc.toPublicJSON();
}

// Deletes a comment (editor tool) and announces it on the event bus with the id of the editor who did it.
async function remove(id, userId) {
  assertObjectId(id, 'comment id');
  const doc = await Comment.findByIdAndDelete(id);
  if (!doc) throw AppError.notFound('Comment not found.');
  bus.emit('comment:deleted', { commentId: id, editorId: userId });
}

module.exports = { listForArticle, create, search, update, remove };
