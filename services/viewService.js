'use strict';

/**
 * Collects article views efficiently for a site that may have thousands of concurrent readers.
 *
 * Instead of one database write per page view, views are counted in memory and flushed to MongoDB in
 * small batches (every FLUSH_MS, and on graceful shutdown) as:
 *   - $inc on the hourly ViewStat bucket (feeds the Impact Analytics chart)
 *   - $inc on Article.viewCount            (feeds the "popular" sort)
 *   - upsert in ViewedLog                  (feeds the "viewed / not viewed" filter)
 * Every entry counts (no de-duplication), as required.
 */
const Article = require('../models/Article');
const ViewStat = require('../models/ViewStat');
const ViewedLog = require('../models/ViewedLog');
const logger = require('../utils/logger');

// How often (in ms) the in-memory counts are written to MongoDB: every 2 seconds.
const FLUSH_MS = 2000;

// In-memory buffers. They fill up as people read, and are emptied by every flush.
let buckets = new Map(); // "articleId|hourMs" -> count
let totals = new Map(); // articleId -> count
let viewed = new Map(); // "deviceId|articleId" -> {deviceId, article}
// The repeating timer that triggers the flush (null when it is not running).
let timer = null;
// A promise that always points to the latest flush. Used to make flushes wait for each other.
let flushing = Promise.resolve();

// Called on every article view. It only updates the in-memory maps (no database call), so it is very cheap.
// Important: this is why thousands of readers do not cause thousands of DB writes. The counts are saved later in one batch.
function record(articleId, deviceId, when = new Date()) {
  const id = String(articleId);
  // Important: views are grouped into hourly buckets (one counter per article per hour), not one record per view. This keeps the stats small and the chart fast.
  const hour = ViewStat.hourStart(when).getTime();
  const bucketKey = `${id}|${hour}`;
  buckets.set(bucketKey, (buckets.get(bucketKey) || 0) + 1);
  totals.set(id, (totals.get(id) || 0) + 1);
  // Remember that this device viewed this article (only if we know the device).
  if (deviceId) viewed.set(`${deviceId}|${id}`, { deviceId, article: id });
}

// Does the real work of a flush: takes what is in memory and writes it to MongoDB in bulk operations.
// If the database write fails, the counts are put back so no views are lost.
async function doFlush() {
  // Nothing collected since the last flush, so nothing to do.
  if (!buckets.size && !totals.size && !viewed.size) return;

  // Swap the buffers first so views arriving during the flush are not lost.
  const b = buckets;
  const t = totals;
  const v = viewed;
  buckets = new Map();
  totals = new Map();
  viewed = new Map();

  try {
    // 1) Hourly buckets: add the counted views to each article+hour document (create it if it doesn't exist yet).
    // Important: bulkWrite sends all the updates to MongoDB in one go instead of one by one.
    const ops = [];
    for (const [key, count] of b) {
      const [article, hour] = key.split('|');
      ops.push({
        updateOne: {
          filter: { article, hour: new Date(Number(hour)) },
          update: { $inc: { count } },
          upsert: true,
        },
      });
    }
    if (ops.length) await ViewStat.bulkWrite(ops, { ordered: false });

    // 2) Total view counter on each article (used for the "popular" sort).
    if (t.size) {
      await Article.bulkWrite(
        [...t].map(([id, count]) => ({ updateOne: { filter: { _id: id }, update: { $inc: { viewCount: count } } } })),
        { ordered: false }
      );
    }

    // 3) Log that this device viewed this article. $setOnInsert keeps the first-viewed date and never overwrites it.
    if (v.size) {
      await ViewedLog.bulkWrite(
        [...v.values()].map((doc) => ({
          updateOne: {
            filter: { deviceId: doc.deviceId, article: doc.article },
            update: { $setOnInsert: { firstViewedAt: new Date() } },
            upsert: true,
          },
        })),
        { ordered: false }
      );
    }
  } catch (err) {
    logger.error('View flush failed; re-queueing counts', err);
    // put the counts back so nothing is lost
    for (const [k, c] of b) buckets.set(k, (buckets.get(k) || 0) + c);
    for (const [k, c] of t) totals.set(k, (totals.get(k) || 0) + c);
    for (const [k, d] of v) viewed.set(k, d);
  }
}

/** Flushes the buffer now. Calls are chained so two flushes never run at the same time. */
// Each new flush waits for the previous one to finish (promise chain), so they never overlap.
function flush() {
  flushing = flushing.then(doFlush);
  return flushing;
}

// Starts the timer that flushes every FLUSH_MS. Safe to call twice (it does nothing if already running).
function start() {
  if (timer) return;
  // The empty catch is there so a failed flush can't crash the server (doFlush already logs the error).
  timer = setInterval(() => flush().catch(() => {}), FLUSH_MS);
  // unref() means this timer alone won't keep the Node process alive when it wants to exit.
  timer.unref();
}

// Stops the timer and does one last flush, used when the server shuts down so the last views are saved.
async function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  await flush();
}

module.exports = { record, flush, start, stop };
