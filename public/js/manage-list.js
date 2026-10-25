/*
 * Article list used by BOTH the reporter workspace and the editor area (same script, different buttons).
 * Important: the server decides what each user may see (a reporter only receives their own articles),
 * so this script only changes how things look, not what is allowed.
 * Important: fetch (through DW.api) is used for Ajax: search, filter and paging happen without a page reload.
 */
(function () {
  'use strict';

  // The page elements: the list, the box for page buttons, and the search/filter form. Stop if they are missing.
  const list = document.getElementById('manage-list');
  const pagerBox = document.getElementById('manage-pager');
  const form = document.getElementById('list-filters');
  if (!list || !form) return;

  // area = "workspace" (reporter) or "editor", read from the page. It decides which buttons each row gets.
  const area = list.getAttribute('data-area');
  // page = the page number we are showing, controller = AbortController of the request in flight.
  const state = { page: 1, controller: null };

  // If the URL has ?status=..., preselect that status in the dropdown (only if it is a real option).
  const initial = new URLSearchParams(window.location.search).get('status');
  if (initial && Array.from(form.elements.status.options).some((o) => o.value === initial)) form.elements.status.value = initial;

  // Makes the buttons for one article row. Reporters get Edit / Fix and resubmit / View.
  // Editors get Review, Edit and Delete. "View live" shows if a published version exists.
  function actionsFor(item) {
    const id = encodeURIComponent(item.id);
    const actions = [];
    if (area === 'workspace') {
      const pending = item.status === 'pending_approval';
      actions.push(DW.el('a', {
        class: 'btn btn-small' + (pending ? ' btn-ghost' : ''),
        href: '/workspace/articles/' + id + '/edit',
        text: pending ? 'View' : item.status === 'returned' ? 'Fix and resubmit' : 'Edit',
      }));
    } else {
      actions.push(DW.el('a', {
        class: 'btn btn-small' + (item.status === 'pending_approval' ? '' : ' btn-ghost'),
        href: '/editor/articles/' + id,
        text: item.status === 'pending_approval' ? 'Review & decide' : 'Open',
      }));
      actions.push(DW.el('a', { class: 'btn btn-small btn-ghost', href: '/editor/articles/' + id + '/edit', text: 'Edit' }));
      actions.push(DW.el('button', {
        type: 'button', class: 'btn btn-small btn-danger', text: 'Delete',
        // On click of Delete: call remove() for this article.
        onclick: () => remove(item),
      }));
    }
    if (item.hasLiveVersion) {
      actions.push(DW.el('a', { class: 'btn btn-small btn-ghost', href: '/articles/' + id, text: 'View live' }));
    }
    return DW.el('div', { class: 'row-actions' }, actions);
  }

  // Builds one row of the list: title, category, author (editors only), dates, status badge, editor note and buttons.
  // Important: built with DW.el (textContent), never innerHTML, so titles and notes can't inject HTML (XSS protection).
  function row(item) {
    return DW.el('article', { class: 'row', 'data-id': item.id },
      DW.el('div', { class: 'row-main' },
        DW.el('h2', { class: 'row-title', text: item.title }),
        DW.el('p', { class: 'row-meta' },
          item.category ? DW.el('span', { class: 'tag', text: item.category }) : DW.el('span', { class: 'muted', text: 'No category yet' }),
          area === 'editor' ? DW.el('span', { text: 'By ' + item.author.displayName }) : null,
          DW.el('span', { text: 'Updated ' + DW.formatDateTime(item.updatedAt) }),
          item.hasLiveVersion ? DW.el('span', { text: item.viewCount + ' views' }) : null),
        item.status === 'returned' && item.editorNote
          ? DW.el('p', { class: 'editor-note' }, DW.el('strong', { text: 'Editor note: ' }), item.editorNote)
          : null,
        item.hasLiveVersion && item.status !== 'published'
          ? DW.el('p', { class: 'muted small', text: 'An earlier approved version is still shown to readers until this update is approved.' })
          : null),
      DW.el('div', { class: 'row-side' }, DW.statusBadge(item.status), actionsFor(item)));
  }

  // Loads the current page from the server with the search and status filter, then draws the rows and the page buttons.
  // Important: AbortController cancels the previous request, so a slow old answer can't overwrite the newest list.
  async function load() {
    if (state.controller) state.controller.abort();
    const controller = new AbortController();
    state.controller = controller;
    const params = new URLSearchParams({ page: String(state.page) });
    if (form.elements.q.value.trim()) params.set('q', form.elements.q.value.trim());
    if (form.elements.status.value !== 'all') params.set('status', form.elements.status.value);

    try {
      const data = await DW.api('GET', '/api/v1/manage/articles?' + params, undefined, { signal: controller.signal });
      if (state.page > data.pages) {
        state.page = data.pages;
        return load();
      }
      list.replaceChildren();
      if (!data.items.length) {
        list.append(DW.el('p', { class: 'empty', text: area === 'workspace' ? 'No articles here yet.' : 'No articles match.' }));
      } else {
        list.append(DW.el('p', { class: 'muted small', text: data.total + ' article' + (data.total === 1 ? '' : 's') }));
        data.items.forEach((item) => list.append(row(item)));
      }
      // When a page button is clicked: remember the new page, load it, and scroll back to the top.
      DW.pager(pagerBox, data.page, data.pages, (p) => {
        state.page = p;
        load();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
    } catch (err) {
      if (err.name === 'AbortError') return;
      list.replaceChildren(
        DW.el('div', { class: 'feed-error', role: 'alert' },
          DW.el('p', { text: err.message }),
          DW.el('button', { type: 'button', class: 'btn btn-small', text: 'Try again', onclick: load }))
      );
    }
  }

  // Deletes an article (with its comments and statistics) after the user confirms, then reloads the list.
  // The server still checks the user's permissions before it deletes anything.
  async function remove(item) {
    if (!confirm('Delete "' + item.title + '" together with its comments and statistics? This cannot be undone.')) return;
    try {
      await DW.api('DELETE', '/api/v1/manage/articles/' + encodeURIComponent(item.id));
      DW.toast('Article deleted.', 'success');
      load();
    } catch (err) {
      DW.toast(err.message, 'error');
    }
  }

  // Important: debounce waits 300ms after the user stops typing, then goes back to page 1 and reloads the list.
  // That way we don't send a request for every letter.
  const debounced = DW.debounce(() => {
    state.page = 1;
    load();
  }, 300);
  // On submit (Enter key): stop the page refresh, cancel the waiting search and search right now from page 1.
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    debounced.cancel();
    state.page = 1;
    load();
  });
  // Live search while typing (with the debounce wait).
  form.elements.q.addEventListener('input', debounced);
  // When the status dropdown changes: go back to page 1 and reload.
  form.elements.status.addEventListener('change', () => {
    state.page = 1;
    load();
  });

  // First load when the page opens.
  load();
})();
