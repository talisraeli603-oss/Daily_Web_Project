'use strict';

/**
 * REST API (version 1). Resources are nouns, HTTP verbs express the action, and status codes are meaningful:
 *   200 OK, 201 Created, 202 Accepted, 204 No Content, 400 validation, 401 not logged in,
 *   403 forbidden, 404 not found, 409 invalid state / conflict, 429 rate limited.
 */
const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/constants');

const feed = require('../controllers/feedController');
const article = require('../controllers/articleController');
const comment = require('../controllers/commentController');
const auth = require('../controllers/authController');
const manage = require('../controllers/manageController');
const stats = require('../controllers/statsController');
const users = require('../controllers/userController');
const weather = require('../controllers/weatherController');

const router = express.Router();
// Ready-made middleware lists: each one first checks login, then checks the role.
// Important: these are what protect the routes on the server (staff = reporter or editor).
const staff = [requireAuth, requireRole(ROLES.REPORTER, ROLES.EDITOR)];
const editor = [requireAuth, requireRole(ROLES.EDITOR)];
const reporter = [requireAuth, requireRole(ROLES.REPORTER)];

/* ---- auth ---- */
router.post('/auth/login', auth.apiLogin);
router.post('/auth/logout', requireAuth, auth.logout);
router.get('/auth/me', auth.apiMe);

/* ---- public: articles, comments, views, weather ---- */
router.get('/categories', feed.apiCategories);
router.get('/articles', feed.apiFeed);
router.get('/articles/:id', article.apiGetArticle);
router.get('/articles/:id/comments', comment.list);
router.post('/articles/:id/comments', comment.create);
router.post('/stats/views', article.apiRecordView);
router.get('/weather', weather.current);

/* ---- reporter + editor: manage articles (scope and rights are enforced in the service layer) ----
   Only reporters can create/submit; only editors can approve, return or delete. */
router.get('/manage/articles', staff, manage.list);
router.post('/manage/articles', reporter, manage.create);
router.get('/manage/articles/:id', staff, manage.get);
router.put('/manage/articles/:id/revision', staff, manage.saveRevision);
router.post('/manage/articles/:id/submit', reporter, manage.submit);
router.post('/manage/articles/:id/approve', editor, manage.approve);
router.post('/manage/articles/:id/return', editor, manage.returnForCorrections);
router.delete('/manage/articles/:id', editor, manage.remove);

/* ---- editor: comments ---- */
router.get('/comments', editor, comment.search);
router.put('/comments/:id', editor, comment.update);
router.delete('/comments/:id', editor, comment.remove);

/* ---- editor: statistics ---- */
router.get('/stats/articles/:id', editor, stats.articleSeries);
router.get('/stats/views', editor, stats.listBuckets);
router.put('/stats/views/:id', editor, stats.updateBucket);
router.delete('/stats/views/:id', editor, stats.deleteBucket);

/* ---- editor: users ---- */
router.get('/users', editor, users.list);
router.post('/users', editor, users.create);
router.get('/users/:id', editor, users.get);
router.put('/users/:id', editor, users.update);
router.delete('/users/:id', editor, users.remove);

module.exports = router;
