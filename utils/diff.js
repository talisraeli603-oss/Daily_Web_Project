'use strict';

/**
 * Small word-level diff (longest common subsequence), written for this project so the editor
 * can see what changed between the published text and the pending revision.
 * Returns a list of { type: 'same' | 'add' | 'del', text } operations.
 */
// Important: the comparison table has (words in old text) x (words in new text) cells. This cap keeps memory and time
// under control, so a huge article can't freeze the server.
const MAX_CELLS = 4_000_000; // safety limit for very long texts

// Splits text into "words" and "spaces" so we can compare word by word.
function tokenize(text) {
  // keep whitespace and newlines as their own tokens so the text can be rebuilt exactly
  return String(text || '').match(/\s+|[^\s]+/g) || [];
}

// Compares the old and new text and returns a list of pieces marked 'same', 'add' (new) or 'del' (removed).
// Important: it uses the Longest Common Subsequence idea (find the longest run of words that both texts share in order);
// whatever is not shared is a deletion or an addition.
function diffWords(oldText, newText) {
  const a = tokenize(oldText);
  const b = tokenize(newText);

  if (a.length * b.length > MAX_CELLS) {
    // Too large for LCS: fall back to "everything replaced".
    const ops = [];
    if (oldText) ops.push({ type: 'del', text: String(oldText) });
    if (newText) ops.push({ type: 'add', text: String(newText) });
    return ops;
  }

  const n = a.length;
  const m = b.length;
  const width = m + 1;
  // The table is one flat typed array (faster and lighter than an array of arrays).
  // table[i][j] = how many words (in the same order) the rest of the old text (from word i) and the rest of the new text (from word j) share.
  const table = new Uint32Array((n + 1) * width);

  // Fill the table from the end of both texts backwards.
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }

  const ops = [];
  // Adds a piece to the result. If the previous piece has the same type, it is merged into it,
  // so we get one long 'same' / 'add' / 'del' block instead of many one-word pieces.
  const push = (type, text) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  // Walk through both texts using the table: equal words are 'same', otherwise follow the path with the longer shared run.
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
      push('del', a[i++]);
    } else {
      push('add', b[j++]);
    }
  }
  // Whatever is left over: the rest of the old text was removed, the rest of the new text was added.
  while (i < n) push('del', a[i++]);
  while (j < m) push('add', b[j++]);
  return ops;
}

module.exports = { diffWords };
