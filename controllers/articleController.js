'use strict';

const articleService = require('../services/articleService');
const commentService = require('../services/commentService');
const viewService = require('../services/viewService');
const { asyncHandler, assertObjectId } = require('../utils/helpers');
const AppError = require('../utils/AppError');

// GET /articles/:id  - the FULL article is rendered on the server (search-engine friendly, no JS needed).
// Steps: check the id, load the published article and its first comments, count a view, render the EJS page.
// asyncHandler passes any error to the error middleware, so we don't need try/catch everywhere.
exports.articlePage = asyncHandler(async (req, res) => {
  const { id } = req.params;
  // A badly formed id means the page can't exist, so we answer 404 (not a 400 error) for the visitor.
  try {
    assertObjectId(id, 'article id');
  } catch {
    throw AppError.notFound('The article you are looking for does not exist.');
  }
  const article = await articleService.getPublishedArticle(id);
  const comments = await commentService.listForArticle(id);

  // Every page load counts as a view (counted in memory, flushed to MongoDB in batches).
  // Important: batching means one database write for many views, so it stays fast with many readers.
  viewService.record(id, req.deviceId);

  res.render('pages/article', {
    title: `${article.title} - The Daily Web`,
    description: article.summary,
    ogImage: article.image,
    article,
    // split the text on new lines to get paragraphs, and skip empty ones
    paragraphs: article.content.split(/\r?\n+/).filter((p) => p.trim()),
    comments: comments.items,
    commentsCursor: comments.nextCursor,
  });
});

// GET /api/v1/articles/:id  - public JSON
// Returns one published article as JSON (the service only gives the live version, never drafts).
exports.apiGetArticle = asyncHandler(async (req, res) => {
  res.json(await articleService.getPublishedArticle(req.params.id));
});

// POST /api/v1/stats/views  { articleId } - records a view (beacon-style endpoint, public)
// Checks the id, makes sure the article is published, then counts the view. It answers 202 Accepted
// because the view is only queued in memory and saved to the database a bit later.
exports.apiRecordView = asyncHandler(async (req, res) => {
  const articleId = req.body && req.body.articleId;
  assertObjectId(articleId, 'article id');
  await articleService.getPublishedArticle(articleId); // only published articles can be viewed
  viewService.record(articleId, req.deviceId);
  res.status(202).json({ ok: true });
});
