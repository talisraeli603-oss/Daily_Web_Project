'use strict';

const userService = require('../services/userService');
const { asyncHandler, str, parseIntInRange } = require('../utils/helpers');

// GET /users (editor) - list of users with search by text, filter by role and page numbers.
// The service returns users without the password hash (toSafeJSON).
exports.list = asyncHandler(async (req, res) => {
  res.json(
    await userService.list({
      q: str(req.query.q).slice(0, 100),
      role: str(req.query.role),
      page: parseIntInRange(req.query.page, { min: 1, max: 100000, fallback: 1 }),
      limit: parseIntInRange(req.query.limit, { min: 1, max: 100, fallback: 20 }),
    })
  );
});

// GET /users/:id (editor) - one user.
exports.get = asyncHandler(async (req, res) => res.json(await userService.getById(req.params.id)));

// POST /users (editor) - creates a user. req.user (the editor doing it) is passed to the service. Answers 201 Created.
exports.create = asyncHandler(async (req, res) => res.status(201).json(await userService.create(req.body, req.user)));

// PUT /users/:id (editor) - updates a user. The service has safety rules (for example, you can't change
// your own role, and there must always be at least one editor).
exports.update = asyncHandler(async (req, res) => res.json(await userService.update(req.params.id, req.body, req.user)));

// DELETE /users/:id (editor) - deletes a user. The service refuses to delete yourself, the last editor,
// or a user who still owns articles. Answers 204 No Content.
exports.remove = asyncHandler(async (req, res) => {
  await userService.remove(req.params.id, req.user);
  res.status(204).end();
});
