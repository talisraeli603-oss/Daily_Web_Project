/*
 * Home feed: search, filter, sort and infinite scroll - all with Ajax, no full page reloads.
 * The first 20 articles are drawn by the server (EJS); this script loads the rest when the reader needs them.
 * Important: fetch (through DW.api) is used for Ajax, so the page never refreshes.
 */
(function () {
  'use strict';

  // The page elements we work with: filter form, article list, status message, the invisible "bottom marker", and a screen-reader message.
  const form = document.getElementById('filters');
  const feed = document.getElementById('feed');
  const status = document.getElementById('feed-status');
  const sentinel = document.getElementById('feed-sentinel');
  const announce = document.getElementById('feed-count');
  if (!form || !feed) return;

  // Everything the feed needs to remember:
  // cursor = marker from the server that says where the next 20 articles start (cursor pagination),
  // loading = a request is running, done = no more articles left,
  // controller = lets us cancel the request in flight, seen = ids already shown (to avoid duplicates).
  const state = {
    cursor: feed.getAttribute('data-next-cursor') || '',
    loading: false,
    done: !feed.getAttribute('data-next-cursor'),
    controller: null, // AbortController of the request in flight
    seen: new Set(Array.from(feed.querySelectorAll('.card')).map((c) => c.getAttribute('data-id'))),
  };

  // Reads the current values of the search box and the dropdowns from the form.
  function filters() {
    return {
      q: form.elements.q.value.trim(),
      category: form.elements.category.value,
      viewed: form.elements.viewed.value,
      sort: form.elements.sort.value,
    };
  }

  // Builds the "?q=...&category=..." part of the URL. Default values are left out so the URL stays short.
  // `extra` adds more parameters, like the cursor. URLSearchParams also escapes special characters for us.
  function queryString(extra) {
    const params = new URLSearchParams();
    const f = filters();
    if (f.q) params.set('q', f.q);
    if (f.category) params.set('category', f.category);
    if (f.viewed && f.viewed !== 'all') params.set('viewed', f.viewed);
    if (f.sort && f.sort !== 'date') params.set('sort', f.sort);
    Object.keys(extra || {}).forEach((k) => extra[k] && params.set(k, extra[k]));
    return params.toString();
  }

  // Puts one message (like "Loading...") under the list, or clears it when there is nothing to show.
  function setStatus(node) {
    status.replaceChildren();
    if (node) status.append(node);
  }

  // Shows the error message with a "Try again" button that calls loadMore again.
  function showError(err) {
    setStatus(
      DW.el('div', { class: 'feed-error', role: 'alert' },
        DW.el('p', { text: err.message || 'Could not load articles.' }),
        DW.el('button', { type: 'button', class: 'btn btn-small', text: 'Try again', onclick: () => loadMore() }))
    );
  }

  /**
   * Loads the next 20 articles with the current filters and adds the cards at the bottom (infinite scroll).
   * Does nothing if a request is already running or there are no more articles.
   * Important: it passes an AbortController signal so a new search can cancel this request.
   */
  async function loadMore() {
    if (state.loading || state.done) return;
    state.loading = true;
    setStatus(DW.el('p', { class: 'muted', text: 'Loading more articles...' }));

    const controller = new AbortController();
    state.controller = controller;
    try {
      const data = await DW.api('GET', '/api/v1/articles?' + queryString({ cursor: state.cursor }), undefined, { signal: controller.signal });
      appendItems(data.items);
      state.cursor = data.nextCursor || '';
      state.done = !data.nextCursor;
      setStatus(state.done && feed.children.length ? DW.el('p', { class: 'muted end-note', text: 'You have reached the end.' }) : null);
    } catch (err) {
      if (err.name === 'AbortError') return; // a newer search replaced this request
      showError(err);
    } finally {
      if (state.controller === controller) {
        state.loading = false;
        state.controller = null;
      }
      observeAgain();
    }
  }

  // Turns the articles from the server into cards and adds them to the page, skipping ones we already show.
  // Important: all cards go into a DocumentFragment first and are added in one step, which is faster than adding them one by one.
  function appendItems(items) {
    const fragment = document.createDocumentFragment();
    items.forEach((item) => {
      if (state.seen.has(item.id)) return; // ignore duplicates (e.g. popularity changed between pages)
      state.seen.add(item.id);
      fragment.append(DW.buildCard(item));
    });
    feed.append(fragment);
  }

  /**
   * Starts a brand-new search / filter / sort: clears the list and loads page one again.
   * Important: AbortController cancels the old request first, so a slow old search can't overwrite the newest results.
   * Important: history.replaceState updates the address bar so the URL can be shared, without reloading the page.
   */
  async function reload() {
    if (state.controller) state.controller.abort();
    state.controller = null;
    state.loading = false;
    state.cursor = '';
    state.done = false;
    state.seen = new Set();
    feed.replaceChildren();
    feed.setAttribute('aria-busy', 'true');

    const qs = queryString();
    history.replaceState(null, '', qs ? '/?' + qs : '/'); // keep the URL shareable without reloading

    setStatus(DW.el('p', { class: 'muted', text: 'Searching...' }));
    const controller = new AbortController();
    state.controller = controller;
    state.loading = true;
    try {
      const data = await DW.api('GET', '/api/v1/articles?' + qs, undefined, { signal: controller.signal });
      appendItems(data.items);
      state.cursor = data.nextCursor || '';
      state.done = !data.nextCursor;
      announce.textContent = data.items.length ? '' : 'No articles found.';
      setStatus(!data.items.length ? DW.el('p', { class: 'empty', text: 'No articles match your search.' }) : null);
    } catch (err) {
      if (err.name === 'AbortError') return;
      state.done = false;
      showError(err);
    } finally {
      feed.removeAttribute('aria-busy');
      if (state.controller === controller) {
        state.loading = false;
        state.controller = null;
      }
      observeAgain();
    }
  }

  /* ---- infinite scroll: load the next page when the user gets near the bottom ---- */
  // The IntersectionObserver (created below). It stays null in browsers that don't support it.
  let observer = null;
  // Makes the observer check the bottom marker again, so more articles load if it is still on screen.
  function observeAgain() {
    if (!observer) return;
    // Re-observing re-triggers the callback if the sentinel is still visible (short pages).
    observer.unobserve(sentinel);
    observer.observe(sentinel);
  }

  // Important: IntersectionObserver tells us when the reader scrolled near the bottom (the marker is within 400px
  // of the screen), so we load the next 20 articles without a page refresh (infinite scroll).
  // It is more efficient than listening to every scroll event.
  if ('IntersectionObserver' in window) {
    observer = new IntersectionObserver(
      // Called when the marker enters or leaves the screen. If it is visible, load more articles.
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '400px 0px' }
    );
    observer.observe(sentinel);
  } else {
    // Very old browsers: a simple "load more" button instead
    sentinel.replaceChildren(DW.el('button', { type: 'button', class: 'btn', text: 'Load more', onclick: loadMore }));
  }

  /* ---- controls ---- */
  // Important: debounce waits 300ms after the user stops typing before searching, so we don't send a request for every letter.
  const debouncedReload = DW.debounce(reload, 300);
  // When the form is submitted (Enter key): stop the normal page refresh, cancel the waiting search and search right now.
  form.addEventListener('submit', (e) => {
    e.preventDefault(); // no full page refresh
    debouncedReload.cancel();
    reload();
  });
  // Live search: every time the user types in the search box, search (after the short debounce wait).
  form.elements.q.addEventListener('input', debouncedReload);
  // The dropdowns (category, viewed, sort) reload the list as soon as the choice changes.
  ['category', 'viewed', 'sort'].forEach((name) => form.elements[name].addEventListener('change', reload));

  const reset = document.getElementById('f-reset');
  if (reset) {
    // On click of "Reset": put every filter back to its default value and reload the list.
    reset.addEventListener('click', (e) => {
      e.preventDefault();
      form.reset();
      form.elements.q.value = '';
      form.elements.category.value = '';
      form.elements.viewed.value = 'all';
      form.elements.sort.value = 'date';
      reload();
    });
  }
})();
