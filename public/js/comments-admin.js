/* Editor: search, correct and delete reader comments */
(function () {
  'use strict';

  // Grab the page elements. If the list or the search form is missing, this is not the comments page, so stop.
  const box = document.getElementById('comments-admin');
  const pagerBox = document.getElementById('comments-pager');
  const form = document.getElementById('comment-filters');
  if (!box || !form) return;

  // state.page = which page of comments we are looking at.
  const state = { page: 1 };

  // Builds one comment row: author, date, link to the article, the text, and Edit / Delete buttons.
  // Important: everything is built with DW.el (textContent), so a comment can't inject HTML (XSS protection).
  function row(c) {
    const text = DW.el('p', { class: 'comment-text', text: c.text });
    const item = DW.el('article', { class: 'row', 'data-id': c.id });
    const actions = DW.el('div', { class: 'row-actions' });

    const editBtn = DW.el('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Edit' });
    const delBtn = DW.el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Delete' });
    actions.append(editBtn, delBtn);

    // Edit click: swap the comment text for a text box with Save and Cancel buttons.
    editBtn.addEventListener('click', () => {
      const area = DW.el('textarea', { rows: '3', maxlength: '1000' });
      area.value = c.text;
      const save = DW.el('button', { type: 'button', class: 'btn btn-small', text: 'Save' });
      const cancel = DW.el('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Cancel' });
      const errorLine = DW.el('p', { class: 'form-error', role: 'alert', hidden: true });
      const editor = DW.el('div', { class: 'stack' }, area, errorLine, DW.el('div', { class: 'row-actions' }, save, cancel));
      text.replaceWith(editor);
      // Cancel click: throw the text box away and show the old text again.
      cancel.addEventListener('click', () => editor.replaceWith(text));
      // Save click: send the new text to the server; on success show the saved text, on error show the message under the box.
      save.addEventListener('click', async () => {
        try {
          const updated = await DW.api('PUT', '/api/v1/comments/' + encodeURIComponent(c.id), { text: area.value });
          c.text = updated.text;
          text.textContent = updated.text;
          editor.replaceWith(text);
          DW.toast('Comment updated.', 'success');
        } catch (err) {
          errorLine.textContent = err.message;
          errorLine.hidden = false;
        }
      });
    });

    // Delete click: ask first, then delete the comment on the server and reload the list.
    delBtn.addEventListener('click', async () => {
      if (!confirm('Delete this comment?')) return;
      try {
        await DW.api('DELETE', '/api/v1/comments/' + encodeURIComponent(c.id));
        DW.toast('Comment deleted.', 'success');
        load();
      } catch (err) {
        DW.toast(err.message, 'error');
      }
    });

    item.append(
      DW.el('div', { class: 'row-main' },
        DW.el('p', { class: 'row-meta' },
          DW.el('strong', { text: c.authorName }),
          DW.el('time', { datetime: new Date(c.createdAt).toISOString(), text: DW.formatDateTime(c.createdAt) }),
          DW.el('a', { href: '/articles/' + encodeURIComponent(c.article), text: 'On: ' + c.articleTitle })),
        text),
      DW.el('div', { class: 'row-side' }, actions)
    );
    return item;
  }

  // Loads one page of comments (filtered by the search box) and draws them.
  async function load() {
    const params = new URLSearchParams({ page: String(state.page) });
    if (form.elements.q.value.trim()) params.set('q', form.elements.q.value.trim());
    try {
      const data = await DW.api('GET', '/api/v1/comments?' + params);
      // If we are on a page that no longer exists (for example we just deleted the last comment on it), go to the last page.
      if (state.page > data.pages) {
        state.page = data.pages;
        return load();
      }
      box.replaceChildren();
      if (!data.items.length) box.append(DW.el('p', { class: 'empty', text: 'No comments found.' }));
      else box.append(DW.el('p', { class: 'muted small', text: data.total + ' comment' + (data.total === 1 ? '' : 's') }));
      data.items.forEach((c) => box.append(row(c)));
      // Page buttons: go to the clicked page and reload.
      DW.pager(pagerBox, data.page, data.pages, (p) => {
        state.page = p;
        load();
      });
    } catch (err) {
      box.replaceChildren(DW.el('p', { class: 'form-error', role: 'alert', text: err.message }));
    }
  }

  // Search while typing, but wait 300 ms after the last key so we don't send a request on every letter (debounce).
  const debounced = DW.debounce(() => {
    state.page = 1;
    load();
  }, 300);
  // Pressing Enter in the search form: cancel the waiting debounce and search right now.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    debounced.cancel();
    state.page = 1;
    load();
  });
  form.elements.q.addEventListener('input', debounced);
  load();
})();
