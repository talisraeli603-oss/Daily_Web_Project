/*
 * Editor review page: see what is published now vs. what is waiting for approval,
 * then approve & publish, return with a note, edit, or delete.
 * Important: the page itself is an empty shell (review.ejs). This script asks the API for the
 * article and builds everything in the browser with DW.el, which uses textContent,
 * so article text can never inject HTML (XSS protection).
 */
(function () {
  'use strict';

  // The empty box from review.ejs where we draw everything. If it is missing, this is not the review page.
  const root = document.getElementById('review-root');
  if (!root) return;
  // The article id comes from the data-article-id attribute that the server put on the box.
  const id = root.getAttribute('data-article-id');
  const statusSlot = document.getElementById('review-status');
  // Start of every API address for this article (approve, return, delete add something to the end).
  const base = '/api/v1/manage/articles/' + encodeURIComponent(id);

  /** Renders diff operations. side "old": unchanged + removed text. side "new": unchanged + added text. */
  // Builds one column of the comparison. Unchanged text is plain, removed text goes in <del>, added text goes in <ins>.
  // Important: the server compares the two versions word by word, so the editor sees exactly what changed.
  function diffText(ops, side) {
    const box = DW.el('div', { class: 'diff-text' });
    ops.forEach((op) => {
      if (op.type === 'same') box.append(document.createTextNode(op.text));
      else if (op.type === 'del' && side === 'old') box.append(DW.el('del', { text: op.text }));
      else if (op.type === 'add' && side === 'new') box.append(DW.el('ins', { text: op.text }));
    });
    return box;
  }

  // Shows the main image, or a small "No image" text if the article has none.
  function image(src) {
    return src ? DW.el('img', { class: 'review-image', src, alt: 'Main image' }) : DW.el('p', { class: 'muted', text: 'No image' });
  }

  // The nice names shown above each compared field.
  const LABELS = { title: 'Title', category: 'Category', summary: 'Summary', image: 'Main image', content: 'Article text' };

  /** Side-by-side comparison for an update to a published article. */
  // Draws the "published version vs. new version" comparison, one block per field (title, category, summary, image, text).
  function renderDiff(detail) {
    const { live, revision, diff } = detail;
    const wrap = DW.el('section', { class: 'diff', 'aria-labelledby': 'diff-title' },
      DW.el('h2', { id: 'diff-title', text: 'Published version vs. new version' }),
      DW.el('p', { class: 'muted', text: 'Removed text is shown in red on the left, added text in green on the right.' }));

    const head = DW.el('div', { class: 'diff-cols diff-head' },
      DW.el('div', { class: 'diff-col' }, DW.el('h3', { text: 'Published now (' + DW.formatDateTime(live.publishedAt) + ')' })),
      DW.el('div', { class: 'diff-col' }, DW.el('h3', { text: 'New version waiting' })));
    wrap.append(head);

    // Go through every field in a fixed order and add a block with the old side and the new side.
    ['title', 'category', 'summary', 'image', 'content'].forEach((field) => {
      const changed = diff && diff[field] && diff[field].changed;
      let left;
      let right;
      if (field === 'image') {
        // Images can't be compared word by word, so we just show both pictures.
        left = image(live.image);
        right = image(revision.image);
      } else {
        left = diffText(diff[field].ops, 'old');
        right = diffText(diff[field].ops, 'new');
      }
      wrap.append(
        DW.el('div', { class: 'diff-block' },
          DW.el('h4', { class: 'diff-label' }, LABELS[field], changed ? DW.el('span', { class: 'badge badge-changed', text: 'changed' }) : DW.el('span', { class: 'muted small', text: ' unchanged' })),
          DW.el('div', { class: 'diff-cols' },
            DW.el('div', { class: 'diff-col' }, DW.el('span', { class: 'col-tag', text: 'Published now' }), left),
            DW.el('div', { class: 'diff-col' }, DW.el('span', { class: 'col-tag', text: 'New version' }), right))));
    });
    return wrap;
  }

  // Shows the article content when there is nothing to compare (a brand-new article, or one with no update waiting).
  function renderContent(detail) {
    const c = detail.current;
    const heading = detail.revision ? 'Submitted content' : 'Published content';
    return DW.el('section', { class: 'review-content' },
      DW.el('h2', { text: heading }),
      DW.el('h3', { class: 'review-title', text: c.title || '(no title)' }),
      DW.el('p', { class: 'card-meta' }, DW.el('span', { class: 'tag', text: c.category || 'No category' })),
      image(c.image),
      DW.el('p', { class: 'article-summary', text: c.summary }),
      DW.el('div', { class: 'diff-text', text: c.content }));
  }

  // Builds the list of times this article was published or updated. Returns null if it was never published.
  function renderHistory(detail) {
    if (!detail.publishHistory.length) return null;
    return DW.el('section', { class: 'review-history' },
      DW.el('h2', { text: 'Publication history' }),
      DW.el('ul', { class: 'marker-list' }, detail.publishHistory.map((e) =>
        DW.el('li', {}, DW.el('strong', { text: e.kind === 'initial' ? 'First published' : 'Update published' }), ' - ' + DW.formatDateTime(e.at)))),
      DW.el('p', {}, DW.el('a', { href: '/editor/analytics?article=' + encodeURIComponent(id), text: 'See the views chart for this article' })));
  }

  // Runs one editor action (approve / return). Asks "are you sure?" if needed, shows a message,
  // then reloads the page content so the new state is visible.
  async function act(label, request, confirmText) {
    if (confirmText && !confirm(confirmText)) return;
    try {
      await request();
      DW.toast(label, 'success');
      load();
    } catch (err) {
      DW.toast(err.message, 'error');
      // If the server complained about the note (for example it was empty), show it next to the note field.
      const noteField = document.getElementById('return-note');
      if (noteField && err.details) DW.showFieldErrors(noteField.form, err.details);
    }
  }

  // Builds the "Decision" panel with the approve button, the return-with-note form, and the edit / view / delete buttons.
  // Important: approve and return only show up when the article is waiting for approval (the server checks this too).
  function renderActions(detail) {
    const panel = DW.el('section', { class: 'review-actions', 'aria-labelledby': 'actions-title' }, DW.el('h2', { id: 'actions-title', text: 'Decision' }));

    if (detail.status === 'pending_approval') {
      panel.append(
        DW.el('button', {
          type: 'button', class: 'btn btn-success', text: 'Approve and publish',
          // Click: ask for confirmation, then tell the server to publish this version.
          onclick: () => act('Published. Readers now see this version.', () => DW.api('POST', base + '/approve'),
            'Approve this version and show it to readers?'),
        })
      );
      const form = DW.el('form', { class: 'stack return-form', novalidate: true },
        DW.el('div', { class: 'field' },
          DW.el('label', { for: 'return-note', text: 'Or return it to the reporter with a note about the corrections needed' }),
          DW.el('textarea', { id: 'return-note', name: 'note', rows: '4', maxlength: '1000', placeholder: 'What should the reporter fix?' })),
        DW.el('button', { type: 'submit', class: 'btn btn-warning', text: 'Return for corrections' }));
      // Submit: the note is required. If it is empty we show an error, otherwise we send the article back to the reporter.
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        DW.showFieldErrors(form, null);
        const note = form.elements.note.value.trim();
        if (!note) {
          DW.showFieldErrors(form, { note: 'Please explain which corrections are needed.' });
          return;
        }
        act('Returned to the reporter.', () => DW.api('POST', base + '/return', { note }));
      });
      panel.append(form);
    } else if (detail.status === 'in_preparation' && detail.live) {
      // Editor shortcut: a new version of an already published article (for example one the editor just edited)
      // can be published directly, without waiting for the reporter to submit it. The server allows this too.
      panel.append(
        DW.el('p', { class: 'muted', text: 'This is a new version of an article that is already published. You can publish it now, or leave it for the reporter to finish and submit.' }),
        DW.el('button', {
          type: 'button', class: 'btn btn-success', text: 'Publish these changes',
          onclick: () => act('Published. Readers now see this version.', () => DW.api('POST', base + '/approve'),
            'Publish this new version and show it to readers?'),
        })
      );
    } else {
      panel.append(DW.el('p', { class: 'muted', text: 'Only an article that is awaiting approval can be approved or returned. Current state: ' + DW.STATUS_LABELS[detail.status] + '.' }));
    }

    panel.append(
      DW.el('div', { class: 'form-bar-actions' },
        DW.el('a', { class: 'btn btn-ghost', href: '/editor/articles/' + encodeURIComponent(id) + '/edit', text: 'Edit this article' }),
        detail.live ? DW.el('a', { class: 'btn btn-ghost', href: '/articles/' + encodeURIComponent(id), text: 'View live page' }) : null,
        DW.el('button', {
          type: 'button', class: 'btn btn-danger', text: 'Delete article',
          // Click: ask first, then delete the article (with its comments and stats) and go back to the editor list.
          onclick: async () => {
            if (!confirm('Delete this article together with its comments and statistics? This cannot be undone.')) return;
            try {
              await DW.api('DELETE', base);
              window.location.href = '/editor';
            } catch (err) {
              DW.toast(err.message, 'error');
            }
          },
        }))
    );
    return panel;
  }

  // Gets the article from the API and draws the whole page: status badge, info line, diff or content, actions, history.
  // Also called again after every action so the page always shows the latest state.
  async function load() {
    try {
      const detail = await DW.api('GET', base);
      statusSlot.replaceChildren(DW.statusBadge(detail.status));
      const parts = [
        DW.el('p', { class: 'muted' }, 'By ' + detail.author.displayName + ' - last changed ' + DW.formatDateTime(detail.updatedAt) + ' - ' + detail.viewCount + ' views'),
        detail.revision && detail.revision.editorNote && detail.status === 'returned'
          ? DW.el('p', { class: 'editor-note' }, DW.el('strong', { text: 'Note sent to the reporter: ' }), detail.revision.editorNote)
          : null,
        // If there is a diff (an update to a published article) show the comparison, otherwise just the content.
        detail.diff ? renderDiff(detail) : renderContent(detail),
        DW.buildReviewHistory(detail.reviewHistory), // every earlier submit / return note / approval
        renderActions(detail),
        renderHistory(detail),
      ];
      root.replaceChildren(...parts.filter(Boolean)); // (replaceChildren would print "null" for empty parts)
    } catch (err) {
      root.replaceChildren(DW.el('p', { class: 'form-error', role: 'alert', text: err.message }));
    }
  }

  load();
})();
