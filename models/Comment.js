'use strict';

const mongoose = require('mongoose');
const { LIMITS } = require('../config/constants');

// A comment on an article. Readers don't need an account, they just type a name and a text.
const commentSchema = new mongoose.Schema(
  {
    article: { type: mongoose.Schema.Types.ObjectId, ref: 'Article', required: true },
    authorName: { type: String, required: true, trim: true, maxlength: LIMITS.COMMENT_NAME },
    text: { type: String, required: true, trim: true, maxlength: LIMITS.COMMENT },
    // Used only by the server-side spam limit (3 comments / minute / device).
    // Important: select:false so deviceId and ip are not returned in normal queries (private data).
    deviceId: { type: String, default: '', select: false },
    ip: { type: String, default: '', select: false },
  },
  { timestamps: true }
);

// Indexes: first one loads the newest comments of an article quickly; the other two make the
// spam check (count recent comments by device / by ip) fast.
commentSchema.index({ article: 1, createdAt: -1, _id: -1 });
commentSchema.index({ deviceId: 1, createdAt: -1 });
commentSchema.index({ ip: 1, createdAt: -1 });

// Returns only the fields that are OK to send to the browser.
// Important: deviceId and ip are left out on purpose, so private info never leaks.
commentSchema.methods.toPublicJSON = function toPublicJSON() {
  return {
    id: String(this._id),
    article: String(this.article),
    authorName: this.authorName,
    text: this.text,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('Comment', commentSchema);
