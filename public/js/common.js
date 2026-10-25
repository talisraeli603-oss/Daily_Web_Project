/*
 * Shared browser helpers (Vanilla JavaScript - no libraries).
 * Exposes one global object: window.DW
 */
(function () {
  'use strict';

  // Turns the status codes saved in the database into text people can read (used for the badges).
  const STATUS_LABELS = {
    in_preparation: 'In preparation',
    pending_approval: 'Awaiting editor approval',
    returned: 'Returned for corrections',
    published: 'Published',
  };

  /** Our own error type for failed server calls. It keeps the HTTP status (like 404) and the per-field messages. */
  class ApiError extends Error {
    // Saves the message, the HTTP status and the validation details on the error object.
    constructor(status, message, details) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.details = details || null;
    }
  }

  /**
   * One helper that every page uses to talk to the server. It sends and receives JSON and the page never reloads.
   * Any failure (no network, 4xx, 5xx, bad JSON) becomes an ApiError with a readable message.
   * Important: fetch is used for Ajax. An optional AbortSignal lets the caller cancel the request,
   * and keepalive lets a request finish even while the page is closing (used by autosave).
   * Important: if the server answers 401 (not logged in) we send the user to the login page and bring them back after.
   */
  async function api(method, url, body, options) {
    const init = {
      method,
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
      signal: options && options.signal,
      keepalive: !!(options && options.keepalive),
    };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    let response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.');
    }

    if (response.status === 204) return null;

    let data = null;
    try {
      data = await response.json();
    } catch (err) {
      /* body is not JSON */
    }

    if (!response.ok) {
      const info = (data && data.error) || {};
      if (response.status === 401 && !(options && options.noRedirect)) {
        // Session expired or never existed: go to the login page, then come back.
        window.location.href = '/login?next=' + encodeURIComponent(window.location.pathname + window.location.search);
      }
      throw new ApiError(response.status, info.message || 'Something went wrong (' + response.status + ').', info.details);
    }
    return data;
  }

  /**
   * Small helper that builds an HTML element: el('p', { class: 'x', text: 'hi' }, child1, child2).
   * Important: text goes in with textContent / createTextNode, never innerHTML, so text written by users
   * can't inject HTML or scripts (XSS protection). Attributes starting with "on" become event listeners.
   */
  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) {
      // Go through each attribute: skip empty ones, otherwise set it the right way for its type.
      Object.keys(attrs).forEach((key) => {
        const value = attrs[key];
        if (value === undefined || value === null || value === false) return;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, value);
      });
    }
    children.flat().forEach((child) => {
      if (child === undefined || child === null || child === false) return;
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    });
    return node;
  }

  /**
   * Important: debounce waits until the user stops (typing, for example) for `wait` milliseconds before it
   * runs the function. So we send one request instead of one for every key press.
   * The returned function also has .cancel() to drop a call that is still waiting.
   */
  function debounce(fn, wait) {
    // The timer of the call that is currently waiting.
    let timer;
    // Each new call cancels the waiting one and starts the countdown again.
    const wrapped = (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
    // Lets the caller stop the waiting call (for example when the form is submitted right away).
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
  }

  // Date formatters made once and reused. Intl uses the reader's own language and time zone.
  const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });
  const dateTimeFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  // Shows only the date (e.g. "Oct 24, 2026"); empty text if there is no date.
  const formatDate = (d) => (d ? dateFmt.format(new Date(d)) : '');
  // Shows date and time; empty text if there is no date.
  const formatDateTime = (d) => (d ? dateTimeFmt.format(new Date(d)) : '');

  /** Friendly relative time ("5 min ago", "yesterday"); older than a week falls back to the full date and time. */
  function timeAgo(d) {
    if (!d) return '';
    const diff = Date.now() - new Date(d).getTime();
    const minute = 60 * 1000;
    if (diff < 0 || diff >= 7 * 24 * 60 * minute) return formatDateTime(d);
    if (diff < minute) return 'just now';
    if (diff < 60 * minute) return Math.floor(diff / minute) + ' min ago';
    if (diff < 24 * 60 * minute) {
      const h = Math.floor(diff / (60 * minute));
      return h + (h === 1 ? ' hour ago' : ' hours ago');
    }
    const days = Math.floor(diff / (24 * 60 * minute));
    return days === 1 ? 'yesterday' : days + ' days ago';
  }

  /**
   * The server writes dates in UTC. This finds every <time> tag and rewrites its text in the reader's own time zone.
   * The data-local-* attribute on the tag says which format to use (ago / date / date and time).
   */
  function localizeTimes(root) {
    // Go over each <time> tag and fill in its text.
    (root || document).querySelectorAll('time[datetime]').forEach((t) => {
      if (t.hasAttribute('data-local-ago')) {
        t.textContent = timeAgo(t.getAttribute('datetime'));
        t.title = formatDateTime(t.getAttribute('datetime'));
      } else if (t.hasAttribute('data-local-date')) t.textContent = formatDate(t.getAttribute('datetime'));
      else if (t.hasAttribute('data-local-datetime')) t.textContent = formatDateTime(t.getAttribute('datetime'));
    });
  }

  // Shows a small popup message (success / error / info) that disappears by itself (errors stay a bit longer).
  function toast(message, type) {
    const box = document.getElementById('toasts');
    if (!box) return;
    const node = el('div', { class: 'toast toast-' + (type || 'info'), text: message });
    box.append(node);
    setTimeout(() => node.remove(), type === 'error' ? 6000 : 3500);
  }

  // Makes the colored label that shows an article's status (e.g. "Published").
  function statusBadge(status) {
    return el('span', { class: 'badge badge-' + status, text: STATUS_LABELS[status] || status });
  }

  /**
   * Builds the same article card the server already draws in the EJS page, so cards added by infinite scroll look identical.
   * Important: built with el() (textContent), not innerHTML, so titles and names can't inject HTML (XSS protection).
   * The image uses loading="lazy" so the browser only downloads pictures when they get close to the screen.
   */
  function buildCard(item) {
    const link = '/articles/' + encodeURIComponent(item.id);
    return el(
      'article',
      { class: 'card', 'data-id': item.id, 'data-category': item.category },
      el('a', { class: 'card-image', href: link, tabindex: '-1', 'aria-hidden': 'true' },
        el('img', { src: item.image, alt: '', loading: 'lazy', width: '400', height: '225' })),
      el('div', { class: 'card-body' },
        el('p', { class: 'card-meta' },
          el('span', { class: 'tag', text: item.category }),
          el('span', { text: 'By ' + item.author.displayName }),
          el('time', { datetime: new Date(item.publishedAt).toISOString(), title: formatDateTime(item.publishedAt), text: timeAgo(item.publishedAt) })),
        el('h2', { class: 'card-title' }, el('a', { href: link, text: item.title })),
        el('p', { class: 'card-summary', text: item.summary }),
        el('p', { class: 'card-foot' },
          el('a', { class: 'read-more', href: link, text: 'Read the full article' }),
          el('span', { class: 'muted views', text: item.viewCount + ' views' })))
    );
  }

  // Builds the "Review history" box: every time the article was submitted, returned (with the editor's note)
  // or approved, newest first. Used on the edit page (reporter and editor) and on the review page (editor),
  // so both sides can read ALL earlier notes, not only the latest one. Returns null when there is nothing yet.
  // Important: text goes in with textContent (through el), so a note can't inject HTML.
  function buildReviewHistory(history) {
    if (!history || !history.length) return null;
    const verbs = { submitted: 'sent the article for approval', returned: 'returned the article for corrections', approved: 'approved and published the article' };
    // One list item per event, newest first (slice() makes a copy so we don't reverse the original array).
    const items = history.slice().reverse().map((e) =>
      el('li', { class: 'review-event review-' + e.action },
        el('p', { class: 'review-event-head' },
          el('strong', { text: e.byName || (e.role === 'editor' ? 'An editor' : 'The reporter') }),
          ' ' + (verbs[e.action] || e.action) + ' ',
          el('time', { datetime: new Date(e.at).toISOString(), class: 'muted', text: formatDateTime(e.at) })),
        e.note ? el('p', { class: 'editor-note', text: e.note }) : null));
    return el('section', { class: 'review-log', 'aria-labelledby': 'review-log-title' },
      el('h2', { id: 'review-log-title', text: 'Review history (' + history.length + ')' }),
      el('ol', { class: 'review-events' }, items));
  }

  /** Shows per-field validation messages returned by the server next to the matching inputs. */
  function showFieldErrors(form, details) {
    form.querySelectorAll('.field-error').forEach((n) => n.remove());
    form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    if (!details) return;
    // For every field the server complained about, mark it invalid and put the message right after it.
    Object.keys(details).forEach((name) => {
      const input = form.elements[name];
      if (!input) return;
      input.setAttribute('aria-invalid', 'true');
      input.insertAdjacentElement('afterend', el('span', { class: 'field-error', text: String(details[name]) }));
    });
  }

  // Draws the "Previous / Page X of Y / Next" buttons. Calls onChange(newPage) when one is clicked. Draws nothing if there is only one page.
  function pager(container, page, pages, onChange) {
    container.replaceChildren();
    if (pages <= 1) return;
    container.append(
      el('button', { type: 'button', class: 'btn btn-small btn-ghost', disabled: page <= 1, onclick: () => onChange(page - 1), text: 'Previous' }),
      el('span', { class: 'muted', text: 'Page ' + page + ' of ' + pages }),
      el('button', { type: 'button', class: 'btn btn-small btn-ghost', disabled: page >= pages, onclick: () => onChange(page + 1), text: 'Next' })
    );
  }

  // The only global: window.DW. Other scripts (feed.js, edit.js...) use these helpers as DW.api, DW.el, etc.
  // DW.role is the logged-in user's role, read from the data-user-role attribute on <body>.
  window.DW = {
    timeAgo, buildReviewHistory, api, ApiError, el, debounce, formatDate, formatDateTime, localizeTimes, toast,
    statusBadge, buildCard, showFieldErrors, pager, STATUS_LABELS,
    role: document.body.getAttribute('data-user-role') || '',
  };

  // Convert the dates already on the page to the reader's time zone as soon as the script loads.
  localizeTimes();

  /** "Back to top" button, shown after scrolling down (handy on the long infinite-scroll feed). */
  const toTop = el('button', { type: 'button', class: 'to-top', 'aria-label': 'Back to top', title: 'Back to top', text: '\u2191', hidden: true,
    onclick: () => window.scrollTo({ top: 0, behavior: 'smooth' }) });
  document.body.append(toTop);
  // On every scroll: show the button once the page is scrolled down more than 700px, hide it otherwise.
  // Important: { passive: true } tells the browser we won't block scrolling, so scrolling stays smooth.
  window.addEventListener('scroll', () => { toTop.hidden = window.scrollY < 700; }, { passive: true });
})();
