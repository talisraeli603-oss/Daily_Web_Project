'use strict';

const mongoose = require('mongoose');

/**
 * Views are saved as HOURLY BUCKETS: one document per article per hour, not one per view.
 * Important: with many readers at once this keeps writes cheap (just add 1 to an existing document with $inc),
 * keeps the collection small, and makes the chart query a simple range read.
 */
const viewStatSchema = new mongoose.Schema({
  article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true },
  hour: { type: Date, required: true }, // start of the hour (UTC)
  count: { type: Number, required: true, min: 0, default: 0 },
});

// Important: unique index, so there can only be one bucket per article per hour (no duplicates)
// and it also makes looking up a bucket fast.
viewStatSchema.index({ article: 1, hour: 1 }, { unique: true });

// One hour in milliseconds, shared as a static so other files can use ViewStat.HOUR_MS.
const HOUR_MS = 60 * 60 * 1000;
viewStatSchema.statics.HOUR_MS = HOUR_MS;
// Takes a date (default: now) and rounds it down to the start of its hour, e.g. 14:37 -> 14:00.
// This is the "hour" value used to find the right bucket.
viewStatSchema.statics.hourStart = (date = new Date()) => new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);

module.exports = mongoose.model('ViewStat', viewStatSchema);
