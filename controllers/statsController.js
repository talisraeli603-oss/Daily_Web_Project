'use strict';

const statsService = require('../services/statsService');
const { asyncHandler, str, parseIntInRange } = require('../utils/helpers');

// GET /stats/articles/:id (editor) - views per hour for one article, for the Impact Analytics chart.
// The optional from / to dates and windowHours are passed to the service, which checks them.
exports.articleSeries = asyncHandler(async (req, res) => {
  res.json(
    await statsService.getArticleSeries(req.params.id, {
      from: str(req.query.from),
      to: str(req.query.to),
      windowHours: req.query.windowHours,
    })
  );
});

// GET /stats/views (editor) - lists the raw hourly buckets (article + hour + count), with filters and page numbers.
exports.listBuckets = asyncHandler(async (req, res) => {
  res.json(
    await statsService.listBuckets({
      article: str(req.query.article),
      from: str(req.query.from),
      to: str(req.query.to),
      page: parseIntInRange(req.query.page, { min: 1, max: 100000, fallback: 1 }),
      limit: parseIntInRange(req.query.limit, { min: 1, max: 200, fallback: 50 }),
    })
  );
});

// PUT /stats/views/:id (editor) - changes the count of one hourly bucket.
exports.updateBucket = asyncHandler(async (req, res) => {
  res.json(await statsService.updateBucket(req.params.id, req.body));
});

// DELETE /stats/views/:id (editor) - deletes one hourly bucket. Answers 204 No Content.
exports.deleteBucket = asyncHandler(async (req, res) => {
  await statsService.deleteBucket(req.params.id);
  res.status(204).end();
});
