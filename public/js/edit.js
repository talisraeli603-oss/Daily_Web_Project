/*
 * Article editor with AUTOSAVE.
 * Important: autosave - every change is sent to the server a moment after typing stops (and again when the tab
 * is closed), so closing the browser, refreshing, or continuing on another computer never loses work.
 * The page always loads the latest version from the server.
 * Important: fetch (through DW.api) is used for Ajax, so saving never reloads the page.
 */
(function () {
  'use strict';

  // The editor form. If this page has no such form, the script stops.
  const form = document.getElementById('edit-form');
  if (!form) return;

  const area = form.getAttribute('data-area'); // "workspace" (reporter) or "editor"
  // Empty means a brand-new article that is not on the server yet. It gets an id after the first save.
  let articleId = form.getAttribute('data-article-id') || '';

  // The names of the form fields that make up an article (these are what we save).
  const fields = ['title', 'category', 'image', 'summary', 'content'];
  // Page elements we update: save message, banner, status badge, buttons, heading and the image preview.
  const saveState = document.getElementById('save-state');
  const banner = document.getElementById('edit-banner');
  const statusSlot = document.getElementById('edit-status');
  const submitBtn = document.getElementById('submit-btn');
  const reviewLink = document.getElementById('review-link');
  const historySlot = document.getElementById('review-history-slot');
  const saveBtn = document.getElementById('save-btn');
  const publishBtn = document.getElementById('publish-btn');
  const heading = document.getElementById('edit-heading');
  const preview = document.getElementById('image-preview');
  const previewImg = preview.querySelector('img');

  // Autosave bookkeeping. Important: version goes up by 1 on every edit and savedVersion is the last version the
  // server confirmed. If they are different, there are unsaved changes. This also lets us notice edits made while a save is running.
  let version = 0; // increases with every edit
  let savedVersion = 0; // the version that is safely on the server
  // true while a save request is running (so we never send two saves at the same time)
  let saving = false;
  // The article's status (in_preparation, pending_approval, returned, published). A new article starts as in_preparation.
  let status = articleId ? '' : 'in_preparation';
  // true when the fields are locked (for example, waiting for the editor's approval)
  let readOnly = false;
  // Timer for trying a failed save again after a few seconds.
  let retryTimer = null;
  // The last save error (null if the last save worked). Used to warn the user before leaving the page.
  let lastError = null;

  /* ------------------------------ helpers ------------------------------ */
  // Short way to read the current value of a form field by its name.
  const value = (name) => form.elements[name].value;

  // Shows the save message ("Saving...", "All changes saved.") and gives it a color class by kind (ok / error / ...).
  function setSaveState(text, kind) {
    saveState.textContent = text;
    saveState.className = 'save-state' + (kind ? ' save-' + kind : '');
  }

  // Checks the image address with a regex: either a full http(s) link, or a path on our own site that starts with "/".
  const validImage = (v) => /^https?:\/\/\S+$/i.test(v) || /^\/[A-Za-z0-9/_\-.?=&%]*$/.test(v);

  // Updates the live character counters next to the summary (max 300) and the content (max 20000).
  function updateCounters() {
    document.getElementById('summary-count').textContent = '(' + value('summary').length + '/300)';
    document.getElementById('content-count').textContent = '(' + value('content').length + '/20000)';
  }

  // Shows a small preview of the image if the address is valid, otherwise hides it.
  function updatePreview() {
    const src = value('image').trim();
    if (src && validImage(src)) {
      previewImg.src = src;
      preview.hidden = false;
    } else {
      preview.hidden = true;
    }
  }
  // If the browser can't load the image (broken link), hide the preview.
  previewImg.addEventListener('error', () => (preview.hidden = true));

  // Puts the article data from the server into the form fields (empty text if a value is missing).
  function fill(current) {
    fields.forEach((name) => {
      form.elements[name].value = (current && current[name]) || '';
    });
    updateCounters();
    updatePreview();
  }

  // Locks (or unlocks) all the form fields, so the user can't type while editing is not allowed.
  function setReadOnly(on) {
    readOnly = on;
    fields.forEach((name) => (form.elements[name].disabled = on));
  }

  // Shows the message box at the top (info / warning / error) and the editor's note if there is one. Hides it if both are empty.
  function showBanner(message, kind, note) {
    banner.replaceChildren();
    if (!message && !note) {
      banner.hidden = true;
      return;
    }
    banner.className = 'notice' + (kind ? ' notice-' + kind : '');
    if (message) banner.append(DW.el('p', { text: message }));
    if (note) banner.append(DW.el('p', { class: 'editor-note' }, DW.el('strong', { text: 'Editor note: ' }), note));
    banner.hidden = false;
  }

  /**
   * Updates the status badge, banner and buttons from the article the server sent back.
   * It decides who can edit, which message to show, and which buttons (submit / publish / save) are visible.
   */
  function applyDetail(detail) {
    status = detail.status;
    statusSlot.replaceChildren(DW.statusBadge(status));
    heading.textContent = (detail.current && detail.current.title) || 'Edit article';

    const isReporter = area === 'workspace';
    const note = detail.revision && detail.revision.editorNote;

    // All earlier notes and decisions (not only the latest editor note), so the reporter and the editor can read the whole story.
    const log = DW.buildReviewHistory(detail.reviewHistory);
    historySlot.replaceChildren(...(log ? [log] : []));

    if (isReporter && status === 'pending_approval') {
      setReadOnly(true);
      showBanner('This article is waiting for an editor and cannot be edited right now.', 'info');
    } else if (status === 'returned') {
      setReadOnly(false);
      showBanner('An editor returned this article for corrections. Fix the points below, then submit it again.', 'warning', note);
    } else if (detail.live && status === 'published') {
      setReadOnly(false);
      showBanner('This article is published. Readers keep seeing the approved version. Your changes are saved as a new version that needs editor approval.', 'info');
    } else if (detail.live && detail.revision) {
      setReadOnly(false);
      showBanner(
        isReporter
          ? 'You are editing a new version of a published article. Readers still see the last approved version until an editor approves this one.'
          : 'This is a new version of a published article. Readers still see the last approved version until you publish this one (use Save & publish below) or the reporter submits it.',
        'info'
      );
    } else {
      setReadOnly(false);
      showBanner('', '');
    }

    const canSubmit = isReporter && !readOnly && (status === 'in_preparation' || status === 'returned') && !!detail.revision;
    submitBtn.hidden = !canSubmit;
    submitBtn.textContent = status === 'returned' ? 'Submit corrections for approval' : 'Submit for editor approval';

    // An editor can publish straight from here when the article waits for approval, or when it is a new version of an
    // article that is already published (the server allows both).
    const canPublishNow = status === 'pending_approval' || (status === 'in_preparation' && !!detail.live);
    publishBtn.hidden = isReporter || readOnly || !canPublishNow;
    saveBtn.hidden = readOnly;

    if (!isReporter && articleId) {
      reviewLink.href = '/editor/articles/' + encodeURIComponent(articleId);
      reviewLink.hidden = false;
    }
  }

  /* ------------------------------ loading ------------------------------ */
  // Runs when the page opens. A new article just shows a welcome message; an existing one is loaded from the server
  // and put into the form. If loading fails, the form is locked and the error is shown.
  async function load() {
    if (!articleId) {
      statusSlot.replaceChildren(DW.statusBadge('in_preparation'));
      setSaveState('Start writing: your work is saved automatically.');
      return;
    }
    try {
      const detail = await DW.api('GET', '/api/v1/manage/articles/' + encodeURIComponent(articleId));
      fill(detail.current);
      applyDetail(detail);
      setSaveState('All changes saved.', 'ok');
    } catch (err) {
      setReadOnly(true);
      showBanner(err.message, 'error');
      setSaveState('');
    }
  }

  /* ------------------------------ autosave ----------------------------- */
  // Collects the current field values into one object to send to the server.
  function payload() {
    const data = {};
    fields.forEach((name) => (data[name] = value(name)));
    // An invalid image address would make the server reject the whole draft: leave it out until it is valid.
    if (data.image.trim() && !validImage(data.image.trim())) delete data.image;
    return data;
  }

  /**
   * Sends the draft to the server: POST (create) the first time, PUT (update) after that.
   * Important: only one save runs at a time. If the user kept typing during the save, version != savedVersion
   * afterwards, so another save is scheduled. Nothing typed is skipped.
   * Important: when `immediate` is true (tab closing) we use keepalive so the request can finish even as the page unloads.
   * If the server is down (status 0 or 5xx) we keep the text and retry after 5 seconds; for other errors we show the message.
   */
  async function save(immediate) {
    if (readOnly) return;
    clearTimeout(retryTimer);
    if (saving) return; // the running save will notice the newer version and run again
    if (version === savedVersion) return;

    saving = true;
    const sentVersion = version;
    setSaveState('Saving...', 'saving');
    try {
      let detail;
      if (!articleId) {
        detail = await DW.api('POST', '/api/v1/manage/articles', payload(), { keepalive: !!immediate });
        articleId = detail.id;
        form.setAttribute('data-article-id', articleId);
        history.replaceState(null, '', '/workspace/articles/' + encodeURIComponent(articleId) + '/edit');
      } else {
        detail = await DW.api('PUT', '/api/v1/manage/articles/' + encodeURIComponent(articleId) + '/revision', payload(), { keepalive: !!immediate });
      }
      savedVersion = sentVersion;
      lastError = null;
      applyDetail(detail);
      const invalidImage = value('image').trim() && !validImage(value('image').trim());
      setSaveState(
        invalidImage ? 'Saved, except the image address (it must start with http:// or https://).' : 'Saved at ' + new Date().toLocaleTimeString(),
        invalidImage ? 'warn' : 'ok'
      );
    } catch (err) {
      lastError = err;
      if (err.status === 0 || err.status >= 500) {
        // temporary problem: keep the text in the form and try again shortly
        setSaveState('Could not save (' + err.message + ') Retrying...', 'error');
        retryTimer = setTimeout(() => save(), 5000);
      } else {
        setSaveState('Not saved: ' + err.message, 'error');
        if (err.status === 403 || err.status === 409) {
          setReadOnly(true);
          showBanner(err.message, 'error');
        }
      }
    } finally {
      saving = false;
      if (version !== savedVersion && !readOnly && !(lastError && lastError.status >= 400 && lastError.status < 500)) {
        scheduleSave();
      }
    }
  }

  // Important: debounce - the autosave waits until the user stops typing for 0.9 seconds, so we don't
  // send a request for every key press.
  const scheduleSave = DW.debounce(() => save(), 900);

  // Runs on every change in a field: marks the draft as changed (version + 1), updates the counters and plans an autosave.
  function onEdit() {
    if (readOnly) return;
    version++;
    updateCounters();
    setSaveState('Unsaved changes...', 'pending');
    scheduleSave();
  }

  // Every field counts as an edit when the user types in it. The image preview updates 0.4s after typing stops (debounce).
  fields.forEach((name) => form.elements[name].addEventListener('input', onEdit));
  form.elements.image.addEventListener('input', DW.debounce(updatePreview, 400));
  // The category dropdown also listens for "change" (picking an option), to be sure that choice counts as an edit.
  form.elements.category.addEventListener('change', onEdit);

  // Save right away when the user leaves the tab or closes the page (keepalive lets the request finish).
  // Important: this is why work is never lost when the tab is closed.
  function flush() {
    scheduleSave.cancel();
    if (version !== savedVersion) save(true);
  }
  // When the tab becomes hidden (user switched tab or minimized), save any unsaved changes right now.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  // When the page is being closed or left, save right now too.
  window.addEventListener('pagehide', flush);
  // If the last save failed and there are still unsaved changes, make the browser ask "Leave this page?" before closing.
  window.addEventListener('beforeunload', (e) => {
    if (lastError && version !== savedVersion) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  /* ------------------------------ submit ------------------------------- */
  // Checks the required fields in the browser before submitting. Returns an object like { title: 'message' }; empty if all is fine.
  // The server validates again, because browser checks can be skipped.
  function clientErrors() {
    const errors = {};
    if (!value('title').trim()) errors.title = 'A title is required.';
    if (!value('category')) errors.category = 'Choose a category.';
    if (!value('image').trim()) errors.image = 'A main image address is required.';
    else if (!validImage(value('image').trim())) errors.image = 'The image must be an http(s) address.';
    if (!value('summary').trim()) errors.summary = 'A summary is required.';
    if (value('content').trim().length < 20) errors.content = 'The article text must be at least 20 characters.';
    return errors;
  }

  // On click of "Submit for approval" (reporter): check the fields, ask to confirm, make sure the latest text is saved,
  // then tell the server to submit the article to an editor and go back to the workspace.
  submitBtn.addEventListener('click', async () => {
    DW.showFieldErrors(form, null);
    const errors = clientErrors();
    if (Object.keys(errors).length) {
      DW.showFieldErrors(form, errors);
      DW.toast('Please complete the highlighted fields first.', 'error');
      return;
    }
    if (!confirm('Submit this article to an editor for approval? You will not be able to edit it while it is waiting.')) return;

    submitBtn.disabled = true;
    try {
      scheduleSave.cancel();
      // Wait (checking every 100ms) until a running save finishes, so we don't start a second one at the same time.
      while (saving) await new Promise((r) => setTimeout(r, 100));
      await save(); // make sure the very latest text is on the server
      if (version !== savedVersion) throw new Error('Your latest changes could not be saved. Please try again.');
      await DW.api('POST', '/api/v1/manage/articles/' + encodeURIComponent(articleId) + '/submit');
      DW.toast('Submitted for approval.', 'success');
      window.location.href = '/workspace';
    } catch (err) {
      DW.toast(err.message, 'error');
      DW.showFieldErrors(form, err.details);
      submitBtn.disabled = false;
    }
  });

  /** Saves the very latest text and waits until it is safely on the server. Used before submit and publish. */
  async function saveAndWait() {
    scheduleSave.cancel();
    // Wait until a running save finishes (checks every 100ms).
    while (saving) await new Promise((r) => setTimeout(r, 100));
    await save();
    if (version !== savedVersion) throw new Error('Your latest changes could not be saved. Please try again.');
  }

  // On click of "Save changes": autosave already does this, but an explicit button gives clear feedback.
  // It saves now and shows a message when it is done.
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      if (!articleId && version === 0) {
        DW.toast('Nothing to save yet.', 'info');
      } else {
        await saveAndWait();
        DW.toast('Changes saved.', 'success');
      }
    } catch (err) {
      DW.toast(err.message, 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  // On click of "Publish" (editor): check the fields, ask to confirm, save the edits and publish the article.
  // The server only allows this while the article waits for approval.
  publishBtn.addEventListener('click', async () => {
    DW.showFieldErrors(form, null);
    const errors = clientErrors();
    if (Object.keys(errors).length) {
      DW.showFieldErrors(form, errors);
      DW.toast('Please complete the highlighted fields first.', 'error');
      return;
    }
    if (!confirm('Save your changes and publish this version to readers?')) return;
    publishBtn.disabled = true;
    try {
      await saveAndWait();
      await DW.api('POST', '/api/v1/manage/articles/' + encodeURIComponent(articleId) + '/approve');
      DW.toast('Published. Readers now see this version.', 'success');
      window.location.href = '/editor';
    } catch (err) {
      DW.toast(err.message, 'error');
      DW.showFieldErrors(form, err.details);
      publishBtn.disabled = false;
    }
  });

  // Pressing Enter in a field must not submit the form (that would reload the page). Saving is done by autosave and the buttons.
  form.addEventListener('submit', (e) => e.preventDefault());
  // Start: load the article (or show the empty new-article form).
  load();
})();
