'use strict';

const mongoose = require('mongoose');

/** Remembers which articles a device has opened (powers the "viewed / not viewed" feed filter).
 *  It only says "this device has seen this article". The real view counts are kept elsewhere
 *  (ViewStat and Article.viewCount), and every view is still counted there. */
const viewedLogSchema = new mongoose.Schema({
  deviceId: { type: String, required: true },
  article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true },
  firstViewedAt: { type: Date, default: Date.now },
});

// Important: unique index on device + article, so there is only ONE log row per device per article
// (the same device can't be listed twice for the same article), and the lookup is fast.
viewedLogSchema.index({ deviceId: 1, article: 1 }, { unique: true });
// Makes it quick to find all log rows of one article.
viewedLogSchema.index({ article: 1 });

module.exports = mongoose.model('ViewedLog', viewedLogSchema);
