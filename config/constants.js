'use strict';

// Fixed values shared by the whole project, kept in one place so they are easy to change.
module.exports = {
  // The list of news categories an article can have.
  CATEGORIES: ['Politics', 'World', 'Business', 'Technology', 'Science', 'Health', 'Sports', 'Culture'],
  // The two kinds of users: reporters write articles, editors approve them.
  ROLES: { REPORTER: 'reporter', EDITOR: 'editor' },
  // Workflow states of an article. "published" is not stored on the revision:
  // an article with a live version and no pending revision counts as published.
  STATUS: {
    IN_PREPARATION: 'in_preparation',
    PENDING: 'pending_approval',
    RETURNED: 'returned',
    PUBLISHED: 'published',
  },
  // Friendly text shown to users for each status.
  STATUS_LABELS: {
    in_preparation: 'In preparation',
    pending_approval: 'Awaiting editor approval',
    returned: 'Returned for corrections',
    published: 'Published',
  },
  // Maximum / minimum lengths of text fields (used by the validators and the schemas).
  LIMITS: {
    TITLE: 150,
    SUMMARY: 300,
    CONTENT: 20000,
    IMAGE: 500,
    COMMENT: 1000,
    COMMENT_NAME: 40,
    NOTE: 1000,
    USERNAME_MIN: 3,
    USERNAME_MAX: 30,
    PASSWORD_MIN: 6,
    PASSWORD_MAX: 72, // bcrypt only looks at the first 72 bytes, so longer passwords would not add any safety
  },
  // How many items are loaded per page (home feed, comments, management lists).
  FEED_PAGE_SIZE: 20,
  COMMENTS_PAGE_SIZE: 20,
  MANAGE_PAGE_SIZE: 20,
  // Comment spam limit: within 1 minute, one device may post 3 comments and one IP address may post 10.
  COMMENT_RATE: { WINDOW_MS: 60 * 1000, PER_DEVICE: 3, PER_IP: 10 },
  // Name of the cookie that identifies a browser (device).
  DEVICE_COOKIE: 'dw_device',
};
