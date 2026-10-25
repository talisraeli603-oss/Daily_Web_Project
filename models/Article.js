'use strict';

const mongoose = require('mongoose');
const { CATEGORIES, STATUS, LIMITS } = require('../config/constants');

/**
 * An article keeps TWO versions of its content:
 *   live     - the last version approved by an editor. This is the ONLY version readers ever see.
 *   revision - the working copy (draft / pending approval / returned). null when nothing is in progress.
 *
 * Effective status shown to staff:  revision ? revision.status : "published".
 * Approving a revision copies it into `live`, clears `revision` and records the event in publishHistory,
 * which the Impact Analytics chart uses to mark publication / update times.
 */
// The text fields shared by both versions (live and revision), so we write them only once.
// Important: every string has a max length from the constants file, so nobody can save huge text.
const contentFields = {
  title: { type: String, trim: true, maxlength: LIMITS.TITLE, default: '' },
  summary: { type: String, trim: true, maxlength: LIMITS.SUMMARY, default: '' },
  content: { type: String, trim: true, maxlength: LIMITS.CONTENT, default: '' },
  image: { type: String, trim: true, maxlength: LIMITS.IMAGE, default: '' },
  category: { type: String, enum: [...CATEGORIES, ''], default: '' },
};

// The published version of the article (what readers see). _id:false because it is just a sub-part of the article.
const liveSchema = new mongoose.Schema(
  { ...contentFields, publishedAt: { type: Date, required: true } },
  { _id: false }
);

// The working copy: its status can only be in preparation, pending approval or returned (never "published").
// editorNote is the message the editor writes when sending the article back.
const revisionSchema = new mongoose.Schema(
  {
    ...contentFields,
    status: {
      type: String,
      enum: [STATUS.IN_PREPARATION, STATUS.PENDING, STATUS.RETURNED],
      required: true,
    },
    editorNote: { type: String, trim: true, maxlength: LIMITS.NOTE, default: '' },
    updatedAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

// One entry in the publish history: when it was published, who approved it, and if it was the first
// publish ("initial") or a later edit ("update"). The analytics chart uses these to draw markers.
const publishEventSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    kind: { type: String, enum: ['initial', 'update'], default: 'initial' },
  },
  { _id: false }
);

// One entry in the review history: the conversation between reporter and editor about an article.
// Every submit, return (with the editor's note) and approval adds one entry, so nothing is lost when the
// article is returned again later (revision.editorNote only keeps the LATEST note).
// byName is a copy of the person's name at that moment, so we can show the history without extra lookups.
const reviewEventSchema = new mongoose.Schema(
  {
    at: { type: Date, required: true, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: { type: String, trim: true, maxlength: 60, default: '' },
    role: { type: String, enum: ['reporter', 'editor'], required: true },
    action: { type: String, enum: ['submitted', 'returned', 'approved'], required: true },
    note: { type: String, trim: true, maxlength: LIMITS.NOTE, default: '' },
  },
  { _id: false }
);

// The main article schema. It points to the author (a User) and holds the live version, the revision,
// the total view count and the publish history.
const articleSchema = new mongoose.Schema(
  {
    author: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // default undefined: an article with no live/revision simply doesn't have the field (it stays "missing", not an empty object).
    live: { type: liveSchema, default: undefined },
    revision: { type: revisionSchema, default: undefined },
    // Total views kept right on the article so the "most popular" sort is fast.
    viewCount: { type: Number, default: 0, min: 0 },
    publishHistory: { type: [publishEventSchema], default: [] },
    // Everything that happened in the review process, oldest first (see reviewEventSchema).
    reviewHistory: { type: [reviewEventSchema], default: [] },
  },
  // Important: optimisticConcurrency - a save fails (409) instead of silently overwriting if the document
  // changed between reading and saving it (e.g. two editors approving the same article).
  // timestamps adds createdAt and updatedAt automatically.
  { timestamps: true, optimisticConcurrency: true }
);

// Important: indexes make MongoDB find and sort articles fast without scanning the whole collection.
// Public feed: newest first / most popular, with _id as a stable tie-breaker (keyset pagination).
articleSchema.index({ 'live.publishedAt': -1, _id: -1 });
articleSchema.index({ viewCount: -1, _id: -1 });
articleSchema.index({ 'live.category': 1, 'live.publishedAt': -1 });
// Staff lists.
articleSchema.index({ 'revision.status': 1, updatedAt: -1 });
articleSchema.index({ author: 1, updatedAt: -1 });
articleSchema.index({ updatedAt: -1 });

// Virtual field "status" (not saved in the database, calculated when read): if there is a revision
// we show its status, otherwise the article is simply "published".
articleSchema.virtual('status').get(function status() {
  return this.revision ? this.revision.status : STATUS.PUBLISHED;
});

module.exports = mongoose.model('Article', articleSchema);
