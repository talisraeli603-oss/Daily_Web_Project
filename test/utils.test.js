'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { diffWords } = require('../utils/diff');
const { validateDraft, validateForSubmit, validateComment } = require('../utils/validators');
const { escapeRegex, withLock, encodeCursor, decodeCursor } = require('../utils/helpers');
const { compare } = require('../services/statsService');

// One hour in milliseconds, used to build fake hourly view counts below.
const HOUR = 3600 * 1000;

// Proves the word diff finds the removed/added words, and that putting the pieces back gives both original texts.
test('diffWords marks added and removed words and rebuilds both texts', () => {
  const ops = diffWords('the quick brown fox', 'the slow brown dog');
  const oldText = ops.filter((o) => o.type !== 'add').map((o) => o.text).join('');
  const newText = ops.filter((o) => o.type !== 'del').map((o) => o.text).join('');
  assert.equal(oldText, 'the quick brown fox');
  assert.equal(newText, 'the slow brown dog');
  assert.ok(ops.some((o) => o.type === 'del' && o.text.includes('quick')));
  assert.ok(ops.some((o) => o.type === 'add' && o.text.includes('slow')));
});

// Proves that two identical texts give one "same" piece and no added/removed words.
test('diffWords of identical text has no changes', () => {
  assert.deepEqual(diffWords('same text', 'same text'), [{ type: 'same', text: 'same text' }]);
});

// Proves a draft can be partly filled, but wrong types, unknown categories and dangerous image links (javascript:) are rejected.
test('validateDraft accepts partial input and rejects bad types / values', () => {
  assert.deepEqual(validateDraft({ title: '  Hello ' }), { title: 'Hello' });
  assert.throws(() => validateDraft({ title: 5 }), /not valid/);
  assert.throws(() => validateDraft({ category: 'Nope' }), /not valid/);
  assert.throws(() => validateDraft({ image: 'javascript:alert(1)' }), /not valid/);
  assert.throws(() => validateDraft(null), /JSON object/);
  assert.doesNotThrow(() => validateDraft({ image: '/placeholder/World/1.svg' }));
  assert.doesNotThrow(() => validateDraft({ image: 'https://example.com/a.png' }));
});

// Proves an article can only be submitted for approval when every field is filled in.
test('validateForSubmit requires a complete article', () => {
  assert.throws(() => validateForSubmit({ title: 'x', summary: '', content: '', image: '', category: '' }), /not complete/);
  assert.doesNotThrow(() =>
    validateForSubmit({ title: 'T', summary: 'S', content: 'x'.repeat(30), image: 'https://a.b/c.png', category: 'World' })
  );
});

// Proves comment input is trimmed, and that an empty name or a text over 1000 characters is rejected.
test('validateComment trims and rejects empty / oversized input', () => {
  assert.deepEqual(validateComment({ authorName: ' Ann ', text: ' hi ' }), { authorName: 'Ann', text: 'hi' });
  assert.throws(() => validateComment({ authorName: '', text: 'x' }));
  assert.throws(() => validateComment({ authorName: 'A', text: 'x'.repeat(1001) }));
});

// Proves special regex characters (like . * ( ) ) are treated as normal text, so a search can't be broken or abused.
test('escapeRegex neutralises regex metacharacters', () => {
  assert.equal(new RegExp(escapeRegex('a.b*(c)')).test('a.b*(c)'), true);
  assert.equal(new RegExp(escapeRegex('a.b')).test('axb'), false);
});

// Proves a pagination cursor can be encoded and decoded back to the same object, an empty one gives null, and garbage throws "Invalid cursor".
test('cursor round trip and invalid cursor', () => {
  assert.deepEqual(decodeCursor(encodeCursor({ v: 1, id: 'x' })), { v: 1, id: 'x' });
  assert.equal(decodeCursor(''), null);
  assert.throws(() => decodeCursor('%%%not-json'), /Invalid cursor/);
});

// Proves two jobs with the same lock key run one after the other (a1, a2, then b1, b2), never mixed.
// This is the lock that the 3-comments-per-minute check relies on.
test('withLock serialises work with the same key', async () => {
  const order = [];
  await Promise.all([
    // First job: it waits 20ms in the middle, so the second job has a chance to jump in if the lock didn't work.
    withLock('k', async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 20));
      order.push('a2');
    }),
    // Second job: must only start after the first one has finished.
    withLock('k', async () => {
      order.push('b1');
      order.push('b2');
    }),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2']);
});

// Proves the before/after view comparison ignores the hour of the update itself and gives the right averages and percent change.
test('before/after comparison skips the hour containing the update', () => {
  const at = Date.UTC(2026, 5, 10, 14, 30); // 14:30
  const hour14 = Date.UTC(2026, 5, 10, 14);
  const byHour = new Map();
  for (let i = 1; i <= 24; i++) byHour.set(hour14 - i * HOUR, 10); // 10 views/hour before
  byHour.set(hour14, 999); // the straddling hour must be ignored
  for (let i = 1; i <= 24; i++) byHour.set(hour14 + i * HOUR, 30); // 30 views/hour after
  const now = hour14 + 100 * HOUR;
  const result = compare(byHour, at, 24, now);
  assert.equal(result.before.avgPerHour, 10);
  assert.equal(result.after.avgPerHour, 30);
  assert.equal(result.changePct, 200);
});

// Proves that if no full hour has passed after the update yet, the "after" side is null (no fake numbers).
test('comparison reports null for a side without complete hours', () => {
  const at = Date.UTC(2026, 5, 10, 14, 30);
  const result = compare(new Map(), at, 24, at + 30 * 60 * 1000); // "now" is only 30 minutes after
  assert.equal(result.after, null);
});
