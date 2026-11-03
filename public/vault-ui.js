export function createVaultUI({ api, escape, generation, authenticated, onSavingChange, toast }) {
  const $ = selector => document.querySelector(selector), form = $('#vault-form');
  let request = 0, data = null, saving = false, deleting = null;
  const error = message => { $('#vault-error').textContent = message; $('#vault-error').hidden = !message; };
  function render() {
    const existing = new Map([...$('#vault-list').querySelectorAll('[data-vault-key]')].map(row => [row.dataset.vaultKey, row]));
    const rows = data.keys.map(({ key }) => {
      if (existing.has(key)) return existing.get(key);
      const row = document.createElement('tr'); row.dataset.vaultKey = key;
      row.innerHTML = `<th scope="row"><code>${escape(key)}</code><span class="form-hint">설정됨 · 값 숨김</span></th><td><form id="vault-update-${escape(key)}" data-vault-update="${escape(key)}" autocomplete="off"><label class="field"><input data-vault-value="${escape(key)}" type="password" required maxlength="4000" autocomplete="new-password" spellcheck="false" aria-label="${escape(key)} 새 비밀 값" placeholder="교체할 값 입력" aria-describedby="vault-value-hint"></label></form></td><td><div class="vault-actions"><button type="submit" form="vault-update-${escape(key)}" class="button secondary" data-vault-edit="${escape(key)}" aria-label="${escape(key)} 교체">교체</button><button type="button" class="button secondary" data-vault-delete="${escape(key)}" aria-label="${escape(key)} 삭제">삭제</button></div></td>`;
      return row;
    });
    $('#vault-list').replaceChildren(...rows);
    if (!rows.length) $('#vault-list').innerHTML = '<tr><td colspan="3" class="form-hint">등록된 비밀 값이 없습니다.</td></tr>';
    $('#vault-delete-confirm').hidden = true; deleting = null;
  }
  function setBusy(busy) {
    saving = busy; onSavingChange(busy);
    $('#vault-fields').disabled = busy || !data || !authenticated();
    for (const button of $('#vault-panel').querySelectorAll('button')) button.disabled = busy || !authenticated();
  }
  async function loadSettings() {
    if (saving) return;
    const current = ++request, session = generation();
    data = null; form.reset(); error(''); $('#vault-fields').disabled = true;
    $('#vault-reload').disabled = false;
    $('#vault-list').replaceChildren(); $('#vault-loading').hidden = false;
    $('#vault-delete-confirm').hidden = true;
    try {
      const result = await api('/api/settings/vault');
      if (current !== request || session !== generation() || !$('#branding-dialog').open) return;
      data = result; render(); $('#vault-fields').disabled = false;
    } catch (failure) {
      if (current === request && session === generation()) error(failure.message);
    } finally { if (current === request) $('#vault-loading').hidden = true; }
  }
  async function save(key, value, input = null) {
    if (saving || !data || !authenticated()) return;
    const session = generation(), version = data.version;
    setBusy(true); error('');
    if (input) input.value = '';
    try {
      const body = JSON.stringify({ version, key, value }); value = null;
      const result = await api('/api/settings/vault', { method: 'PUT', body });
      if (session !== generation()) return;
      data = result; render();
      if (input === form.elements.value) form.reset();
      toast('비밀 값 저장소를 변경했습니다.');
    } catch (failure) {
      if (session === generation()) {
        error(failure.message);
        if (failure.status === 409) { data = null; form.reset(); $('#vault-list').replaceChildren(); $('#vault-delete-confirm').hidden = true; deleting = null; }
      }
    } finally { setBusy(false); }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (form.reportValidity()) save(form.elements.key.value, form.elements.value.value, form.elements.value);
  });
  $('#vault-list').addEventListener('submit', event => {
    const update = event.target.closest('[data-vault-update]');
    if (!update) return;
    event.preventDefault();
    const input = update.querySelector('[data-vault-value]');
    if (update.reportValidity()) save(update.dataset.vaultUpdate, input.value, input);
  });
  $('#vault-list').addEventListener('click', event => {
    if (saving || !data) return;
    const remove = event.target.closest('[data-vault-delete]');
    if (remove) {
      deleting = remove.dataset.vaultDelete;
      $('#vault-delete-message').textContent = `${deleting} 키를 삭제할까요? 이 키를 사용하는 다음 HTTP 요청부터 실행이 실패합니다.`;
      $('#vault-delete-confirm').hidden = false; $('#vault-delete-yes').focus();
    }
  });
  $('#vault-delete-yes').addEventListener('click', () => { if (deleting) save(deleting, null); });
  $('#vault-delete-no').addEventListener('click', () => { deleting = null; $('#vault-delete-confirm').hidden = true; });
  $('#vault-reload').addEventListener('click', loadSettings);
  function clear() {
    request++; data = null; deleting = null; form.reset(); error('');
    $('#vault-list').replaceChildren(); $('#vault-fields').disabled = true;
    $('#vault-loading').hidden = true; $('#vault-delete-confirm').hidden = true;
  }
  $('#branding-dialog').addEventListener('close', clear);
  return { loadSettings, clear };
}
