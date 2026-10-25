'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { transition, canEditContent, canDelete, ACTIONS } = require('../services/workflowService');
const { STATUS } = require('../config/constants');

// Fake users for the tests: the reporter who owns the article, a different reporter, and an editor.
const owner = { role: 'reporter', isOwner: true };
const otherReporter = { role: 'reporter', isOwner: false };
const editor = { role: 'editor', isOwner: false };

// Proves the owner can submit for approval from "in preparation" and also again after the editor returned it.
test('reporter submits own article from in_preparation and from returned', () => {
  assert.deepEqual(transition(STATUS.IN_PREPARATION, ACTIONS.SUBMIT, owner), { ok: true, to: STATUS.PENDING });
  assert.deepEqual(transition(STATUS.RETURNED, ACTIONS.SUBMIT, owner), { ok: true, to: STATUS.PENDING });
});

// Proves submit fails from the wrong state, and for another reporter or an editor (403 forbidden).
test('submit is rejected for other states, other reporters and editors', () => {
  assert.equal(transition(STATUS.PENDING, ACTIONS.SUBMIT, owner).ok, false);
  assert.equal(transition(STATUS.PUBLISHED, ACTIONS.SUBMIT, owner).ok, false);
  assert.equal(transition(STATUS.IN_PREPARATION, ACTIONS.SUBMIT, otherReporter).httpStatus, 403);
  assert.equal(transition(STATUS.IN_PREPARATION, ACTIONS.SUBMIT, editor).httpStatus, 403);
});

// Proves only an editor can approve (publish) or return an article, and only while it is waiting for approval.
test('only an editor can approve or return, and only from pending_approval', () => {
  assert.deepEqual(transition(STATUS.PENDING, ACTIONS.APPROVE, editor), { ok: true, to: STATUS.PUBLISHED });
  assert.deepEqual(transition(STATUS.PENDING, ACTIONS.RETURN, editor), { ok: true, to: STATUS.RETURNED });
  assert.equal(transition(STATUS.PENDING, ACTIONS.APPROVE, owner).httpStatus, 403);
  assert.equal(transition(STATUS.PENDING, ACTIONS.RETURN, owner).httpStatus, 403);
  // For every other state, even an editor gets 409 (conflict: wrong state for this action).
  [STATUS.IN_PREPARATION, STATUS.RETURNED, STATUS.PUBLISHED].forEach((s) => {
    assert.equal(transition(s, ACTIONS.APPROVE, editor).httpStatus, 409);
    assert.equal(transition(s, ACTIONS.RETURN, editor).httpStatus, 409);
  });
});

// Proves the editor shortcut: a new version of an already published article can be published straight from
// in_preparation, but a never-published draft cannot, and reporters can never do it.
test('editor can publish an update of a published article directly', () => {
  const editorWithLive = { ...editor, hasLive: true };
  assert.deepEqual(transition(STATUS.IN_PREPARATION, ACTIONS.APPROVE, editorWithLive), { ok: true, to: STATUS.PUBLISHED });
  assert.equal(transition(STATUS.IN_PREPARATION, ACTIONS.APPROVE, editor).httpStatus, 409);
  assert.equal(transition(STATUS.RETURNED, ACTIONS.APPROVE, editorWithLive).httpStatus, 409);
  assert.equal(transition(STATUS.IN_PREPARATION, ACTIONS.APPROVE, { ...owner, hasLive: true }).httpStatus, 403);
});

// Proves the owner can edit a published article (it starts a new draft revision), but other reporters can't and it's not allowed while pending.
test('editing a published article starts a new in_preparation revision', () => {
  assert.deepEqual(transition(STATUS.PUBLISHED, ACTIONS.START_REVISION, owner), { ok: true, to: STATUS.IN_PREPARATION });
  assert.equal(transition(STATUS.PUBLISHED, ACTIONS.START_REVISION, otherReporter).httpStatus, 403);
  assert.equal(transition(STATUS.PENDING, ACTIONS.START_REVISION, owner).httpStatus, 409);
});

// Proves an action name that doesn't exist (like "publish") is refused.
test('unknown actions are rejected', () => {
  assert.equal(transition(STATUS.IN_PREPARATION, 'publish', editor).ok, false);
});

// Proves when a reporter may edit the content: own draft or returned article yes, while pending no (409), published yes but as a new revision, someone else's no (403).
test('reporter content-editing rules', () => {
  assert.equal(canEditContent(STATUS.IN_PREPARATION, owner).allowed, true);
  assert.equal(canEditContent(STATUS.RETURNED, owner).allowed, true);
  assert.equal(canEditContent(STATUS.PENDING, owner).allowed, false);
  assert.equal(canEditContent(STATUS.PENDING, owner).httpStatus, 409);
  assert.deepEqual(
    { a: canEditContent(STATUS.PUBLISHED, owner).allowed, r: canEditContent(STATUS.PUBLISHED, owner).createsRevision },
    { a: true, r: true }
  );
  assert.equal(canEditContent(STATUS.IN_PREPARATION, otherReporter).httpStatus, 403);
});

// Proves an editor can edit an article in any status, and that only an editor (not the owner reporter) can delete.
test('editor can edit everything, and only editors delete', () => {
  Object.values(STATUS).forEach((s) => assert.equal(canEditContent(s, editor).allowed, true));
  assert.equal(canDelete(editor), true);
  assert.equal(canDelete(owner), false);
});
