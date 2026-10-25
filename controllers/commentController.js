'use strict';

const commentService = require('../services/commentService');
const { asyncHandler, str, parseIntInRange } = require('../utils/helpers');

// GET /articles/:id/comments (public) - one page of comments for an article, newest first.
// The cursor says where the previous page ended (cursor pagination, so pages stay correct when new comments arrive).
exports.list = asyncHandler(async (req, res) => {
  res.json(await commentService.listForArticle(req.params.id, { cursor: str(req.query.cursor) }));
});

// POST /articles/:id/comments (public) - adds a comment. The device id and IP are passed so the service
// can apply the spam limit. Important: the limit is checked on the server, not in the browser. Answers 201 Created.
exports.create = asyncHandler(async (req, res) => {
  const comment = await commentService.create(req.params.id, req.body, { deviceId: req.deviceId, ip: req.ip });
  res.status(201).json(comment);
});

/* ---- editor only ---- */
// GET /comments - the editor searches comments by text and/or article, with page numbers.
// The search text is cut to 100 characters and page/limit are forced into safe ranges.
exports.search = asyncHandler(async (req, res) => {
  res.json(
    await commentService.search({
      q: str(req.query.q).slice(0, 100),
      article: str(req.query.article),
      page: parseIntInRange(req.query.page, { min: 1, max: 100000, fallback: 1 }),
      limit: parseIntInRange(req.query.limit, { min: 1, max: 100, fallback: 20 }),
    })
  );
});

// PUT /comments/:id - the editor edits the text of a comment.
exports.update = asyncHandler(async (req, res) => {
  res.json(await commentService.update(req.params.id, req.body));
});

// DELETE /comments/:id - the editor deletes a comment. Answers 204 No Content (success, nothing to send back).
exports.remove = asyncHandler(async (req, res) => {
  await commentService.remove(req.params.id, req.user.id);
  res.status(204).end();
});
