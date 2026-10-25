'use strict';

const articleService = require('../services/articleService');
const { asyncHandler, str, parseIntInRange } = require('../utils/helpers');
const { CATEGORIES, FEED_PAGE_SIZE } = require('../config/constants');

// Reads the feed filters from the URL (?q=&category=&viewed=&sort=) and gives them safe defaults.
// Important: str() turns anything that is not a string into '' (and trims it), and the search text is cut to 100 characters.
function readFilters(query) {
  return {
    q: str(query.q).slice(0, 100),
    category: str(query.category),
    viewed: str(query.viewed) || 'all',
    sort: str(query.sort) || 'date',
  };
}

// GET /  - first page is rendered on the server; the rest is loaded with Ajax.
// It gets the first batch of published articles (using the device id for the viewed / not viewed filter)
// and renders the home EJS page.
exports.homePage = asyncHandler(async (req, res) => {
  const filters = readFilters(req.query);
  const feed = await articleService.getFeed({ ...filters, limit: FEED_PAGE_SIZE, deviceId: req.deviceId });
  res.render('pages/home', {
    title: 'The Daily Web - Latest news',
    description: 'The Daily Web: the latest approved and published news.',
    categories: CATEGORIES,
    filters,
    items: feed.items,
    nextCursor: feed.nextCursor,
  });
});

// GET /api/v1/articles?q=&category=&viewed=&sort=&cursor=&limit=
// Returns the next batch of articles as JSON (used by the "load more" Ajax call). The cursor marks where
// the last batch ended; limit is kept between 1 and 50.
exports.apiFeed = asyncHandler(async (req, res) => {
  const filters = readFilters(req.query);
  const limit = parseIntInRange(req.query.limit, { min: 1, max: 50, fallback: FEED_PAGE_SIZE });
  const feed = await articleService.getFeed({
    ...filters,
    cursor: str(req.query.cursor),
    limit,
    deviceId: req.deviceId,
  });
  res.json(feed);
});

// GET /api/v1/categories - returns the fixed list of categories.
exports.apiCategories = (req, res) => res.json({ categories: CATEGORIES });
