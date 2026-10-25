'use strict';

const express = require('express');
const { requireAuth, requireRole } = require('../middleware/auth');
const { ROLES } = require('../config/constants');
const feed = require('../controllers/feedController');
const article = require('../controllers/articleController');
const auth = require('../controllers/authController');
const pages = require('../controllers/pageController');
const placeholder = require('../controllers/placeholderController');

const router = express.Router();
// Role guards for the page routes. Important: the server checks the role, not the browser.
const reporter = requireRole(ROLES.REPORTER);
const editor = requireRole(ROLES.EDITOR);

/* ---- public: pages anyone can open (home feed, one article, placeholder images) ---- */
router.get('/', feed.homePage);
router.get('/articles/:id', article.articlePage);
router.get('/placeholder/:category/:seed.svg', placeholder.svg);

/* ---- authentication ---- */
router.get('/login', auth.loginPage);
router.post('/login', auth.loginSubmit);
router.post('/logout', requireAuth, auth.logout);

/* ---- reporter workspace: only reporters (editArticle('workspace') builds a handler for the reporter's edit page) ---- */
router.get('/workspace', reporter, pages.workspace);
router.get('/workspace/articles/new', reporter, pages.newArticle);
router.get('/workspace/articles/:id/edit', reporter, pages.editArticle('workspace'));

/* ---- editor area: only editors (review, analytics, users, comments) ---- */
router.get('/editor', editor, pages.editorHome);
router.get('/editor/articles/:id', editor, pages.review);
router.get('/editor/articles/:id/edit', editor, pages.editArticle('editor'));
router.get('/editor/analytics', editor, pages.analytics);
router.get('/editor/users', editor, pages.users);
router.get('/editor/comments', editor, pages.comments);

module.exports = router;
