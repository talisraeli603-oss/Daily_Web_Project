'use strict';

/** Impact Analytics: hourly view series + publish markers + before/after comparison. */
const Article = require('../models/Article');
const ViewStat = require('../models/ViewStat');
const AppError = require('../utils/AppError');
const { assertObjectId } = require('../utils/helpers');
const viewService = require('./viewService');

// One hour in milliseconds. Views are stored in hourly buckets, so all the time math here is done in whole hours.
const HOUR = ViewStat.HOUR_MS;
// The longest time range the chart may ask for: 120 days, counted in hours.
const MAX_RANGE_HOURS = 24 * 120;

// Turns a date from the query string into a Date object. Empty means "not given" (null), a bad date gives an error.
function parseDate(value, label) {
  if (value === undefined || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw AppError.badRequest(`Invalid "${label}" date.`);
  return d;
}

// Rounds a time (in ms) down to the start of its hour, e.g. 14:35 becomes 14:00.
const hourFloor = (ms) => Math.floor(ms / HOUR) * HOUR;

/**
 * Average views/hour in the window BEFORE and AFTER a publish event. The hour that contains the event
 * is skipped because it mixes both periods. Returns null for a side that has no complete hours.
 */
// Important: this is the "did the update help?" calculation. It compares the average views per hour
// before and after a publish/update, and gives the change in percent. It is exported so the unit test can check it.
function compare(byHour, atMs, windowHours, nowMs) {
  const boundary = hourFloor(atMs);
  // Adds up the views of every hour from startHour up to (not including) endHour, and gives the average per hour.
  // Hours with no data count as 0. Returns null if the range has no hours at all.
  const avg = (startHour, endHour) => {
    // hours in [startHour, endHour) in ms
    if (endHour <= startHour) return null;
    let sum = 0;
    let hours = 0;
    for (let h = startHour; h < endHour; h += HOUR) {
      sum += byHour.get(h) || 0;
      hours++;
    }
    return hours ? { avgPerHour: Math.round((sum / hours) * 10) / 10, hours, total: sum } : null;
  };

  // "Before" = the window of hours right before the event's hour.
  const before = avg(boundary - windowHours * HOUR, boundary);
  // "After" = the window starting one hour after the event's hour, but it stops at the last full hour (not the current, unfinished one).
  const afterStart = boundary + HOUR;
  const afterEnd = Math.min(afterStart + windowHours * HOUR, hourFloor(nowMs));
  const after = avg(afterStart, afterEnd);

  // Percent change, only when both sides exist and "before" is not zero (can't divide by zero).
  let changePct = null;
  if (before && after && before.avgPerHour > 0) {
    changePct = Math.round(((after.avgPerHour - before.avgPerHour) / before.avgPerHour) * 100);
  }
  return { before, after, changePct };
}

// Builds all the data for one article's Impact Analytics chart: views per hour, the publish/update
// markers on the timeline, and a before/after comparison for each marker.
async function getArticleSeries(articleId, query = {}) {
  assertObjectId(articleId, 'article id');
  const article = await Article.findById(articleId).select('live revision publishHistory viewCount').lean();
  if (!article) throw AppError.notFound('Article not found.');

  // Important: views are held in memory and saved in batches, so we force a save now. That way the chart includes the very latest views.
  await viewService.flush(); // include the very latest views

  const now = Date.now();
  // How many hours to compare before/after a marker: default 24, kept between 1 and 168 (one week).
  const windowHours = Math.min(168, Math.max(1, Number.parseInt(query.windowHours, 10) || 24));

  // The list of publish/update events, and the time of the first publish (if never published, use 7 days ago).
  const history = (article.publishHistory || []).map((e) => ({ at: e.at, kind: e.kind }));
  const firstPublish = history.length ? new Date(history[0].at).getTime() : now - 7 * 24 * HOUR;

  // Work out the chart's time range (from / to) from the query, with sensible defaults.
  const to = parseDate(query.to, 'to');
  // from=first  ->  start two hours before the first publication (capped at the maximum range)
  const sinceFirst = query.from === 'first';
  const from = sinceFirst ? null : parseDate(query.from, 'from');
  const toMs = hourFloor((to ? to.getTime() : now)) + HOUR;
  const defaultSpan = sinceFirst ? MAX_RANGE_HOURS * HOUR : 30 * 24 * HOUR;
  const fromMs = hourFloor(from ? from.getTime() : Math.max(firstPublish - 2 * HOUR, toMs - defaultSpan));
  // Safety checks: the range must make sense and can't be longer than 120 days.
  if (fromMs >= toMs) throw AppError.badRequest('"from" must be before "to".');
  if ((toMs - fromMs) / HOUR > MAX_RANGE_HOURS) throw AppError.badRequest('The selected range is too long (max 120 days).');

  // Fetch a little more than requested so before/after comparisons near the edges are accurate.
  const fetchFrom = new Date(fromMs - windowHours * HOUR);
  const fetchTo = new Date(Math.min(toMs + windowHours * HOUR, hourFloor(now) + HOUR));
  // Important: we read the small hourly buckets (one document per article per hour), not one document per view, so this stays fast.
  const buckets = await ViewStat.find({ article: articleId, hour: { $gte: fetchFrom, $lt: fetchTo } }).select('hour count').lean();
  // Quick lookup table: hour start time -> number of views in that hour.
  const byHour = new Map(buckets.map((b) => [b.hour.getTime(), b.count]));

  // Continuous series (missing hours are zero) so the line chart shows quiet periods honestly.
  const points = [];
  for (let h = fromMs; h < toMs; h += HOUR) points.push({ t: h, count: byHour.get(h) || 0 });

  // Keep only the publish/update events inside the chart range, and attach a before/after comparison to each.
  const markers = history
    .filter((m) => new Date(m.at).getTime() >= fromMs && new Date(m.at).getTime() < toMs)
    .map((m) => ({
      at: m.at,
      kind: m.kind,
      comparison: compare(byHour, new Date(m.at).getTime(), windowHours, now),
    }));

  const current = article.revision || article.live || {};
  return {
    article: { id: String(article._id), title: (article.live && article.live.title) || current.title || '(untitled)', totalViews: article.viewCount || 0 },
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    windowHours,
    points,
    markers,
    totalInRange: points.reduce((s, p) => s + p.count, 0),
  };
}

/* ---- CRUD on the raw hourly buckets (editor tools) ---- */

// Lists the raw hourly view buckets for the editor, with optional filters (article, from/to dates) and page numbers.
async function listBuckets({ article, from, to, page, limit }) {
  const filter = {};
  if (article) filter.article = assertObjectId(article, 'article id');
  const f = parseDate(from, 'from');
  const t = parseDate(to, 'to');
  // Only add the date filter for the sides that were given ("from" is included, "to" is not).
  if (f || t) filter.hour = { ...(f ? { $gte: f } : {}), ...(t ? { $lt: t } : {}) };
  const [total, docs] = await Promise.all([
    ViewStat.countDocuments(filter),
    ViewStat.find(filter).sort({ hour: -1 }).skip((page - 1) * limit).limit(limit).lean(),
  ]);
  return {
    items: docs.map((d) => ({ id: String(d._id), article: String(d.article), hour: d.hour, count: d.count })),
    total,
    page,
    pages: Math.max(1, Math.ceil(total / limit)),
  };
}

// Lets an editor fix the view count of one hourly bucket. The count must be a whole number, 0 or more.
async function updateBucket(id, body) {
  assertObjectId(id, 'bucket id');
  const count = body && Number.isInteger(body.count) ? body.count : NaN;
  if (!Number.isInteger(count) || count < 0 || count > 10_000_000) throw AppError.badRequest('"count" must be a non-negative whole number.');
  const before = await ViewStat.findById(id);
  if (!before) throw AppError.notFound('View bucket not found.');
  // How much the count changed (can be negative), so the article's total can be adjusted by the same amount.
  const delta = count - before.count;
  before.count = count;
  await before.save();
  await Article.updateOne({ _id: before.article }, { $inc: { viewCount: delta } }); // keep the popularity counter consistent
  return { id: String(before._id), article: String(before.article), hour: before.hour, count: before.count };
}

// Deletes one hourly bucket and takes its views away from the article's total view count.
async function deleteBucket(id) {
  assertObjectId(id, 'bucket id');
  const doc = await ViewStat.findByIdAndDelete(id);
  if (!doc) throw AppError.notFound('View bucket not found.');
  await Article.updateOne({ _id: doc.article }, { $inc: { viewCount: -doc.count } });
}

module.exports = { getArticleSeries, listBuckets, updateBucket, deleteBucket, compare };
