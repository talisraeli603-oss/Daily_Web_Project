'use strict';

/** Server-rendered pages for staff areas. Data is loaded by the page scripts through the JSON API. */
const { CATEGORIES, STATUS, STATUS_LABELS } = require('../config/constants');
const { assertObjectId } = require('../utils/helpers');
const AppError = require('../utils/AppError');

// Takes the article id from the URL and checks it looks like a real MongoDB id.
// If not, it throws a 404 "not found" instead of a 400, since for a page it just means the page doesn't exist.
function validId(req) {
  try {
    return assertObjectId(req.params.id, 'article id');
  } catch {
    throw AppError.notFound('The article you are looking for does not exist.');
  }
}

// Values that every staff page needs in its EJS template (categories and status names), so we don't repeat them.
const common = { categories: CATEGORIES, STATUS, STATUS_LABELS };

// Reporter's page with the list of their articles (the list itself is loaded later through the API).
exports.workspace = (req, res) => res.render('pages/workspace', { ...common, title: 'My articles' });

// The empty edit form for writing a new article (no article id yet).
exports.newArticle = (req, res) =>
  res.render('pages/edit', { ...common, title: 'New article', articleId: '', area: 'workspace' });

// A function that returns a handler: the same edit page is used by reporters ('workspace') and editors ('editor'),
// and "area" tells the page which one it is. It also checks the article id first.
exports.editArticle = (area) => (req, res) =>
  res.render('pages/edit', { ...common, title: 'Edit article', articleId: validId(req), area });

// Editor's dashboard page.
exports.editorHome = (req, res) => res.render('pages/editor-dashboard', { ...common, title: 'Editor area' });

// The page where the editor reads an article and approves it or sends it back.
exports.review = (req, res) => res.render('pages/review', { ...common, title: 'Review article', articleId: validId(req) });

// The Impact Analytics page (views chart). If ?article= is in the URL, that article is pre-selected.
exports.analytics = (req, res) =>
  res.render('pages/analytics', { ...common, title: 'Impact Analytics', preselect: req.query.article || '' });

// The page where the editor manages users.
exports.users = (req, res) => res.render('pages/users', { ...common, title: 'Users' });

// The page where the editor manages comments.
exports.comments = (req, res) => res.render('pages/comments-admin', { ...common, title: 'Comments' });
