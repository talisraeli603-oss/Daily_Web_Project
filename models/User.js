'use strict';

const mongoose = require('mongoose');
const { ROLES, LIMITS } = require('../config/constants');

// A staff user (writer, editor, ...). The role decides what the user is allowed to do.
const userSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      // Important: unique creates a unique index, so two users can't have the same username.
      // lowercase makes "Dana" and "dana" the same name.
      unique: true,
      trim: true,
      lowercase: true,
      minlength: LIMITS.USERNAME_MIN,
      maxlength: LIMITS.USERNAME_MAX,
    },
    displayName: { type: String, required: true, trim: true, maxlength: 60 },
    // bcrypt hash only. The plain password is never stored and cannot be recovered from the hash.
    // Important: select:false so the password hash is never returned by accident in normal queries.
    passwordHash: { type: String, required: true, select: false },
    // Role must be one of the allowed values from the constants file; indexed because we filter users by role.
    role: { type: String, enum: Object.values(ROLES), required: true, index: true },
  },
  { timestamps: true }
);

// Returns the user as a plain object that is safe to send to the browser.
// Important: it has no password hash, only id, name, role and creation date.
userSchema.methods.toSafeJSON = function toSafeJSON() {
  return {
    id: String(this._id),
    username: this.username,
    displayName: this.displayName,
    role: this.role,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('User', userSchema);
