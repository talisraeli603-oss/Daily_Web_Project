'use strict';

/** JSON API for the reporter workspace and the editor area (all routes require login + role checks). */
const articleService = require('../services/articleService');
const { asyncHandler, str, parseIntInRange } = require('../utils/helpers');
const { MANAGE_PAGE_SIZE } = require('../config/constants');

// GET /manage/articles - list of articles for the logged-in staff user, with status filter, search and paging.
// req.user is passed so the service can limit what a reporter sees (the rules live in the service, not here).
exports.list = asyncHandler(async (req, res) => {
  res.json(
    await articleService.listManage(req.user, {
      status: str(req.query.status),
      q: str(req.query.q).slice(0, 100),
      page: parseIntInRange(req.query.page, { min: 1, max: 100000, fallback: 1 }),
      limit: parseIntInRange(req.query.limit, { min: 1, max: 100, fallback: MANAGE_PAGE_SIZE }),
    })
  );
});

// GET /manage/articles/:id - one article for editing or reviewing (the service checks the user may see it).
exports.get = asyncHandler(async (req, res) => {
  res.json(await articleService.getManageArticle(req.user, req.params.id));
});

// POST /manage/articles - a reporter creates a new article (starts as a draft). Answers 201 Created.
exports.create = asyncHandler(async (req, res) => {
  res.status(201).json(await articleService.createArticle(req.user, req.body));
});

// PUT /manage/articles/:id/revision - saves the working copy (revision). The live version readers see is not touched.
exports.saveRevision = asyncHandler(async (req, res) => {
  res.json(await articleService.saveRevision(req.user, req.params.id, req.body));
});

// POST /manage/articles/:id/submit - the reporter sends the article to the editor for approval.
exports.submit = asyncHandler(async (req, res) => {
  res.json(await articleService.submitArticle(req.user, req.params.id));
});

// POST /manage/articles/:id/approve - the editor approves it, so the revision becomes the live version.
exports.approve = asyncHandler(async (req, res) => {
  res.json(await articleService.approveArticle(req.user, req.params.id));
});

// POST /manage/articles/:id/return - the editor sends it back to the reporter with a note about what to fix.
exports.returnForCorrections = asyncHandler(async (req, res) => {
  res.json(await articleService.returnArticle(req.user, req.params.id, req.body && req.body.note));
});

// DELETE /manage/articles/:id - the editor deletes an article. Answers 204 No Content.
exports.remove = asyncHandler(async (req, res) => {
  await articleService.deleteArticle(req.user, req.params.id);
  res.status(204).end();
});
