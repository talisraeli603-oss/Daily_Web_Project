'use strict';

/**
 * Article workflow rules (a small state machine: "from this status, which actions are allowed?").
 * Important: these are pure functions (no database, no Express), so every rule is easy to read
 * and easy to unit-test. The article service calls these before touching the database.
 *
 *   (new) -> in_preparation --submit--> pending_approval --approve--> published
 *                  ^                          |
 *                  |                       return (with note)
 *               resubmit                      v
 *                  +----------------------- returned
 *
 *   published --(reporter/editor starts editing)--> new revision in_preparation (live stays visible)
 *
 * Anything not listed here is rejected.
 */
const { STATUS, ROLES } = require('../config/constants');

// The names of the actions a user can try. Used instead of loose strings so there are no typos.
const ACTIONS = {
  SUBMIT: 'submit',
  APPROVE: 'approve',
  RETURN: 'return',
  START_REVISION: 'start_revision',
};

/**
 * Decides if an action is allowed for this person in this status, and what the new status would be.
 * It does NOT change anything. It just answers { ok: true, to: newStatus } or { ok: false, httpStatus, reason }.
 * Important: 403 means "wrong person" (role/owner), 409 means "wrong state" (e.g. approving something not pending).
 * Anything not listed in the switch is rejected (default case).
 * @param {string} status  effective status (published / in_preparation / pending_approval / returned)
 * @param {string} action  one of ACTIONS
 * @param {{role: string, isOwner: boolean, hasLive?: boolean}} actor
 * @returns {{ok: true, to: string} | {ok: false, httpStatus: number, reason: string}}
 */
function transition(status, action, actor) {
  const { role, isOwner } = actor;
  // Small helper to build the "not allowed" answer in one line.
  const deny = (httpStatus, reason) => ({ ok: false, httpStatus, reason });

  switch (action) {
    // Submit: only the reporter who owns it; from in_preparation or returned -> pending_approval.
    case ACTIONS.SUBMIT:
      if (role !== ROLES.REPORTER || !isOwner) return deny(403, 'Only the reporter who owns the article can submit it for approval.');
      if (status === STATUS.IN_PREPARATION || status === STATUS.RETURNED) return { ok: true, to: STATUS.PENDING };
      return deny(409, `An article that is "${status}" cannot be submitted for approval.`);

    // Approve: only an editor. Normally from pending_approval -> published.
    // Shortcut for editors: if the article was ALREADY published once (actor.hasLive) and someone is working on a
    // new version of it (in_preparation), the editor may publish that update directly, without waiting for a submit.
    // A brand new article (never published) still has to be submitted by its reporter first.
    case ACTIONS.APPROVE:
      if (role !== ROLES.EDITOR) return deny(403, 'Only an editor can approve and publish an article.');
      if (status === STATUS.PENDING) return { ok: true, to: STATUS.PUBLISHED };
      if (status === STATUS.IN_PREPARATION && actor.hasLive) return { ok: true, to: STATUS.PUBLISHED };
      return deny(409, 'Only an article that is awaiting approval (or a new version of an already published article) can be published.');

    // Return: only an editor; only from pending_approval -> returned (sent back for corrections).
    case ACTIONS.RETURN:
      if (role !== ROLES.EDITOR) return deny(403, 'Only an editor can return an article for corrections.');
      if (status === STATUS.PENDING) return { ok: true, to: STATUS.RETURNED };
      return deny(409, 'Only an article that is awaiting approval can be returned.');

    // Start revision: a published article gets a new working copy (in_preparation) while the live version stays visible.
    // A reporter can only do it on their own article; an editor can do it on any.
    case ACTIONS.START_REVISION:
      if (role === ROLES.REPORTER && !isOwner) return deny(403, 'You can only edit your own articles.');
      if (status === STATUS.PUBLISHED) return { ok: true, to: STATUS.IN_PREPARATION };
      return deny(409, 'Only a published article starts a new revision.');

    default:
      return deny(400, 'Unknown action.');
  }
}

/**
 * Who may change the CONTENT of an article in its current state? (Different from transition(): editing text
 * doesn't move the article to another status.)
 * - Reporter: only their own article, and not while it waits for approval.
 *   Editing a published article is allowed: it creates a revision (the public keeps the live version).
 * - Editor: any article in any state (an editor edit never changes the status).
 * @returns {{allowed: boolean, createsRevision: boolean, httpStatus?: number, reason?: string}}
 */
function canEditContent(status, actor) {
  const { role, isOwner } = actor;
  if (role === ROLES.EDITOR) return { allowed: true, createsRevision: status === STATUS.PUBLISHED };
  if (role !== ROLES.REPORTER) return { allowed: false, createsRevision: false, httpStatus: 403, reason: 'Not allowed.' };
  if (!isOwner) return { allowed: false, createsRevision: false, httpStatus: 403, reason: 'You can only edit your own articles.' };
  if (status === STATUS.PENDING) {
    return { allowed: false, createsRevision: false, httpStatus: 409, reason: 'This article is awaiting editor approval and cannot be edited right now.' };
  }
  return { allowed: true, createsRevision: status === STATUS.PUBLISHED };
}

// Only editors can delete articles.
function canDelete(actor) {
  return actor.role === ROLES.EDITOR;
}

module.exports = { ACTIONS, transition, canEditContent, canDelete };
