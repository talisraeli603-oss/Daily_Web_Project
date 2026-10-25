/* Editor: user management (list, search, create, edit, delete) */
(function () {
  'use strict';

  // Grab the page elements. If the table or form is missing, this is not the users page, so stop.
  const tbody = document.querySelector('#users-table tbody');
  const pagerBox = document.getElementById('users-pager');
  const filters = document.getElementById('user-filters');
  const form = document.getElementById('user-form');
  if (!tbody || !form) return;

  const formTitle = document.getElementById('user-form-title');
  const submitBtn = document.getElementById('uf-submit');
  const cancelBtn = document.getElementById('uf-cancel');
  const errorBox = document.getElementById('user-form-error');
  const pwHint = document.getElementById('uf-password-hint');
  // state.page = current page of the table. state.editingId = id of the user being edited ('' means we are adding a new one).
  const state = { page: 1, editingId: '' };

  // Loads one page of users (with the search text and role filter) and fills the table.
  async function load() {
    const params = new URLSearchParams({ page: String(state.page) });
    if (filters.elements.q.value.trim()) params.set('q', filters.elements.q.value.trim());
    if (filters.elements.role.value) params.set('role', filters.elements.role.value);
    try {
      const data = await DW.api('GET', '/api/v1/users?' + params);
      tbody.replaceChildren();
      if (!data.items.length) {
        tbody.append(DW.el('tr', {}, DW.el('td', { colspan: '4', class: 'muted', text: 'No users found.' })));
      }
      // One table row per user, with Edit and Delete buttons.
      // Important: cells are built with DW.el (textContent), so a weird username can't inject HTML (XSS protection).
      data.items.forEach((u) => {
        tbody.append(DW.el('tr', {},
          DW.el('td', { text: u.username }),
          DW.el('td', { text: u.displayName }),
          DW.el('td', {}, DW.el('span', { class: 'badge badge-role-' + u.role, text: u.role })),
          DW.el('td', { class: 'row-actions' },
            DW.el('button', { type: 'button', class: 'btn btn-small btn-ghost', text: 'Edit', onclick: () => startEdit(u) }),
            DW.el('button', { type: 'button', class: 'btn btn-small btn-danger', text: 'Delete', onclick: () => remove(u) }))));
      });
      // Page buttons: go to the clicked page and reload the table.
      DW.pager(pagerBox, data.page, data.pages, (p) => {
        state.page = p;
        load();
      });
    } catch (err) {
      tbody.replaceChildren(DW.el('tr', {}, DW.el('td', { colspan: '4', class: 'form-error', text: err.message })));
    }
  }

  // Puts the form back to "Add a user" mode: empty fields, normal button texts, no errors.
  function resetForm() {
    state.editingId = '';
    form.reset();
    form.elements.id.value = '';
    formTitle.textContent = 'Add a user';
    submitBtn.textContent = 'Create user';
    cancelBtn.hidden = true;
    pwHint.textContent = '';
    errorBox.hidden = true;
    DW.showFieldErrors(form, null);
  }

  // Switches the form to "Edit" mode and fills it with the chosen user's data.
  // The password box stays empty: leaving it empty means "keep the current password".
  function startEdit(u) {
    resetForm();
    state.editingId = u.id;
    form.elements.id.value = u.id;
    form.elements.username.value = u.username;
    form.elements.displayName.value = u.displayName;
    form.elements.role.value = u.role;
    formTitle.textContent = 'Edit ' + u.username;
    submitBtn.textContent = 'Save changes';
    cancelBtn.hidden = false;
    pwHint.textContent = '(leave empty to keep the current password)';
    form.elements.username.focus();
  }

  // Deletes a user after the editor confirms. If that user was open in the form, the form is cleared too.
  async function remove(u) {
    if (!confirm('Delete the user "' + u.username + '"?')) return;
    try {
      await DW.api('DELETE', '/api/v1/users/' + encodeURIComponent(u.id));
      DW.toast('User deleted.', 'success');
      if (state.editingId === u.id) resetForm();
      load();
    } catch (err) {
      DW.toast(err.message, 'error');
    }
  }

  // Form submit: creates a new user (POST) or saves changes to the edited one (PUT), then refreshes the table.
  // If the server rejects the data, the error messages are shown next to the fields.
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorBox.hidden = true;
    DW.showFieldErrors(form, null);

    const body = {
      username: form.elements.username.value.trim(),
      displayName: form.elements.displayName.value.trim(),
      role: form.elements.role.value,
    };
    // When editing, the password is only sent if the editor typed a new one. A new user must always have one.
    if (form.elements.password.value || !state.editingId) body.password = form.elements.password.value;

    // Disable the button while we wait, so a double click can't send the form twice.
    submitBtn.disabled = true;
    try {
      if (state.editingId) await DW.api('PUT', '/api/v1/users/' + encodeURIComponent(state.editingId), body);
      else await DW.api('POST', '/api/v1/users', body);
      DW.toast(state.editingId ? 'User updated.' : 'User created.', 'success');
      resetForm();
      load();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
      DW.showFieldErrors(form, err.details);
    } finally {
      submitBtn.disabled = false;
    }
  });

  // "Cancel editing" button: go back to the empty "Add a user" form.
  cancelBtn.addEventListener('click', resetForm);

  // Search while typing, but wait 300 ms after the last key so we don't send a request on every letter (debounce).
  const debounced = DW.debounce(() => {
    state.page = 1;
    load();
  }, 300);
  // Pressing Enter in the search form: cancel the waiting debounce and search right now.
  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    debounced.cancel();
    state.page = 1;
    load();
  });
  filters.elements.q.addEventListener('input', debounced);
  // Changing the role dropdown searches again from page 1.
  filters.elements.role.addEventListener('change', () => {
    state.page = 1;
    load();
  });

  load();
})();
