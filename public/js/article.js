/*
 * Article page: comments (show the list, add a new one without reloading, load more).
 * Important: fetch (through DW.api) is used for Ajax, so the page never refreshes.
 */
(function () {
  'use strict';

  // The page elements we need. If this is not an article page they are missing and the script stops.
  const article = document.getElementById('article');
  const form = document.getElementById('comment-form');
  const list = document.getElementById('comment-list');
  if (!article || !form || !list) return;

  // Which article this is (from the page), more page elements, and whether the user is an editor.
  // cursor = marker from the server for the next batch of comments (empty = no more), seen = comment ids already on the page.
  const articleId = article.getAttribute('data-article-id');
  const errorBox = document.getElementById('comment-error');
  const submitBtn = document.getElementById('comment-submit');
  const emptyNote = document.getElementById('comments-empty');
  const moreBtn = document.getElementById('comments-more');
  const countEl = document.getElementById('comments-count');
  const isEditor = DW.role === 'editor';
  let cursor = list.getAttribute('data-next-cursor') || '';
  const seen = new Set(Array.from(list.children).map((li) => li.getAttribute('data-id')));

  // Fill in the name the visitor used last time (kept in the browser's localStorage) so they don't retype it.
  try {
    const saved = localStorage.getItem('dw.commentName');
    if (saved) form.elements.authorName.value = saved;
  } catch (e) { /* storage may be unavailable */ }

  // Updates the "(5+)" number next to the comments title and shows or hides the "no comments yet" note.
  // The "+" means there are more comments on the server that are not loaded yet.
  function updateCount() {
    const n = list.children.length;
    countEl.textContent = n ? '(' + n + (cursor ? '+' : '') + ')' : '';
    emptyNote.hidden = n > 0;
  }

  // Shows the message in the error box above the form, or hides the box if the message is empty.
  function showError(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  // Builds one comment (<li>) from the data the server sent. Editors also get a Delete button.
  // Important: built with DW.el (textContent), never innerHTML, so a comment can't inject HTML (XSS protection).
  function buildComment(c) {
    const item = DW.el('li', { class: 'comment', 'data-id': c.id },
      DW.el('p', { class: 'comment-head' },
        DW.el('strong', { text: c.authorName }),
        DW.el('time', { datetime: new Date(c.createdAt).toISOString(), text: DW.formatDateTime(c.createdAt) })),
      DW.el('p', { class: 'comment-text', text: c.text }));
    if (isEditor) addModeration(item, c.id);
    return item;
  }

  // Adds a Delete button to a comment. Only editors see it.
  // Important: hiding the button is just for looks - the server still checks the user's role on every DELETE request.
  function addModeration(item, id) {
    item.append(DW.el('button', {
      type: 'button', class: 'btn btn-small btn-danger', text: 'Delete',
      // On click of Delete: ask to confirm, tell the server to delete the comment, then remove it from the page.
      onclick: async () => {
        if (!confirm('Delete this comment?')) return;
        try {
          await DW.api('DELETE', '/api/v1/comments/' + encodeURIComponent(id));
          item.remove();
          seen.delete(id);
          updateCount();
        } catch (err) {
          DW.toast(err.message, 'error');
        }
      },
    }));
  }

  // If the user is an editor, also add Delete buttons to the comments the server already drew on the page.
  if (isEditor) Array.from(list.children).forEach((li) => addModeration(li, li.getAttribute('data-id')));

  // Quick check in the browser before sending: returns an error text, or empty text if all is fine.
  // The server checks again, because browser checks can be skipped.
  function validate() {
    const name = form.elements.authorName.value.trim();
    const text = form.elements.text.value.trim();
    if (!name) return 'Please enter your name.';
    if (!text) return 'Please write a comment.';
    if (text.length > 1000) return 'Comments are limited to 1000 characters.';
    return '';
  }

  // On submit of the comment form: stop the page refresh, check the input, send the comment to the server,
  // and show the new comment at the top of the list right away. The button is disabled while sending (no double posts).
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showError('');
    DW.showFieldErrors(form, null);
    const problem = validate();
    if (problem) return showError(problem);

    submitBtn.disabled = true;
    try {
      const comment = await DW.api('POST', '/api/v1/articles/' + encodeURIComponent(articleId) + '/comments', {
        authorName: form.elements.authorName.value.trim(),
        text: form.elements.text.value.trim(),
      });
      try { localStorage.setItem('dw.commentName', comment.authorName); } catch (err) { /* ignore */ }
      seen.add(comment.id);
      justPosted.set(comment.id, Date.now());
      list.prepend(buildComment(comment)); // appears immediately, the rest of the list is not reloaded
      form.elements.text.value = '';
      updateCount();
    } catch (err) {
      // 429 = the server blocked us (more than 3 comments / minute); 400 = invalid data
      showError(err.message);
      DW.showFieldErrors(form, err.details);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // On click of "load more": fetch the next batch of comments (using the cursor) and add them at the bottom of the list.
  moreBtn.addEventListener('click', async () => {
    moreBtn.disabled = true;
    try {
      const data = await DW.api('GET', '/api/v1/articles/' + encodeURIComponent(articleId) + '/comments?cursor=' + encodeURIComponent(cursor));
      data.items.forEach((c) => {
        if (seen.has(c.id)) return;
        seen.add(c.id);
        list.append(buildComment(c));
      });
      cursor = data.nextCursor || '';
      moreBtn.hidden = !cursor;
      updateCount();
    } catch (err) {
      DW.toast(err.message, 'error');
    } finally {
      moreBtn.disabled = false;
    }
  });

  // ---- Live updates: comments written in other browsers show up without a refresh ----
  // Important: this is "polling". Every few seconds the page asks the server for the newest comments (plain fetch,
  // the same Ajax we use everywhere) and adds the new ones on top. We chose polling because it needs no extra library
  // and no special server (a WebSocket library is not part of what we learned). The trade-off is a few seconds delay.
  const POLL_MS = 5000;
  let polling = false; // true while a request is running, so requests never pile up
  const justPosted = new Map(); // comment id -> time we posted it from this page (protects it from the delete check below)

  // Asks the server for the newest comments and updates the list on the page:
  // 1) comments we have not seen yet are added at the top, 2) comments an editor deleted elsewhere are removed.
  async function pollComments() {
    if (polling || document.hidden) return; // do nothing in a background tab or while the last request is still running
    polling = true;
    try {
      const data = await DW.api('GET', '/api/v1/articles/' + encodeURIComponent(articleId) + '/comments', undefined, { noRedirect: true });
      const serverIds = new Set(data.items.map((c) => c.id));

      // New comments: the server list is newest-first, so we go from the oldest new one to the newest
      // and put each one on top; the newest ends up first.
      data.items.filter((c) => !seen.has(c.id)).reverse().forEach((c) => {
        seen.add(c.id);
        list.prepend(buildComment(c));
      });

      // Deleted comments: the server only sent the newest page, so we can only judge comments that are
      // at least as new as the oldest comment in that page. If one of them is missing, it was deleted.
      const oldestSent = data.nextCursor && data.items.length ? new Date(data.items[data.items.length - 1].createdAt).getTime() : 0;
      Array.from(list.children).forEach((li) => {
        const id = li.getAttribute('data-id');
        const time = li.querySelector('time');
        const created = time ? new Date(time.getAttribute('datetime')).getTime() : 0;
        // (a comment we posted a moment ago may not be in a response that was requested before we posted it)
        const postedJustNow = Date.now() - (justPosted.get(id) || 0) < 15000;
        if (!serverIds.has(id) && created >= oldestSent && !postedJustNow) {
          li.remove();
          seen.delete(id);
        }
      });
      updateCount();
    } catch (err) {
      // A failed check is not important (maybe the network dropped): we simply try again at the next tick.
    } finally {
      polling = false;
    }
  }

  // Check every few seconds, and also right away when the reader comes back to this tab.
  setInterval(pollComments, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) pollComments();
  });

  // Set the starting comment count when the page loads.
  updateCount();
})();
